# Device Pane (iOS Simulator) — Feature Spec

Status: agreed design, pre-implementation. Branch: `feat/ios-simulator-pane` (off `upstream/main` @ fcf24599). Ships as one complete feature PR.

## Goal

A fully interactive iOS Simulator pane in Synara, on par with Claude Code Desktop's simulator pane: the agent can boot devices, install/launch apps, tap/type/read the screen; the user watches a live video stream in a right-dock pane and can drive the same device by clicking, typing, and pressing hardware buttons. macOS only. Contracts are provider- and platform-agnostic ("device") so Android emulators can plug in later without schema breaks.

## Non-goals (v1)

- Android emulators (design for them, don't build them).
- Physical devices.
- Screen recording to file; stream quality knobs (fps/resolution/encoding toggles).
- Wrapping xcodebuild — building stays in the agent's shell.
- Swift-file-detection heuristics for surfacing the pane.

## Architecture decisions (resolved via grill session)

| Decision            | Choice                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display engine      | Headless CoreSimulator: private-framework Swift helper reads the device IOSurface. No Simulator.app dependency, no macOS Screen Recording/Accessibility permissions.                                                                                                                                                                                                  |
| Input               | Same helper injects HID events (touch, keys, hardware buttons) via SimulatorKit private APIs. Pane sends per-key HID; agent `device_type` uses bulk text entry synthesized in the helper.                                                                                                                                                                             |
| Helper distribution | Compile on-device at first attach with the user's Xcode toolchain; cache keyed by Xcode version (e.g. `~/Library/Caches/synara/device-helper/<xcode-build>/`). Compile failure is a designed error state in the pane. References: Codex++ `sim-capture.swift`/`sim-input.m`, Meta's idb.                                                                              |
| Frame pipeline      | Helper hardware-encodes H.264 via VideoToolbox → NAL units over local socket to server → binary messages on the existing WebSocket (tagged header: deviceId, ts) → WebCodecs VideoDecoder → canvas. Backpressure: drop frames when slow, keyframe re-sync; must never starve RPC traffic.                                                                             |
| Engine home         | `apps/server` owns DeviceManager + helper lifecycle + MCP server (desktop-optional; works in plain browser tabs). Contracts become real schemas in `packages/contracts` since they cross the WS boundary. Gated on darwin.                                                                                                                                            |
| Abstraction         | Generic `device` contracts: `DeviceState { platform: "ios-simulator", udid, name, runtime, state, bootSource }`. `DeviceBackend` interface with one iOS implementation. Pane kind `"device"`. UI copy says "iOS Simulator" where it matters.                                                                                                                          |
| Agent control       | Local MCP server registered per-session into provider configs. Tools: `device_list`, `device_boot`, `device_install`, `device_launch`, `device_open_url`, `device_tap`, `device_swipe`, `device_type`, `device_press_button`, `device_screenshot`, `device_describe_ui` (accessibility tree: labels, roles, frames).                                                  |
| Provider coverage   | Target all 9 providers; audit each provider's per-session MCP path during implementation. If a provider genuinely has no workable MCP hook, it ships pane-only (user can watch/tap; agent falls back to shell simctl) — best-effort all 9, not release-blocked.                                                                                                       |
| Consent             | Ride existing per-provider tool-approval flows. Read tools (screenshot/describe) default-allowed; input tools prompt until always-allowed; `device_open_url` always goes through approval (exfiltration vector). No new consent subsystem.                                                                                                                            |
| Lifecycle           | Thread-scoped attachment (mirrors ThreadBrowserState). Synara-booted devices shut down on app quit, thread archive, or idle timeout after detach. User-booted devices (pane picker or Simulator.app) are never auto-shutdown. Cap Synara-booted devices at 3 globally; boot requests beyond that prompt to shut one down. Viewing already-booted devices is uncapped. |
| Build story         | Agent builds via its own shell (xcodebuild/tuist/whatever). MCP `device_install`/`device_launch` are the integration points; a launch through MCP auto-opens the pane on that thread.                                                                                                                                                                                 |
| Open triggers       | Auto-open on agent install/launch (requestOpenPanel-style push). Manual: "Device" entry always in the right-dock add menu on macOS, plus a `device.toggle` keybinding command. Off-macOS: entry hidden entirely. On Mac without Xcode/runtimes: pane opens to a live setup checklist (install Xcode → install iOS platform → attach), items check off as completed.   |
| Pane UX (v1)        | Click=tap, drag=swipe, keyboard passthrough; hardware buttons with Simulator.app shortcuts (Cmd+Shift+H Home, Cmd+L lock, Cmd+↑/↓ volume); no rotate — see below; device picker showing runtime + boot state, boot-on-select; attach/detach/shutdown; screenshot save; "Agent is using this device" badge while MCP input tools are active.                           |
| Prompt nicety       | browserPromptContext-style: mentioning the simulator in the composer attaches a `device_screenshot` PNG.                                                                                                                                                                                                                                                              |
| Testing             | Fake `DeviceBackend` for Vitest coverage of manager state machine, MCP handlers, frame framing, pane logic (runs in normal CI). Helper gets a standalone smoke CLI (capture N frames, inject tap, dump AX) via `bun run test:device`, run on a real Mac before release, documented, not in PR CI.                                                                     |
| Upstream            | One complete feature PR from `aristotl-dylan/synara`, feature-complete end to end.                                                                                                                                                                                                                                                                                    |

## Rotation is unavailable (and why)

The pane ships no rotate control. A headless CoreSimulator device cannot be
turned, and rotating only the pane's picture is worse than not offering it: the
guest keeps composing a portrait frame, so the app inside ends up lying on its
side inside a landscape chassis, with its own status bar and Dynamic Island on
the wrong edge. That reads as a broken pane rather than a rotated phone.

What was probed, so this is not re-litigated:

- `simctl` has no orientation subcommand. `simctl ui` covers only `appearance`,
  `increase_contrast`, and `content_size`.
- CoreSimulator exports zero symbols matching `orientation` or `rotate`, and a
  booted `SimDevice` responds to none of `gsEventsSendOrientation:`,
  `sendPurpleEvent:`, or `setOrientation:`.
- SimulatorKit has `SimScreenUIOrientation` and
  `SimDisplayUIOrientationChangeDelegate`, but they are notification-side: they
  report the orientation a display is in, with no setter.
- Simulator.app rotates through `SimDevice(GSEventsPrivate)`, a category _it_
  adds, which posts a Purple event to `PurpleWorkspacePort`. That category is
  compiled into the Simulator executable, not into CoreSimulator, so it does not
  exist on a headless boot.
- Loading the Simulator executable with `dlopen` does register the category, and
  `gsEventsSendOrientation:` can then be called against a headlessly booted
  device without error — but it is a silent no-op. Verified against a booted
  iPhone 17 Pro running Safari (an app that does rotate): the framebuffer stayed
  1206x2622 and a pixel diff of before/after screenshots was empty for every
  orientation value. The Purple port is only wired when Simulator.app owns the
  device.

If rotation is wanted later, the paths are driving Simulator.app itself (giving
up the headless, permission-free design the pane is built on) or an
accelerometer event through `IndigoHIDMessageForDeviceMotionLiteEvent`, which is
unexplored and would rotate only apps that honour device motion.

The shell geometry keeps its landscape support (`resolveDeviceShellMetrics`
takes a `landscape` flag and is tested in both orientations), so the drawing
side is ready if a real orientation path ever appears.

## Integration map (existing code to follow)

- Dock pane registration: `apps/web/src/rightDockStore.logic.ts` (`RIGHT_DOCK_PANE_KINDS`), `rightDockPaneMeta.tsx`, `SingleChatSurface.tsx` `renderDockPane`, lazy panel via `ChatThreadSurfacePrimitives.tsx`.
- Auto-open flow: browser's `requestOpenPanel` (`apps/desktop/src/main.ts:407` → `useBrowserPanelDesktopBridge.ts`) — but routed via server WS push since the engine lives in apps/server.
- Setup/unavailable states + platform gating precedent: AppSnap (`contracts/src/ipc.ts:339-406`, `appSnapManager.ts`).
- Prompt screenshot: `apps/web/src/lib/browserPromptContext.ts`.
- Thread-scoped state shape: `ThreadBrowserState` in `contracts/src/ipc.ts`.
- MCP per-provider registration: provider session config in `apps/server/src/providerManager.ts` + per-provider adapters (audit target).

## Risks

1. Private CoreSimulator/SimulatorKit APIs shift across Xcode releases — mitigated by on-device compilation and the smoke CLI; Codex++/idb sources are the living reference for symbol churn.
2. H.264-over-WS starving RPC — needs framing-level backpressure tests with the fake backend.
3. Provider MCP audit may surface providers needing the pane-only fallback; document per-provider status in the PR.
4. Single large PR into a fast-moving upstream — keep the branch rebased frequently; feature is additive (new files + small registration diffs) to minimize conflict surface.
