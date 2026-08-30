# Gates for Plan 6: Attach GitHub issues/PRs

## Acceptance criteria (binary)

1. [ ] "Attach issue or PR" appears in the composer "+" menu with correct disabled/hidden states.
2. [ ] Empty-query dialog lists ≤20 recently updated open issues/PRs; typing filters via gh with 300ms debounce.
3. [ ] Selecting a row attaches a removable chip; duplicates/6th attach are impossible.
4. [ ] Chips survive page reload and prompt-history browse/restore.
5. [ ] Sending appends one `<attached_work_items>` block after pasted texts, before browser annotations.
6. [ ] Transcript user bubble shows compact chips, never the raw block; copied message text excludes the block.
7. [ ] Queued turns carry work items and serialize identically.
8. [ ] gh unauthenticated: menu disabled with hint once availability query errors; dialog shows hint + Retry; no crash.
9. [ ] Empty/edge repos produce the correct empty-state texts.
10. [ ] `git grep` shows no GitHub mutation commands; contracts diff is schemas/types only; no new package.json dependencies.

## Verification gates

- [ ] `cd packages/contracts && bun run test src/workItems.test.ts` passes.
- [ ] `cd apps/web && bun run test src/lib/composerWorkItems.test.ts src/lib/terminalContext.test.ts` passes.
- [ ] `cd apps/server && bun run test src/pullRequests src/git` passes.
- [ ] `bun fmt && bun lint && bun typecheck` passes.
