# Final checks and comparison — 2026-09-08

**The requested repository checks pass, and the combined implementation is the recommended version to keep.** This pass rechecked PR #822 at `bf70dfd0e7ee1e512a633da3cc6e814d2f791b0b` and PR #1010 at `32d62c28c39229a42f8d9f31b160bf61996e494a`; both heads were unchanged. The comparison used their source snapshots and the current worktree, not their reported test counts.

## Final checks

| Check                          | Result                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `bun fmt`                      | Passed. Existing work was snapshotted first.                                               |
| `bun lint`                     | Passed: 0 errors, 549 warnings.                                                            |
| `bun typecheck`                | Passed across all 7 workspace packages, including the separately checked desktop fixtures. |
| Combined server regressions    | 421 tests passed in 32 files.                                                              |
| Provider lifecycle regressions | 6 selected tests passed; 184 unrelated cases were not selected.                            |
| Contracts and frame transport  | 22 tests passed.                                                                           |
| Production builds              | Web, server and desktop passed; the built server's dependency smoke check also passed.     |

The targeted pane/queue suite passed 23 tests, which overlap the combined server run. The preceding integration also passed 137 frontend tests, 12 desktop-host tests, and native revision 2's 60 pure tests plus 6 real control-plane cases. Those earlier runs were not all repeated here. No summed count mixes overlapping or historical runs.

Logs and scope are in the [final verification ledger](evidence/final-checks-2026-09-08/verification.json). Bun 1.4.2 was downloaded from its official release, verified against its published SHA256, and run from a temporary directory. The missing ignored Fumadocs index was regenerated using the existing postinstall generator; dependency versions and the lockfile were not changed.

## Additional fixes made during this pass

- **Cancelled pane input:** the RPC abort signal now reaches queue admission and active backend work. A cancelled click, scroll or key cannot remain queued and dispatch later. Detached pane work is rejected before it can create a fresh operation. The independent same-script reproduction changed late key and click dispatches from **1 to 0** for each case; cleanup still retains the operation lane until it finishes.
- **Unarchive restoration:** `thread.unarchived` now enters the durable provider event source. The regression proves archive cleanup finishes before restoration, and restoration finishes before the next provider turn. Restoration is replay-safe local state work, so an unrelated provider failure cannot discard it.
- **Session reuse:** computer capability lookup uses the actual reusable session's provider even when projected provider metadata is absent, avoiding an unnecessary restart.
- **Type correctness:** the recursive Computer schema now preserves its service-free codec type; conditional waits retain a narrowed window ID; coordinate checks expose their proven point type; optional frame callbacks and capability options match their actual lifecycle. Fixture contexts provide required fields.
- **Fixture coverage:** the production desktop project and cross-package fixtures have separate explicit TypeScript projects. All five fixture files remain checked with strictness intact, and Electron receives a numeric exit code. No check was disabled to obtain a pass.

## Comparison

| Area                     | Final assessment                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared core and frontend | Keep the combined implementation. It includes the selected improvements from the refreshed PRs and retains local immediate revocation, persistent Computer preferences, precise targeting and cleanup. This final pass also fixes the queued-input cancellation gap shared by the earlier local/upstream path. |
| Stop and uncertain input | Cua revision 2 retains stronger explicit cleanup acknowledgement and replacement-generation barriers. It now adds Space/target admission and fixes the exposed AX mutation fallback paths. No remaining blocking defect was found in the reviewed native scope.                                                |
| Native feature breadth   | Swift remains broader: actual application hover, background drag, pixel/two-axis/modified scrolling, and richer menu/offscreen accessibility actions. These are not advertised as supported by the Cua adapter.                                                                                                |
| RAM and performance      | No overall winner is established. The combined version removes diagnostic image retention, bounds cursor pending frames and stops hidden-pane work. Swift's smaller vector cursor and capture design remain promising. There is no equivalent current-version native workload measuring both implementations.  |

Detailed independent comparisons: [shared core](evidence/final-checks-2026-09-08/core-comparison.md), [frontend](evidence/final-checks-2026-09-08/frontend-comparison.md), and [native](evidence/final-checks-2026-09-08/native-comparison.md).

## Qualification boundary

The native patch, revision and universal binary are unchanged by this final check pass. Apple Silicon native tests/protocol probes ran during integration; Intel was compiled, not executed. This pass did not run fresh desktop input/capture, a signed-app provider round trip, a RAM soak or production signing/notarization. The historical 307.84 MiB measurement belongs to revision 1. The 699,469 → 475 byte result measures retained event serialization, not application RSS.

The requested local checks and comparison are complete. They do not establish that Cua is better than Swift in every capability or that either backend is production-qualified.
