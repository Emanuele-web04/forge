# Synara computer-use plugin for Hyprland

The Hyprland twin of `../computer-use-kwin`: the agent drives the human's real
desktop with its own drawn ghost cursor and its own input path, never the seat
the human is sitting at. It exposes the identical D-Bus surface —
`org.synara.ComputerUse` at `/org/synara/ComputerUse`, interface
`org.synara.ComputerUse1`, the same sixteen methods and `sessionStopped`
signal — so the server's whole KWin driving path is reused; only loading
differs (`hyprctl plugin load`, which takes effect live with no relogin).

Build with `make` against the installed Hyprland's headers (`pkg-config
hyprland`). The plugin ABI churns per Hyprland release, so builds are
per-version, like the KWin plugin's prebuilts.

Status: the plugin itself is feature-complete — window enumeration, session
lifecycle (idle timeout, Meta+Shift+Esc release/resume chord), the ghost cursor
(arrow + name badge, scale-aware, hold-then-fade), direct per-client input
injection (raw wire events on the target client's own
`wl_pointer`/`wl_keyboard` resources, seat-manager serials, xkb modifier
mirror — the compositor's seat state is never touched; the seat's pointer focus
is only observed, so an enter the human's seat sends to a sibling surface of the
agent's target invalidates the agent's own enter and the next motion re-enters,
and every agent action ends by handing the shared pointer/keyboard object back
to the seat so the human's own scroll, motion, and typing stay in their window),
and the capture
pipeline (offscreen GPU render of a window snapshot or each monitor's full
scene, read back and composited in cairo with the ghost cursor overlaid, so
captures show the agent's pointer exactly where the human sees it; the human's
cursor is never in the offscreen scene). The server side is wired too: a live
Hyprland session (instance signature with a live socket) auto-selects the
`hyprland` backend tier, which reuses the whole KWin backend engine through a
`hyprctl`-backed plugin host (`apps/server/src/computer/hyprlandPluginHost.ts`)
and provisions with `scripts/install-and-load.sh` — prebuilt when one matches
the exact running Hyprland, otherwise built from source, loaded live by
absolute path with no relogin ever.

Development testing runs in a disposable nested Hyprland (nested inside a
headless `kwin_wayland --virtual` parent — Hyprland cannot boot headless on a
busy seat), never against the live desktop.

Run `make test` for the compositor-free input regression fixture. It compiles
the production input functions against stub protocol resources and checks
clicks, dragging, scrolling, focus restoration, and refusal cleanup.
