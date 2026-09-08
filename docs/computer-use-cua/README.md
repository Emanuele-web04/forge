# Native Computer use through Cua

This worktree implements a single macOS backend using the pinned `cua-driver` executable on the existing desktop. Synara retains its provider gateway, approval policy, thread ownership, observations and Computer UI. No Cua agent framework, Cua VM, Swift input actuator, second production backend or automatic fallback is included.

**Status: selected improvements from refreshed PRs #822/#1010 are integrated, and the requested full repository checks pass.** See the [final checks and comparison](final-checks-and-comparison.md) and [integration record](integration-refresh.md). The earlier native revision 1 passed the owned background/foreground fixtures and the real Codex/provider-to-approval-card-to-native click path: 19 assertions passed, with two expected multiwindow keyboard refusals and a 307.84 MiB driver peak. Those results belong to that recorded artifact; they do not qualify a later native revision automatically. The cooperative cleanup and bounded cursor mailbox remain in the implementation. Simultaneous human input, wider application coverage and the production host lifecycle remain unqualified. [qualification.md](qualification.md) preserves the revision 1 evidence and its limits.

The [initial completion audit](completion-audit.md) maps the revision 1 requirements to its evidence. Its historical test counts overlap and are not a repository-wide total. Current refresh checks are listed separately in [integration-refresh.md](integration-refresh.md).

## Provenance

- Base: `8599826d75d9932e69c301f2441f585da8f211e2` (v0.8.3).
- Shared foundations were selected from the reviewed #820, #821, #822 and #1010 heads. [import-provenance.json](import-provenance.json) records the exact heads and imported paths. Those files were then modified locally; this manifest is not a claim that they remain identical to the source PRs.
- Driver: `cua-driver 0.24.0`, source `4b3396d9fe4bd3cf723b0eb8db83c18a8764b520`.
- The current native revision and patch checksum are pinned by [the shared release manifest](../../packages/shared/src/cuaDriverRelease.json), using Rust `1.97.1` and [the checked-in native patch](../../apps/desktop/patches/cua-driver/0001-synara-native.patch).
- The source, upstream archive checksum, patch checksum and toolchain are defined once in `packages/shared/src/cuaDriverRelease.json`. The original release binary is no longer accepted: it lacks the required cancellation protocol. The redistribution license is [CUA-LICENSE.txt](CUA-LICENSE.txt).
- The historical revision 1 fixture artifact, before app signing, has SHA-256 `a972aa860beb4b9c4572675796ebc6e628dcd80cc0b91269384c4812cc8e2336`; [provenance](evidence/native-revision1-provenance.json) records both architectures and that patch checksum.

No branches, commits, pushes, PR changes, merges, published artifacts or deployment were made by this implementation task.

## Responsibility boundaries

```text
Codex / Claude tool request
  → provider gateway: session capability, approval, owner and delivery mode
  → ComputerManager: current authority, turn lease, targeting, serial operation
  → CuaComputerBackend: native protocol, geometry and effect translation
  → authenticated local socket
  → Electron CuaDriverHost: child lifetime and generation retirement
  → pinned cua-driver: native observation / action
```

The GUI process creates a private directory (`0700`) and socket (`0600`). The backend receives the host capability through the existing private descriptor handoff; a socket pathname or claimed bundle identifier does not confer authority. The broker checks the capability and native tool allowlist before dispatch. Requests and responses are bounded, preserve fragmented UTF-8, and use one request per connection.

Electron starts Cua as an embedded child with a private native socket, telemetry disabled and stdin liveness enabled. The handshake verifies version, native revision, embedded mode and child PID. Native reads and writes are serialized. Stop, timeout or active connection cancellation closes native input admission and asks the exact generation to drain registered input releases and action contexts. The host retires it only after a valid cleanup acknowledgement; replacement awaits its exit. Missing or invalid acknowledgement keeps replacement blocked and does not authorize a kill. Native EOF drains the same gate. A process crash or external SIGKILL cannot offer cooperative cleanup.

Desktop backend shutdown additionally suspends host admission. Requests arriving during or after that drain cannot start another native generation while the old server exits. Admission resumes only when the desktop starts a backend again; failed cleanup remains a barrier even after resume. Ordinary turn Stop keeps its existing reusable behavior.

macOS attributes permissions through the actual process responsibility chain. `CUA_DRIVER_HOST_BUNDLE_ID` describes the host but cannot impersonate it. The standalone server reports that the macOS desktop app is required when no authenticated GUI host exists.

## Authority and approvals

- Computer control is disabled by default for new conversations. Enabling it provisions only supported provider sessions. The effective provider capability is removed when control is disabled or the provider changes.
- An explicit Computer choice survives draft promotion and page reload, including when no prompt remains. Both true and false are preserved; clearing the thread draft normally still removes its choice.
- One thread/turn lease owns agent input. Terminal events from a child turn do not release its parent's lease. Background approvals retain their owner when the foreground turn completes.
- Computer off revokes current and queued authority. A rapid off/on cannot revive operations submitted before revocation. Enabling waits for an earlier Stop; the UI ignores stale toggle responses.
- Archiving/removing a thread revokes authority and performs cleanup. Restoring it preserves a separate explicit user opt-out.
- Codex and Claude approvals keep callback and durable ownership aligned. Cancel targets the owning turn. Native approval values accept the scalar and array forms used by provider responses.
- Foreground operations always require explicit per-action approval, including in full-access conversations. A background refusal is never promoted to foreground or replayed automatically.

The local capability is a boundary against provider subprocesses inheriting authority accidentally. It is not a sandbox against arbitrary same-user malware with access to the GUI host's memory or filesystem.

## Native behavior and limits

| Operation                       | Current behavior                                                                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window observation              | Returned PID/window ID is verified; exact capture identity survives schema and screenshot-ID registration. AX elements and window screenshot use a bounded tree. Zero-area WindowServer placeholders are ignored.                                                          |
| Pixel actions                   | Screenshot pixels are mapped through the observed frame. The fresh preparation capture must also match the requested PID/window ID; bounds and point containment are checked before dispatch.                                                                              |
| Click / text / keys             | Explicit exact-window target; background by default. Coordinate clicks and text select synthetic delivery before submission. The native click recipe is chosen from process metadata; an event uses one transport. Native policy may refuse a target; no automatic replay. |
| Multiple windows of one PID     | Cua may refuse background keyboard input as `same_pid_keyboard_ambiguity`; the adapter returns `not-dispatched`.                                                                                                                                                           |
| Semantic actions                | `set_value` uses the element token from the observation. `perform_action` supports AXPress only. No synthetic semantic fallback.                                                                                                                                           |
| Drag                            | Explicit foreground mode, bounded to ten seconds. Native release guards cover drag; the owned foreground fixture verifies Stop after real movement, matching mouse up and no later movement.                                                                               |
| Scroll                          | One axis, no modifiers; quantized to Cua's 120-pixel wheel notches, at most 50. No corrective replay inferred from uncertain read-back.                                                                                                                                    |
| Cursor                          | Agent cursor overlay; it does not promise a real hover or independent human focus.                                                                                                                                                                                         |
| Capture                         | Exact-window screenshots; primary-display overview. The macOS tool schema omits rectangle arguments, and native region capture is refused. Mixed-scale and secondary-display coverage remains unqualified.                                                                 |
| Clipboard / launch / activation | Provider approval and authority apply. Activation additionally requires foreground approval.                                                                                                                                                                               |
| Other platforms                 | No native Computer backend is supplied by this change.                                                                                                                                                                                                                     |

Effects are explicit: `not-dispatched` means no input was submitted; `dispatched-unknown` means input may have happened; `verified` requires an established native verification result. Native structured admission refusals (`effect: "refused"`) map to `not-dispatched`. An unchanged screenshot, native no-op suspicion, exception or timeout does not justify retrying an action.

A window's `focused` flag means the agent-selected input target. It does not establish that the window became frontmost. The optional `active` flag describes native activation; absence means unknown.

The bounds check and final native injection are separate operations. A window can still move in that interval. Cua also uses native/private platform mechanisms; a wrapper cannot turn these into atomic targeting or isolation from concurrent human activity.

## Observation cost

Shared physical observations are coalesced instead of repeated for every thread. Thread ownership/activity publications remain lightweight. The detached Computer pane performs no still capture. An attached pane requests at most one still every two seconds and can reuse a recent overview. Transport drain delivers queued stills without requiring a new publication, and independent-image recovery is separate from video configuration recovery.

Tool actions may still perform multiple captures: Synara validates the target frame and Cua performs its own verification. This cost is visible in fixture timings. The native cursor keeps one replaceable pending bitmap and one queued presentation callback, and transfers bitmap storage to CoreGraphics without another full-screen copy. The historical revision 1 peak of 307.84 MiB and the earlier 3304.23 MiB peak cover different workloads; they are not a normalized benchmark or measurements of revision 2. The refresh additionally removes retained diagnostic image copies and suspends hidden-pane frame work. No measured whole-application RAM advantage over Swift has been established.

## Build and setup

Provision the pinned executable into ignored desktop resources before running the desktop app:

```sh
node apps/desktop/scripts/provision-cua-driver.mjs --arch universal
# Build the pinned commit from a local checkout, using cached dependencies:
node apps/desktop/scripts/provision-cua-driver.mjs --source-checkout /path/to/cua --arch universal --offline
# Reuse a previously built artifact and its verified provenance:
node apps/desktop/scripts/provision-cua-driver.mjs --artifact-dir /path/to/artifact --arch universal
```

The script archives the exact source commit, verifies and applies the patch, and builds with the pinned Rust toolchain and Cargo lockfile. Rust and Apple build tools are build-time dependencies only. Artifact reuse verifies identity, patch, binary checksum and Mach-O architectures; desktop packaging accepts the same directory through `SYNARA_CUA_ARTIFACT_DIR`. Packaging places the executable outside ASAR and includes it in signing. The recorded binary checksum precedes app signing. Production signing/notarization was not performed here. See [native build details](../../apps/desktop/patches/cua-driver/README.md).

Launch the actual Synara GUI bundle. In Settings → Computer use, select Set up and grant Accessibility and Screen Recording to that bundle, then fully quit and relaunch it. The driver needs no separate permission entry and the installed feature does not require Xcode. An ad-hoc rebuild changes the code identity: stale TCC grants can require removing/re-adding that exact test bundle. Do not reset unrelated applications' grants.

## Reproducible fixtures

`scripts/computer-use-fixtures/build-electron.mjs` builds the isolated ad-hoc `Synara Cua Fixture.app` under `/private/tmp/synara-cua-implementation/`. Its Electron controls and AppKit child report application-owned click/text state. The AppKit executable is a test target only; all injected input still comes from Cua. The local fixture builder uses the installed Command Line Tools compiler and macOS 26.5 SDK; that requirement does not apply to Synara's runtime or ordinary packaging.

Install a copy in `~/Applications`, preserve any earlier fixture build, register/launch that copy through LaunchServices and grant only its two required permissions. Running `Contents/MacOS/Electron` directly from a terminal can attribute Screen Recording to the terminal host instead.

```sh
open -n -W -a "$HOME/Applications/Synara Cua Fixture.app" \
  --env SYNARA_CUA_FIXTURE_DIR=/private/tmp/synara-cua-implementation/fixture-run \
  --env SYNARA_CUA_FIXTURE_LIVE= \
  --env SYNARA_CUA_FIXTURE_FOREGROUND= \
  --env SYNARA_CUA_FIXTURE_FOREGROUND_CANCEL=
```

Use a fresh output directory per run. The runner refuses input unless its exact window title, process PID and native window ID agree. It saves window-only screenshots, application state, individual case results and timings; it never intentionally types into personal applications. Missing grants stop the suite before input. Reports distinguish refusal, skipped work and failed assertions. Process exit by itself is not a passing suite.

Foreground cases are skipped by default. When covered by the operator's authorization, `--env SYNARA_CUA_FIXTURE_FOREGROUND=approved-once` opts into one replacement of a fresh fixture-owned seed with `foreground-ok` per run. Separately, `--env SYNARA_CUA_FIXTURE_FOREGROUND_CANCEL=approved-once` opts into interrupting one moving drag and one Shift-click in the owned target. Respect the authorized scope, including any explicit standing authorization for continued fixture testing. No fixture uses the clipboard. `scripts/computer-use-fixtures/sample-resources.mjs` records CPU/RSS for the exact fixture host and its native children for up to two minutes; pass a fresh output JSON path. `probe-native-cancellation.mjs` checks the private cancellation protocol without input or capture.

For a live provider/UI check, build the production web and server bundles, use a fresh directory, and set `SYNARA_CUA_FIXTURE_LIVE=1` plus `SYNARA_CUA_FIXTURE_SERVER=/absolute/worktree/apps/server/dist/index.mjs` on the same LaunchServices command. Keep both foreground flags empty. The fixture launches the real server on a temporary loopback port and records its URL in `live-report.json`. Its private proxy restricts capture to the owned window and admits at most one background click on its counter. Use the real UI to create an isolated thread, enable Computer, request that exact target and exercise the approval card. The fixture stops after twenty minutes or a graceful SIGTERM. This mode uses real provider credentials through the normal provider setup; it does not fabricate model output or approvals. [The live qualification](qualification.md#real-provider-and-approval-ui) records the tested scope and evidence.

Focused validation uses `bun run test`, never `bun test`. The user subsequently requested final checks: `bun fmt`, `bun lint` and `bun typecheck` now pass. [The final record](final-checks-and-comparison.md) documents the fixes, test scopes, warnings and remaining native qualification limits.
