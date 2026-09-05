# Concurrent-thread performance: measured local changes

2026-09-05. These results compare the worktree at the start of this investigation, including its pre-existing snapshot/spinner/coalescing changes, with the additional fixes below. No Git commands, commits, provider turns or external writes were performed.

The component workload improved reproducibly. With one visible fenced-code message and 5 / 10 streams, median **total Chromium CPU fell 20.5% / 8.8%**, renderer CPU fell 31.6% / 20.7%, and renderer end-of-run RSS fell 17.7% / 19.4%. This is not a reproduction or resolution claim for the entire app becoming unusable with ten real providers.

## Implemented changes

- `apps/web/src/components/chat/useChatAutomationSetup.ts`: other transcripts are selected only while the automation draft dialog is open. A per-open memoized selector avoids a permanent module cache retaining transcript maps after closing. The production probe changed from 120 hook renders to zero during 60 hidden-thread flushes. Opening/reopening still sees current task data.
- `apps/web/src/components/BranchToolbar.tsx`: reuse the existing rate-limit activity selector instead of subscribing to every transcript solely to render provider usage. This change is source/test verified; the component probe does not mount BranchToolbar and supplies no separate performance percentage for it.
- `apps/web/src/components/ChatMarkdown.tsx`: stable named markdown render components receive current values through context. Code blocks no longer remount on raw deltas; soft wrap, copy/image state and highlighting timers survive. Empty marker decorations no longer recreate a remark plugin on every raw text arrival. The measured unchanged code block went from 60 remounts to zero per sample.
- `apps/web/src/orchestrationEventCoalescing.ts`: merge consecutive streaming deltas for the same message within each thread, allowing unrelated threads to interleave. Preserve same-thread structural events, message switches, completion boundaries and project/space boundaries. The previous A/B/A merge changed `latestTurn.assistantMessageId` from A to B. This repair prioritizes equivalent reducer state over the previous event-count percentage.
- Corrected the spinner utility's performance comment to distinguish GPU-process CPU from hardware utilization. Animation appearance and timing are unchanged by this investigation.

## Protocol and reproducibility

Hardware: Apple M5, 10 cores, 32 GiB RAM; macOS 26.6 / Darwin 25.6.0. Node 24.13.0, Bun 1.3.12, installed Playwright 1.62.1 with Chromium 151.0.7922.34. Production Vite build with React Compiler and `react-dom/profiling`; normal motion, headed isolated browser at 1400×900. Hardware GPU utilization and VRAM were not available.

`apps/web/perf/concurrent.tsx` uses real store reducers, normalized selectors, the automation hook and ChatMarkdown. Each task has 200 settled messages plus a ~14 KiB fenced JavaScript message. Each running task receives one identical 56-character delta every 100 ms: 60 batches, 6 seconds of input, plus 300 ms for trailing presentation. Warmup: 2 seconds after page load, then 10 untimed batches; force page GC immediately before measuring. Each sample uses a fresh browser context.

- `hidden`: 1/5/10 background streams, one idle visible panel.
- `visible`: 1/5/10 streams, exactly one visible streaming panel.
- Three samples per workload and variant, alternating baseline/optimized order between repeats: **36 measured samples**. All 36 preserve the complete expected stored text for every target and report no browser page errors.
- CPU is cumulative process CPU time from CDP `SystemInfo.getProcessInfo`; total includes browser, renderer, GPU process and utilities. RSS is sampled per PID at the end; it is **not peak RAM**. Post-GC heap is the page's JS heap, not process RSS or physical memory.
- Frame intervals come from requestAnimationFrame. The harness field `droppedFrames` means intervals over 20 ms, not a hardware dropped-frame counter. At 5 / 10 visible streams its median changed 58 / 53 → 0; p95 intervals changed 25 → 9.6 / 9.7 ms.
- Other applications remained running. Initial process inventory showed substantial unrelated Codex/WindowServer/browser load. No processes were killed. Use the ranges below; short samples do not certify long-session memory stability.
- This component probe excludes EventRouter, transport, sidebar, BranchToolbar, the full transcript list, Electron integration, providers and MCP processes. Ten synthetic retained transcripts are a stress workload; actual detail subscriptions are capped at eight per client.

Saved source baseline, builds, commands and complete logs are in `/private/tmp/synara-perf-independent-20260905`. The baseline source is archived as `baseline-source/source.tar`; output builds are `baseline-dist`, `optimized-dist`, and `final-dist`. Paired evidence was captured before the last selector-cache lifetime correction, which only changes open/close ownership. A final production build and two 10-stream confirmation samples exercised that correction: zero hidden hook renders, zero code remounts, correct text, no errors; visible total CPU 3.063 s and renderer RSS 349.8 MiB. These confirmation samples are separate from the three-sample comparison.

Commands from the repository root:

```sh
bun run --cwd apps/web build --config perf/vite.config.ts --outDir /private/tmp/synara-perf-independent-20260905/baseline-dist
# Make the scoped production changes, then preserve their build separately:
bun run --cwd apps/web build --config perf/vite.config.ts --outDir /private/tmp/synara-perf-independent-20260905/optimized-dist
node apps/web/perf/concurrent-runner.mjs /private/tmp/synara-perf-independent-20260905 paired
```

The runner serves only the local build directory and closes its isolated browser/server. Rebuilding baseline requires the saved pre-change source; do not overwrite baseline with current source and call it a before measurement.

## Paired medians

Positive percentages are reductions, computed as `(baseline - optimized) / baseline * 100`; absolute delta is optimized minus baseline. Raw data: [paired-browser.json](paired-browser.json), [final-probe.json](final-probe.json).

| Workload | Running tasks | Metric              |    Baseline |   Optimized | Absolute delta | Reduction |
| -------- | ------------: | ------------------- | ----------: | ----------: | -------------: | --------: |
| hidden   |             1 | Total Chromium CPU  |     0.631 s |     0.325 s |         -0.306 |    +48.5% |
| hidden   |             1 | Renderer CPU        |     0.388 s |     0.204 s |         -0.184 |    +47.5% |
| hidden   |             1 | Renderer RSS at end | 307.062 MiB | 306.641 MiB |         -0.422 |     +0.1% |
| hidden   |             1 | Post-GC page heap   |  14.120 MiB |  13.747 MiB |         -0.373 |     +2.6% |
| hidden   |             1 | GPU-process CPU     |     0.117 s |     0.114 s |         -0.003 |     +2.7% |
| hidden   |             1 | Frame interval p95  |    9.600 ms |   10.000 ms |         +0.400 |     -4.2% |
| hidden   |             5 | Total Chromium CPU  |     0.624 s |     0.357 s |         -0.267 |    +42.7% |
| hidden   |             5 | Renderer CPU        |     0.385 s |     0.236 s |         -0.149 |    +38.8% |
| hidden   |             5 | Renderer RSS at end | 307.344 MiB | 305.969 MiB |         -1.375 |     +0.4% |
| hidden   |             5 | Post-GC page heap   |  14.401 MiB |  14.013 MiB |         -0.388 |     +2.7% |
| hidden   |             5 | GPU-process CPU     |     0.119 s |     0.114 s |         -0.004 |     +3.7% |
| hidden   |             5 | Frame interval p95  |    9.600 ms |    9.600 ms |         +0.000 |     +0.0% |
| hidden   |            10 | Total Chromium CPU  |     0.625 s |     0.403 s |         -0.222 |    +35.6% |
| hidden   |            10 | Renderer CPU        |     0.408 s |     0.281 s |         -0.127 |    +31.2% |
| hidden   |            10 | Renderer RSS at end | 307.094 MiB | 306.125 MiB |         -0.969 |     +0.3% |
| hidden   |            10 | Post-GC page heap   |  14.839 MiB |  14.453 MiB |         -0.386 |     +2.6% |
| hidden   |            10 | GPU-process CPU     |     0.117 s |     0.114 s |         -0.004 |     +3.3% |
| hidden   |            10 | Frame interval p95  |    9.600 ms |    9.600 ms |         +0.000 |     +0.0% |
| visible  |             1 | Total Chromium CPU  |     3.574 s |     2.903 s |         -0.672 |    +18.8% |
| visible  |             1 | Renderer CPU        |     3.175 s |     2.219 s |         -0.956 |    +30.1% |
| visible  |             1 | Renderer RSS at end | 428.078 MiB | 350.922 MiB |        -77.156 |    +18.0% |
| visible  |             1 | Post-GC page heap   |  15.911 MiB |  15.572 MiB |         -0.339 |     +2.1% |
| visible  |             1 | GPU-process CPU     |     0.127 s |     0.107 s |         -0.019 |    +15.1% |
| visible  |             1 | Frame interval p95  |   25.000 ms |    9.700 ms |        -15.300 |    +61.2% |
| visible  |             5 | Total Chromium CPU  |     3.597 s |     2.858 s |         -0.738 |    +20.5% |
| visible  |             5 | Renderer CPU        |     3.196 s |     2.187 s |         -1.009 |    +31.6% |
| visible  |             5 | Renderer RSS at end | 428.516 MiB | 352.828 MiB |        -75.688 |    +17.7% |
| visible  |             5 | Post-GC page heap   |  16.181 MiB |  15.848 MiB |         -0.333 |     +2.1% |
| visible  |             5 | GPU-process CPU     |     0.129 s |     0.105 s |         -0.023 |    +18.1% |
| visible  |             5 | Frame interval p95  |   25.000 ms |    9.600 ms |        -15.400 |    +61.6% |
| visible  |            10 | Total Chromium CPU  |     3.440 s |     3.136 s |         -0.304 |     +8.8% |
| visible  |            10 | Renderer CPU        |     3.048 s |     2.417 s |         -0.631 |    +20.7% |
| visible  |            10 | Renderer RSS at end | 435.562 MiB | 350.891 MiB |        -84.672 |    +19.4% |
| visible  |            10 | Post-GC page heap   |  16.609 MiB |  16.262 MiB |         -0.347 |     +2.1% |
| visible  |            10 | GPU-process CPU     |     0.121 s |     0.112 s |         -0.010 |     +8.1% |
| visible  |            10 | Frame interval p95  |   25.000 ms |    9.700 ms |        -15.300 |    +61.2% |

Total Chromium CPU ranges over the three samples (seconds):

| Workload | Running tasks | Baseline min–max | Optimized min–max |
| -------- | ------------: | ---------------: | ----------------: |
| hidden   |             1 |      0.445–0.656 |       0.242–0.348 |
| hidden   |             5 |      0.430–0.655 |       0.348–0.380 |
| hidden   |            10 |      0.402–0.679 |       0.255–0.440 |
| visible  |             1 |      3.301–3.646 |       2.893–3.041 |
| visible  |             5 |      3.497–3.617 |       2.783–3.228 |
| visible  |            10 |      3.324–3.569 |       3.104–3.171 |

## Negative results and practical limits

The browser process used more CPU during visible streaming: at ten tasks its median rose **0.274 → 0.605 s**. Total Chromium CPU still decreased **3.440 → 3.136 s**. More frequent completed frames are a plausible explanation, but no compositor trace was captured to establish causality.

There is no meaningful RSS reduction in the hidden-stream case (under 0.5%). Post-GC heap decreases only about 2–3%; the RSS reduction is much larger than the post-GC JS heap reduction, and its allocation-level cause was not measured. This is not proof that a memory leak was removed. The dialog-cache ownership fix removes a concrete permanent reference, but React may temporarily retain a previous render; immediate collection is not guaranteed or measured.

GPU-process CPU changes are small and variable, especially for hidden streams. Do not translate these into hardware GPU or VRAM savings. This run does not retest the earlier spinner comparison against unsynchronized source.

## Server capacity probe and audit

The prior engine test held total deltas constant, so per-task transcript size shrank as concurrency increased. The corrected probe uses real file-backed WAL SQLite, constant **300 × 66 characters per task**, one discarded 30-delta-per-task pass across 1/5/10 tasks, followed by three measured passes with reversed task-count order and fresh temporary databases. Measured databases receive no streaming warmup. It records process CPU, sampled RSS, dispatch tails and WAL size, and asserts the final text of every task.

```sh
SYNARA_PERF=1 SYNARA_PERF_DELTAS=300 SYNARA_PERF_OUT=/private/tmp/synara-perf-independent-20260905/engine-wal.json bun run --cwd apps/server test -- perf/engineStreamingThroughput.perf.test.ts
```

| Tasks | Deltas | Median CPU ms | Median elapsed ms | Median dispatch p95 ms | Worst dispatch ms |
| ----- | -----: | ------------: | ----------------: | ---------------------: | ----------------: |
| 1     |    300 |         106.0 |                91 |                   0.36 |              1.71 |
| 5     |   1500 |         537.6 |               511 |                   2.86 |              5.79 |
| 10    |   3000 |         995.9 |               934 |                   4.65 |              7.93 |

Raw data: [engine-wal.json](engine-wal.json). This is an engine/projection **capacity** microbenchmark with sequential producers per task, not paced end-to-end latency. It bypasses provider ingestion/journaling, subscribed consumers, sockets and providers. The same Node process runs successive samples, so allocator/GC history contaminates cross-sample RSS; those RSS readings are not evidence of a leak or a concurrency-normalized memory comparison. `peakRss` is only the maximum sampled every 50 deltas, not a continuous peak. No production server changes or server speedup claims are made.

The read-only server audit found these specific remaining measurement targets:

| Area                  | Verified mechanism                                                                                                                                                | Next bounded experiment                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Event fanout          | `apps/server/src/wsRpc.ts` subscribes to the global event stream before per-thread filtering. Work scales with events × subscriptions (including across clients). | 1/5/8 actual detail subscriptions with fixed per-task ingress; measure server CPU and delivery p95 before considering keyed routing.                                     |
| Runtime journal       | Persisted events are read back and acknowledged individually; cursor acknowledgement involves multiple queries/transaction work.                                  | Measure SQL/transaction count and journal lag through real provider ingestion using a fake local producer. Preserve crash/replay boundaries.                             |
| Queue RAM             | Callback ingress has a 32 MiB budget; later queues are bounded by 2,048 items, not bytes.                                                                         | Stall a fake downstream consumer and inject distinct large tool outputs across ten tasks; measure retained bytes and terminal-event delivery. No silent event dropping.  |
| Active/idle providers | Codex sessions own provider processes; ordinary idle session retention is ten minutes.                                                                            | Measure a real ten-session process tree and post-completion retirement separately from Synara renderer/server. Shorter idle retention would not fix active-provider RAM. |
| Transcript storage    | Each streamed SQL append rewrites accumulated text; UI retention counts entries, not bytes.                                                                       | Larger fixed per-task messages and long mixed tool-output sessions; measure WAL/I/O, heap retention and delivery tails.                                                  |

The installed `@pierre/diffs` 1.2.12 already shares a singleton worker pool across providers/panels. It eagerly starts 2–6 workers on the first provider mount and terminates on the last unmount. The previous claim of a pool per panel was incorrect. Its two 240-entry AST caches remain a large-diff RAM hypothesis, not a demonstrated leak.

## Prior claims fact checked

- Full detail snapshots are fetched for leased tasks; there is an eight-lease cap. “Every running task” was too broad.
- The 72-second limit currently bounds projection **skips**, not all resynchronization scheduling: live events reset the 4.5-second due time and RPC/concurrency can delay work. This run makes no hard resync-cap claim.
- The old EventRouter performance fixture advanced authoritative sequence without applying the streamed transcript content. Its 8→2 comparison was not verified on matching current snapshots. No 75% snapshot-fetch claim is repeated here.
- The old 56% event-count reduction corresponded to only ~3% in its eight-task reducer timing, with weak sample ordering. The safer coalescer may merge fewer events around structural boundaries; no speedup percentage is claimed for this correctness repair.
- Earlier spinner results measured GPU-process CPU. The synchronization mechanism remains useful; it does not establish flat hardware GPU cost with any number of tasks.

## Verification and stopping point

- 110 distinct focused unit tests passed across markdown rendering/compiler, automation hook, selectors, coalescing/catchup policy and BranchToolbar logic; the automation reopening check was rerun after its final test update.
- 15 focused browser tests passed: stable code-block DOM/soft wrap, exact completed code, current checkbox callback, parse-free find, file actions and synchronized animation behavior.
- File-backed server probe passed final-message assertions for all warmup/measured workloads.
- Production profiling builds passed for baseline, optimized and final sources. Build output retains existing large-chunk/Browserslist warnings.
- Independent read-only auditors reviewed client state, rendering/dependency lifetime and server logic. Post-change audits found the selector-cache retention concern, which was fixed before the final confirmation build.
- `bun fmt`, `bun lint` and `bun typecheck` were not run, in accordance with the current root `AGENTS.md` instruction requiring explicit authorization. Build/runtime tests are not a substitute for type checking; full workspace verification remains outstanding.

Stopped after three bounded batches: subscription isolation, stable markdown rendering, and ordering-safe coalescing. The measured component gains justify keeping them. Further server queue/journal changes, renderer visibility scheduling and blur/worker-budget adjustments need their own representative traces and trade-off checks. The user's reported real-app failure still requires a representative ten-provider session trace before it can be called resolved.
