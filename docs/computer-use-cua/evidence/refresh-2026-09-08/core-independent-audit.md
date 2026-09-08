# Independent combined-core audit

Read-only review of current `ComputerManager.ts`, `DesktopOperationQueue.ts`, `computerTools.ts`, `waitForControl.ts` and `waitForWindow.ts` against the saved pre-integration versions. Helper implementations were excluded because this reviewer authored their integration.

No additional actionable defect remains from this audit after the core owner's final guards.

The final admission guard reads the underlying inherited operation record, rather than `desktopOperationSignal()` (which intentionally returns undefined for expired cosmetic contexts). Both `withAgentActivity` and `withDesktopControl` call it before the queue can create a fresh context. Expired or aborted inherited calls therefore cannot obtain new input authority. Direct calls without inherited operation state remain admissible, subject to the queued disabled/suspended checks and existing lease/turn revocation rules. Intentional cleanup through `withoutDesktopCancellation` is preserved.

Two independent temporary checks pass against the final source:

1. A delayed backend input-pause refusal after thread removal leaves that thread absent and publishes no resurrected state. The owner's new disposed/suspended catch guard prevents the recreation path.
2. Parent cancellation propagates through a nested composed scope and remains visible when execution resumes in the live parent transaction; detached work from the completed nested scope subsequently sees no stale signal.

Evidence: `core-audit.test.ts`, `core-audit.config.mjs`, and final `core-audit.log` (two passing tests). These use actual manager/queue modules with a fake backend and controlled promises. No native, browser, or desktop operations were performed.

Other inspected invariants: conditional waits acquire fresh manager admission for each AX read and optional capture, check turn activity, and release the transaction between polls. Wait cancellation is checked before and after reads; failed post-input observation retains the original completed action rather than issuing a replacement. Input-pause clearing requires a successful scoped readiness check and preserves the state/pause identity snapshot across its await. Global versions are assigned at publication, including cached activity updates, and active/paused/pane-surfaced/publishing records are excluded from normal idle eviction. Screenshot-coordinate conversion still rejects mismatched explicit window identities; implicit scrolling adopts the captured window and bounds each requested axis to half the captured logical extent. The macOS manager branch still dispatches one scroll operation without corrective replay.

This is a bounded read-only audit and two synthetic invariant checks, not a full application/runtime qualification. The core owner runs the broader focused manager/tool suites.
