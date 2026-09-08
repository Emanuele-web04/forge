# Whole-codebase performance audit — 6 September 2026

Three parallel read-only auditors screened the complete repository. Six measured improvements were retained in nine production files: tool-output parsing, shared line counting, diff ordering, bounded browser-log reads, prior-transcript selection, and website theme synchronization. No dependencies were added.

## Coverage and selection

This was whole-tree static screening followed by deeper inspection and measurements of candidate execution paths. It is not a claim that every line was formally verified or every possible bottleneck measured.

| Area                        | Screened scope before additions                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web                         | All 1,226 source files: 807 runtime/type/style/generated files and 419 tests/support; components, stores, hooks, routes, transport, build configuration, scripts, existing probes and public assets                                                                                |
| Server                      | All 597 non-test TypeScript files, 190,153 lines across 22 source groups; providers/ACP, orchestration, SQLite, HTTP/WebSocket, terminals, device/video, workspace/Git/PR services, auth, gateways, automation, attachments and statistics; native helpers and build configuration |
| Desktop                     | 172 code/config/test files, including 75 tests; Electron startup, browser automation, Swift/AppSnap, snapshots, IPC, updates and launch scripts                                                                                                                                    |
| Marketing                   | 122 code/config/test files, including 14 tests; Next rendering, theme, navigation, public assets and configuration                                                                                                                                                                 |
| Shared                      | 145 files, including 66 tests; runtime utilities and common hot paths                                                                                                                                                                                                              |
| Contracts                   | 59 files, including 18 tests; schemas, limits and transport contracts                                                                                                                                                                                                              |
| Root scripts/infrastructure | 44 code/config/test files, including 14 tests; build/release helpers, seven workflows and workspace manifests                                                                                                                                                                      |

Auditors worked independently; benchmark processes ran serially. They also reviewed the candidate changes. The desktop review found and helped eliminate an exact one-byte truncation-boundary difference before final validation.

## Retained changes and evidence

1. **Tool-output parsing:** shared suffix extraction replaces duplicate expressions that repeatedly backtracked over long whitespace. Status-suffix stripping and pipe detection also avoid redundant regex scanning. A baseline CPU profile attributed 46.32% of self-samples to exit-suffix matching, 38.04% to status matching and 10.26% to pipe matching in this benchmark. These percentages describe this deliberately mixed benchmark, not normal whole-app CPU use. Ordinary 24 KB multiline work-log derivation improved 38%; a valid but adversarial 23,988-character whitespace-heavy output fell from 2.287 seconds to 0.053 ms. Raw indentation, exit codes and output content are preserved.
2. **Read summaries:** count line-feed characters without allocating a split array. A 2,000-line summary improved 58%; empty input, terminal newline and CRLF behavior stay the same. No measured RAM-saving percentage is claimed.
3. **Diff ordering:** lazily reuse one natural-order `Intl.Collator` in file-list and tree sorting, instead of supplying locale options on every string comparison. Sorting 2,048 paths improved 93%; tree construction improved 90%. Initialization remains lazy. Numeric padding, case/accent ties, default-locale ordering, directories-first ordering and input immutability are covered.
4. **Browser diagnostics:** retain the existing fast-path size check, then count the exact JSON UTF-8 bytes of a newest-entry suffix once. The old loop serialized and discarded the oldest entry repeatedly on the Electron main thread. Reading 200 large URL entries improved 98.8%, with the same 40 entries and 326,893-byte response. Tests preserve Unicode/escaping, filtering, history and dropped counts, and the original behavior when `truncated: false` is exactly one byte over budget.
5. **Server turn start:** prior-message selection checks trimmed nonemptiness without normalizing every message body. This runs on ordinary turn starts, including those needing no bootstrap. Selection from 2,000 total 2 KiB messages improved 98.9%. Original object identity, text, order, current-message boundary and streaming exclusion are unchanged. The separate bootstrap text formatter is untouched.
6. **Marketing idle activity:** write the HTML `dark` class only when the desired value changes. Previously, redundant writes triggered the script's MutationObserver, which scheduled another write indefinitely. In the independent repeated Chromium experiment, 427–430 observer callbacks per 1.1 seconds fell to zero; timer callbacks fell to the two intended settling callbacks. All dark/light/system behavior checks passed. The checked-in probe reproduced the baseline at 425–427 callbacks and verified the edited script at zero, in all three preference modes.

## Before and after

Node 24.13.0, Bun 1.3.12, Vitest 4.1.10, Apple M5, macOS/Darwin 25.6.0, arm64, 32 GiB RAM. Baseline source: `4ff0af3dfe6b34b94fc6018a421597d7f5900a04`, initially clean. Locked dependencies were installed; dependency manifests and the lockfile were not changed.

Each row below uses three fresh processes per version, three discarded warmup batches and eleven measured batches per case. The headline is the median of the three process medians. Ranges are the smallest/largest process medians, not confidence intervals. Iteration counts and all samples are in `measurements.json`. Run order was B1 → A1 → A2 → B2 → B3 → A3; the first diagnostics optimized run was repeated after the boundary fix. Fixtures, hashing and assertions are outside timing. Every case's output hash matches across all six runs.

| Workload                       |   Before ms | After ms |       Reduction | Before run range       | After run range   |
| ------------------------------ | ----------: | -------: | --------------: | ---------------------- | ----------------- |
| details/short                  |     0.00038 | 0.000193 |          49.19% | 0.000346–0.000417      | 0.000184–0.000197 |
| work-log/short                 |    0.007046 | 0.005791 |          17.81% | 0.006948–0.008632      | 0.005654–0.006401 |
| details/multiline-24k          |    0.044871 | 0.005876 |          86.90% | 0.040381–0.050126      | 0.005768–0.006126 |
| work-log/multiline-24k         |    0.741786 | 0.459812 |          38.01% | 0.684731–0.767025      | 0.446244–0.487573 |
| details/whitespace-24k         |  259.920417 | 0.005875 |         >99.99% | 227.60575–280.369208   | 0.005833–0.006667 |
| work-log/whitespace-24k        | 2287.289791 | 0.052667 |         >99.99% | 2234.344416–2494.19575 | 0.045292–0.053875 |
| read-summary/10-lines          |    0.000241 | 0.000114 |          52.78% | 0.000226–0.000272      | 0.00011–0.000123  |
| read-summary/2000-lines        |    0.035461 | 0.014923 |          57.92% | 0.033757–0.036104      | 0.014775–0.015485 |
| transcript/2000-messages       |     0.57399 | 0.566958 | control / noise | 0.56319–0.578938       | 0.550675–0.597083 |
| sort/32                        |     0.20909 | 0.012328 |          94.10% | 0.195657–0.210298      | 0.01219–0.012363  |
| tree/32                        |    0.145829 | 0.018568 |          87.27% | 0.14572–0.159262       | 0.018493–0.01933  |
| sort/512                       |    6.900879 | 0.499854 |          92.76% | 6.778429–7.501692      | 0.473558–0.510029 |
| tree/512                       |    2.981513 | 0.358521 |          87.98% | 2.901421–3.061638      | 0.322958–0.401554 |
| sort/2048                      |   36.452083 | 2.593033 |          92.89% | 35.265025–37.152871    | 2.591692–2.694158 |
| tree/2048                      |   18.888779 | 1.912208 |          89.88% | 17.658562–19.070988    | 1.881996–2.017383 |
| read/200-entries-100-char-url  |    0.045018 | 0.045687 | control / noise | 0.043217–0.045983      | 0.043052–0.050023 |
| read/200-entries-8000-char-url |   80.060375 | 0.963667 |          98.80% | 79.4475–83.699416      | 0.949333–0.9885   |
| select/32-messages-2KiB        |    0.028534 | 0.000507 |          98.22% | 0.027831–0.033786      | 0.000504–0.000534 |
| select/1000-messages-2KiB      |    0.917064 | 0.012276 |          98.66% | 0.90574–1.043392       | 0.010847–0.014202 |
| select/2000-messages-2KiB      |    1.832789 | 0.019538 |          98.93% | 1.774806–2.094458      | 0.018433–0.021593 |

The unchanged web-transcript control overlaps across runs. Small browser-log reads varied from 0.043–0.046 ms before and 0.043–0.050 ms after: the median difference is +1.5% (0.0007 ms), below the observed variation, with the same fast-path operations. Neither control is claimed as a performance win. Very short tool-detail samples also have noisy upper batches; no tail-latency improvement is claimed there.

Raw fields named `p95Ms` contain the maximum of eleven batch-average samples under nearest-rank calculation. They are not application request p95, and the report uses medians/ranges instead. These are isolated production-function workloads, not end-to-end response, startup or rendering measurements. The theme probe runs actual initializer source on synthetic HTML and simulates hydration class changes; it does not measure Next SSR, first paint or full-site CPU/energy. It is a manually invoked regression probe, not added CI coverage.

The existing real-SQLite streaming-engine probe was also run with 300 deltas per thread and one/five/ten producers, three repeats. Median processing was 0.371/0.351/0.306 ms per delta respectively. No engine implementation change was justified. Its sequential RSS observations do not establish a leak or memory improvement.

## Verification

- 352 focused unit/integration tests passed: 298 across tool outputs, work-log/transcript/session logic, shared summaries and ACP; 32 diff ordering/tree tests; 11 diagnostics tests; seven handoff tests; four selected provider turn-start/rebootstrap cases (182 unrelated reactor cases skipped).
- Eight Chromium transcript/tool-details/collapse checks passed.
- A temporary differential audit matched 8,192 combinations of whitespace, suffix and status inputs against the original implementations. Focused regression cases remain in the repository; the generated audit is not added to routine CI.
- The standalone theme probe passed all dark/light/system checks against both baseline and edited source: initial preference, simulated hydration repair with other classes retained, manual toggle, stored preference overriding OS changes, and system changes after removing the preference. The independent experiment repeated each variant/preference three times.
- Final workspace `bun fmt --check`, `bun lint` and `bun typecheck` all passed; typecheck covered all seven packages. Lint reports 529 warnings and zero errors. The final diagnostics test refinements also passed their focused tests, formatting, lint and desktop typecheck.

## Deferred candidates

These are concrete static leads, not measured wins. They remain unchanged until their benefit and correctness can be established.

| Priority | Candidate and production evidence                                                                                                                                                          | Next bounded measurement                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 1        | `apps/server/src/workspaceEntries.ts`: reference resolution rebuilds a basename map over up to 25,000 entries even with a warm 15-second index cache; web callers batch at 128 references. | Repeated warm-cache calls at 5,000/25,000 entries, with invalidation correctness and retained-memory accounting. |
| 2        | `apps/web/src/components/Sidebar.logic.ts`: project comparators rescan thread timestamps; also used by Kanban. Existing memoization prevents per-token repetition.                         | Realistic project/history sizes, including small cases and summary updates.                                      |
| 3        | `apps/server/src/orchestration/handoff.ts`: actual bootstrap normalization still uses a potentially expensive whitespace-before-newline regex before truncation.                           | Exported bootstrap builders with ordinary text and 8/16/32 KiB internal whitespace runs; exact output parity.    |
| 4        | `apps/server/src/profileStats.ts`: trailing-context patterns repeat newline-prefix scans for qualifying skill prompts.                                                                     | Actual aggregation with long internal blank runs and existing context-stripping tests.                           |
| 5        | ACP, browser-host RPC, device helper and desktop browser-use pipes repeatedly concatenate/split partial frames; some screenshot/upload frames permit 12 MiB.                               | Normal small frames versus fragmented 1/8 MiB frames; UTF-8, malformed input, limits and framing behavior.       |
| 6        | `apps/desktop/src/browserAutomation/semanticSnapshot.ts`: accessible names are computed twice for some candidates, with up to 20,000 candidates and 120 retained nodes.                    | Representative label-heavy pages; reuse only if CPU savings exceed added bookkeeping.                            |
| 7        | `apps/web/src/threadDerivation.ts`: `flatMap` creates one-element arrays on collection-cache misses; retained messages/activities are each capped at 2,000.                                | Real bound, cache hit/miss mix and complete reducer impact.                                                      |
| 8        | `apps/web/src/components/SidebarActivityView.logic.ts`: repeated status and timestamp calculations in sorting before pagination.                                                           | Mixed attention/settlement states with order-equivalence checks.                                                 |
| 9        | `packages/shared/src/logging.ts`: synchronous append per packaged backend output chunk.                                                                                                    | Actual output rates and main-thread impact before changing durability, rotation or shutdown semantics.           |

Broad rewrites, blanket memoization/virtualization, animation reductions, polling removal, extra caches and worker changes were not justified. Existing batching, visibility gates, resource limits, WAL tuning, bounded queues, lazy terminal-history materialization and busy-frame dropping already address many suspected costs.

## Reproduce

Run from the repository root with installed locked dependencies. The four new opt-in probes use the existing Vitest runner; the theme probe uses existing Playwright. Copy the unchanged probe files into a separate checkout of the baseline revision to compare production implementations. Run each version three times in alternating order on the same otherwise-idle machine, choosing a distinct output path each time.

```sh
SYNARA_PERF=1 SYNARA_PERF_OUT=/tmp/tool-output.json bun run --cwd apps/web test perf/toolOutput.perf.test.ts
SYNARA_PERF=1 SYNARA_PERF_OUT=/tmp/file-diff.json bun run --cwd apps/web test perf/fileDiff.perf.test.ts
SYNARA_PERF=1 SYNARA_PERF_OUT=/tmp/diagnostics.json bun run --cwd apps/desktop test perf/browserDiagnostics.perf.test.ts
SYNARA_PERF=1 SYNARA_PERF_OUT=/tmp/prior-transcript.json bun run --cwd apps/server test perf/priorTranscript.perf.test.ts
node apps/marketing/scripts/theme-smoke.mjs apps/marketing/src/components/ThemeScript.tsx /tmp/theme.json
```

For a baseline theme run, set `SYNARA_PERF=1` so the probe records the pre-fix idle callbacks while still checking behavior. Normal invocation asserts that the feedback loop is absent. Chromium must be installed for the existing Playwright dependency.

Raw output, hashes, environment, controls and server baseline: `measurements.json`. CPU sampling attribution: `profile-summary.json`. Measurements and local verification were completed before PR publication.
