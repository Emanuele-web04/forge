# Repository Scan - Executive Summary

Date: 2026-04-16

Scope:

- Current checkout of the whole repository
- Includes the current dirty worktree state
- Focused on maintainability, reliability, performance, and product velocity

## What looks strong already

- The monorepo boundaries are directionally good: `apps/server`, `apps/web`, `apps/desktop`, `packages/contracts`, and `packages/shared` are sensible package roles.
- CI is not superficial. It already runs format, lint, typecheck, tests, browser tests, and desktop build verification in [`.github/workflows/ci.yml`](/Users/emanueledipietro/Developer/Testing/synara/.github/workflows/ci.yml).
- The codebase has meaningful test coverage across server, web, desktop, shared, and contracts.
- The server architecture is trying to separate `Layers` and `Services`, which is a healthy direction for long-term reliability.
- The web app is already moving toward normalized state plus derived selectors, which is the right foundation for a chat-heavy UI.

## What stands out as the main improvement areas

## 1. The biggest risk is concentration of complexity

Several files are carrying too much behavior at once:

- [`apps/web/src/components/ChatView.tsx`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/components/ChatView.tsx)
- [`apps/web/src/components/Sidebar.tsx`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/components/Sidebar.tsx)
- [`apps/web/src/store.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/store.ts)
- [`apps/web/src/composerDraftStore.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/composerDraftStore.ts)
- [`apps/server/src/codexAppServerManager.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/server/src/codexAppServerManager.ts)
- [`apps/server/src/wsServer.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/server/src/wsServer.ts)
- [`apps/desktop/src/main.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/desktop/src/main.ts)

This is not a style issue. It is the main factor that will slow down safe changes.

## 2. The web app is the heaviest maintainability pressure point

Quick scan metrics:

- `apps/web/src`: about 90k LOC across 330 source files
- `apps/server/src`: about 75k LOC across 195 source files
- `apps/desktop/src` + `packages/shared/src` + `packages/contracts/src`: about 15k LOC combined

The web app is where product complexity, state synchronization, and UI rendering all meet. That is where the next round of cleanup will likely pay off fastest.

## 3. Reliability logic exists, but operational seams are still wide

The repo clearly cares about reconnects, orchestration events, sessions, checkpoints, and persistence. That is good. But some of the transport/runtime integration still appears concentrated in large coordination files, which increases the chance of subtle regression under failure or partial-stream conditions.

## 4. Docs are not yet keeping up with system complexity

There is useful release documentation in [`docs/release.md`](/Users/emanueledipietro/Developer/Testing/synara/docs/release.md), but there is not yet a matching level of architecture guidance for:

- event flow from provider runtime to UI
- persistence and projection responsibilities
- state ownership in the web app
- desktop/server integration boundaries

That gap will matter more as the codebase grows.

## Recommended top 5 improvements

1. Break `ChatView`, `Sidebar`, `store`, `codexAppServerManager`, and desktop `main.ts` into feature-owned modules with stricter responsibilities.
2. Push more web derivation and transition logic out of components and into small domain modules near the store.
3. Introduce stronger runtime boundary tests around server transport, orchestration ingestion, resume/reconnect, and approval/user-input flows.
4. Create short architecture docs for the critical paths so refactors stop depending on tribal knowledge.
5. Add simple complexity guardrails in CI for giant files so new hotspots do not quietly form.

## Suggested execution order

- First: web state/component decomposition
- Second: server runtime boundary cleanup
- Third: desktop IPC/lifecycle decomposition
- Fourth: architecture docs and contributor guidance
- Fifth: CI complexity guardrails and measurement
