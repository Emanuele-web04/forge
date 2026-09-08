# Desktop observation recovery review and integration

The final review identified a post-unlock admission gap: automatic pane overview captures could satisfy the host's fresh-observation gate while a model retained its pre-interruption coordinates. The backend also learned about interruption only from an explicit pause refusal, so lock/unlock occurring between requests preserved old grounding.

The integrated backend now marks only actual native window/desktop state requests originating inside explicit `computer_get_state`, `computer_screenshot`, or `computer_wait` execution. The AsyncLocalStorage scope expires when the observation finishes. Automatic preview captures explicitly disable the marker even when spawned inside a live observation scope; semantic action targeting and post-action captures do not acquire that authority.

The GUI-host `desktopEpoch` response field invalidates backend cached pixels and observed window geometry on interruption. Delayed older-epoch replies are rejected, preventing stale observation results from restoring grounding. Root separately owns the complementary host gate, interrupted-read rejection, protocol field, and host tests.

Owned changed files:

- `apps/server/src/computer/modelDesktopObservation.ts`
- `apps/server/src/computer/modelDesktopObservation.test.ts`
- `apps/server/src/computer/CuaComputerBackend.ts`
- `apps/server/src/computer/CuaComputerBackend.test.ts`
- `apps/server/src/agentGateway/computerTools.ts` (import and invocation scope only)
- `apps/server/src/agentGateway/computerTools.test.ts` (one handler-boundary regression)

Verification on 2026-09-08: Node/Vitest selected run passed **37 tests in 3 files**, with 93 unrelated tests skipped. Command from `apps/server`: `/opt/homebrew/bin/node ../../node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism src/computer/CuaComputerBackend.test.ts src/computer/modelDesktopObservation.test.ts src/agentGateway/computerTools.test.ts -t 'Cua|model desktop observation|reserves model observation authority'`. Scoped `git diff --check` passed. No full formatter, linter, typecheck, or physical desktop interaction was run by this worker.

Independent static review of revision 3 logical coordinates found no concrete transform or target-validation defect: logical window-local points skip capture scaling only with finite exact expected bounds, while native InputTarget admission and per-post checks remain in force. A separate child review found no cancellation/startup deadlock or input bypass in host stop/retire/pause/resume ordering. These are static findings, not physical-device qualification claims.
