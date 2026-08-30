# Delegation plan

Units: 1

The feedback bug-reporting feature is a single sequential feature. Review fixes touch the same prompt builder, dialog form, and sidebar wiring, so there is no clean file-boundary split. I handled it as one self-owned unit and used focused subagent review only for the prompt security audit (read-only), not parallel writes.

| #   | Unit                                                                                                                                                                             | Files (mine)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Worker    | Acceptance                                                                                                                                                                            | Status   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Implement and harden Plan 07: sidebar bug button, search-palette bug action, feedback dialog/store `initialCategory`, agent-drafted GitHub issue prompt, security fixes, and tests | `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/SidebarSearchPalette.tsx`, `apps/web/src/components/SidebarBugReportButton.tsx`, `apps/web/src/components/SidebarBugReportButton.test.tsx`, `apps/web/src/components/FeedbackDialog.tsx`, `apps/web/src/components/FeedbackDialog.test.tsx`, `apps/web/src/feedbackDialogStore.ts`, `apps/web/src/feedbackDialogStore.test.ts`, `apps/web/src/feedbackGithubIssue.ts`, `apps/web/src/feedbackGithubIssue.test.ts`, `apps/web/src/routes/__root.tsx`, `apps/web/src/feedback.ts` | worker-07 | Focused tests pass, `bun fmt && bun lint && bun typecheck` pass, branch SHA recorded, no unrelated files changed, no push/PR/issue created | verified |

## Rules of this ledger

- One row per unit. No two rows share a file.
- Acceptance is checkable: a command, a test, a measurable criterion. "Works" is not acceptance.
- Status: `pending` → `done` (worker reported) → `verified` (coordinator checked it themselves).
- No "done" for the task until every row is `verified`.

## Evidence

- `cd apps/web && bun run test src/feedbackGithubIssue.test.ts src/feedbackDialogStore.test.ts src/components/SidebarBugReportButton.test.tsx src/components/FeedbackDialog.test.tsx` — 4 test files, 21/21 tests passed.
- `cd apps/web && bun run test` — 330 test files, 4141 tests passed.
- `bun fmt` — passed.
- `bun lint` — 473 pre-existing warnings, 0 errors.
- `bun typecheck` — all 7 packages passed.
- No files changed outside the ledger's file list.
- No push, PR, or GitHub issue created.
