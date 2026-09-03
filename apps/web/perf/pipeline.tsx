// FILE: perf/pipeline.tsx
// Purpose: Pipeline-mode performance harness. Unlike perf/main.tsx (which sets component
//          state directly), this harness drives real orchestration domain events through
//          the production reducer -> zustand store -> selectors -> workLog/timeline
//          derivations -> ChatTranscriptPane, so per-flush store and derivation costs are
//          measured on the same code path the app runs while a thread streams.
// Layer: Perf tooling (dev-only page, not shipped in the app bundle)
// Exposes: window.__synaraPipelinePerf { runStream, runQuiet, scrollCycle, snapshot, resetMetrics }
//
// URL params:
//   messages=<n>      settled seed messages (default 200)
//   working=0         render as idle instead of mid-turn
//   instrument=1      patch getBoundingClientRect to count layout reads (keep OFF for
//                     uninstrumented timing runs — instrumented and timing runs are
//                     separate by design)
//   animations=off, shimmer=off, scrollFade=off   style cost toggles (see metrics.ts)

import "../src/index.css";

import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import {
  Profiler,
  StrictMode,
  useMemo,
  useRef,
  type ComponentProps,
  type ProfilerOnRenderCallback,
} from "react";
import { createRoot } from "react-dom/client";

import { ChatTranscriptPane } from "../src/components/chat/ChatTranscriptPane";
import { composerTranscriptBottomInsetPx } from "../src/components/chat/composerOverlay";
import {
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
} from "../src/components/chat/composerPickerStyles";
import { cn } from "../src/lib/utils";
import { useStore } from "../src/store";
import { createThreadSelector } from "../src/storeSelectors";
import { makeActivity, makeDomainEvent, makeState, makeThread } from "../src/storeTestFixtures";
import type { ChatMessage } from "../src/types";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../src/workLog";
import {
  createFrameCollector,
  durationStats,
  frameReport,
  installCostToggleStyles,
  scrollCycleOnTranscript,
  sleep,
  type DurationStats,
  type FrameReport,
} from "./metrics";
import { assistantText, buildStreamCorpus, isoAt } from "./workload";

type TimelineEntries = ComponentProps<typeof ChatTranscriptPane>["timelineEntries"];

type PipelineSnapshot = {
  reactCommits: number;
  reactCommitMs: number;
  storeCommits: number;
  longTasks: number;
  longTaskMs: number;
  gbcrCalls: number | null;
  domNodeCount: number;
  heapUsedBytes: number | null;
  scrollHeight: number;
  scrollTop: number;
};

type StreamRunOptions = {
  durationMs?: number;
  batchMs?: number;
  chunkChars?: number;
  activityEvery?: number;
};

type QuietRunOptions = {
  durationMs?: number;
  batchMs?: number;
  activitiesPerBatch?: number;
};

type RunReport = {
  scenario: "visible-streaming" | "quiet-running";
  options: Required<StreamRunOptions> | Required<QuietRunOptions>;
  elapsedMs: number;
  batches: number;
  frames: FrameReport;
  flush: DurationStats;
  reactCommits: number;
  reactCommitMs: number;
  storeCommits: number;
  longTasks: number;
  longTaskMs: number;
  gbcrCalls: number | null;
  gbcrPerBatch: number | null;
  finalTextLength: number;
  finalTextMatches: boolean | null;
  heapUsedBytes: number | null;
  domNodeCount: number;
};

declare global {
  interface Window {
    __synaraPipelinePerf: {
      runStream: (options?: StreamRunOptions) => Promise<RunReport>;
      runQuiet: (options?: QuietRunOptions) => Promise<RunReport>;
      scrollCycle: (cycles?: number) => Promise<FrameReport>;
      snapshot: () => PipelineSnapshot;
      resetMetrics: () => void;
      debugStreamText: () => unknown;
    };
  }

  interface Performance {
    memory?: {
      usedJSHeapSize: number;
    };
  }
}

const NOOP = () => {};
const EMPTY_TURN_DIFFS = new Map();
const EMPTY_REVERT_COUNTS = new Map();
const EMPTY_PROPOSED_PLANS: never[] = [];

const THREAD_ID = ThreadId.makeUnsafe("thread-pipeline");
const STREAM_TURN_ID = TurnId.makeUnsafe("pipeline-turn-streaming");
// Per-run stream message id so repeated runs in one page session append to a fresh
// message instead of merging into the previous run's text.
let streamRunIndex = 0;
let STREAM_MESSAGE_ID = MessageId.makeUnsafe("pipeline-message-streaming-0");

const params = new URLSearchParams(window.location.search);
const seedMessageCount = Math.max(1, Number(params.get("messages") ?? 200));
const working = params.get("working") !== "0";
const instrumentLayout = params.get("instrument") === "1";
// `composer=0` drops the floating composer overlay. By default the harness mounts the
// same frosted composer surface the app floats over the transcript (and the matching
// bottom inset + viewport mask), because that overlay is where the compositor cost of a
// streaming turn lives and a transcript-only harness cannot see it.
const composerOverlay = params.get("composer") !== "0";
const COMPOSER_OVERLAY_HEIGHT_PX = 148;
const composerInsetBottomPx = composerOverlay
  ? composerTranscriptBottomInsetPx(COMPOSER_OVERLAY_HEIGHT_PX)
  : 0;

installCostToggleStyles();

// ---------------------------------------------------------------------------
// Metrics collection (module-level so the driver and the component share it)
// ---------------------------------------------------------------------------

const metrics = {
  reactCommits: 0,
  reactCommitMs: 0,
  storeCommits: 0,
  longTasks: 0,
  longTaskMs: 0,
  gbcrCalls: 0,
};

function resetMetrics(): void {
  metrics.reactCommits = 0;
  metrics.reactCommitMs = 0;
  metrics.storeCommits = 0;
  metrics.longTasks = 0;
  metrics.longTaskMs = 0;
  metrics.gbcrCalls = 0;
}

if (instrumentLayout) {
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRectCounted(this: Element) {
    metrics.gbcrCalls += 1;
    return originalGetBoundingClientRect.call(this);
  };
}

if (typeof PerformanceObserver !== "undefined") {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      metrics.longTasks += 1;
      metrics.longTaskMs += entry.duration;
    }
  });
  try {
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // Long task timing is unsupported in this browser; counters stay at zero.
  }
}

// ---------------------------------------------------------------------------
// Store seeding: a long settled transcript in the REAL normalized store
// ---------------------------------------------------------------------------

function seedStore(messageCount: number): void {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    messages.push({
      id: MessageId.makeUnsafe(`pipeline-message-${index}`),
      role,
      text:
        role === "user"
          ? `Representative request ${index}: inspect rendering, scrolling, tools, terminals, and diffs.`
          : assistantText(index),
      createdAt: isoAt(index * 2),
      ...(role === "assistant" ? { completedAt: isoAt(index * 2 + 1) } : {}),
      streaming: false,
    });
  }
  const activities = [];
  for (let index = 25; index < messageCount; index += 25) {
    activities.push(
      makeActivity({
        id: `pipeline-seed-activity-${index}`,
        createdAt: isoAt(index * 2 + 1),
        kind: "tool.completed",
        summary: `Inspected ${index} repository files`,
        tone: "tool",
        sequence: index,
      }),
    );
  }
  const thread = makeThread({
    id: THREAD_ID,
    title: "Pipeline perf thread",
    messages,
    activities,
  });
  useStore.setState(makeState(thread));
}

seedStore(seedMessageCount);

useStore.subscribe(() => {
  metrics.storeCommits += 1;
});

// ---------------------------------------------------------------------------
// Event drivers: dispatch real domain events through the production reducer
// ---------------------------------------------------------------------------

let eventSequence = 1_000;

/** Dispatch one `thread.message-sent` event. While `streaming` is true the reducer treats
 *  `text` as a DELTA appended to the existing message (see mergeStreamingMessage); the
 *  final non-streaming event carries the full cumulative text and replaces via the
 *  startsWith branch — matching the transport's real semantics. */
function dispatchMessageDelta(text: string, streaming: boolean, batchIndex: number): number {
  eventSequence += 1;
  const occurredAt = isoAt(seedMessageCount * 2 + batchIndex);
  const event = makeDomainEvent(
    "thread.message-sent",
    {
      threadId: THREAD_ID,
      messageId: STREAM_MESSAGE_ID,
      role: "assistant",
      text,
      attachments: [],
      mentions: [],
      turnId: STREAM_TURN_ID,
      streaming,
      source: "native",
      createdAt: isoAt(seedMessageCount * 2),
      updatedAt: occurredAt,
    },
    { sequence: eventSequence, occurredAt },
  );
  lastDispatchedText = text;
  const start = performance.now();
  useStore.getState().applyOrchestrationEventsHotPath([event]);
  return performance.now() - start;
}

function dispatchActivityBatch(count: number, batchIndex: number): number {
  const occurredAt = isoAt(seedMessageCount * 2 + batchIndex);
  const events = Array.from({ length: count }, () => {
    eventSequence += 1;
    return makeDomainEvent(
      "thread.activity-appended",
      {
        threadId: THREAD_ID,
        activity: makeActivity({
          id: `pipeline-activity-${eventSequence}`,
          createdAt: occurredAt,
          kind: "tool.started",
          summary: `Tool call ${eventSequence}`,
          tone: "tool",
          turnId: "pipeline-turn-streaming",
          sequence: eventSequence,
        }),
      },
      { sequence: eventSequence, occurredAt },
    );
  });
  const start = performance.now();
  useStore.getState().applyOrchestrationEventsHotPath(events);
  return performance.now() - start;
}

function readStreamedMessageText(): string | null {
  const message = useStore.getState().messageByThreadId[THREAD_ID]?.[STREAM_MESSAGE_ID];
  return message?.text ?? null;
}

let lastDispatchedText = "";

/** Diagnostic for finalTextMatches failures: where does the stored message diverge
 *  from the last dispatched text? */
function debugStreamText() {
  const stored = readStreamedMessageText();
  const expected = lastDispatchedText;
  if (stored === null) return { stored: null, expectedLength: expected.length };
  let firstDiff = -1;
  const max = Math.max(stored.length, expected.length);
  for (let index = 0; index < max; index += 1) {
    if (stored[index] !== expected[index]) {
      firstDiff = index;
      break;
    }
  }
  return {
    storedLength: stored.length,
    expectedLength: expected.length,
    firstDiff,
    storedAround: firstDiff >= 0 ? stored.slice(Math.max(0, firstDiff - 40), firstDiff + 40) : "",
    expectedAround:
      firstDiff >= 0 ? expected.slice(Math.max(0, firstDiff - 40), firstDiff + 40) : "",
    message: useStore.getState().messageByThreadId[THREAD_ID]?.[STREAM_MESSAGE_ID] ?? null,
  };
}

const frameCollector = createFrameCollector();

/** Visible-streaming scenario: one message-sent delta per batch (default 100ms cadence,
 *  matching the transport throttler), with an activity batch every `activityEvery`
 *  batches. Mirrors an active turn producing text plus occasional tool events. */
async function runStream(options: StreamRunOptions = {}): Promise<RunReport> {
  const resolved = {
    durationMs: options.durationMs ?? 60_000,
    batchMs: options.batchMs ?? 100,
    chunkChars: options.chunkChars ?? 80,
    activityEvery: options.activityEvery ?? 5,
  };
  const expectedBatches = Math.ceil(resolved.durationMs / resolved.batchMs);
  const corpus = buildStreamCorpus(expectedBatches * resolved.chunkChars + resolved.chunkChars);

  streamRunIndex += 1;
  STREAM_MESSAGE_ID = MessageId.makeUnsafe(`pipeline-message-streaming-${streamRunIndex}`);
  resetMetrics();
  const flushDurations: number[] = [];
  frameCollector.start();
  const startedAt = performance.now();
  let batches = 0;
  let text = "";

  while (performance.now() - startedAt < resolved.durationMs) {
    const nextLength = (batches + 1) * resolved.chunkChars;
    const chunk = corpus.slice(batches * resolved.chunkChars, nextLength);
    text = corpus.slice(0, nextLength);
    flushDurations.push(dispatchMessageDelta(chunk, true, batches));
    if (resolved.activityEvery > 0 && batches > 0 && batches % resolved.activityEvery === 0) {
      flushDurations.push(dispatchActivityBatch(2, batches));
    }
    batches += 1;
    await sleep(resolved.batchMs);
  }

  flushDurations.push(dispatchMessageDelta(text, false, batches));
  const elapsedMs = performance.now() - startedAt;
  const frames = frameCollector.stop();
  const storedText = readStreamedMessageText();

  return {
    scenario: "visible-streaming",
    options: resolved,
    elapsedMs,
    batches,
    frames: frameReport(frames),
    flush: durationStats(flushDurations),
    reactCommits: metrics.reactCommits,
    reactCommitMs: metrics.reactCommitMs,
    storeCommits: metrics.storeCommits,
    longTasks: metrics.longTasks,
    longTaskMs: metrics.longTaskMs,
    gbcrCalls: instrumentLayout ? metrics.gbcrCalls : null,
    gbcrPerBatch: instrumentLayout && batches > 0 ? metrics.gbcrCalls / batches : null,
    finalTextLength: text.length,
    finalTextMatches: storedText === null ? null : storedText === text,
    heapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
    domNodeCount: document.getElementsByTagName("*").length,
  };
}

/** Quiet-running scenario: the turn is active but produces only tool activity, no
 *  visible text growth. Isolates the per-flush store/derivation cost that remains
 *  when nothing in the transcript text changes. */
async function runQuiet(options: QuietRunOptions = {}): Promise<RunReport> {
  const resolved = {
    durationMs: options.durationMs ?? 60_000,
    batchMs: options.batchMs ?? 100,
    activitiesPerBatch: options.activitiesPerBatch ?? 2,
  };

  resetMetrics();
  const flushDurations: number[] = [];
  frameCollector.start();
  const startedAt = performance.now();
  let batches = 0;

  while (performance.now() - startedAt < resolved.durationMs) {
    flushDurations.push(dispatchActivityBatch(resolved.activitiesPerBatch, batches));
    batches += 1;
    await sleep(resolved.batchMs);
  }

  const elapsedMs = performance.now() - startedAt;
  const frames = frameCollector.stop();

  return {
    scenario: "quiet-running",
    options: resolved,
    elapsedMs,
    batches,
    frames: frameReport(frames),
    flush: durationStats(flushDurations),
    reactCommits: metrics.reactCommits,
    reactCommitMs: metrics.reactCommitMs,
    storeCommits: metrics.storeCommits,
    longTasks: metrics.longTasks,
    longTaskMs: metrics.longTaskMs,
    gbcrCalls: instrumentLayout ? metrics.gbcrCalls : null,
    gbcrPerBatch: instrumentLayout && batches > 0 ? metrics.gbcrCalls / batches : null,
    finalTextLength: 0,
    finalTextMatches: null,
    heapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
    domNodeCount: document.getElementsByTagName("*").length,
  };
}

function snapshot(): PipelineSnapshot {
  const scrollContainer = document.querySelector<HTMLElement>(
    "[data-chat-scroll-container='true']",
  );
  return {
    reactCommits: metrics.reactCommits,
    reactCommitMs: metrics.reactCommitMs,
    storeCommits: metrics.storeCommits,
    longTasks: metrics.longTasks,
    longTaskMs: metrics.longTaskMs,
    gbcrCalls: instrumentLayout ? metrics.gbcrCalls : null,
    domNodeCount: document.getElementsByTagName("*").length,
    heapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
    scrollHeight: scrollContainer?.scrollHeight ?? 0,
    scrollTop: scrollContainer?.scrollTop ?? 0,
  };
}

window.__synaraPipelinePerf = {
  runStream,
  runQuiet,
  scrollCycle: scrollCycleOnTranscript,
  snapshot,
  resetMetrics,
  debugStreamText,
};

// ---------------------------------------------------------------------------
// Component: real selector + real ChatView derivation chain -> real pane
// ---------------------------------------------------------------------------

function PipelineHarness() {
  const selectThread = useMemo(() => createThreadSelector(THREAD_ID), []);
  const thread = useStore(selectThread);
  const listRef = useRef<LegendListRef | null>(null);

  const messages = thread?.messages ?? [];
  const activities = thread?.activities ?? [];
  const proposedPlans = thread?.proposedPlans ?? EMPTY_PROPOSED_PLANS;

  // Same derivation chain ChatView runs per store flush (workLog entries from
  // activities, then merged timeline entries), memoized on the same identities.
  const workEntries = useMemo(
    () =>
      deriveWorkLogEntries(activities, working ? STREAM_TURN_ID : undefined, {
        activeTurnId: working ? STREAM_TURN_ID : null,
        activeTurnStartedAt: working ? isoAt(seedMessageCount * 2) : null,
      }),
    [activities],
  );
  const timelineEntries: TimelineEntries = useMemo(
    () => deriveTimelineEntries(messages, proposedPlans, workEntries),
    [messages, proposedPlans, workEntries],
  );

  return (
    <main className="relative flex h-screen min-h-0 w-screen bg-background text-foreground">
      <ChatTranscriptPane
        {...(composerInsetBottomPx ? { contentInsetBottomPx: composerInsetBottomPx } : {})}
        activeThreadId={THREAD_ID}
        activeTurnId={working ? STREAM_TURN_ID : null}
        activeTurnInProgress={working}
        activeTurnStartedAt={working ? isoAt(seedMessageCount * 2) : null}
        chatFontSizePx={15}
        emptyStateProjectName={undefined}
        hasMessages
        isRevertingCheckpoint={false}
        isWorking={working}
        followLiveOutput={working}
        listRef={listRef}
        markdownCwd={undefined}
        onExpandTimelineImage={NOOP}
        onMessagesClickCapture={NOOP}
        onMessagesMouseUp={NOOP}
        onMessagesPointerCancel={NOOP}
        onMessagesPointerDown={NOOP}
        onMessagesPointerUp={NOOP}
        onMessagesTouchEnd={NOOP}
        onMessagesTouchMove={NOOP}
        onMessagesTouchStart={NOOP}
        onMessagesWheel={NOOP}
        onMessagesScroll={NOOP}
        onIsAtEndChange={NOOP}
        onOpenTurnDiff={NOOP}
        onOpenThread={NOOP}
        onRevertUserMessage={NOOP}
        onScrollToBottom={NOOP}
        onToggleWorkGroup={NOOP}
        resolvedTheme="dark"
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        scrollButtonVisible={false}
        terminalWorkspaceTerminalTabActive={false}
        timelineEntries={timelineEntries}
        timestampFormat="locale"
        turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
        workspaceRoot={undefined}
        worktreeSetup={null}
      />
      {composerOverlay ? (
        // Same shell/surface classes as the real composer so index.css applies the
        // identical glass (`.chat-composer-surface::before` backdrop-filter).
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4"
          style={{ height: COMPOSER_OVERLAY_HEIGHT_PX }}
        >
          <div className={cn(COMPOSER_INPUT_SHELL_CLASS_NAME, "w-full max-w-3xl")}>
            <div
              className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "h-32 rounded-3xl")}
              data-perf-composer-overlay="true"
            />
          </div>
        </div>
      ) : null}
    </main>
  );
}

const handleRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  metrics.reactCommits += 1;
  metrics.reactCommitMs += actualDuration;
};

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element.");

createRoot(rootElement).render(
  <StrictMode>
    <Profiler id="synara-pipeline-perf" onRender={handleRender}>
      <PipelineHarness />
    </Profiler>
  </StrictMode>,
);
