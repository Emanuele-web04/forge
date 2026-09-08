#!/usr/bin/env python3
"""Read a bounded AT-SPI tree and return JSON-RPC responses on stdout."""

import json
import sys

try:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as error:  # pragma: no cover - exercised only on live Linux
    Atspi = None
    ATSPI_IMPORT_ERROR = str(error)
else:
    ATSPI_IMPORT_ERROR = None


MAX_NODES = 2048
MAX_DEPTH = 64
WINDOW_ROLE_NAMES = {"frame", "window", "dialog"}
EDITABLE_TEXT_INTERFACE = "editabletext"

# Accessible names are whatever the application put there — dense Chromium or
# Electron trees carry paragraph-sized labels — and this helper's reply is one
# newline-framed line that the client caps (HELPER_MAX_FRAME_BYTES in
# atspiClient.ts, 8 MiB). A line past the cap is a transport error, a process
# reset, and silent perception loss for that application, so the truncation
# happens here, before serialization, rather than after the bytes crossed the
# wire.
MAX_TEXT_CHARS = 1024
MAX_ROLE_CHARS = 64
# Headroom under the client cap for the envelope and framing itself. If even
# the stripped fallback below cannot fit, failing the one request loudly beats
# desyncing the transport for everything behind it.
SAFE_REPLY_BYTES = 6 * 1024 * 1024


def clamp_text(value, limit):
    """Cut to `limit` characters without splitting a surrogate pair.

    Python strings are sequences of code points, so plain slicing never lands
    inside a surrogate pair — the hazard the TypeScript side guards against does
    not exist here. `None` passes through untouched.
    """
    if not isinstance(value, str) or len(value) <= limit:
        return value
    return value[:limit]


def emit(message):
    encoded = json.dumps(message, separators=(",", ":"))
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()


def rect_for(accessible):
    try:
        component = accessible.get_component_iface()
        rect = component.get_extents(Atspi.CoordType.SCREEN)
        return {
            "x": float(rect.x),
            "y": float(rect.y),
            "width": max(0.0, float(rect.width)),
            "height": max(0.0, float(rect.height)),
        }
    except Exception:
        return {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}


def text_or_none(value):
    return value if isinstance(value, str) and value else None


def supports_editable_text(accessible):
    """Whether a node accepts EditableText.set_text_contents.

    The interface list is the cheap answer and is what most toolkits expose;
    probing the interface itself is the fallback for bindings that do not
    report the list.
    """
    try:
        interfaces = accessible.get_interfaces()
    except Exception:
        interfaces = None
    if isinstance(interfaces, (list, tuple)):
        for name in interfaces:
            if isinstance(name, str) and name.rsplit(".", 1)[-1].casefold() == (
                EDITABLE_TEXT_INTERFACE
            ):
                return True
        return False
    try:
        return accessible.get_editable_text_iface() is not None
    except Exception:
        return False


def node_for(accessible, depth, budget, path=()):
    if depth > MAX_DEPTH or budget[0] >= MAX_NODES:
        return None
    budget[0] += 1
    try:
        role = accessible.get_role_name() or "unknown"
    except Exception:
        role = "unknown"
    try:
        label = text_or_none(accessible.get_name())
    except Exception:
        label = None
    try:
        description = text_or_none(accessible.get_description())
    except Exception:
        description = None
    value = None
    try:
        value_iface = accessible.get_value_iface()
        value = text_or_none(str(value_iface.get_current_value()))
    except Exception:
        pass

    children = []
    try:
        count = accessible.get_child_count()
        for index in range(min(count, MAX_NODES)):
            child = accessible.get_child_at_index(index)
            if child is None:
                continue
            child_node = node_for(child, depth + 1, budget, tuple(path) + (index,))
            if child_node is not None:
                children.append(child_node)
    except Exception:
        pass

    return {
        "role": clamp_text(role, MAX_ROLE_CHARS),
        "label": clamp_text(label, MAX_TEXT_CHARS),
        "value": clamp_text(value, MAX_TEXT_CHARS),
        "description": clamp_text(description, MAX_TEXT_CHARS),
        "frame": rect_for(accessible),
        "activationPoint": None,
        # The real child indices, not the emitted ones: a skipped or budgeted-out
        # child would otherwise shift every later sibling's address.
        "path": [int(index) for index in path],
        "editable": supports_editable_text(accessible),
        "children": children,
    }


def process_id(accessible):
    try:
        value = accessible.get_process_id()
        return int(value) if value and int(value) > 0 else None
    except Exception:
        return None


def role_name(accessible):
    try:
        value = accessible.get_role_name()
        return value.strip().casefold() if isinstance(value, str) else ""
    except Exception:
        return ""


def is_window_candidate(accessible):
    try:
        role = accessible.get_role()
        if role in (Atspi.Role.FRAME, Atspi.Role.WINDOW, Atspi.Role.DIALOG):
            return True
    except Exception:
        pass
    return role_name(accessible) in WINDOW_ROLE_NAMES


def same_window_score(accessible, requested, inherited_pid=None):
    if not is_window_candidate(accessible):
        return None

    requested_pid = requested.get("pid")
    score = 0
    if requested_pid is not None:
        actual_pid = process_id(accessible) or inherited_pid
        if actual_pid != requested_pid:
            return None
        score += 100

    requested_title = (requested.get("title") or "").strip().casefold()
    try:
        name = (accessible.get_name() or "").strip().casefold()
    except Exception:
        name = ""
    if requested_title:
        if name == requested_title:
            score += 100
        elif requested_title in name or name in requested_title:
            score += 30
        elif requested_pid is None:
            return None
    elif requested_pid is None:
        return None

    requested_bounds = requested.get("bounds")
    actual_bounds = rect_for(accessible)
    if isinstance(requested_bounds, dict):
        requested_width = requested_bounds.get("width")
        requested_height = requested_bounds.get("height")
        if (
            isinstance(requested_width, (int, float))
            and isinstance(requested_height, (int, float))
            and actual_bounds["width"] > 0
            and actual_bounds["height"] > 0
        ):
            width_delta = abs(actual_bounds["width"] - float(requested_width))
            height_delta = abs(actual_bounds["height"] - float(requested_height))
            if width_delta <= 2 and height_delta <= 2:
                score += 40
            elif width_delta <= 8 and height_delta <= 8:
                score += 20
            elif width_delta <= 64 and height_delta <= 64:
                score += 5
    return score


def same_window(accessible, requested):
    return same_window_score(accessible, requested) is not None


def find_window_match(accessible, requested, depth=0, budget=None, inherited_pid=None):
    if budget is None:
        budget = [0]
    if depth > MAX_DEPTH or budget[0] >= MAX_NODES:
        return None
    budget[0] += 1

    actual_pid = process_id(accessible) or inherited_pid
    score = same_window_score(accessible, requested, inherited_pid)
    best = (score, accessible) if score is not None else None
    try:
        count = accessible.get_child_count()
        for index in range(min(count, MAX_NODES)):
            child = accessible.get_child_at_index(index)
            if child is None:
                continue
            found = find_window_match(child, requested, depth + 1, budget, actual_pid)
            if found is not None and (best is None or found[0] > best[0]):
                best = found
    except Exception:
        pass
    return best


def find_window(accessible, requested):
    match = find_window_match(accessible, requested)
    return match[1] if match is not None else None


def client_size_for(window):
    rect = rect_for(window)
    return {"width": rect["width"], "height": rect["height"]}


def read_tree(params):
    if Atspi is None:
        raise RuntimeError("PyGObject Atspi is unavailable: " + ATSPI_IMPORT_ERROR)
    desktop = Atspi.get_desktop(0)
    trees = []
    for requested in params.get("windows", []):
        if not isinstance(requested, dict) or not isinstance(requested.get("id"), str):
            continue
        window = find_window(desktop, requested)
        if window is None:
            continue
        budget = [0]
        root = node_for(window, 0, budget)
        if root is None:
            continue
        trees.append(
            {
                "windowId": requested["id"],
                "clientSize": client_size_for(window),
                "root": root,
            }
        )
    return fit_reply({"trees": trees})


def serialized_bytes(result):
    return len(json.dumps(result, separators=(",", ":")).encode("utf-8", errors="replace"))


def strip_node_text(node, keep_label=False):
    """Drop a node's free text in place, keeping role, geometry, and shape.

    A stripped tree still says which windows exist and where they are; only
    per-widget text is gone. The window root keeps even its label, because a
    tree that no longer names its own window is half useless.
    """
    node["label"] = None if not keep_label else node["label"]
    node["value"] = None
    node["description"] = None
    for child in node["children"]:
        strip_node_text(child)


def fit_reply(result):
    """Keep a read-tree reply inside what the transport can carry.

    Per-field clamps make an oversized line implausible; this is the guard that
    turns the implausible into one structured error instead of a frame that the
    client must drop and a helper it must reset.
    """
    if serialized_bytes(result) <= SAFE_REPLY_BYTES:
        return result
    stripped = {"trees": [dict(tree) for tree in result["trees"]]}
    for tree in stripped["trees"]:
        tree["root"] = json.loads(json.dumps(tree["root"]))
        strip_node_text(tree["root"], keep_label=True)
    if serialized_bytes(stripped) > SAFE_REPLY_BYTES:
        raise RuntimeError(
            "The accessibility tree stayed over the transport limit even with all text dropped"
        )
    return stripped


def node_at_path(window, path):
    """Re-resolve a node from a child-index path, or None when it moved."""
    node = window
    for index in path:
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            return None
        try:
            if index >= node.get_child_count():
                return None
            child = node.get_child_at_index(index)
        except Exception:
            return None
        if child is None:
            return None
        node = child
    return node


def matches_expected_node(accessible, expected_role, expected_label):
    """Guard against tree drift writing text into an unrelated widget."""
    if isinstance(expected_role, str) and expected_role:
        if role_name(accessible) != expected_role.strip().casefold():
            return False
    if isinstance(expected_label, str) and expected_label:
        try:
            name = accessible.get_name() or ""
        except Exception:
            name = ""
        if name.strip() != expected_label.strip():
            return False
    return True


def set_text(params):
    if Atspi is None:
        raise RuntimeError("PyGObject Atspi is unavailable: " + ATSPI_IMPORT_ERROR)
    text = params.get("text")
    if not isinstance(text, str):
        raise ValueError("set-text requires a text string")
    requested = params.get("window")
    if not isinstance(requested, dict):
        raise ValueError("set-text requires a window descriptor")
    path = params.get("path")
    if not isinstance(path, list):
        raise ValueError("set-text requires a node path")

    window = find_window(Atspi.get_desktop(0), requested)
    if window is None:
        return {"ok": False, "reason": "window-not-found"}
    node = node_at_path(window, path)
    if node is None:
        return {"ok": False, "reason": "node-not-found"}
    if not matches_expected_node(node, params.get("role"), params.get("label")):
        return {"ok": False, "reason": "node-changed"}
    if not supports_editable_text(node):
        return {"ok": False, "reason": "not-editable"}
    try:
        iface = node.get_editable_text_iface()
        if iface is None:
            return {"ok": False, "reason": "not-editable"}
        result = iface.set_text_contents(text)
    except Exception as error:
        return {"ok": False, "reason": str(error)}
    # Bindings that return nothing have already applied the write; only an
    # explicit false is a refusal the caller must fall back from.
    return {"ok": result is None or bool(result)}


def read_request_lines():
    """Requests, one per line, decoded so that a bad byte costs one request.

    ``for line in sys.stdin`` decodes strictly, so a single non-UTF-8 byte
    anywhere in the stream raises ``UnicodeDecodeError`` out of the ``for``
    itself — outside any handler — and the helper dies mid-conversation, taking
    every outstanding request with it. Reading the underlying binary buffer and
    decoding each line with ``errors="replace"`` turns that into one request
    that fails to parse and one error reply, which is what the caller can act
    on.
    """
    for raw in sys.stdin.buffer:
        yield raw.decode("utf-8", errors="replace")


def main():
    for line in read_request_lines():
        # Reset per iteration. Carrying the previous request's id into this
        # one's failure reply attributes the error to a request that already
        # succeeded, and leaves the request that actually failed with no reply
        # at all — the caller waits for it until its timeout.
        request_id = None
        try:
            message = json.loads(line)
            request_id = message.get("id")
            method = message.get("method")
            params = message.get("params") or {}
            if method == "read-tree":
                result = read_tree(params)
            elif method == "set-text":
                result = set_text(params)
            else:
                raise ValueError("Unknown AT-SPI helper method")
            emit({"jsonrpc": "2.0", "id": request_id, "result": result})
        except Exception as error:
            emit(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32000, "message": str(error)},
                }
            )


if __name__ == "__main__":
    main()
