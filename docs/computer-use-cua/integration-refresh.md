# Computer use integration refresh — 2026-09-08

**Follow-up:** the user subsequently authorized full checks. Formatting, lint and all seven workspace type checks now pass, with additional pane-cancellation and unarchive fixes. The [final checks and comparison](final-checks-and-comparison.md) supersede the initial verification status recorded below.

This refresh combines selected changes from [PR #822](https://github.com/Emanuele-web04/Synara/pull/822) at `bf70dfd0e7ee1e512a633da3cc6e814d2f791b0b` and [PR #1010](https://github.com/Emanuele-web04/Synara/pull/1010) at `32d62c28c39229a42f8d9f31b160bf61996e494a` with the existing Cua implementation. Those immutable heads were compared against the local source before integration. The original import history remains in [import-provenance.json](import-provenance.json).

There is still one native backend: Cua. Shared improvements were adapted to its actual capabilities. The refreshed Swift helper has capabilities that Cua does not yet implement, so this integration does not claim that either backend is better in every respect.

## What changed

| Area               | Integrated behavior                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Computer pane      | Hidden pages stop frame subscriptions and decode work. Resume restores dimensions even when the image size is unchanged. Pending clicks and wheel batches cancel on hide, navigation, detach and control-off. Double-clicks become one atomic command before entering the RPC queue. |
| Rendering          | ChatView subscribes only to availability changes. Snapshots reuse immutable window inventories. Activity updates avoid physical desktop reads.                                                                                                                                       |
| Pause and recovery | An exact-window off-Space refusal pauses further input. Reads remain available. Recovery requires a fresh scoped observation and native read-only readiness confirmation; it never repeats the refused action.                                                                       |
| Observation        | Conditional label/role/window waits yield between polls and recheck authority on each read. A post-action screenshot cannot silently switch to another application's window. Failed observation does not make completed input retryable.                                             |
| Scrolling          | Omitted targets inherit the screenshot window. Requests preserve at least half-frame overlap. Repeating image rows are treated as ambiguous. Cua still submits one quantized wheel dispatch; uncertain read-back cannot trigger correction.                                          |
| Retention          | Diagnostic queues, snapshots, logs and persistence strip inline image copies while model delivery retains its original image. PNG decoding and screenshot hashes reuse immutable inputs; idle state and socket interests have explicit cleanup.                                      |
| Socket lifecycle   | Computer events go to interested views. Stream retries retain interests, actual socket closure removes them, and exceeding 64 viewed threads falls back to broadcast without evicting live views.                                                                                    |
| Activity           | The pane reports short factual tool/runtime activity, including pending approvals. Child-turn events cannot replace the parent's activity or release its lease.                                                                                                                      |

The integration also closes local correctness gaps: calibrated scrolling now passes through the same pause/control gate, and detached asynchronous work cannot acquire fresh input authority after its original operation ended.

## Native revision 2

The release manifest and checked-in patch define the current native revision. The driver adds a side-effect-free `check_input_ready` tool, exact target/bounds admission, and current-Space invalidation during an action. Matching held-key/button releases remain permitted after invalidation or Stop. The authenticated cleanup acknowledgement and replacement-generation barrier remain in place.

Synara's exposed AXPress and set-value paths choose their actuator before writing. A failed or uncertain AXPress, selection, numeric write or increment/decrement does not trigger a second actuator. The untargeted Safari JavaScript fallback is removed. Text entry retains the adapter's forced synthetic route; this does not qualify every unused raw upstream tool path. Foreground activation remains subject to explicit action approval and final native target checks.

Native target checks and macOS delivery are separate operations. They reduce stale-target exposure but do not make input atomic against simultaneous human/window activity. A new Space change can still occur between the last check and an OS call. Unknown effects remain unknown and are not replayed.

## Preserved local guarantees

- Computer is off by default; an explicit choice survives draft promotion and reload.
- Turning Computer off immediately revokes provider capability, pending approvals and queued input. Rapid off/on cannot revive old work.
- Thread/turn ownership, child-turn filtering and archive/delete cleanup remain intact.
- Foreground input always requires its existing per-action approval, including in full-access sessions.
- Claude background approvals retain their callback owner until resolution.
- Screenshot PID/window/bounds identity, exact native effects, one-dispatch scrolling and native input-release tracking remain enforced.
- The existing cursor mailbox keeps one replaceable pending bitmap and one queued presentation callback.

No second production backend, automatic fallback to Swift, or unsupported hover/drag/capture capability was added.

## Verification and limits

The integration passed **412 tests in the combined server run**, **137 frontend tests** (including 11 real headless browser cases), **12 desktop host tests**, and the separate contract, socket-lifecycle and transport checks. The final activity-reactor change passed a focused 12-test rerun. Web, server and desktop production bundles build successfully, and the built server's dependency smoke check passes.

Native revision 2 passed **60 pure tests and 6 real control-plane cases** without desktop input or capture. Both Apple Silicon and Intel release slices compiled and were staged as one verified universal artifact. The patch reconstructs all 817 compiled source files exactly. Intel was compiled, not executed. The upstream duplicate CoreMediaBridge linker warning remains; both builds exited successfully.

The [verification ledger](evidence/refresh-2026-09-08/verification.json) records scopes, outcomes and evidence files; overlapping test runs are not added into an inflated total. [Native provenance](evidence/refresh-2026-09-08/native-provenance.json) records the pre-signing binary and patch hashes. [Source integrity](evidence/refresh-2026-09-08/source-integrity.json) verifies the preserved local safeguards, with this refresh's changed files recorded separately from the existing dirty worktree.

For the same 512 KiB sample image, retained ingress serialization decreased from **699,469 bytes to 475 bytes**, while the source image remained intact for the model. This measures one retained event, not application RSS. See [the measurement](evidence/refresh-2026-09-08/diagnostic-image-before-after.json).

The earlier live fixture, provider approval and RAM measurements in [qualification.md](qualification.md) apply to native revision 1. They do not qualify revision 2. Fresh signed-app native actuation, full provider-to-desktop qualification, long-running RAM/CPU comparison, mixed-display coverage and production signing/notarization have not been established by this refresh.

The initial integration did not run `bun fmt`, `bun lint` or `bun typecheck` because explicit authorization was then missing. The user's subsequent final-check request authorized them; all now pass. See the [final verification ledger](evidence/final-checks-2026-09-08/verification.json) for the current source and results.
