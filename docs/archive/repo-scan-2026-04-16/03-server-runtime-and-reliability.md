# Repository Scan - Server Runtime And Reliability

## Where the server is strong

The server side clearly takes runtime behavior seriously:

- orchestration has deciders, projectors, layers, services, and persistence
- provider handling is separated from web transport at a high level
- checkpointing, persistence, and projection recovery exist
- tests are present across key areas

That is a strong base for a WIP product.

## Main improvement opportunities

## 1. Narrow the failure surface of provider session management

[`apps/server/src/codexAppServerManager.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/server/src/codexAppServerManager.ts) appears to own too many runtime concerns in one place:

- child process lifecycle
- shell/env decisions
- JSON-RPC request tracking
- approval state
- pending user input
- session/account state
- discovery flows
- error parsing/classification
- voice transcription support

This should become a small runtime composed from smaller parts. That is the best way to keep behavior predictable under partial failure.

## 2. Make timeout and retry policy more centralized

There are several timeout-driven behaviors across provider sessions, orchestration dispatch, readiness, and desktop/backend startup. A shared policy approach would help:

- one place for timeout constants by concern
- one place for retry/backoff policies
- one place for timeout telemetry/logging shape

Right now those concerns are present, but they are still scattered.

## 3. Strengthen end-to-end invariants around event flow

The critical product path is roughly:

provider runtime -> server ingestion -> orchestration events -> read model -> WebSocket push -> web store

That path deserves a small set of named invariants, for example:

- no duplicate terminal event causes duplicate durable timeline entry
- streaming message chunks always converge to one final message shape
- approval/user-input requests are resumable or fail loudly and visibly
- reconnect/bootstrap never silently drops the latest actionable state

Those invariants can become scenario tests rather than only local unit tests.

## 4. Add more "chaos-shaped" tests, not just happy-path assembly tests

What would be especially valuable:

- provider process exits mid-turn
- duplicated provider event delivery
- delayed or reordered stream chunks
- reconnect during pending approval
- checkpoint rebuild with partially applied projection state
- attachment path or file-read denial edge cases

This repo's priorities explicitly favor predictability under failure. Test shape should mirror that priority.

## 5. Improve observability around the orchestration pipeline

The server already has logging and analytics hooks, but the next leap is better correlation:

- command id
- thread id
- provider session id
- turn id
- process pid
- projection sequence

When a failure happens, those identifiers should make the story reconstructable from logs without guesswork.

## Specific refactors worth doing

1. Create a dedicated provider RPC/session runtime module extracted from `codexAppServerManager.ts`.
2. Extract `wsServer.ts` request families into per-domain handler modules.
3. Introduce a shared runtime policy module for timeouts/retries/backoff.
4. Add scenario tests for reconnect, resume, duplicate delivery, and mid-stream failure.
5. Add correlation-friendly structured logging to the provider and orchestration critical paths.

## Why this matters

This repo is building a stateful agent product, not a stateless CRUD app. Reliability bugs here are usually "works 95% of the time until a session hiccups" bugs. Those are expensive bugs. The best improvements are the ones that make the runtime easier to reason about under stress.
