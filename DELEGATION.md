# Delegation plan

Units: 4

| #   | Unit                                   | Files (mine)                                                                                                                         | Worker (subagent)                         | Acceptance                                                                                                                                  | Status   |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Reconcile Plan 04 production scope     | `apps/web/src/storePersistence.ts`, `apps/web/src/storeNormalization.ts`, `apps/web/src/store.ts`, `apps/web/src/storeProjection.ts` | inherited implementation, parent verified | Exact v8 boundary; hydrated-only writes; local toggles win; invalid cwd entries do not revive; no rate-limit, animation, or transcript work | verified |
| 2   | Reconcile focused persistence tests    | `apps/web/src/storePersistence.test.ts`, `apps/web/src/store.test.ts`, `apps/web/src/storeTestFixtures.ts`                           | inherited implementation, parent verified | Binary matrix covers restart, reconnect/hydration, rename/reorder, missing/deleted, corrupt/legacy, multi-change, stale-write race          | verified |
| 3   | Live isolated verification             | `/tmp/pr861-live/**`                                                                                                                 | parent                                    | Real WebSocket instance proves restart/reconnect persistence with no sidebar flicker or route/selection regression                          | verified |
| 4   | Independent review and merge readiness | read-only full diff; GitHub PR 861                                                                                                   | fresh reviewer, parent fixes/verifies     | Correctness, races, corruption, scope, performance, maintainability pass; tested SHA pushed normally; GitHub CLEAN/MERGEABLE and green      | verified |

## Acceptance matrix

| ID  | Case                                               | Expected                                                                               | Check                                           |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| A1  | Collapse all, persist, full restart                | All known projects remain collapsed                                                    | Focused restart test plus live restart artifact |
| A2  | Mixed expansion, persist, restart                  | Exact per-project values survive                                                       | Focused restart test plus live restart artifact |
| A3  | Fresh profile or missing key                       | Every project defaults expanded                                                        | Boundary test                                   |
| A4  | Corrupt or malformed old data                      | No throw; safe expanded defaults; valid fields only                                    | Boundary tests                                  |
| A5  | Legacy expanded-only payload                       | Legacy members expanded and other known projects collapsed                             | Boundary test                                   |
| A6  | Unknown/new cwd beside collapsed known projects    | Unknown project expands                                                                | Boundary and store tests                        |
| A7  | Snapshot hydration or reconnect after local toggle | Existing local toggle wins                                                             | Store projection tests plus live reconnect      |
| A8  | Rename or cwd change                               | New cwd is new identity and expands                                                    | Focused store test                              |
| A9  | Reorder                                            | Persisted order changes without corrupting expansion                                   | Focused store test                              |
| A10 | Missing project briefly returns in session         | Remembered expansion returns                                                           | Existing focused store test                     |
| A11 | Deleted project and stale persisted cwd            | Removed cwd is pruned and cannot revive                                                | Boundary and deletion tests                     |
| A12 | Multiple project toggles/changes                   | Last in-memory state is persisted after hydration                                      | Focused store test                              |
| A13 | Pre-hydration persist and unload                   | No storage write                                                                       | Boundary and facade tests                       |
| A14 | Storage write failure                              | App state remains usable and no throw                                                  | Boundary test                                   |
| A15 | Persistence boundary                               | Only normalized cwd, order, expansion, and local names in v8; no runtime state         | Diff inspection and payload assertion           |
| A16 | UI regression                                      | No flicker; route and selection unchanged; shared motion untouched                     | Live browser artifact and zero diff check       |
| A17 | Scope                                              | No `rateLimits.ts`, transcript lifecycle, Sidebar, disclosure motion, or Plan 05+ diff | Authoritative git diff                          |
| A18 | Full gate                                          | Full tests, browser tests, build, fmt, lint, and typecheck pass                        | Required commands and GitHub checks             |

## Throughput checkpoint

- Blocking first steps. Read the plan, recon, inherited trail, branch, and old CI before accepting code.
- Independent workstreams. Production/test reconciliation precedes live verification; final review runs after runtime proof.
- Shared mutable state. One writer owns the existing worktree. Reviewers are read-only.
- Smallest safe decomposition. Keep one writer because persistence and normalization share one state invariant; split verification by unit.

## Lane-04 refresh delegation (PR 861 onto upstream/main 182208581e)

Units: 4

| #   | Unit                                                        | Files (mine)                                                                                | Worker (subagent) | Acceptance                                                                                                                                       | Status  |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| R1  | Merge upstream/main into handoff/plan-04, verify boundaries | merge commit; `apps/web/src/components/Sidebar.tsx`, `apps/web/src/lib/disclosureMotion.ts` | worker-merge      | Merge completes; Sidebar.tsx and disclosureMotion.ts zero diff vs upstream/main; owned-file semantics preserved (v8, tri-state, hydration guard) | verified |
| R2  | Focused vitest gate verification (gates 1-11)               | read-only runs of `apps/web` store/persistence suites                                       | worker-gates      | `bun run test` focused suites pass; gate-by-gate mapping reported with real output                                                               | verified |
| R3  | Live full-restart proof (gate 12)                           | `./.synara-h04/**` (ephemeral home dir), port 58104                                         | worker-restart    | lsof LISTEN evidence; persisted storage shows collapsed state before and after full restart; only own processes stopped                          | verified |
| R4  | Final bundled fmt/lint/typecheck + evidence report          | `evidence/lane-04-report.md`                                                                | orchestrator      | One bundled pass of fmt, lint, typecheck; focused tests re-run; report written with gate table                                                   | verified |

## Verification evidence

- Unit 1. `git diff upstream/main...HEAD`; zero diff for `rateLimits.ts`, `Sidebar.tsx`, `disclosureMotion.ts`, and transcript files.
- Unit 2. `cd apps/web && bun run test src/storePersistence.test.ts src/store.test.ts src/storeNormalization.test.ts src/storeProjection.test.ts` passed 123 tests.
- Unit 3. `/tmp/pr861-live/restart-result.json`, `reconnect-result.json`, `collapsed-hydration-timeline.json`, and screenshots prove restart, reconnect, stable route, no console errors, and no expanded-frame flicker.
- Unit 4. Fresh review passed after adding reconnect, cwd-change, reorder, and multi-toggle proofs; full tests and build passed; the one stable browser geometry failure reproduces alone outside this diff; SHA pushed normally; GitHub watcher reached READY.
