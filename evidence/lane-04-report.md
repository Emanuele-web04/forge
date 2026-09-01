# Lane-04 report — PR 861 refresh onto upstream/main

- Branch: `handoff/plan-04`
- Starting head: `aac33dd2d` (PR 861 head, 32 commits behind main)
- Merged: `refs/remotes/upstream/main` at `182208581e` (no fetch; ref was already local)
- Merge commit: `3a450405dc1d26188e690cf3af72f636932da4a0` (clean, `ort` strategy, zero conflicts)
- Final head: see "Final HEAD" below (merge commit + ledger/evidence commit)
- Worktree: `/Users/user/synara-handoff-wt/plan-04` only

## Merge refresh

- `sfw bun install` run once (1240 packages). Upstream's `bun.lock` delta vs the
  merge base is workspace version bumps only (0.7.3 -> 0.8.0), no dependency
  changes, so node_modules stayed valid.
- `git merge refs/remotes/upstream/main --no-edit`: clean. Upstream's only
  change inside PR-owned files was `storeNormalization.ts` `toLegacyProvider`
  gaining `|| providerName === "devin"`; it does not overlap the PR's edits and
  auto-merged. Both semantics verified present in the merged tree:
  - PR tri-state expansion: `storeNormalization.ts` L378-386
    (`persistedProjectOrderIndex` / `hasKnownLegacyExpansion` / `expanded`)
  - Upstream devin provider: `storeNormalization.ts` `toLegacyProvider`
- No conflict touched any protected Devin file or any file outside PR ownership.

## Boundary (gate 10)

```
git diff refs/remotes/upstream/main HEAD -- apps/web/src/components/Sidebar.tsx apps/web/src/lib/disclosureMotion.ts
-> empty (verified after merge and again at final head)
```

The PR head already satisfied this before the merge; the merge kept it.

## Acceptance gates

| #  | Gate                                                        | Result | Proof                                                                                                                                                                                                                   |
| -- | ----------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Collapse ALL projects, full restart, still collapsed        | PASS   | `storePersistence.test.ts` "remembers a fully collapsed project set"; end-to-end `store.test.ts` "preserves all-collapsed state across a full reload and defaults unknown projects to expanded"; live restart proof below |
| 2  | Mixed expanded/collapsed survives full restart              | PASS   | `storePersistence.test.ts` "remembers mixed expansion state per project"; end-to-end `store.test.ts` "preserves mixed expansion state across a full reload"                                                              |
| 3  | Fresh profile loads all projects expanded                   | PASS   | `storePersistence.test.ts` "has no remembered project UI state on a fresh profile (no persisted key)" + default-expanded branch `storeNormalization.ts` L382-386; behavior asserted at store level (unknown cwd -> expanded) |
| 4  | Corrupt persisted value loads expanded, no throw            | PASS   | `storePersistence.test.ts` "resets remembered state when the stored value is corrupt" (input `'"{"'`, `not.toThrow()`); also "ignores malformed persisted shapes and falls back to defaults"                              |
| 5  | cwd absent from persisted data hydrates expanded even when all persisted collapsed (intentional change) | PASS | `storePersistence.test.ts` "treats a new project cwd as unknown (not in persisted order) when every persisted project is collapsed"; end-to-end in `store.test.ts` L667 test (project 3 absent from payload -> expanded) |
| 6  | Legacy expanded-only payload behaves identically            | PASS   | `storePersistence.test.ts` "preserves legacy payloads that contain only expandedProjectCwds" (+ empty-legacy and legacy-exit edge tests L133/L308)                                                                        |
| 7  | Removed project pruned from both persisted lists            | PASS   | `storePersistence.test.ts` "removes a deleted project from both persisted project lists on the next write" (asserts both `projectOrderCwds` and `expandedProjectCwds` pruned); `forgetProjectState` test L252              |
| 8  | Persist while `threadsHydrated === false` performs no setItem | PASS  | `storePersistence.test.ts` "does not call localStorage.setItem while threadsHydrated is false"; store-level `store.test.ts` "does not persist project UI before thread hydration"                                          |
| 9  | Existing store test around store.test.ts:386 passes unmodified | PASS | Test "preserves the current project order when syncing incoming read model updates" (L346-398) passes; `git diff refs/remotes/upstream/main...HEAD -- apps/web/src/store.test.ts | grep -c "preserves the current project order"` -> 0 |
| 10 | Sidebar.tsx and disclosureMotion.ts zero diff vs upstream/main | PASS | Command above; empty output at merge commit and final head                                                                                                                                                              |
| 11 | Focused vitest suites pass (`bun run test` from apps/web)   | PASS   | 4 files, 123 tests, 0 failed, 0 skipped (run twice: worker + orchestrator)                                                                                                                                               |
| 12 | Full-restart live proof                                     | PASS   | See "Live restart proof" below                                                                                                                                                                                           |

### Focused test command and result (run twice, both green)

```
cd apps/web && bun run test src/storePersistence.test.ts src/store.test.ts src/storeNormalization.test.ts src/storeProjection.test.ts
Test Files  4 passed (4)
     Tests  123 passed (123)
```

Per file: storePersistence 17, storeProjection 71, storeNormalization 12, store 23.
`bun test` was never used (repo rule).

## Live restart proof (gate 12)

Isolated instance, never touched the user's own Synara or any other worktree.

- Dry-run first: `env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3104 SYNARA_NO_BROWSER=1 bun run dev -- --home-dir ./.synara-h04 --port 58104 --dry-run`
  -> no conflicts; ports recorded: server `127.0.0.1:58104`, web (vite) `localhost:8837`.
- Run 1 launched without `--dry-run`; listeners verified with
  `lsof -nP -iTCP:58104 -sTCP:LISTEN` and `:8837` (`lsof-run1.txt`).
- Drove the real UI with Playwright (chromium, persistent user profile at
  `.synara-h04/browser-profile-h04` so renderer localStorage survives browser
  restart, mimicking the desktop renderer profile):
  - Created two projects through the Add-project UI dialog:
    `demo-project-alpha`, `demo-project-beta`.
  - Collapsed ALL sidebar project sections; captured DOM state
    (`collapsed-state-before.json`): both projects `derivedExpanded: false`
    (shell `grid-rows-[0fr] opacity-0`, computed `grid-template-rows: 0px`,
    opacity 0, list `offsetHeight 0`, `pointer-events: none`).
  - Captured `localStorage["synara:renderer-state:v8"]`
    (`localStorage-before.json`): alpha/beta present in `projectOrderCwds`,
    absent from `expandedProjectCwds` (the persisted-collapsed encoding).
- Full restart: stopped ONLY the PIDs recorded at launch (SIGTERM to own
  process groups; ports freed; `stop-run1.txt`), relaunched the same command
  (`server-run2.log`, `lsof-run2.txt`), relaunched the browser with the SAME
  persistent profile, and captured WITHOUT any interaction:
  - `collapsed-state-after.json`: same project IDs, both `derivedExpanded: false`.
  - `localStorage-after.json`: v8 payload byte-identical to before.
- Screenshots: `collapsed-before-restart.png`, `collapsed-after-restart.png`
  (1440x900 PNGs).
- Server-side storage: projects persist in `projection_projects` of
  `.synara-h04/dev/state.sqlite` (WAL); expansion state is renderer-side
  (localStorage v8), as designed (`server-storage-notes.md`).
- All lane-started processes were stopped after the proof (`stop-run2.txt`);
  leftover-process check found none.

## Final verification pass (one bundled run)

```
bun run fmt        -> exit 0 (oxfmt, 2730 files, no changes)
bun run lint       -> exit 0 (oxlint, 0 errors; 491 warnings, all pre-existing upstream code; the 4 warnings inside owned files sit on lines untouched by the PR diff)
bun run typecheck  -> exit 0 (turbo, 7/7 tasks successful)
focused tests      -> 123/123 pass (re-run after fmt/lint/typecheck)
```

## Fixes made

None required. The refresh introduced no regression: the merge was clean, all
12 gates passed on the merged tree, and no source file needed modification.
The only artifacts added by this lane are the DELEGATION.md ledger update and
this evidence directory.

## Named gaps

1. Visual check was headless Playwright (chromium, 1440x900), not a human-eye
   check of a visible browser. DOM geometry + computed styles + screenshots
   stand in for visual confirmation; no flicker/route regression was measured
   in this lane (the prior lane's A16 evidence covers flicker; not re-proven here).
2. Project rows expose no `aria-expanded` attribute (only the non-project
   "Chats" toggle does); collapsed state was derived from the disclosure shell
   class, computed grid-template-rows/opacity, and list geometry instead.
3. Gate 3 (fresh profile) is proven by a combination (no-remembered-state test +
   default-expanded branch + store-level unknown-cwd assertion) rather than one
   single dedicated test name.
4. Live sqlite inspection used a copy (`state-copy-inspect.sqlite`) because the
   live WAL database was write-locked.

## Delegation ledger

See `DELEGATION.md` section "Lane-04 refresh delegation": R1 (merge, worker),
R2 (focused vitest gates, worker), R3 (live restart proof, worker),
R4 (final pass + this report, orchestrator) — all rows verified by the
orchestrator (merge boundary re-checked, tests re-run, restart evidence files
re-read and cross-compared, leftover-process check run).
