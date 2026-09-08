# Independent Cua readiness and Space-pause review

Read-only source review of current adapter/protocol against `/private/tmp/synara-best-integration/before`; no native input, capture, build or test execution. Native revision 2 implementation was still in progress at the first pass.

## Current adapter and host result

No must-fix regression found in the changes inspected.

- `apps/server/src/computer/CuaComputerBackend.ts:177-183`: readiness is a read-only native RPC after fresh exact-window selection. Success requires `ready === true` and the matching numeric PID/window ID; absent, false or wrong-target success is refused.
- `CuaComputerBackend.ts:98-107`: only native structured `effect: refused` plus `target_not_on_active_space` becomes a recoverable input pause. A generic exception after mutation remains `dispatched-unknown`; constructor line 10 does not attach pause to unknown effects.
- `CuaComputerBackend.ts:259-268`: latest window inventory supplies the visibility/Space gate and geometry checks before dispatch. The new drag `preparedBounds` check prevents capture-to-admission movement from silently changing the coordinate frame.
- `CuaComputerBackend.ts:270-284,313-328`: pointer preparation still re-captures/validates exact identity and scale; point and drag calls now forward expected global window bounds into native admission. Foreground approval and the existing 10-second drag limit remain intact.
- `CuaComputerBackend.ts:283-288`: caches are invalidated in `finally`, including errors that may follow partial input. No retry was added.
- `packages/shared/src/cuaDriverProtocol.ts:81`: readiness is allowlisted in reads, not actions. Independent subreview confirmed `apps/desktop/src/cuaDriverHost.ts` is unchanged: capability authentication, method allowlist, serialized queue/epoch checks, owned-session override, cancellation retirement and exact-PID cleanup acknowledgement remain in force.

## Evidence and final parity checks

Observed existing log `/private/tmp/synara-best-integration/cua-adapter-tests.log` records 24 passing adapter tests. I inspected the new test bodies rather than rerunning them. They cover exact readiness success/wrong ID/false reply, invisible target pause with continued observation, native refusal versus uncertain transport effect, and a drag moving after capture.

Useful focused additions before finalizing: native readiness Space-refusal mapping through `checkInputReady`, and successful approved drag forwarding its captured expected bounds. The existing move test proves refusal but not the successful drag argument shape.

Still required: independent inspection of completed native `check_input_ready` implementation and per-action/per-event guards; exact method/argument/result/error-code parity; guard failures after prior posts must not become `effect: refused`; no side effects in the readiness read; native revision/artifact handshake published atomically with the method. At initial inspection release metadata was revision 1 and the native method was not yet present; that is expected active work, not a completed-state defect.
