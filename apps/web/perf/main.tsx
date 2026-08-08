import "../src/index.css";

import { MessageId, TurnId } from "@synara/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import {
  Profiler,
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ProfilerOnRenderCallback,
} from "react";
import { createRoot } from "react-dom/client";

import { ChatTranscriptPane } from "../src/components/chat/ChatTranscriptPane";

type TimelineEntries = ComponentProps<typeof ChatTranscriptPane>["timelineEntries"];

type FrameReport = {
  count: number;
  droppedFrames: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
};

type PerfSnapshot = {
  commitCount: number;
  commitDurationMs: number;
  domNodeCount: number;
  heapUsedBytes: number | null;
  longTaskCount: number;
  longTaskDurationMs: number;
  scrollHeight: number;
  scrollTop: number;
};

declare global {
  interface Window {
    __synaraPerf: {
      appendStreamingChunks: (count?: number) => Promise<FrameReport>;
      resetMetrics: () => void;
      scrollCycle: (cycles?: number) => Promise<FrameReport>;
      snapshot: () => PerfSnapshot;
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
const BASE_TIME_MS = Date.parse("2026-08-08T12:00:00.000Z");

function isoAt(index: number): string {
  return new Date(BASE_TIME_MS + index * 1_000).toISOString();
}

function assistantText(index: number): string {
  if (index % 10 === 0) {
    return [
      `## Performance result ${index}`,
      "",
      "This response contains representative Markdown, lists, and a highlighted code block.",
      "",
      "- preserves streaming order",
      "- keeps tool calls responsive",
      "- avoids unrelated transcript work",
      "",
      "```ts",
      `export function sample${index}(items: readonly number[]) {`,
      "  return items.reduce((total, item) => total + item, 0);",
      "}",
      "```",
    ].join("\n");
  }
  if (index % 7 === 0) {
    return Array.from(
      { length: 18 },
      (_, paragraph) =>
        `Paragraph ${paragraph + 1}: representative long Markdown text for transcript row ${index}.`,
    ).join("\n\n");
  }
  return `Measured assistant response ${index}. The completed row should remain stable during unrelated updates.`;
}

function createTimelineEntries(messageCount: number, streamingText: string): TimelineEntries {
  const entries: TimelineEntries = [];
  const settledMessageCount = Math.max(1, messageCount - 1);
  for (let index = 0; index < settledMessageCount; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    const id = MessageId.makeUnsafe(`perf-message-${index}`);
    entries.push({
      id,
      kind: "message",
      createdAt: isoAt(index * 2),
      message: {
        id,
        role,
        text:
          role === "user"
            ? `Representative request ${index}: inspect rendering, scrolling, tools, terminals, and diffs.`
            : assistantText(index),
        createdAt: isoAt(index * 2),
        ...(role === "assistant" ? { completedAt: isoAt(index * 2 + 1) } : {}),
        streaming: false,
      },
    });
    if (index > 0 && index % 25 === 0) {
      entries.push({
        id: `perf-work-${index}`,
        kind: "work",
        createdAt: isoAt(index * 2 + 1),
        entry: {
          id: `perf-work-${index}`,
          createdAt: isoAt(index * 2 + 1),
          label: `Inspected ${index} repository files`,
          toolTitle: "Repository inspection",
          tone: "tool",
        },
      });
    }
  }

  const streamingId = MessageId.makeUnsafe("perf-message-streaming");
  entries.push({
    id: streamingId,
    kind: "message",
    createdAt: isoAt(messageCount * 2),
    message: {
      id: streamingId,
      role: "assistant",
      turnId: TurnId.makeUnsafe("perf-turn-streaming"),
      text: streamingText,
      createdAt: isoAt(messageCount * 2),
      streaming: true,
    },
  });
  return entries;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0;
}

function frameReport(durations: readonly number[]): FrameReport {
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    count: durations.length,
    droppedFrames: durations.filter((duration) => duration > 20).length,
    meanMs: durations.length > 0 ? total / durations.length : 0,
    p95Ms: percentile(durations, 0.95),
    maxMs: Math.max(0, ...durations),
  };
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function installCostToggleStyles(): void {
  const params = new URLSearchParams(window.location.search);
  const style = document.createElement("style");
  if (params.get("animations") === "off") {
    style.textContent += `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    `;
  }
  if (params.get("shimmer") === "off") {
    style.textContent += `
      .shimmer {
        animation: none !important;
      }
    `;
  }
  if (params.get("scrollFade") === "off") {
    style.textContent += `
      .scroll-fade-b {
        animation: none !important;
        -webkit-mask-image: none !important;
        mask-image: none !important;
      }
    `;
  }
  document.head.append(style);
}

installCostToggleStyles();

function PerformanceHarness() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const messageCount = Math.max(1, Number(params.get("messages") ?? 100));
  const working = params.get("working") !== "0";
  const [streamingText, setStreamingText] = useState(
    "Streaming response baseline. New chunks should update only this final row.",
  );
  const listRef = useRef<LegendListRef | null>(null);
  const commitCountRef = useRef(0);
  const commitDurationMsRef = useRef(0);
  const longTaskCountRef = useRef(0);
  const longTaskDurationMsRef = useRef(0);

  const timelineEntries = useMemo(
    () => createTimelineEntries(messageCount, streamingText),
    [messageCount, streamingText],
  );

  const handleRender: ProfilerOnRenderCallback = useCallback((_id, _phase, actualDuration) => {
    commitCountRef.current += 1;
    commitDurationMsRef.current += actualDuration;
  }, []);

  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCountRef.current += 1;
        longTaskDurationMsRef.current += entry.duration;
      }
    });
    try {
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      return;
    }
    return () => observer.disconnect();
  }, []);

  const resetMetrics = useCallback(() => {
    commitCountRef.current = 0;
    commitDurationMsRef.current = 0;
    longTaskCountRef.current = 0;
    longTaskDurationMsRef.current = 0;
  }, []);

  const snapshot = useCallback((): PerfSnapshot => {
    const scrollContainer = document.querySelector<HTMLElement>(
      "[data-chat-scroll-container='true']",
    );
    return {
      commitCount: commitCountRef.current,
      commitDurationMs: commitDurationMsRef.current,
      domNodeCount: document.getElementsByTagName("*").length,
      heapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
      longTaskCount: longTaskCountRef.current,
      longTaskDurationMs: longTaskDurationMsRef.current,
      scrollHeight: scrollContainer?.scrollHeight ?? 0,
      scrollTop: scrollContainer?.scrollTop ?? 0,
    };
  }, []);

  const scrollCycle = useCallback(async (cycles = 2): Promise<FrameReport> => {
    const scrollContainer = document.querySelector<HTMLElement>(
      "[data-chat-scroll-container='true']",
    );
    if (!scrollContainer) throw new Error("Transcript scroll container is not mounted.");
    const durations: number[] = [];
    let previous = await nextFrame();
    const stepsPerDirection = 90;
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      for (const direction of [0, 1] as const) {
        for (let step = 0; step <= stepsPerDirection; step += 1) {
          const progress = step / stepsPerDirection;
          scrollContainer.scrollTop =
            (direction === 0 ? 1 - progress : progress) *
            Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
          const now = await nextFrame();
          durations.push(now - previous);
          previous = now;
        }
      }
    }
    return frameReport(durations);
  }, []);

  const appendStreamingChunks = useCallback(async (count = 120): Promise<FrameReport> => {
    const durations: number[] = [];
    let previous = await nextFrame();
    for (let index = 0; index < count; index += 1) {
      setStreamingText(
        (current) => `${current} chunk-${index} with **Markdown** and \`inline code\`.`,
      );
      const now = await nextFrame();
      durations.push(now - previous);
      previous = now;
    }
    return frameReport(durations);
  }, []);

  useEffect(() => {
    window.__synaraPerf = {
      appendStreamingChunks,
      resetMetrics,
      scrollCycle,
      snapshot,
    };
  }, [appendStreamingChunks, resetMetrics, scrollCycle, snapshot]);

  return (
    <main className="flex h-screen min-h-0 w-screen bg-background text-foreground">
      <Profiler id="synara-transcript-perf" onRender={handleRender}>
        <ChatTranscriptPane
          activeThreadId="perf-thread"
          activeTurnId={working ? TurnId.makeUnsafe("perf-turn-streaming") : null}
          activeTurnInProgress={working}
          activeTurnStartedAt={working ? isoAt(messageCount * 2) : null}
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
          onMessagesScroll={NOOP}
          onMessagesTouchEnd={NOOP}
          onMessagesTouchMove={NOOP}
          onMessagesTouchStart={NOOP}
          onMessagesWheel={NOOP}
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
      </Profiler>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element.");

createRoot(rootElement).render(
  <StrictMode>
    <PerformanceHarness />
  </StrictMode>,
);
