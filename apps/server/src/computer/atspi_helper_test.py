import importlib.util
import json
import unittest
from pathlib import Path


HELPER_PATH = Path(__file__).with_name("atspi_helper.py")
SPEC = importlib.util.spec_from_file_location("synara_atspi_helper", HELPER_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(HELPER)


class FakeRole:
    FRAME = "frame"
    WINDOW = "window"
    DIALOG = "dialog"


class FakeCoordType:
    SCREEN = "screen"


class FakeAtspi:
    Role = FakeRole
    CoordType = FakeCoordType
    desktop = None

    @staticmethod
    def get_desktop(_index):
        return FakeAtspi.desktop


class FakeRect:
    def __init__(self, width, height):
        self.x = 0
        self.y = 0
        self.width = width
        self.height = height


class FakeEditableText:
    def __init__(self, owner, accepts=True):
        self.owner = owner
        self.accepts = accepts

    def set_text_contents(self, text):
        if not self.accepts:
            return False
        self.owner.text = text
        return True


class FakeAccessible:
    def __init__(
        self,
        role,
        name="",
        pid=None,
        width=0,
        height=0,
        children=None,
        interfaces=None,
        editable=None,
    ):
        self.role = role
        self.name = name
        self.pid = pid
        self.rect = FakeRect(width, height)
        self.children = children or []
        self.interfaces = ["Accessible", "Component"] if interfaces is None else interfaces
        self.editable = editable
        self.text = None

    def get_interfaces(self):
        return self.interfaces

    def get_editable_text_iface(self):
        return self.editable

    def get_role(self):
        return self.role

    def get_role_name(self):
        return self.role

    def get_name(self):
        return self.name

    def get_process_id(self):
        return self.pid

    def get_component_iface(self):
        return self

    def get_extents(self, _coord_type):
        return self.rect

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, index):
        return self.children[index]

    def get_description(self):
        return ""

    def get_value_iface(self):
        raise RuntimeError("no value")


def editable_field(name="Name"):
    field = FakeAccessible(
        "entry",
        name,
        interfaces=["Accessible", "Component", "org.a11y.atspi.EditableText", "Text"],
    )
    field.editable = FakeEditableText(field)
    return field


class AtspiHelperTest(unittest.TestCase):
    def setUp(self):
        HELPER.Atspi = FakeAtspi
        FakeAtspi.desktop = None

    def test_descends_through_application_to_find_a_frame(self):
        frame = FakeAccessible("frame", "Terminal", None, 640, 480)
        application = FakeAccessible("application", "Terminal", 42, 0, 0, [frame])
        desktop = FakeAccessible("desktop", children=[application])

        found = HELPER.find_window(
            desktop,
            {
                "title": "Terminal",
                "pid": 42,
                "bounds": {"width": 648, "height": 518},
            },
        )

        self.assertIs(found, frame)
        self.assertEqual(HELPER.client_size_for(found), {"width": 640.0, "height": 480.0})

    def test_chooses_the_frame_with_matching_name_and_extents_for_one_pid(self):
        other = FakeAccessible("frame", "Other", 42, 400, 300)
        target = FakeAccessible("window", "Terminal", 42, 640, 480)
        desktop = FakeAccessible("desktop", children=[other, target])

        found = HELPER.find_window(
            desktop,
            {
                "title": "Terminal",
                "pid": 42,
                "bounds": {"width": 648, "height": 518},
            },
        )

        self.assertIs(found, target)


class AtspiSemanticWriteTest(unittest.TestCase):
    def setUp(self):
        HELPER.Atspi = FakeAtspi
        self.field = editable_field()
        self.label = FakeAccessible("label", "Name:")
        # The dropped child keeps the emitted list and the real indices apart.
        self.frame = FakeAccessible(
            "frame",
            "Terminal",
            42,
            640,
            480,
            [None, self.label, self.field],
        )
        self.application = FakeAccessible("application", "Terminal", 42, 0, 0, [self.frame])
        FakeAtspi.desktop = FakeAccessible("desktop", children=[self.application])
        self.requested = {
            "id": "window-1",
            "title": "Terminal",
            "pid": 42,
            "bounds": {"width": 648, "height": 518},
        }

    def tearDown(self):
        FakeAtspi.desktop = None

    def test_emits_real_child_indices_and_the_editable_flag(self):
        trees = HELPER.read_tree({"windows": [self.requested]})["trees"]

        root = trees[0]["root"]
        self.assertEqual(root["path"], [])
        self.assertFalse(root["editable"])
        # Two children were emitted, at their real AT-SPI indices 1 and 2.
        self.assertEqual([child["path"] for child in root["children"]], [[1], [2]])
        self.assertEqual([child["editable"] for child in root["children"]], [False, True])

    def test_resolves_a_path_and_rejects_one_that_no_longer_exists(self):
        self.assertIs(HELPER.node_at_path(self.frame, [2]), self.field)
        self.assertIs(HELPER.node_at_path(self.frame, []), self.frame)
        self.assertIsNone(HELPER.node_at_path(self.frame, [9]))
        self.assertIsNone(HELPER.node_at_path(self.frame, [0]))
        self.assertIsNone(HELPER.node_at_path(self.frame, [2, 0]))
        self.assertIsNone(HELPER.node_at_path(self.frame, ["2"]))

    def test_writes_the_whole_value_through_editable_text(self):
        result = HELPER.set_text(
            {
                "window": self.requested,
                "path": [2],
                "text": "naïve",
                "role": "entry",
                "label": "Name",
            }
        )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(self.field.text, "naïve")

    def test_refuses_a_node_that_drifted_or_cannot_take_text(self):
        drifted = HELPER.set_text(
            {"window": self.requested, "path": [2], "text": "x", "label": "Other"}
        )
        not_editable = HELPER.set_text({"window": self.requested, "path": [1], "text": "x"})
        missing_node = HELPER.set_text({"window": self.requested, "path": [7], "text": "x"})
        missing_window = HELPER.set_text(
            {"window": {"id": "gone", "title": "Gone", "pid": 7}, "path": [], "text": "x"}
        )

        self.assertEqual(drifted, {"ok": False, "reason": "node-changed"})
        self.assertEqual(not_editable, {"ok": False, "reason": "not-editable"})
        self.assertEqual(missing_node, {"ok": False, "reason": "node-not-found"})
        self.assertEqual(missing_window, {"ok": False, "reason": "window-not-found"})
        self.assertIsNone(self.field.text)

    def test_reports_a_toolkit_that_refuses_the_write(self):
        self.field.editable = FakeEditableText(self.field, accepts=False)

        self.assertEqual(
            HELPER.set_text({"window": self.requested, "path": [2], "text": "x"}),
            {"ok": False},
        )

    def test_falls_back_to_the_interface_probe_when_no_list_is_reported(self):
        probed = editable_field()
        probed.get_interfaces = lambda: None

        self.assertTrue(HELPER.supports_editable_text(probed))
        self.assertFalse(HELPER.supports_editable_text(self.label))


class AtspiReplySizeTest(unittest.TestCase):
    def setUp(self):
        HELPER.Atspi = FakeAtspi
        self.frame = FakeAccessible("frame", "Terminal", 42, 640, 480)
        self.application = FakeAccessible("application", "Terminal", 42, 0, 0, [self.frame])
        FakeAtspi.desktop = FakeAccessible("desktop", children=[self.application])
        self.requested = {
            "id": "window-1",
            "title": "Terminal",
            "pid": 42,
            "bounds": {"width": 648, "height": 518},
        }

    def tearDown(self):
        FakeAtspi.desktop = None

    def test_clamps_oversized_accessible_names_before_serialization(self):
        # A megabyte-scale name: a dense Chromium tree can produce these, and
        # before the clamp one of them failed the client's frame cap and took
        # perception for the whole application down with it.
        self.frame.name = "x" * (2 * 1024 * 1024)

        trees = HELPER.read_tree({"windows": [self.requested]})["trees"]

        label = trees[0]["root"]["label"]
        self.assertEqual(len(label), HELPER.MAX_TEXT_CHARS)
        # The reply stays well inside what the newline-framed transport accepts.
        self.assertLess(
            len(json.dumps(trees, separators=(",", ":")).encode()), HELPER.SAFE_REPLY_BYTES
        )

    def test_drops_node_text_when_the_whole_reply_would_still_exceed_the_cap(self):
        # Enough nodes that even clamped text sums past the safety threshold:
        # the fallback keeps role, geometry, and shape, dropping free text.
        many = [
            FakeAccessible(f"n{i}", "y" * HELPER.MAX_TEXT_CHARS, width=10, height=10)
            for i in range(2048)
        ]
        self.frame.children = many
        # A threshold the bare node shapes fit under but one clamped label per
        # node blows straight through.
        limit = 512 * 1024
        HELPER.SAFE_REPLY_BYTES = limit
        try:
            result = HELPER.read_tree({"windows": [self.requested]})
        finally:
            HELPER.SAFE_REPLY_BYTES = 6 * 1024 * 1024

        root = result["trees"][0]["root"]
        encoded = json.dumps(result, separators=(",", ":")).encode()
        self.assertLessEqual(len(encoded), limit)
        # The window node kept its identity; leaf nodes lost their text.
        self.assertEqual(root["label"], "Terminal")
        self.assertIsNone(root["children"][0]["label"])

    def test_raises_when_even_the_strip_cannot_fit(self):
        HELPER.SAFE_REPLY_BYTES = 16
        try:
            with self.assertRaises(RuntimeError) as caught:
                HELPER.read_tree({"windows": [self.requested]})
        finally:
            HELPER.SAFE_REPLY_BYTES = 6 * 1024 * 1024
        self.assertIn("transport limit", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
