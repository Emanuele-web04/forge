// FILE: MessagesTimeline.rowOverlap.browser.tsx
// Purpose: Browser regression for virtualized row overlap — while a turn
//          streams (tool calls landing one by one, narration growing, groups
//          collapsing behind summaries, disclosures animating), LegendList's
//          absolutely-positioned row containers must never draw on top of each
//          other for more than a transient frame.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import type { TimelineEntry } from "../../session-logic";

const VIEWPORT_HEIGHT_PX = 480;
// Entry transforms (`chat-message-send-enter`) and sub-pixel rounding shift a
// row's rect by a few pixels without any layout fault; only deeper intrusions
// count as overlap.
const OVERLAP_SLACK_PX = 4;
// A stale measurement that self-corrects on the next layout pass is the
// virtualizer working as designed. The user-visible bug is overlap that
// persists across frames.
const MAX_TOLERATED_OVERLAP_STREAK_FRAMES = 4;

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text: string,
  streaming = false,
): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming,
    },
  };
}

function commandEntry(
  id: string,
  command: string,
  toolStatus: "running" | "completed",
): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "work",
    createdAt: "2026-03-17T19:12:28.000Z",
    entry: {
      id,
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      toolStatus,
      command,
    },
  };
}

function thinkingEntry(id: string, label: string): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "work",
    createdAt: "2026-03-17T19:12:28.000Z",
    entry: {
      id,
      createdAt: "2026-03-17T19:12:28.000Z",
      label,
      tone: "thinking",
    },
  };
}

function seedEntries(): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (let index = 0; index < 6; index += 1) {
    entries.push(messageEntry(`seed-user-${index}`, "user", `Earlier question ${index}.`));
    entries.push(
      messageEntry(
        `seed-assistant-${index}`,
        "assistant",
        `Earlier answer ${index}. ${"Some settled response text. ".repeat(6)}`,
      ),
    );
  }
  return entries;
}

interface HarnessHandle {
  listRef: React.RefObject<LegendListRef | null>;
  send: (messageId: string) => void;
  clearAnchor: () => void;
  update: (mutate: (current: TimelineEntry[]) => TimelineEntry[]) => void;
  setFollowLiveOutput: (follow: boolean) => void;
}

function RowOverlapTimeline({ handleRef }: { handleRef: { current: HarnessHandle | null } }) {
  const listRef = useRef<LegendListRef | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>(seedEntries);
  const [tailAnchorMessageId, setTailAnchorMessageId] = useState<MessageId | null>(null);
  const [followLiveOutput, setFollowLiveOutput] = useState(false);

  handleRef.current = {
    listRef,
    send: (messageId: string) => {
      setEntries((current) => [
        ...current,
        messageEntry(messageId, "user", "Freshly sent question."),
      ]);
      setTailAnchorMessageId(MessageId.makeUnsafe(messageId));
    },
    clearAnchor: () => {
      setTailAnchorMessageId(null);
    },
    update: (mutate) => {
      setEntries((current) => mutate([...current]));
    },
    setFollowLiveOutput,
  };

  return (
    <div style={{ height: VIEWPORT_HEIGHT_PX, width: "100%" }}>
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:29.000Z"
        listRef={listRef}
        tailAnchorMessageId={tailAnchorMessageId}
        followLiveOutput={followLiveOutput}
        timelineEntries={entries}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

function createTimelineHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = `display:block;width:600px;height:${VIEWPORT_HEIGHT_PX}px;overflow:hidden;`;
  document.body.append(host);
  return host;
}

type OverlapSample = {
  frame: number;
  overlapPx: number;
  pair: string;
};

/**
 * Measures every timeline row's border box and returns the deepest intrusion of
 * one row into the next (sorted by top). Rows are absolutely positioned by
 * LegendList, so any intrusion beyond the slack means the container `top`s were
 * computed from stale sizes.
 */
function deepestRowOverlap(): { overlapPx: number; pair: string } {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-timeline-row-kind]")]
    .map((row) => ({ row, rect: row.getBoundingClientRect() }))
    .filter(({ rect }) => rect.height > 0)
    .sort((left, right) => left.rect.top - right.rect.top);

  let overlapPx = 0;
  let pair = "";
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    const intrusion = previous.rect.bottom - current.rect.top;
    if (intrusion > overlapPx) {
      overlapPx = intrusion;
      pair = `${previous.row.dataset["timelineRowKind"]} -> ${current.row.dataset["timelineRowKind"]}`;
    }
  }
  return { overlapPx, pair };
}

function findSummaryTrigger(): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) =>
      (button.textContent ?? "").includes("commands"),
    ) ?? null
  );
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

const STREAM_COMMANDS = [
  "bun run lint",
  "bun run typecheck",
  "rg -n providerManager apps/server/src",
  "bun run test -- storeEventReducer",
  "git diff --stat",
  "node scripts/check.mjs",
  "git status --porcelain",
  "bun run build",
];

describe("MessagesTimeline row overlap under streaming", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps virtualized rows from overlapping while tool calls stream, groups collapse, and disclosures animate", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const host = createTimelineHost();
    const screen = await render(<RowOverlapTimeline handleRef={handleRef} />, {
      container: host,
    });

    try {
      const handle = () => {
        if (!handleRef.current) throw new Error("harness not mounted");
        return handleRef.current;
      };

      await expect.poll(() => handle().listRef.current?.getScrollableNode?.() != null).toBe(true);
      for (let frame = 0; frame < 3; frame += 1) {
        await nextFrame();
      }
      void handle().listRef.current?.scrollToEnd?.({ animated: false });
      await nextFrame();

      // A real turn: anchored send, then narration + tool calls streaming in.
      // The user is reading rather than following the live tail, so once the
      // anchor releases the list runs with maintainVisibleContentPosition on —
      // the mode where anchor-locked size updates defer position recalcs.
      handle().send("overlap-sent-message");
      handle().setFollowLiveOutput(false);

      let narrationText = "";
      let secondNarrationText = "";
      let commandCount = 0;
      const overlapSamples: OverlapSample[] = [];
      let overlapStreakFrames = 0;
      let worstOverlapStreakFrames = 0;

      // Painted-state sampler. Rendered frames are only observable between the
      // frame's ResizeObserver phase and its paint: rAF-time sampling would see
      // React's between-frames commit (row already grown) without the same
      // frame's pre-paint corrections, a state that never reaches the screen.
      // A ResizeObserver created after the timeline mounted is delivered after
      // the timeline's own observers, and resizing the probe every rAF forces
      // it to fire every frame — so its callback sees exactly what this frame
      // paints.
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;";
      document.body.append(probe);
      let sampleFrame = -1;
      const samplerObserver = new ResizeObserver(() => {
        if (sampleFrame < 0) {
          return;
        }
        const { overlapPx, pair } = deepestRowOverlap();
        if (overlapPx > OVERLAP_SLACK_PX) {
          overlapSamples.push({ frame: sampleFrame, overlapPx, pair });
          overlapStreakFrames += 1;
          worstOverlapStreakFrames = Math.max(worstOverlapStreakFrames, overlapStreakFrames);
        } else {
          overlapStreakFrames = 0;
        }
      });
      samplerObserver.observe(probe);

      const applyStreamStep = (frame: number) => {
        handle().update((current) => {
          // Rebuild the live turn's entries from scratch each step, the way the
          // store re-derives the timeline from projected events.
          const next = current.filter(
            (entry) =>
              !entry.id.startsWith("entry-narration-") && !entry.id.startsWith("entry-stream-"),
          );
          // Narration text grows on a token cadence.
          if (frame % 3 === 0 && frame < 90) {
            narrationText += "Streaming narration text that keeps growing. ";
          }
          if (frame >= 90 && frame % 3 === 0 && frame < 150) {
            secondNarrationText += "Second narration block after the tools ran. ";
          }
          // Tool calls land one at a time; the previous one completes as the
          // next starts.
          if (frame % 8 === 4 && commandCount < STREAM_COMMANDS.length && frame < 90) {
            commandCount += 1;
          }
          const commands = STREAM_COMMANDS.slice(0, commandCount).map((command, index) =>
            commandEntry(
              `stream-command-${index}`,
              command,
              index === commandCount - 1 && frame < 90 ? "running" : "completed",
            ),
          );
          const rebuilt = [...next];
          if (narrationText.length > 0) {
            rebuilt.push(messageEntry("narration-1", "assistant", narrationText, frame < 90));
          }
          const boundaryIndex = rebuilt.length;
          rebuilt.push(...commands);
          // Mid-turn a thinking boundary splits the run, collapsing the settled
          // commands behind a "Ran N commands" summary (the structural remap
          // that swings two row heights in one commit).
          if (frame >= 56 && commandCount > 2) {
            rebuilt.splice(
              boundaryIndex + commandCount - 1,
              0,
              thinkingEntry("stream-think", "Weighing the next verification step"),
            );
          }
          if (secondNarrationText.length > 0) {
            rebuilt.push(
              messageEntry("narration-2", "assistant", secondNarrationText, frame < 150),
            );
          }
          return rebuilt;
        });
      };

      for (let frame = 0; frame < 170; frame += 1) {
        applyStreamStep(frame);
        // Mid-stream the tail anchor releases (the real hand-off once the
        // response grows past the reserve), turning maintainVisibleContentPosition
        // back on while data keeps changing — the mode where LegendList's
        // anchor lock defers size-driven position recalcs past the paint.
        if (frame === 40) {
          handle().clearAnchor();
        }
        // The reader has scrolled to the live tail; the frame-100 disclosure
        // now animates above the viewport, so MVCP keeps compensating scroll
        // while sizes change — the anchor-locked mode that defers recalcs.
        if (frame === 95) {
          void handle().listRef.current?.scrollToEnd?.({ animated: false });
        }
        // Toggle a summary disclosure while content still streams, so the
        // 220ms height animation overlaps live growth.
        if (frame === 100) {
          findSummaryTrigger()?.click();
        }
        if (frame === 120) {
          findSummaryTrigger()?.click();
        }
        // Alternate the probe's size so the sampler observer fires during this
        // frame's pre-paint ResizeObserver phase and records the painted state.
        sampleFrame = frame;
        probe.style.height = `${1 + (frame % 2)}px`;
        await nextFrame();
      }
      sampleFrame = -1;
      samplerObserver.disconnect();
      probe.remove();

      // Let everything settle: stream over, animations done.
      handle().setFollowLiveOutput(false);
      for (let frame = 0; frame < 30; frame += 1) {
        await nextFrame();
      }
      const settled = deepestRowOverlap();

      const report = overlapSamples
        .map((sample) => `frame ${sample.frame}: ${sample.overlapPx.toFixed(1)}px (${sample.pair})`)
        .join("\n");

      expect(
        worstOverlapStreakFrames,
        `rows overlapped for ${worstOverlapStreakFrames} consecutive frames:\n${report}`,
      ).toBeLessThanOrEqual(MAX_TOLERATED_OVERLAP_STREAK_FRAMES);
      expect(
        settled.overlapPx,
        `rows still overlap after settling: ${settled.overlapPx.toFixed(1)}px (${settled.pair})`,
      ).toBeLessThanOrEqual(1);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
