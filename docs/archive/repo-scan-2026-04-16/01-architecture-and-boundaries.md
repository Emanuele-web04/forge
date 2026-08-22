# Repository Scan - Architecture And Module Boundaries

## Current shape

The package split is directionally solid and aligned with the repo's own stated goals:

- `apps/server`: runtime orchestration, provider/session management, WebSocket API
- `apps/web`: client UX, rendering, routing, local state
- `apps/desktop`: Electron shell and native integration
- `packages/contracts`: shared schemas and contracts
- `packages/shared`: cross-runtime helpers

That said, several boundary layers are still too "thick", so package-level structure is stronger than module-level structure.

## What to improve

## 1. Reduce "god-file" coordination modules

These files are doing too many jobs:

- [`apps/server/src/codexAppServerManager.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/server/src/codexAppServerManager.ts)
- [`apps/server/src/wsServer.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/server/src/wsServer.ts)
- [`apps/desktop/src/main.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/desktop/src/main.ts)

Suggested split for `codexAppServerManager.ts`:

- process lifecycle
- JSON-RPC request/response plumbing
- approval flow
- user-input flow
- skill/plugin discovery
- voice transcription/auth handling
- stderr/log classification

Suggested split for `wsServer.ts`:

- connection/auth/bootstrap
- request decoding and schema validation
- orchestration method handlers
- attachment/file routes
- server push subscription routing

Suggested split for desktop `main.ts`:

- backend process lifecycle
- updater wiring
- window/menu creation
- browser panel management
- IPC channel registration
- logging and crash/session diagnostics

## 2. Make "Layers" vs "Services" responsibilities more explicit

The server already uses both `Layers` and `Services`, especially under:

- [`apps/server/src/orchestration`](/Users/emanueledipietro/Developer/Testing/synara/apps/server/src/orchestration)
- [`apps/server/src/provider`](/Users/emanueledipietro/Developer/Testing/synara/apps/server/src/provider)
- [`apps/server/src/persistence`](/Users/emanueledipietro/Developer/Testing/synara/apps/server/src/persistence)

This is promising, but the distinction is not self-evident to a new contributor. A short rule would help:

- `Services`: pure interfaces or stable domain APIs
- `Layers`: live wiring, Effect provisioning, concrete runtime assembly

Without that shared rule, folders with the same names can drift into style rather than architecture.

## 3. Tighten contracts ownership around protocol evolution

[`packages/contracts/src/orchestration.ts`](/Users/emanueledipietro/Developer/Testing/synara/packages/contracts/src/orchestration.ts) is large enough that future protocol churn could become noisy and hard to review.

Recommended split:

- command schemas
- event schemas
- read-model schemas
- UI bootstrap payloads
- helper enums/constants

Then add a small "protocol evolution" note that explains:

- which changes are additive-safe
- which changes require migration work
- which consumers must be updated together

## 4. Add architecture ADR-lite docs

The repo does not need long formal RFCs. It would benefit from short, living docs in `docs/architecture/`:

- `provider-runtime-flow.md`
- `orchestration-pipeline.md`
- `web-state-model.md`
- `desktop-shell-boundaries.md`

Each can stay under one page and answer:

- who owns what
- what the critical path is
- what invariants must not break
- what failure cases matter

## Highest-value boundary refactors

1. Extract transport/runtime concerns from `wsServer.ts`.
2. Extract provider session plumbing from `codexAppServerManager.ts`.
3. Split desktop Electron `main.ts` by lifecycle concern.
4. Decompose orchestration contracts into smaller protocol modules.
5. Add 3-4 short architecture docs to preserve intent during refactors.

## Payoff

This work will reduce onboarding cost, make reviews more reliable, and lower the regression risk when the product adds more providers, more desktop capabilities, or more complex thread/session flows.
