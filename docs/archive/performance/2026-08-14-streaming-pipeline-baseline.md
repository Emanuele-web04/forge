# Streaming pipeline baseline — 2026-08-14

Phase 0 of the chat-runtime performance pass. All numbers from the new **pipeline-mode
harness** (`apps/web/perf/pipeline.tsx`), which drives real `thread.message-sent` /
`thread.activity-appended` domain events through the production reducer → zustand store →
selectors → workLog/timeline derivations → `ChatTranscriptPane`, unlike the older
`perf/main.tsx` harness that set component state directly (and therefore could not see any
of this cost).

## Method

- Production Vite build (`perf/vite.config.ts`), served via `vite preview`; `react-dom/client`
  aliased to `react-dom/profiling` so `<Profiler>` reports commit counts/durations at
  production-level code (standard prod React never calls `onRender`).
- Workload: 200 settled seed messages, then 60 s of streaming — one 80-char markdown delta
  per 100 ms batch (matching the transport throttler cadence), an activity pair every 5
  batches, final non-streaming settle event. Deterministic corpus → identical bytes per run.
- Streaming deltas are dispatched with the reducer's real semantics (per-batch text deltas
  while `streaming: true`; full-text replace on settle) and each run asserts
  `finalTextMatches` (store text === dispatched text).
- Warm-up run before each sample; page reloaded between samples; 5 samples (streaming),
  3 samples (quiet; spread <1%). 120 Hz display, M-series MacBook.
- Instrumented runs (dev build + patched `Element.prototype.getBoundingClientRect`) kept
  **separate** from timing runs.
- Raw sample JSONL: `/tmp/synara-baseline/*.jsonl` (this file records the medians).

**Caveats:** the harness measures the Chromium renderer main thread, not packaged-app
process CPU%; it mounts only the transcript pane (no sidebar, `SplitChatSurface`,
`ProviderUsageMenuControl`), so per-flush costs in those components — targeted by the
selector fixes — are _under_-represented here; GPU/compositor cost (animations) is out of
scope by request. These recorded samples predate the profiler-boundary correction in this
PR, so `React commit time` covers the transcript subtree but not the parent selector and
work-log/timeline derivations. The baseline and optimized samples remain like-for-like;
future harness output includes those derivations and must not be compared numerically with
the historical values below.

## Results (medians)

### Visible streaming, 60 s, 200-message transcript (5 samples)

| metric                   | value                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| store commits (flushes)  | ~690                                                                                                                          |
| React commits            | ~13 800 (**~20× amplification** vs store flushes; ~1.9 per 120 Hz frame — reveal commit + `useDeferredValue` markdown commit) |
| React commit time        | **35.4 s per 60 s window ≈ 59% of one core**                                                                                  |
| reducer+store flush time | ~90 ms total (~0.15%) — negligible                                                                                            |
| long tasks               | 0–2; dropped frames 0–6 of ~7 200                                                                                             |

No jank, pure duty cycle: exactly matches the reported symptom (heat/CPU while a thread
runs, UI still smooth).

### Quiet running (activity-only turn), 60 s (3 samples)

React commit time ~615 ms per 60 s (~1% of a core), ~3.1 commits per activity batch.
The quiet path is ~57× cheaper than visible streaming.

### Scaling probes

- **Transcript length barely matters** (virtualization works): 800-message run keeps flush
  ≤0.24 ms mean and commit cost _per commit_ unchanged for equal streamed-text length.
- **Streamed message length is the driver**: per-commit cost ~1.5 ms at ~24 k chars grown
  → ~2.6 ms at ~47 k. The growing message is re-rendered (markdown re-parse of the full
  text) on every reveal commit.
- Scroll cycle (800 msgs): p95 9.1 ms, 0 dropped — scrolling itself is healthy.
- Layout reads: ~1 `getBoundingClientRect` per React commit (frame-bound, not batch-bound).

## Implications for the optimization phases

1. The dominant lever (~59% of a core) is the **per-frame commit loop while streaming**:
   `useSmoothStreamedText` commits at display refresh and each commit re-renders the
   growing message (plus a second deferred markdown commit). Reveal cadence quantization +
   bounding per-commit markdown work is where the headline win lives (Phase 3, thresholds
   from these numbers).
2. Reducer/store/selector flush work is already cheap in the transcript path; the Phase 1
   zero-risk fixes matter mostly for the components this harness does not mount
   (usage menu / split view selector-factory-in-render) and for multi-thread load.
3. Quiet turns are near-free in the transcript; background-thread cost must come from the
   periodic layer (reconcile/replay) and server pipeline, not this render path (Phase 4).
