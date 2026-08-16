# Streaming pipeline — optimized results, 2026-08-14

Phase 5 (paired re-measurement) of the chat-runtime performance pass. Same harness, same
protocol, same machine as the baseline
(`docs/performance/2026-08-14-streaming-pipeline-baseline.md`): pipeline-mode harness
(`apps/web/perf/pipeline.tsx`) driving real domain events through the production
reducer → store → selectors → derivations → `ChatTranscriptPane`; production build with
`react-dom/profiling`; 200 seed messages; warm-up run + page reload between samples;
5 streaming samples, 3 quiet samples, 60 s each. Raw JSONL:
baseline `/tmp/synara-baseline/*.jsonl`, optimized `/tmp/synara-optimized/*.jsonl`.

**Measurement boundary:** these recorded samples predate the profiler-boundary correction
in this PR, so `React commit time` covers the transcript subtree but not the parent selector
and work-log/timeline derivations. The two columns remain like-for-like. Future harness runs
include those derivations and must not be compared numerically with these historical values.

## Headline (medians, 60 s visible streaming)

| metric                          | baseline                         | optimized                        | change                                          |
| ------------------------------- | -------------------------------- | -------------------------------- | ----------------------------------------------- |
| React commit time               | 35 430 ms (**≈59% of one core**) | 11 017 ms (**≈18% of one core**) | **−68.9%**                                      |
| React commits                   | 13 780 (~230/s)                  | 5 429 (~90/s)                    | **−60.6%**                                      |
| store commits (flushes)         | 692                              | 702                              | unchanged (same workload)                       |
| commit amplification vs flushes | ~20×                             | ~7.7×                            | −62%                                            |
| worst frame                     | 26–117 ms                        | 9–25 ms                          | long stalls gone                                |
| dropped frames (of ~7 200)      | 0–6                              | 0–2                              | —                                               |
| long tasks                      | 0–2                              | 0                                | —                                               |
| reducer+flush total             | ~92 ms                           | ~97 ms                           | unchanged (already negligible)                  |
| JS heap after run               | 249–466 MB                       | 26–71 MB                         | large drop (indicative; heap sampling is noisy) |
| `finalTextMatches`              | true ×5                          | true ×5                          | text integrity preserved                        |

Quiet-running (activity-only) medians: 615 ms → 635 ms commit time per 60 s (~1% of a
core, within run-to-run noise). The quiet transcript path was already cheap; the quiet-path
wins of this pass live in the periodic layer (below), which this harness does not mount.

## What changed (by phase)

- **Phase 1 — zero-risk selector/store fixes.** Module-level selectors for the usage menu
  and split chat surface, `lastRememberedProjects` guard, backward scan for message ids,
  activity dedupe fast paths, `orderedActivities` WeakMap cache. Mostly benefits
  components outside this harness (multi-thread load, sidebar, usage menu).
- **Phase 3 — reveal commit quantization** (`useSmoothStreamedText`,
  `MIN_EMIT_INTERVAL_MS = 40`). The reveal float still advances every frame, but React
  commits are batched to ~25/s instead of ~120/s. This is the headline lever: each commit
  re-renders the growing message (markdown re-parse ∝ length), so quantizing the cadence
  scales the whole per-commit pipeline down together. Completion snap, reduced-motion,
  non-append reset, and background-resume clamp are preserved — stepper math is pinned
  by `useSmoothStreamedText.test.ts`, and the hook-level wiring (completion snap,
  reduced-motion bypass, non-append reset, mount-text passthrough) by
  `useSmoothStreamedText.browser.tsx` in the browser-mode suite.
- **Phase 2 — per-token transcript/scroll work.** Message-trail preview WeakMap caches
  (kills O(transcript-text) regex per pane render), overlap-guard bottom-most fast path
  (kills ~1 forced `getBoundingClientRect` per commit while streaming),
  `transcriptTailKey` no longer keys on text length while streaming (stops re-scheduling
  the follow `scrollToEnd` rAF every flush; LegendList `maintainScrollAtEnd` owns
  within-message growth; once settled, length is back in the key so a projection repair
  that rewrites a settled tail in place still re-sticks the follow), scroll-handler rAF
  coalescing for trail-highlight derivation (user-gesture suppression and at-end
  tracking stay synchronous — ChatView's auto-follow reads at-end state the same frame).
- **Phase 4 — periodic layer backoff** (`__root.tsx`). Bounded no-op backoff keyed on
  `(threadId, turnId)`: empty replay polls back off 1.5 s → 3 s → 6 s (cap), no-op
  projection reconciles 4.5 s → 9 s → 18 s (cap). Any applied event, new turn, or pending
  dispatch resets to base immediately; repair paths (missing snapshot, pending dispatch,
  terminal fence, draft promotion) are never backed off. Not visible in this harness —
  it reduces steady-state background RPC + reducer work per open thread.

## Interpretation

- The reported symptom (laptop heat/CPU during long-running threads with a smooth UI) was
  a pure duty-cycle problem: ~59% of a core spent in React commits during visible
  streaming. That is now ~18%, with the remaining cost dominated by the ~25/s reveal
  commits plus the deferred markdown commits that follow them.
- Per-commit cost also fell (~2.57 ms → ~2.03 ms median) from the Phase 2 removals
  (layout read + tail-key rAF + preview regex), on top of the 2.5× reduction in commit
  count.
- Frame pacing improved: worst frame 117 ms → 9 ms on like-for-like samples, zero long
  tasks. Streaming remains visually smooth (multi-character reveal at ~25 Hz).
- Remaining headroom (not taken, needs sign-off): rendering the growing message as plain
  text while streaming (skip Shiki/markdown until settle) if profiling ever shows the
  residual ~18% dominated by markdown parse; live ingestion of `textSegments` on the
  `thread.message-sent` reducer path (see tool-ordering note in the session summary).
