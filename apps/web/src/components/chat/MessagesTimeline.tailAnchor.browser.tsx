// FILE: MessagesTimeline.tailAnchor.browser.tsx
// Purpose: Browser regression for send-time anchoring — a just-sent user message
//          aligns just below the viewport top (matching the container's own top
//          padding), stays pinned while the response streams below it, keeps its
//          reserve when the turn ends, hands off to follow-the-tail once the
//          response overflows, and only collapses when the anchor is cleared.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import type { deriveTimelineEntries } from "../../session-logic";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const VIEWPORT_HEIGHT_PX = 420;
const BASE_BOTTOM_INSET_PX = 64;
// maintainScrollAtEnd re-sticks within its threshold rather than to the exact
// pixel bottom; anything within this tolerance counts as following the tail.
const AUTO_FOLLOW_TOLERANCE_PX = 96;
const FIRST_SENT_MESSAGE_ID = "sent-user-message";
const SECOND_SENT_MESSAGE_ID = "sent-user-message-2";
const FIRST_STREAMING_MESSAGE_ID = "streaming-assistant-message";
const SECOND_STREAMING_MESSAGE_ID = "streaming-assistant-message-2";

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text: string,
  streaming = false,
): TimelineEntries[number] {
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

function seedEntries(): TimelineEntries {
  const entries: TimelineEntries = [];
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
  send: (messageId: string) => void;
  growStream: (streamMessageId: string, lines: number) => void;
  showThinking: () => void;
  showWorkingHeader: () => void;
  finishTurn: () => void;
  clearAnchor: () => void;
  listRef: React.RefObject<LegendListRef | null>;
}

function TailAnchorTimeline({ handleRef }: { handleRef: { current: HarnessHandle | null } }) {
  const listRef = useRef<LegendListRef | null>(null);
  const [entries, setEntries] = useState<TimelineEntries>(seedEntries);
  const [tailAnchorMessageId, setTailAnchorMessageId] = useState<MessageId | null>(null);
  const [followLiveOutput, setFollowLiveOutput] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [activeTurnStartedAt, setActiveTurnStartedAt] = useState<string | null>(null);

  handleRef.current = {
    listRef,
    send: (messageId: string) => {
      setEntries((current) => [
        ...current,
        messageEntry(messageId, "user", "Freshly sent question."),
      ]);
      setTailAnchorMessageId(MessageId.makeUnsafe(messageId));
    },
    growStream: (streamMessageId: string, lines: number) => {
      setFollowLiveOutput(true);
      setEntries((current) => {
        const streamingIndex = current.findIndex(
          (entry) => entry.kind === "message" && entry.message.id === streamMessageId,
        );
        const existingText =
          streamingIndex >= 0 && current[streamingIndex]?.kind === "message"
            ? current[streamingIndex].message.text
            : "";
        const grownText = `${existingText}${"Streamed line of response text.\n\n".repeat(lines)}`;
        const grown = messageEntry(streamMessageId, "assistant", grownText, true);
        if (streamingIndex < 0) {
          return [...current, grown];
        }
        return current.map((entry, index) => (index === streamingIndex ? grown : entry));
      });
    },
    showThinking: () => {
      setIsWorking(true);
      setActiveTurnStartedAt(null);
    },
    showWorkingHeader: () => {
      setIsWorking(true);
      setActiveTurnStartedAt("2026-03-17T19:12:29.000Z");
    },
    // Turn end keeps the anchor: the reserve must persist so the settled
    // transcript does not jump back to its true bottom.
    finishTurn: () => {
      setFollowLiveOutput(false);
    },
    clearAnchor: () => {
      setTailAnchorMessageId(null);
    },
  };

  return (
    <div style={{ height: VIEWPORT_HEIGHT_PX }}>
      <MessagesTimeline
        hasMessages={entries.length > 0}
        isWorking={isWorking}
        activeTurnInProgress={false}
        activeTurnStartedAt={activeTurnStartedAt}
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

function getScrollContainer(handle: HarnessHandle): HTMLElement {
  const node: unknown = handle.listRef.current?.getScrollableNode?.();
  if (!(node instanceof HTMLElement)) {
    throw new Error("scroll container not available");
  }
  return node;
}

function getSpacer(): HTMLElement {
  const spacer = document.querySelector<HTMLElement>('[data-tail-anchor-spacer="true"]');
  if (!spacer) {
    throw new Error("tail anchor spacer not rendered");
  }
  return spacer;
}

/** Live size of LegendList's native anchored end space (see MessagesTimeline). */
function reservePx(): number {
  const root = document.querySelector<HTMLElement>('[data-messages-timeline-root="true"]');
  const value = root?.getAttribute("data-anchored-end-space");
  return value === null || value === undefined ? 0 : Number.parseFloat(value) || 0;
}

function anchorTopOffsetPx(handle: HarnessHandle, messageId: string): number | null {
  const anchor = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  if (!anchor || anchor.getClientRects().length === 0) {
    return null;
  }
  const container = getScrollContainer(handle);
  return anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

function distanceFromBottomPx(handle: HarnessHandle): number {
  const container = getScrollContainer(handle);
  return container.scrollHeight - container.clientHeight - container.scrollTop;
}

async function settleFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }
}

describe("MessagesTimeline tail anchor", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("anchors a sent message below the top inset, pins it while streaming, keeps the reserve at turn end, follows overflow, and collapses only when cleared", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<TailAnchorTimeline handleRef={handleRef} />);

    try {
      const handle = () => {
        if (!handleRef.current) throw new Error("harness not mounted");
        return handleRef.current;
      };

      // Let the list mount, then settle at the bottom like a real open conversation.
      await expect.poll(() => handle().listRef.current?.getScrollableNode?.() != null).toBe(true);
      await settleFrames(3);
      void handle().listRef.current?.scrollToEnd?.({ animated: false });
      await expect
        .poll(() => distanceFromBottomPx(handle()), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

      // The anchored message keeps the same top gap a chat's first message gets:
      // the scroll container's own top padding.
      const topGapPx =
        Number.parseFloat(getComputedStyle(getScrollContainer(handle())).paddingTop) || 0;
      const expectAnchoredAtTopGap = (messageId: string) =>
        expect
          .poll(
            () => {
              const offset = anchorTopOffsetPx(handle(), messageId);
              return offset !== null && Math.abs(offset - topGapPx) <= 8;
            },
            { timeout: 5_000 },
          )
          .toBe(true);

      // 1) Send: the native end space reserves room and the new message slides
      // directly to its anchored coordinate. It must never pass that coordinate
      // and then spring back while the virtualized tail finishes measuring.
      handle().send(FIRST_SENT_MESSAGE_ID);

      const initialSlideOffsets: number[] = [];
      for (let index = 0; index < 36; index += 1) {
        await settleFrames(1);
        const offset = anchorTopOffsetPx(handle(), FIRST_SENT_MESSAGE_ID);
        if (offset !== null) {
          initialSlideOffsets.push(offset);
        }
      }
      expect(initialSlideOffsets.length).toBeGreaterThan(0);
      expect(Math.min(...initialSlideOffsets)).toBeGreaterThanOrEqual(topGapPx - 8);

      await expect.poll(() => reservePx(), { timeout: 5_000 }).toBeGreaterThan(0);
      expect(getSpacer().getBoundingClientRect().height).toBe(BASE_BOTTOM_INSET_PX);
      await expectAnchoredAtTopGap(FIRST_SENT_MESSAGE_ID);

      // 2) Short streaming: response grows into the reserve; the message stays
      // pinned. Sampled every frame, because the regression this guards is a
      // single-frame hop: LegendList positions a freshly appended row from
      // `estimatedItemSize`, and sizing the reserve from that frame moves the
      // scroll max, which jerks the anchored message and springs it back.
      const container = getScrollContainer(handle());
      // The baseline has to be taken once the slide has actually come to rest:
      // the message eases into its coordinate, so a scroll position sampled
      // while it is still arriving would charge the last pixels of the slide to
      // the streaming phase below.
      await expect
        .poll(
          () => {
            const offset = anchorTopOffsetPx(handle(), FIRST_SENT_MESSAGE_ID);
            return offset !== null && Math.abs(offset - topGapPx) <= 1;
          },
          { timeout: 5_000 },
        )
        .toBe(true);
      const scrollTopBeforeStream = container.scrollTop;
      const reserveBeforeStream = reservePx();

      handle().growStream(FIRST_STREAMING_MESSAGE_ID, 2);
      const perFrameOffsets: number[] = [];
      for (let index = 0; index < 24; index += 1) {
        await settleFrames(1);
        const offset = anchorTopOffsetPx(handle(), FIRST_SENT_MESSAGE_ID);
        if (offset !== null) {
          perFrameOffsets.push(offset);
        }
      }
      const worstDriftPx = perFrameOffsets.reduce(
        (worst, offset) => Math.max(worst, Math.abs(offset - topGapPx)),
        0,
      );
      expect(worstDriftPx).toBeLessThanOrEqual(8);
      await expect.poll(() => reservePx(), { timeout: 5_000 }).toBeLessThan(reserveBeforeStream);

      expect(Math.abs(container.scrollTop - scrollTopBeforeStream)).toBeLessThanOrEqual(1);
      await expectAnchoredAtTopGap(FIRST_SENT_MESSAGE_ID);

      // 3) Turn end: the reserve persists — no jump back to the true bottom.
      const reserveBeforeTurnEnd = reservePx();
      const scrollTopBeforeTurnEnd = container.scrollTop;
      handle().finishTurn();
      await settleFrames(6);
      expect(Math.abs(reservePx() - reserveBeforeTurnEnd)).toBeLessThanOrEqual(1);
      expect(Math.abs(container.scrollTop - scrollTopBeforeTurnEnd)).toBeLessThanOrEqual(1);
      await expectAnchoredAtTopGap(FIRST_SENT_MESSAGE_ID);

      // 4) Clearing the anchor (fallback path) collapses the reserve.
      handle().clearAnchor();
      await expect.poll(() => reservePx(), { timeout: 5_000 }).toBe(0);

      // 5) A new send re-anchors, and an overflowing response hands off to
      // follow-the-tail with the reserve back at zero.
      handle().send(SECOND_SENT_MESSAGE_ID);
      void handle().listRef.current?.scrollToEnd?.({ animated: true });
      await expectAnchoredAtTopGap(SECOND_SENT_MESSAGE_ID);

      // Streamed in chunks, the way a real turn arrives: the transcript has to
      // stay at the live edge as it grows past the reserve, rather than being
      // yanked to the bottom in one jump.
      for (let chunk = 0; chunk < 10; chunk += 1) {
        handle().growStream(SECOND_STREAMING_MESSAGE_ID, 4);
        await settleFrames(2);
      }
      await expect.poll(() => reservePx(), { timeout: 5_000 }).toBe(0);
      await expect
        .poll(() => distanceFromBottomPx(handle()), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);
      // The anchored message has scrolled up and out of the way of the live tail.
      const overflowOffset = anchorTopOffsetPx(handle(), SECOND_SENT_MESSAGE_ID);
      expect(overflowOffset === null || overflowOffset < 0).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("anchors a steer monotonically while the previous assistant row is still growing", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<TailAnchorTimeline handleRef={handleRef} />);

    try {
      const handle = () => {
        if (!handleRef.current) throw new Error("harness not mounted");
        return handleRef.current;
      };

      await expect.poll(() => handle().listRef.current?.getScrollableNode?.() != null).toBe(true);
      await settleFrames(3);
      void handle().listRef.current?.scrollToEnd?.({ animated: false });
      await expect
        .poll(() => distanceFromBottomPx(handle()), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

      handle().growStream(FIRST_STREAMING_MESSAGE_ID, 2);
      await settleFrames(3);

      const container = getScrollContainer(handle());
      const topGapPx = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;
      handle().send(FIRST_SENT_MESSAGE_ID);

      const offsets: number[] = [];
      for (let frame = 0; frame < 48; frame += 1) {
        if (frame === 4 || frame === 8 || frame === 12) {
          handle().growStream(FIRST_STREAMING_MESSAGE_ID, 1);
        }
        if (frame === 16) {
          handle().finishTurn();
        }
        await settleFrames(1);
        const offset = anchorTopOffsetPx(handle(), FIRST_SENT_MESSAGE_ID);
        if (offset !== null) {
          offsets.push(offset);
        }
      }

      expect(offsets.length).toBeGreaterThan(0);
      expect(Math.min(...offsets)).toBeGreaterThanOrEqual(topGapPx - 8);
      const largestDownwardJumpPx = offsets.slice(1).reduce((largest, offset, index) => {
        return Math.max(largest, offset - offsets[index]!);
      }, 0);
      expect(largestDownwardJumpPx).toBeLessThanOrEqual(2);
      await expect
        .poll(() => {
          const offset = anchorTopOffsetPx(handle(), FIRST_SENT_MESSAGE_ID);
          return offset !== null && Math.abs(offset - topGapPx) <= 8;
        })
        .toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  // Regression: visible-content preservation must stay disabled for the full
  // lifetime of a send anchor. Thinking and the "Working for" header are rows
  // inserted below that anchor; letting the list start a second preservation
  // cycle for those inserts resets scrollTop after the sent row has reached the
  // top and visibly juggles it through the pre-turn phases.
  it("keeps the sent message stable while pre-turn status rows land mid-slide", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<TailAnchorTimeline handleRef={handleRef} />);

    try {
      const handle = () => {
        if (!handleRef.current) throw new Error("harness not mounted");
        return handleRef.current;
      };

      await expect.poll(() => handle().listRef.current?.getScrollableNode?.() != null).toBe(true);
      await settleFrames(3);
      void handle().listRef.current?.scrollToEnd?.({ animated: false });
      await expect
        .poll(() => distanceFromBottomPx(handle()), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

      const container = getScrollContainer(handle());
      const topGapPx = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;

      handle().send(FIRST_SENT_MESSAGE_ID);

      // The pre-turn status rows land while the anchored slide is still in
      // flight, exactly like a real send: Thinking appears on the server ack,
      // the "Working for" header once the turn starts, then text streams.
      const samples: Array<number | null> = [];
      for (let frame = 0; frame < 90; frame += 1) {
        if (frame === 3) handle().showThinking();
        if (frame === 12) handle().showWorkingHeader();
        if (frame === 40) handle().growStream(FIRST_STREAMING_MESSAGE_ID, 2);
        await settleFrames(1);
        const offset = anchorTopOffsetPx(handle(), FIRST_SENT_MESSAGE_ID);
        samples.push(offset);
      }

      // The message must move only toward its anchor, then never move again.
      const visibleSamples = samples.flatMap((offset) => (offset === null ? [] : [offset]));
      const largestDownwardJumpPx = visibleSamples.slice(1).reduce((largest, offset, index) => {
        return Math.max(largest, offset - visibleSamples[index]!);
      }, 0);
      expect(largestDownwardJumpPx).toBeLessThanOrEqual(2);

      const settledIndex = samples.findIndex(
        (offset) => offset !== null && Math.abs(offset - topGapPx) <= 2,
      );
      expect(settledIndex).toBeGreaterThanOrEqual(0);
      const postSettle = samples
        .slice(settledIndex)
        .flatMap((offset) => (offset === null ? [] : [offset]));
      expect(postSettle.length).toBe(samples.length - settledIndex);
      const maxDriftPx = postSettle.reduce(
        (worst, offset) => Math.max(worst, Math.abs(offset - topGapPx)),
        0,
      );
      expect(maxDriftPx).toBeLessThanOrEqual(2);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a settled send anchored when Thinking gains its Working for header", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<TailAnchorTimeline handleRef={handleRef} />);

    try {
      const handle = () => {
        if (!handleRef.current) throw new Error("harness not mounted");
        return handleRef.current;
      };

      await expect.poll(() => handle().listRef.current?.getScrollableNode?.() != null).toBe(true);
      await settleFrames(3);
      void handle().listRef.current?.scrollToEnd?.({ animated: false });

      const container = getScrollContainer(handle());
      const topGapPx = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;
      handle().send(FIRST_SENT_MESSAGE_ID);
      await expect
        .poll(() => {
          const offset = anchorTopOffsetPx(handle(), FIRST_SENT_MESSAGE_ID);
          return offset !== null && Math.abs(offset - topGapPx) <= 8;
        })
        .toBe(true);

      handle().showThinking();
      await settleFrames(6);
      handle().showWorkingHeader();

      const offsets: number[] = [];
      for (let frame = 0; frame < 24; frame += 1) {
        await settleFrames(1);
        const offset = anchorTopOffsetPx(handle(), FIRST_SENT_MESSAGE_ID);
        if (offset !== null) offsets.push(offset);
      }

      expect(offsets.length).toBeGreaterThan(0);
      expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(2);
      expect(Math.abs(offsets.at(-1)! - topGapPx)).toBeLessThanOrEqual(8);
    } finally {
      await screen.unmount();
    }
  });
});
