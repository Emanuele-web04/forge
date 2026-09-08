# Independent revision 2 native/adapter audit

Result: no outstanding must-fix in the reviewed source at the final checkpoint. Two concrete integration defects found during review were corrected before this verdict: missing readiness authorization classification, and foreground activation boundaries that initially bypassed the new target guard.

This was a read-only review. I did not execute native input, capture, builds, or tests. Full crate paths below are relative to `/private/tmp/synara-best-integration/native/patched/libs/cua-driver/rust/`. Short `input/`, `tools/`, and `windows.rs` references are under `crates/platform-macos/src/`; SDK `runtime.rs` is under `crates/cua-driver-sdk/src/`. Synara paths are explicitly identified. The review does not replace the native owner's compilation/package checks or live qualification.

## Corrected findings

1. `crates/cua-driver-core/src/authorization.rs:872` now classifies `check_input_ready` as reviewed R0. Without this entry, the actual authorization boundary at 1135 rejected the newly registered tool even in unrestricted mode. Lines 1166–1181 preserve exact window grants for restricted manifests; line 1212 preserves self-process protection. Tests at 1562–1610 invoke actual authorization, covering unrestricted admission, exact versus wrong PID/window, denied/undeclared tool rules, and self-process refusal.
2. Foreground boundaries now participate in target admission: `crates/platform-macos/src/input/skylight.rs:615–617,653–665,743–759,839–863,917–932` and `crates/platform-macos/src/tools/bring_to_front.rs:184–186,349–374`. The exact bring-to-front branch also no longer explicitly requests activation of all sibling windows. Midsequence failures are conservatively uncertain.

## Admission, Space invalidation, and cleanup

- `input/target_guard.rs:80–180` validates positive exact identity, optional finite observed bounds, current owner, visibility, active Space membership, display Space identity, and the captured Space epoch. Each later verification reads current metadata. `windows.rs:338–348` requests the exact layer-0 window's metadata without capture or input.
- `input/target_guard.rs:197–224` installs one process-lifetime Space notification observer. It increments an epoch and invalidates only the currently active exact-target operation. It does not retire the entire input generation.
- `input/cancellation.rs:38–73,105–131` checks current target state before new posts/down events and after interruptible pauses. `81–101` rejects overlap with an active exact-target operation. The final action lease clears temporary invalidation at `162–170`.
- Matching releases bypass all admission checks: `HeldInput::drop` at `179–187` calls the already prepared release closure even after retirement or Space invalidation. Tracing mouse and keyboard release callees found no recursive gate acquisition. `press` declares its held owner before locking, so Rust unwind releases the mutex before the matching release runs.
- Guard closures added to foreground activation contain only raw OS/binding calls. They finish before helpers that acquire the gate are invoked, so the reviewed wrappers do not introduce nested-lock deadlocks. `skylight.rs:672–682` adds RAII prior-focus restoration on success, returned error, and unwind; restoration uses raw calls outside target admission. Persistent `bring_to_front` intentionally leaves focus changed.

## Lifetime and result protocol

- `crates/cua-driver/src/sdk_adapter.rs:146–220` prepares an exact target before dispatch and returns structured `effect: refused` for initial admission failures. Expected bounds are removed from public native arguments only after they are retained by the target lease. The lease remains alive through the awaited driver call and projection at `262–305`.
- The embedded path continues through `cua-driver-sdk/src/lib.rs:1594–1607`, `runtime.rs:296–331`, and `cua-driver-core/src/tool.rs:1538–1543`. There is no mutation timeout or cancellation select that drops this awaited native operation early in the reviewed path.
- `cua-driver/src/serve.rs:1230–1235` awaits an invocation before processing connection EOF. Embedded host EOF/shutdown drains native held owners plus operations at `1456–1479` before aborting connection tasks. This keeps an async lease alive while its blocking native worker completes matching releases and restoration.
- `tools/check_input_ready.rs:23–31` executes only the read-only metadata readiness helper. Its success is exact `{ready:true,pid,window_id}`; failure is `{ready:false,effect:"refused",code,...}`. The host-owned `session` argument survives the current registry path safely: the invocation parses needed fields and there is no generic JSON-schema rejection of that added session field.

## Semantic no-replay audit

- `input/ax_actions.rs:111–151` advances to another ancestor only for `NotAttempted`. Once `AXSelected` is submitted, success plus true readback confirms it; errors or ambiguous readback terminate the action.
- `tools/click.rs:1242–1380` uses a coordinate fallback only when prior capability checks caused no semantic mutation. A submitted `AXPress` is terminal. `1193–1201` conservatively upgrades an error after foreground preparation to uncertainty.
- `tools/set_value.rs:311–388` chooses exactly one string/numeric/stepping route from read-only facts. A failed value write does not switch routes. The stepping path at `527–584` admits another step only after successful dispatch and finite observed progress in the correct direction; cancellation after an earlier step is uncertain. The popup path at `588–634` requires an exact AX child and does not use an unrelated browser document.
- `set_value.rs:203–207,231–248` exposes confirmed `value_readback` evidence only when the value is actually verified and the target is not a web AX echo surface.
- Scope matters: Synara still forces synthetic typing. The unused upstream default `type_text` AXSelectedText-to-CGEvent ladder remains in native source; revision 2 should not be described as removing every fallback from all raw upstream APIs.

## Synara adapter and verification evidence

The separate `adapter-readiness-independent-review.md` covers initial adapter review. Final sources additionally include both requested tests: native readiness off-Space refusal mapping and successful foreground drag forwarding the exact expected bounds. The observed `/private/tmp/synara-best-integration/cua-adapter-tests.log` now records 26 passing tests; I inspected test bodies and read the log without rerunning them.

Synara `apps/server/src/computer/CuaComputerBackend.ts:98–107` maps only proven native refusal to not-dispatched, and attaches recoverable Space pause only to that class. Unknown mutation failures remain dispatched-unknown and never replay. Readiness checks exact returned identity at `177–183`. Pointer/drag paths forward observed expected bounds at `284,313–328`; stale observations and uncertain results invalidate caches. Host capability authentication, read/action allowlists, queue generation checks, owned-session override, retirement acknowledgement, and cleanup barriers remain intact.

## Limits of this verdict

Static source review cannot prove atomicity between an OS state check and the following OS call, timely WindowServer/AX completion, native permission behavior, or equivalent RAM/performance. No new live fixture/RSS evidence was generated by this review. Prior-process restoration remains conditional on successfully capturing the previous process. Native artifact revision/hash/architecture publication and current-head build evidence remain the owning integration task's release checks.

Final activation source hashes:

- `input/skylight.rs`: `109622f483094fa68615268cf6628d29e294a16585a8db7b3df7d38db60bdd3d`
- `tools/bring_to_front.rs`: `612b36a8aea94e2ee8544d1d6aeb6accc0c10860948856cd1f73ab60732d8556`
