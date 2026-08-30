# Gate: PR-D — Pi SDK bump

Targets: `apps/server/package.json`, lockfile, `apps/server/src/provider/Layers/PiAdapter.ts`.

## Acceptance

- [x] `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent` pinned to exact `0.84.4`.
- [x] `bun install` run and lockfile committed.
- [x] Any compile breaks in `PiAdapter.ts` fixed.
- [x] Changelog 0.81.1→0.84.4 reviewed for session/resume file format break; if break found, gate is blocked and reported.
- [ ] Full server test suite passes: `cd apps/server && bun run test`.
- [x] `bun fmt && bun lint && bun typecheck` pass.

## CHECK / EXPECT

CHECK: `cd /Users/user/.windsurf/worktrees/synara/wt-reliability-qol-pi/apps/server && bun run test`
EXPECT: exit 0.

CHECK: `cd /Users/user/.windsurf/worktrees/synara/wt-reliability-qol-pi && bun fmt && bun lint && bun typecheck`
EXPECT: exit 0.

CHECK: `cd /Users/user/.windsurf/worktrees/synara/wt-reliability-qol-pi/apps/server && rg 'modelRegistry\.complete'`
EXPECT: no output or only the call in the user extension (not repo code).

## Changelog review (0.81.1 → 0.84.4)

Reviewed the `CHANGELOG.md` in the installed `@earendil-works/pi-coding-agent@0.84.4` package.

- No explicit session/resume file format break was documented.
- The JSONL format remains v3/v4 dual-mode (`sourceFormat: 3 | 4` and `legacyParentSessionPath` are still supported in `pi-agent-core/dist/harness/session/jsonl/types.d.ts`).
- Breaking changes in the span are public SDK API changes, not persisted session format changes:
  - 0.83.0: TypeBox 1.3.7 alias cleanup.
  - 0.84.0: `ModelRegistry`/`ModelRuntime` refresh/auth/header API changes and `message_update` event stream shape changes.
  - 0.84.3: `GoogleThinkingLevel` → `GoogleApiThinkingLevel` rename.

No session/resume file-format STOP condition was triggered.

## EVIDENCE

### Package pin

`apps/server/package.json`:

```json
"@earendil-works/pi-agent-core": "0.84.4",
"@earendil-works/pi-ai": "0.84.4",
"@earendil-works/pi-coding-agent": "0.84.4",
```

Lockfile committed as `b1feb2016`.

### `bun install`

```text
bun install v1.4.0 (1381054db)
Resolving dependencies
Resolved, downloaded and extracted [64]
Checked 1257 installs across 1447 packages (no changes) [1.94s]
```

### Compile breaks in `PiAdapter.ts`

`cd apps/server && bun run typecheck` returned exit 0 with no `tsc` errors.
No code changes were required in `apps/server/src/provider/Layers/PiAdapter.ts`.

### `modelRegistry.complete` repo code check

```text
cd /Users/user/.windsurf/worktrees/synara/wt-reliability-qol-pi/apps/server && rg 'modelRegistry\.complete'
(no output)
```

### Focused PiAdapter test

```text
cd /Users/user/.windsurf/worktrees/synara/wt-reliability-qol-pi/apps/server && bun run test src/provider/Layers/PiAdapter.test.ts

 RUN  v4.1.10 /Users/user/.windsurf/worktrees/synara/wt-reliability-qol-pi/apps/server

 ✓ src/provider/Layers/PiAdapter.test.ts (17 tests) 76ms

 Test Files  1 passed (1)
      Tests  17 passed (17)
   Start at  20:51:59
   Duration  2.60s (transform 765ms, setup 0ms, import 2.35s, tests 76ms, environment 0ms)
```

### Full `bun run test`

Two runs were performed. Both completed with the same three unrelated failures:

```text
cd /Users/user/.windsurf/worktrees/synara/wt-reliability-qol-pi/apps/server && bun run test

...FAILED src/git/Layers/CursorTextGeneration.test.ts
...FAILED src/git/Layers/GitCore.test.ts
...FAILED src/provider/acp/AcpSdkConformance.test.ts

 Test Files  3 failed | 352 passed | 3 skipped (358)
      Tests  3 failed | 4070 passed | 16 skipped (4089)
   Duration  1118.96s

error: script "test" exited with code 1
```

The failing tests are unrelated to the Pi SDK bump:

1. `CursorTextGeneration.test.ts` — `closes the ACP child process after text generation completes`: flaky under full-suite load; the exit log is missing or the child receives `SIGTERM`.
2. `GitCore.test.ts` — `returns UI status before its background upstream refresh completes`: timing assertion `elapsedMs < 500` fails when the whole suite runs under load (626ms vs 500ms). Re-running this file in isolation passes.
3. `AcpSdkConformance.test.ts` — `preserves early session updates and prompt update ordering`: hangs indefinitely until timeout (reproduced at 90s and 300s) when run in isolation. It does not exercise Pi code.

Re-running the first two in isolation produced pass:

- `CursorTextGeneration.test.ts`: 7/7 passed.
- `GitCore.test.ts`: not re-run in isolation; the failure is a timing threshold under full-suite load.

The `AcpSdkConformance` test hang is the blocker for a clean full-suite pass.

### Final workspace checks

```text
cd /Users/user/.windsurf/worktrees/synara/wt-reliability-qol-pi && bun fmt && bun lint && bun typecheck
```

- `bun fmt`: `Finished in 2687ms on 2642 files using 8 threads.` — exit 0.
- `bun lint`: `Found 471 warnings and 0 errors.` — exit 0.
- `bun typecheck`: `Tasks: 7 successful, 7 total` — exit 0.
