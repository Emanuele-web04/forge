# Repository Scan - Web App Improvements

## Why the web app deserves the most attention

The web package is currently the largest source area in the repo and the place where state, transport events, rendering, and product UX all collide.

High-pressure files include:

- [`apps/web/src/components/ChatView.tsx`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/components/ChatView.tsx)
- [`apps/web/src/components/Sidebar.tsx`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/components/Sidebar.tsx)
- [`apps/web/src/store.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/store.ts)
- [`apps/web/src/composerDraftStore.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/composerDraftStore.ts)
- [`apps/web/src/routes/__root.tsx`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/routes/__root.tsx)

## What is already going in the right direction

- Normalized state is present in [`store.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/store.ts).
- Selector extraction is happening in [`storeSelectors.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/storeSelectors.ts).
- Thread reconstruction has started moving into [`threadDerivation.ts`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/threadDerivation.ts).

That is exactly the direction I would keep pushing.

## What to improve

## 1. Turn the store into feature slices, not one long state brain

`store.ts` is carrying too many transition types and persistence concerns together.

Recommended slice split:

- project/sidebar slice
- thread shell/session slice
- message/activity/proposed-plan slice
- persistence/local-storage slice
- orchestration event application slice
- shell event application slice

The goal is not Redux-style ceremony. The goal is smaller files with obvious ownership.

## 2. Shrink `ChatView.tsx` aggressively

`ChatView.tsx` looks like the main UI assembly point for:

- composer state
- slash commands
- worktree actions
- pending approvals
- pending user input
- voice
- plan flows
- terminal context
- split view
- provider/model state

That file should become a composition root, not the place where every decision lives.

Good next extraction targets:

- composer send orchestration
- provider/model selection logic
- pending approval + pending user-input decision hooks
- plan/follow-up logic
- terminal-context integration
- local draft promotion/retry flow

## 3. Separate render components from decision hooks

A useful pattern here would be:

- `components/chat/*` for mostly presentational pieces
- `hooks/chat/*` for decision-heavy logic
- `state/chat/*` for normalized state helpers and transitions
- `lib/chat/*` for pure derivation/utilities

That would make browser tests and unit tests easier to target without going through giant component surfaces.

## 4. Make event ingestion easier to reason about

[`apps/web/src/routes/__root.tsx`](/Users/emanueledipietro/Developer/Testing/synara/apps/web/src/routes/__root.tsx) currently participates in event routing and coalescing. That works, but the event pipeline would be easier to maintain if it became more explicit:

- WebSocket event arrives
- event is validated/coalesced
- event is mapped into a store transition
- transition updates a single owned slice

Today, that flow exists, but it still feels somewhat dispersed.

## 5. Add performance guardrails around the hot chat surfaces

This project is performance-sensitive by design. The biggest win here is not generic memoization. It is making the hot paths observable:

- measure `ChatView` render count in dev
- measure timeline item count and expensive recomputations
- track store updates by event type
- flag when a single event fans out into too many selectors/components

The structure already hints at this concern. It would be worth making it visible.

## Suggested roadmap

1. Continue extracting thread derivation and selectors out of `store.ts`.
2. Split `ChatView.tsx` into domain hooks plus assembly components.
3. Split `Sidebar.tsx` by project list, thread list, and actions.
4. Move event ingestion into a clearer pipeline module.
5. Add lightweight perf instrumentation for the chat timeline and store updates.

## Expected payoff

- Faster feature work
- Safer UI refactors
- Better performance debugging
- Lower risk of subtle state regressions during reconnect/resume flows
