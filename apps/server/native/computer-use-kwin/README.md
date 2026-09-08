# Synara KWin computer-use plugin

A binary KWin plugin that gives Synara native compositor integration for computer
use on Linux/KDE. It paints the agent's own visible cursor (`synara-agent`),
routes synthetic pointer and keyboard events through KWin's compositor seat so
real Wayland clients receive them, and exposes a small D-Bus control API.

This is the Tier 1 backend described in `docs/computer-use-design.md`. It is
intentionally KWin-specific: a generic unprivileged Wayland client cannot inject
input into another client with an independent cursor. That requires running
inside the compositor, which is exactly the privilege level macOS computer use
uses on its side (WindowServer). See the design doc for the full rationale and
the macOS comparison.

## How it works

- Runs inside KWin as a `KWin::Plugin`, so it has the compositor's authority over
  input routing.
- The agent cursor is a KWin scene overlay `Item` (z=1000, parented to
  `effects->scene()->overlayItem()`), not a separate client window. This mirrors
  KWin's own `CursorItem`, except that the arrow is drawn by the plugin with
  `QPainter` rather than taken from the human's cursor theme: a second arrow in
  their own theme is indistinguishable from theirs, and telling the two apart is
  the whole point. It is a violet silhouette with a light rim and a dark outer
  stroke, so it reads against any wallpaper, sized from the human's own
  `themeSize` so both cursors are the same physical size. On a compositor the
  agent owns (a nested session) the same drawn item stands in for KWin's native
  cursor, which is hidden while a session runs: the native arrow depends on a
  cursor theme the host distro may not ship and on clients not hiding or
  replacing it, and the drawn item makes the agent's pointer look identical on
  every machine. It follows the seat's `Cursor::posChanged` there, since clients
  can warp the pointer and the human can drive it through the host window's
  pointer grab.
- A name badge — a pill naming the driving thread — is a second `ImageItem`
  child of the cursor item, offset below-right of the hotspot so it never covers
  the click point. It is fully opaque while the agent acts and fades out two
  seconds after the last action.
- Both images are rasterized at the scale of the output the hotspot is on and
  redrawn when the cursor crosses onto an output with a different scale, when
  the human's cursor theme changes, or when the outputs change.
- The plugin creates a dedicated `SeatInterface` named `synara-agent` and
  delivers all agent input on it: pointer focus/motion/buttons via
  `notifyPointerEnter` / `notifyPointerMotion` / `notifyPointerButton`, keys via
  `notifyKeyboardKey`. The agent seat mirrors the real keyboard's xkb keymap and
  tracks its own `xkb_state` for modifier events. The user's real seat is never
  touched in either direction, so agent and user can point and type at the same
  time without crossover, and the real system cursor never moves.
- Pressed buttons and keys are tracked and released on stop/destroy, so a crash
  or stop mid-action cannot latch a stuck modifier.

## D-Bus API

Service `org.synara.ComputerUse`, path `/org/synara/ComputerUse`, interface
`org.synara.ComputerUse1`. Methods: `healthJson`, `stateJson`, `windowsJson`,
`start`, `stop`, `setIdleTimeout(u milliseconds) -> b`,
`setHumanActiveGuardMs(u milliseconds) -> b`,
`setAgentName(s name) -> b`, `focusWindow`,
`raiseWindow(s windowId) -> b`, `clearFocusWindow`, `movePointer`, `button`,
`axis`, `key`, `captureWindow(s windowId, u maxDimension) -> ay`, and
`captureRegion(i x, i y, u width, u height, u maxDimension) -> ay`. One signal:
`sessionStopped(s reason)`, emitted whenever a running session ends, with the
reason `request`, `idle-timeout`, or `user-release`.

`axis(d horizontal, d vertical) -> b` takes desktop pixels, not wheel notches,
which is the unit the whole computer-use stack speaks; positive is right and
down. The plugin converts to the wheel's own units on the way out, at 80 content
pixels per notch, and the continuous half goes out at libinput's 15 units per notch.

`setAgentName(name)` sets the text on the cursor's name badge and always returns
`true`; an empty string clears it back to `Agent`. The plugin has no way to know
which thread is driving it, so the server names the lease holder — it caches the
name and resends it after every session start, because the plugin forgets it
along with the rest of the session. Setting it mid-session brings the badge back
at full opacity, so a handover announces itself instead of happening silently.
`stateJson` reports the current name as `agentName`.

`windowsJson` reports windows topmost-first. Each entry carries `stackingIndex`
(`0` is the topmost reported window, increasing downward) and `occludedBy`, the
ids of usable windows above it whose frame rects overlap it. The overlap is a
rect intersection rather than true pixel occlusion, so a translucent or shaped
window above still counts; overstating it is the safe direction, because the
remedy — scoping the click to a window — is the same either way.

`raiseWindow(windowId)` restacks a window above the ones covering it and
returns `true` when it did. It deliberately does not call `activateWindow`: the
human's keyboard focus is never moved, because the agent drives its own seat and
only needs the window it is clicking to be the one on top at that coordinate. It
returns `false` when the session is stopped or the id names no usable window.

`focusWindow(windowId)` also scopes the pointer: while a target is named, every
`button` and `axis` event goes to that window, not to whatever the stacking
order puts under the cursor. Without this, a click aimed at a partly covered
window is delivered to the window covering it, and the caller sees a button that
does nothing rather than an error. If the target has gone away, or does not
accept input at the current pointer position, `button` and `axis` return `false`
instead of retargeting — the same rule the keyboard already follows.

The target's own menus are the one exception, and they have to be: a popup is a
window of its own, so scoping to a window would otherwise make that window's
context menu unclickable. A click is accepted when it lands on the target **or**
on a popup in the target's transient tree, deepest first (a submenu is transient
for the menu that opened it and drawn above it). Popups are pointer targets
generally, not only under an explicit target: KWin's `XdgPopupWindow` answers
`wantsInput()` false by construction, so the plugin gates the pointer on
"focusable **or** popup" and the keyboard on `wantsInput()` alone. Nothing ever
focuses or activates a popup; menu key navigation works through KWin's own popup
filter, which holds seat0's keyboard for the duration of the grab.

Each `windowsJson` entry also carries `active`: whether the compositor reports
the window as activated to its client. This matters because toolkits gate
keyboard-shortcut dispatch on activation, not on keyboard focus. Qt's shortcut
matcher requires an active window; a Ctrl-chord delivered to a window the
toolkit considers inactive is silently dropped, while plain typing and pointer
clicks still work. (Apps vary: KWrite drops shortcuts when inactive, KCalc and
Konsole fire them anyway.)

## Keyboard targeting and borrowed activation

`focusWindow(windowId)` names the window that receives all subsequent key
events, independent of where the pointer is. Three rules keep chords from going
astray:

- **Borrowed activation.** While the agent's keyboard focus rests on a window
  the human has not activated, the plugin marks it active via
  `Window::setActive(true)` — a visual/state change only, the human's real
  focus never moves — so toolkits dispatch shortcuts sent to it. The borrow is
  undone when focus moves on, the target is cleared, or the session stops, and
  it refuses to undo activation KWin has since granted for real (if the human
  activates the window themselves, the plugin leaves it alone). Cosmetic side
  effect: while borrowed, two windows may draw active-style decorations.
- **A dead target is an error, not a fallback.** Once `focusWindow` has named a
  target, that target closing does not silently retarget key events to whatever
  window happens to be under the pointer. Key methods return `false` until the
  server names a new target or calls `clearFocusWindow`. `stateJson` reports
  this as `targetLost: true`.
- **Held keys never migrate.** When keyboard focus moves between surfaces, keys
  still held are released to the old surface first; when the old surface is
  already gone, they are dropped and the xkb modifier state is rewound. Without
  this, a dying target could hand the next window a phantom held Ctrl via the
  Wayland enter-with-pressed-keys array, turning the next chord into a
  misdirected shortcut in an unrelated app.

`stateJson` reports `keyboardWindowActive` (whether the current keyboard target
is activated) and `borrowedActivation` (whether that activation is the
plugin's borrow) alongside `targetLost`.

Every input method (`movePointer`, `button`, `axis`, `key`, `focusWindow`,
`raiseWindow`, `clearFocusWindow`) returns `false` while the session is stopped,
so a stop can never be followed by invisible input. Captures work in both
states.

Capture requests are rendered at the next safe compositor render opportunity.
`maxDimension = 0` keeps native pixels; otherwise the PNG is downscaled so its
largest dimension is at most `maxDimension`. The plugin reads back the native
resolution first, then applies `maxDimension` during PNG encoding. The agent's
own cursor is painted into the pixels, so the agent sees its pointer the way a
person sees theirs; the human's cursor never is — on the shared desktop it is
claimed by an exclusive `ItemTreeView` that is deliberately never painted.

Only one capture may be in flight. A second concurrent call fails with
`org.synara.ComputerUse.Error.CaptureFailed` and the reason `capture already in
flight`. The render deadline is 2 seconds. The PNG encode deadline is 5 seconds.
If encoding times out, the reply fails and a late worker result is discarded.

Captures work whether the input seat is running or stopped. `stop()` cancels an
in-flight capture. A region request is first clamped to the workspace geometry.
After applying the output scale, the native image must be no larger than 16,384
pixels on either side and 64 megapixels total. Requests above either limit fail
with `CaptureFailed` before the render target is allocated.

Capture failures are returned as the D-Bus error
`org.synara.ComputerUse.Error.CaptureFailed` with a one-line reason. The methods
never use an empty `ay` as a failure response.

## Idle timeout

A running session stops itself after 5 minutes without agent activity. The
timeout lives in the plugin on purpose: if the Synara server crashes or is
killed, its finalizers never run, and nothing else would take the agent seat
and the ghost cursor down.

- Any method that expresses agent intent resets the deadline: `movePointer`,
  `button`, `axis`, `key`, `focusWindow`, `raiseWindow`, `clearFocusWindow`,
  `captureWindow`, `captureRegion`.
- `healthJson`, `stateJson`, and `windowsJson` deliberately do not. The server
  polls health, so counting introspection would keep every session alive
  forever.
- `SYNARA_COMPUTER_IDLE_TIMEOUT_MS` overrides the value the server sends: `0`
  disables the deadline, anything else is clamped to 1 s – 1 h, and a
  non-numeric or out-of-range value falls back to the 5 minute default.
- `setIdleTimeout(u milliseconds)` reconfigures it; `0` disables it entirely.
  Anything else outside 1 s – 1 h is rejected with `false`. The server sends its
  configured value right after `start()`. The deadline is re-armed from the last
  activity, so lowering it can fire immediately.
- An idle stop takes the same path as `stop()`: pressed buttons and keys are
  released, pointer and keyboard focus are dropped, the ghost cursor is hidden,
  and an in-flight capture is canceled. It does not block the next `start()`.
- `stateJson` reports `idleTimeoutMs`, `idleMs`, `idleRemainingMs` (only while
  running with a timeout set), and `stopReason` for the last lifetime change
  (`request`, `idle-timeout`, `user-release`, `user-resume`).

A long model turn can outlive the deadline — a model that thinks for six minutes
between clicks will find the session stopped. That is expected: the server
restarts it on the next action (see below), and the ghost cursor disappears
while nothing is happening, which is exactly the point.

## Release-control hotkey

**Meta+Shift+Esc** stops the session immediately, from any window, and latches
the plugin so `start()` fails with
`org.synara.ComputerUse.Error.ControlReleased` until control is handed back.
The shortcut is registered through KGlobalAccel (`SynaraReleaseComputerControl`,
listed under KWin in System Settings, remappable there) and is free on stock
Plasma — kill-window is Ctrl+Alt+Esc.

The user's real seat drives KWin's shortcut handling, and agent input is
delivered straight to client surfaces on the `synara-agent` seat without
entering that pipeline, so the agent can neither trigger the shortcut nor
swallow it.

Pressing Meta+Shift+Esc again hands control back. An explicit D-Bus `stop()`
also clears the latch, but Synara only calls `stop()` at server shutdown, so on
a running server the hotkey is the user's toggle.

Unlike the idle timeout, this is a human takeover, so the server does not
restart the session behind the user's back.

## Human-active guard

The agent has its own cursor and its own seat, which is what lets it work while
you work. One window is still off the table: the one you are typing in. A
`button`, `axis`, or `key` whose resolved target is the window seat0 has keyboard
focus on, while seat0 has seen input inside the guard window, is refused with
`org.synara.ComputerUse.Error.HumanActive`. Nothing is injected, the error names
the window and the age of your last input, and the server turns it into a
retryable refusal carrying `computer_human_active` — the same token the
server's own guard uses, so a caller never has to know which side refused.

- Recency comes from a `KWin::InputEventSpy`, not from
  `SeatInterface::timestamp()`. A spy is called from `InputRedirection` before
  any filter, so it sees exactly the events real devices produced — and neither
  agent path can produce one, because the dedicated seat is a second
  `SeatInterface` outside that pipeline and direct injection writes to client
  resources without a seat at all. There is therefore **no attribution epsilon**
  here: nothing the agent does has to be subtracted from what the spy observes.
- Exempt: `movePointer` (a ghost cursor gliding over your window disturbs
  nothing — the refusal belongs on the action, same reasoning as
  `SeatUnsupported`), all perception, the clipboard, `focusWindow` and
  `raiseWindow` (focusing your window is harmless precisely because the `key`
  that follows is refused).
- A popup in the transient tree of the focused window counts as that window: an
  open menu is part of what you are doing.
- The release half of a press the agent already delivered is never refused — a
  latched button or a stuck Ctrl in your window is worse than the press was.
- `SYNARA_COMPUTER_USE_OWNS_COMPOSITOR=1` disables the guard entirely. There the
  agent's input rides seat0, so recency would count its own events, and there is
  no human in that compositor to protect.
- `setHumanActiveGuardMs(u milliseconds)` reconfigures it; `0` disables it,
  anything else outside 100 ms – 60 s is rejected with `false`. The server sends
  its configured value right after `start()`, and
  `SYNARA_COMPUTER_HUMAN_ACTIVE_MS` overrides that value with the same parsing
  rules the idle timeout uses (default 2000 ms).
- `stateJson` reports `humanFocusWindowId` (empty when nothing has focus),
  `msSinceHumanInput` (`-1` when no real device event has been observed at all,
  which is not the same as a long quiet period) and `humanActiveGuardMs`.

## Known limitations

**Drag-and-drop and titlebar moves are refused by design.** A client starts a
drag with `wl_data_device.start_drag` and asks to be moved with
`xdg_toplevel.move`; both carry the serial of the button press that began the
gesture, and KWin validates it against a real implicit pointer grab
(`SeatInterface::hasImplicitPointerGrab`, which requires that button to still be
down on that seat). Direct injection mints its serials from the display counter
and writes to the client's own resources, so seat0 never saw the press: the drag
is silently cancelled (`DragAndDropInputFilter` falls through to
`source->dndCancelled()`) and the move request is dropped
(`implicitGrabPositionBySerial` returns nothing). The agent seat holds a real
grab but KWin's single drag filter listens only to `waylandServer()->seat()`, so
a drag started there reaches nobody, and a titlebar move would anchor at
`input()->globalPointer()` — the human's cursor.

Every mechanism that would fix this drives the human's seat or their cursor,
which is precisely what the dedicated seat exists to avoid, so all of them are
refused. Press-move-release pointer drags are unaffected on both paths and are
what `computer_drag` does (text selection, sliders, canvas strokes, in-client
resize handles); only the protocol-level DnD handshake is out. Between windows,
use the application's keyboard-driven equivalent — cut/copy and paste, a
"Move to…" action, a file dialog. Windows are moved by asking the compositor,
not by dragging their titlebar.

**Xwayland's own menus are not pointer targets.** An X11 client's menus are
override-redirect windows, which KWin models as unmanaged `X11Window`s that
answer `isClient()` false, and every targeting predicate here starts there. A
click aimed at one lands on whatever it is drawn over. Wayland-native menus,
including Chromium's and Electron's, are `xdg_popup`s and are targetable.

## Build (Fedora KDE)

Dependencies:

```sh
sudo dnf -y --setopt=install_weak_deps=False install \
  cmake ninja-build extra-cmake-modules kwin-devel kf6-kcoreaddons-devel \
  kf6-kglobalaccel-devel qt6-qtbase-devel libepoxy-devel libdrm-devel
```

Build, install, unload older Synara plugin ids, load the new versioned id, and
print `healthJson`:

```sh
apps/server/native/computer-use-kwin/scripts/install-and-load.sh
```

The installer keeps its build cache under `~/.cache/synara/` and its signature
under `~/.local/state/synara/`. It uses `sudo install` for the root-owned KWin
plugin directory. Use `--force` when you deliberately want another versioned
load of the same source and KWin build. `--noninteractive` is for the systemd
unit and uses `sudo -n`.

For a compile-only build that does not install or load anything:

```sh
cmake -S apps/server/native/computer-use-kwin \
  -B /tmp/synara-kwin-infra-build \
  -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build /tmp/synara-kwin-infra-build
```

Verify (read-only, does not act on the desktop):

```sh
busctl --user call org.synara.ComputerUse /org/synara/ComputerUse \
  org.synara.ComputerUse1 healthJson
```

Unload:

```sh
busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins UnloadPlugin s SynaraComputerUsePluginV1
```

The loaded id is normally `SynaraComputerUsePluginV1`, `V2`, and so on. The
installer (and the server backend) query the `LoadedPlugins` property on
`org.kde.KWin.Plugins` — on KWin 6.7 the loaded-plugin list is a property, not
a method, and `UnloadPlugin` returns void rather than a boolean. Both fall back
to a `loadedPlugins` method for KWin variants that expose one; if neither
exists, the installer tries the base id and every matching installed versioned
filename. To unload and remove every installed Synara plugin file, use:

```sh
apps/server/native/computer-use-kwin/scripts/uninstall.sh
```

## Version stamping

CMake generates a private build header containing the Git short hash, the UTC
configure timestamp, and the KWin package version found by `find_package(KWin)`.
`healthJson` keeps all of its original fields and adds:

- `build`: `<git-short-hash>-<UTC-build-timestamp>`
- `gitHash`: the short Git hash used by the configure step
- `buildTimestamp`: the UTC timestamp from that configure step
- `kwinVersion`: the KWin version compiled against

The `healthJson` `capture` field is true only when KWin has an effects handler,
OpenGL compositing is active, and an OpenGL context is available. It does not
depend on whether `start()` has been called.

When KWin's workspace is available, `healthJson` also includes
`workspaceGeometry` with `x`, `y`, `width`, and `height` fields. Consumers can
use that geometry when no client windows are currently enumerable.

`healthJson` also carries the session-lifetime fields the server needs on its
existing poll: `idleTimeoutMs`, `releasedByUser`, and `releaseShortcut`.

The build identifier is diagnostic data. The plugin filename carries the reload
identity because KWin can keep a shared library mapped after `UnloadPlugin`.

## Versioned plugin filenames

The installer writes the first changed build as
`SynaraComputerUsePluginV1.so`, then scans the KWin plugin directory and uses
the next higher `Vn` filename for a later changed build. It never overwrites an
older version. This is required on Wayland: unloading a plugin destroys its
instance, but KWin can still return the old mapped library when the same plugin
id is loaded again.

The installer records the source and KWin signature. Repeating it with the same
signature reuses the installed id, so the periodic systemd check does not create
an unbounded stream of identical plugin files. A source change, KWin upgrade,
or `--force` creates a new versioned id.

The plugin metadata sets `EnabledByDefault: false`, so KWin does not load any
installed version at compositor startup; only an explicit `LoadPlugin` (from
the installer or the server backend) loads one. With auto-load, every installed
version came up at startup and the oldest registrant won the
`org.synara.ComputerUse` bus name, shadowing the newest build — builds stamped
before this change still auto-load until they are uninstalled.

## KWin ABI

A binary KWin plugin must be built against the exact running KWin version. KWin
refuses to load a plugin whose embedded `PluginFactoryInterface<version>` does
not match. The factory IID comes from the installed `kwin-devel` headers, and
the generated health fields record the KWin package version used at configure
time. Rebuild after every KWin upgrade. The installer reports a clear error for
KWin's `has mismatching plugin version` refusal.

## Reload caveat (dev loop)

KWin never unloads a plugin's shared library. `UnloadPlugin` destroys the
plugin instance, but reloading the same plugin id serves the still-mapped old
binary, so a rebuilt `.so` under the same name silently does nothing. On
Wayland, KWin is the session, so restarting the compositor is not an option.
During development, install each rebuild under a versioned filename
(`SynaraComputerUsePluginV2.so`, `V3`, ...) and load that id instead.

## Automatic rebuild after KWin upgrades

`systemd/` contains a user service, a path unit, a periodic timer, and an
`enable.sh` helper. The path unit watches the stable `/usr/lib64/libkwin.so*`
symlinks and KWin CMake package files. The timer checks every six hours. The
installer also includes the KWin RPM query and library metadata in its
signature, so an unchanged system is a no-op.

The units are install-ready but are not enabled or started by this source tree.
To opt in later, run the helper from the repository root:

```sh
apps/server/native/computer-use-kwin/systemd/enable.sh
```

The helper enables the path and timer without starting either one. The service
passes `--noninteractive`, so unattended installation needs a narrow sudo rule
for the plugin copy or another policy that permits `sudo -n install`.

## Provenance

Seeded from a proven prior implementation in the sibling `Androdex-Desktop`
project by the same author, then renamed to Synara and updated for KWin 6.7.3
(the `ItemRenderer::createImageItem()` factory was removed upstream; `ImageItem`
now has a public constructor).
