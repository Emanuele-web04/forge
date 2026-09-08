# macOS computer-use helper

A persistent Swift process serving newline-delimited JSON-RPC 2.0 over stdin/stdout. Diagnostics go to stderr. The server adapter is `apps/server/src/computer/MacComputerBackend.ts`; user setup and release qualification are described in [the macOS guide](../../../../docs/computer-use-macos-reference.md).

## Build and packaging

Run `bash apps/server/native/computer-use-macos/build.sh /tmp/synara-helper` from the repository root. This requires Xcode Command Line Tools and produces a host-native executable targeting macOS 12.3. ScreenCaptureKit screenshot capture is available from macOS 14; earlier systems use the capture fallback. A deployment target is not proof of runtime compatibility: see the release qualification matrix in the guide.

`node apps/desktop/scripts/build-computer-helper.mjs --arch universal --output /tmp/SynaraComputerHelper.app` builds arm64 and x86_64 slices, creates the helper app bundle and applies an ad-hoc signature. Release packaging nests the helper in `Contents/Helpers/Synara Computer Use.app`, signs it using the release identity, re-seals the containing app and notarizes the final bundle. The helper has no Electron entitlements.

The bundle identity and paths come from `packages/shared/src/computerHelperBundle.json` and `computerHelperPaths.ts`. The provisioner prefers an explicit packaged binary, then a cached source build, then compilation from the staged sources. Packaged builds marked as expecting a bundled helper fail if it is missing; they do not silently require users to install Xcode.

`--probe` writes one capability report and exits without starting the RPC server. `--request-permissions` is a one-shot permission request. Normal setup uses the live `request-permissions` method so the process requesting access is the process that needs it.

## Protocol

Each request is one JSON object followed by a newline:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": {} }
```

Replies correlate by `id` and may arrive out of order. A success has `result`; a failure has `error.code` and `error.message`. The TypeScript client validates replies, bounds pending requests, propagates deadlines and rejects outstanding work when the helper exits.

| Methods                                                                          | Purpose                                                                    |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ping`, `capabilities`, `request-permissions`                                    | Health, permission and private-symbol availability                         |
| `list-windows`, `screen-size`                                                    | Target inventory and desktop coordinate space                              |
| `describe-ui`                                                                    | Bounded accessibility tree, optionally scoped to a window or subtree       |
| `capture`                                                                        | Window or desktop-region PNG plus pixel dimensions and coordinate metadata |
| `launch-app`                                                                     | Launch an application                                                      |
| `move`, `click`, `double-click`, `triple-click`, `right-click`, `drag`, `scroll` | Pointer input addressed to a target window                                 |
| `type`, `press-key`, `hotkey`                                                    | Keyboard input addressed to the target process                             |
| `set-value`, `perform-action`                                                    | Accessibility value updates and semantic actions                           |
| `focus-window`, `clear-focus-window`, `raise-window`                             | Keyboard aim, clearing aim and checking that a window is revealed          |
| `read-clipboard`, `write-clipboard`                                              | Clipboard access                                                           |
| `set-agent-cursor`                                                               | Agent cursor overlay                                                       |
| `cancel-request`                                                                 | Cancel an action by `params.id` (notification, no reply)                   |

Wire parameters are defined in `Sources/main.swift` and mapped by `macComputerHelperClient.ts`. Shared tool contracts live in `packages/contracts/src/computer.ts`.

## Ordering and cancellation

Input and clipboard operations run on one serial queue. Perception runs concurrently; accessibility tree traversal has a separate serial queue. This allows health checks and cancellation to progress during a long action or capture.

`cancel-request` is handled on the stdin reader before queue dispatch. Actions register their cancellation token before entering the input queue and check it during lengthy input. Cleanup releases held keys and mouse buttons before finishing the request. At the server layer, a bounded desktop operation queue serializes the complete target/action/observation transaction. Releasing ownership cancels in-flight input, clears queued work and clears keyboard aim.

## Input and perception guarantees

- Window stacking comes from the on-screen WindowServer snapshot; the all-window snapshot only supplements it with minimized/off-Space windows.
- Target windows must belong to the requested process. Synara-owned windows and the helper overlay are excluded from targeting.
- Pointer coordinates use desktop points. Captures report their actual pixel extent and the mapping back to desktop coordinates; stale or incompatible frame metadata is refused.
- Input is addressed to a process and window. Routine actions never raise windows or activate another application. Synthetic active/key-window records go only to the target; the user's app is not deactivated. Unconfirmed clicks are not replayed. Foreground keycodes require the target to already be active.
- The agent cursor stays above its target between model calls while a thread owns control. Other windows cover it according to their stacking order; minimizing the target hides it, and restoring the target restores it. Releasing ownership hides it and stops visibility checks.
- Semantic value writes and actions move the agent overlay to the control within the same RPC. They do not inject a hover event that could change the accessibility tree.
- Background delivery is not supported by every application. A refused background route does not authorize activation, window rearrangement, or input into a different app.
- SkyLight symbols are resolved at runtime. Missing symbols become explicit capability failures. They are private macOS interfaces, so each supported OS release needs compatibility testing.
- Captures use ScreenCaptureKit where available, with a bounded, cached shareable-content lookup. The `screencapture` fallback checks image geometry. Multi-display composition handles negative origins, differing scales and gaps; host windows are masked from desktop captures.
- Accessibility traversal has node, depth and time budgets. Truncation and semantic action support are reported rather than inferred.
- Successful, validated captures clear stale negative preflight guidance for the current helper. Actual capture denial, an observed preflight revocation, or helper restart clears that evidence. The OS still enforces every capture request.
- Permission probes do not grant access. Accessibility and Screen Recording require the user's macOS consent. Passive server startup does not prompt or compile the helper.

## Tests

See [Tests/README.md](Tests/README.md) for synthetic capture tests and opt-in native perception/input integration tests. Ordinary Vitest suites cover queue ownership, aborts, helper failure/recovery, capability detection, provisioning, frame reuse, accessibility targeting and UI setup state. The scheduled `computer-helper-matrix.yml` workflow builds and probes the private symbols on available macOS runner versions; runners without desktop grants skip permission-dependent perception checks.
