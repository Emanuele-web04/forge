# Computer event interests integration

Implemented in the shared worktree, preserving all pre-existing local changes.

## Behavior

- Thread snapshots and agent actions are sent only to sockets that requested the thread's Computer state. Global desktop events and human actions retain broadcast behavior.
- Tracking uses the server-generated WebSocket connection-session key, never the RPC client's numeric id.
- `WsConnectionSessions.onClose` owns one cleanup registration per interested socket. Actual socket-scope finalization deletes the connection record, executes cleanup, and clears its callback set.
- A state read without a Computer event subscription still gets deterministic socket-close cleanup. Late state reads cannot resurrect an already-closed connection.
- Stream retry replaces only its event listener, preserving all same-socket interests. Browser reconnect already reseeds active thread state, independently verified by the frontend agent's browser regression.
- Up to 64 distinct thread ids are retained per socket. A socket viewing more falls back to the prior broadcast behavior and drops its stored id set. It does not silently lose older live views.
- There is no global 256-client eviction. Memory is bounded per live socket and released on disconnect. In-process callers without a connection key retain broadcast compatibility.
- Existing `makeWsComputerHandlers` composition still passes the local `AgentGatewaySessionRegistry`; immediate Computer capability revocation is preserved.

## Files

- `apps/server/src/computer/computerEventInterests.ts`
- `apps/server/src/computer/computerEventInterests.test.ts`
- `apps/server/src/wsConnectionSessions.ts`
- `apps/server/src/wsConnectionSessions.test.ts`
- `apps/server/src/wsRpc.ts` (Computer imports, handler construction, state interest registration, event subscription only)
- `apps/server/src/wsRpc.connectionLifecycle.test.ts` (existing real connection-scope test extended with state-only Computer interest cleanup)

## Verification

Node 26.8.1 + Vitest 4.1.10, running from `apps/server`:

`/opt/homebrew/bin/node ../../node_modules/vitest/vitest.mjs run src/computer/computerEventInterests.test.ts src/wsConnectionSessions.test.ts src/computer/wsComputerHandlers.test.ts --silent`

Passed 3 files / 20 tests at 14:32:37. Includes 301 simultaneous interested connections plus 300 transient/disconnected connections; 100 distinct views; repeated reads; state-only cleanup; late reads after close; stream retries and listener cleanup; exactly one socket cleanup callback per retrying connection; missing-context compatibility; unchanged Computer handler authority tests.

`/opt/homebrew/bin/node ../../node_modules/vitest/vitest.mjs run src/wsRpc.connectionLifecycle.test.ts --silent`

Passed 1 file / 23 tests at 14:31:14. Initial sandboxed run was prevented from binding temporary localhost sockets (`listen EPERM 127.0.0.1`). Scoped automatic review allowed the same loopback-only suite, which then passed, including the extended real socket-close cleanup assertion.

No formatter, linter, typecheck, native desktop input, build, or Git mutation was run by this agent.
