// FILE: MessagesTimeline.scrollOwnership.browser.tsx
// Purpose: Browser regression for user scroll ownership during streaming.
//          LegendList must stop re-snapping to the bottom immediately after a
//          wheel/touch/pointer gesture while `followLiveOutput` is on, and must
//          resume end-follow once the user returns to the bottom.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import type { deriveTimelineEntries } from "../../session-logic";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const VIEWPORT_HEIGHT_PX = 420;
const AUTO_FOLLOW_TOLERANCE_PX = 96;

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
  for (let index = 0; index < 8; index += 1) {
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
  startStreaming: () => void;
  streamChunk: (lines: number) => void;
  releaseUserScroll: () => void;
}

function ScrollOwnershipTimeline({ handleRef }: { handleRef: { current: HarnessHandle | null } }) {
  const listRef = useRef<LegendListRef | null>(null);
  const [entries, setEntries] = useState<TimelineEntries>(seedEntries);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isUserScrollDetached, setIsUserScrollDetached] = useState(false);

  const followLiveOutput = isStreaming && !isUserScrollDetached;

  handleRef.current = {
    listRef,
    startStreaming: () => {
      setIsStreaming(true);
    },
    streamChunk: (lines: number) => {
      setEntries((current) => {
        const lastIndex = current.findIndex(
          (entry) => entry.kind === "message" && entry.message.streaming,
        );
        const existingText =
          lastIndex >= 0 && current[lastIndex]?.kind === "message"
            ? current[lastIndex].message.text
            : "";
        const grownText = `${existingText}${"Streamed line of response text.\n\n".repeat(lines)}`;
        const grown = messageEntry("streaming-assistant-message", "assistant", grownText, true);
        if (lastIndex < 0) {
          return [...current, grown];
        }
        return current.map((entry, index) => (index === lastIndex ? grown : entry));
      });
    },
    releaseUserScroll: () => {
      flushSync(() => {
        setIsUserScrollDetached(true);
      });
    },
  };

  return (
    <div style={{ height: VIEWPORT_HEIGHT_PX }}>
      <MessagesTimeline
        hasMessages={entries.length > 0}
        isWorking={isStreaming}
        activeTurnInProgress={isStreaming}
        activeTurnStartedAt={isStreaming ? "2026-03-17T19:12:29.000Z" : null}
        listRef={listRef}
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
        onMessagesWheel={() => handleRef.current?.releaseUserScroll()}
        onIsAtEndChange={(isAtEnd) => {
          if (isAtEnd) {
            setIsUserScrollDetached(false);
          }
        }}
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

function distanceFromBottomPx(container: HTMLElement): number {
  return container.scrollHeight - container.clientHeight - container.scrollTop;
}

async function settleFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }
}

describe("MessagesTimeline scroll ownership", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets a single wheel up detach auto-follow and never re-snaps for 60 frames", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<ScrollOwnershipTimeline handleRef={handleRef} />);

    try {
      const handle = () => {
        if (!handleRef.current) throw new Error("harness not mounted");
        return handleRef.current;
      };

      await expect.poll(() => handle().listRef.current?.getScrollableNode?.() != null).toBe(true);
      await settleFrames(3);
      void handle().listRef.current?.scrollToEnd?.({ animated: false });

      const container = getScrollContainer(handle());
      await expect
        .poll(() => distanceFromBottomPx(container), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

      handle().startStreaming();

      // Establish live follow with a few streaming chunks.
      for (let index = 0; index < 8; index += 1) {
        handle().streamChunk(2);
        await settleFrames(1);
      }

      await expect
        .poll(() => distanceFromBottomPx(container), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

      const scrollTopBeforeWheel = container.scrollTop;

      // A single wheel up should take ownership from live output.
      // Synthetic wheel events do not perform the actual scroll, so we move the
      // viewport explicitly to model the user gesture that LegendList would have
      // handled natively, while keeping the on-wheel callback as the trigger.
      container.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          deltaY: -100,
          clientX: container.clientWidth / 2,
          clientY: container.clientHeight / 2,
        }),
      );
      container.scrollTop = Math.max(0, scrollTopBeforeWheel - 100);
      container.dispatchEvent(new Event("scroll"));

      await settleFrames(1);

      const scrollTopAfterWheel = container.scrollTop;
      expect(scrollTopAfterWheel).toBeLessThan(scrollTopBeforeWheel);

      // Continue streaming for 60 frames and assert the viewport is never
      // re-snapped to the bottom.
      const samples: number[] = [scrollTopAfterWheel];
      for (let frame = 0; frame < 60; frame += 1) {
        handle().streamChunk(1);
        await settleFrames(1);
        samples.push(container.scrollTop);
      }

      // The scroll position may drift slightly but must stay above the pre-wheel
      // live edge (a re-snap would jump back to or near the bottom).
      for (const scrollTop of samples) {
        expect(scrollTop).toBeLessThan(scrollTopBeforeWheel);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("re-attaches end-follow when the user scrolls back to the bottom", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<ScrollOwnershipTimeline handleRef={handleRef} />);

    try {
      const handle = () => {
        if (!handleRef.current) throw new Error("harness not mounted");
        return handleRef.current;
      };

      await expect.poll(() => handle().listRef.current?.getScrollableNode?.() != null).toBe(true);
      await settleFrames(3);
      void handle().listRef.current?.scrollToEnd?.({ animated: false });

      const container = getScrollContainer(handle());
      await expect
        .poll(() => distanceFromBottomPx(container), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

      handle().startStreaming();

      for (let index = 0; index < 8; index += 1) {
        handle().streamChunk(2);
        await settleFrames(1);
      }

      await expect
        .poll(() => distanceFromBottomPx(container), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

      // Wheel up to detach.
      const scrollTopBeforeDetach = container.scrollTop;
      container.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          deltaY: -200,
          clientX: container.clientWidth / 2,
          clientY: container.clientHeight / 2,
        }),
      );
      container.scrollTop = Math.max(0, scrollTopBeforeDetach - 300);
      container.dispatchEvent(new Event("scroll"));
      await settleFrames(3);

      const detachedDistance = distanceFromBottomPx(container);
      expect(detachedDistance).toBeGreaterThan(AUTO_FOLLOW_TOLERANCE_PX);

      // Scroll back to the bottom, like the scroll-to-bottom arrow.
      void handle().listRef.current?.scrollToEnd?.({ animated: false });
      await expect
        .poll(() => distanceFromBottomPx(container), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

      // After returning to the bottom, onIsAtEndChange(true) re-arms follow.
      // The next streaming chunks must keep the viewport pinned to the tail.
      for (let frame = 0; frame < 24; frame += 1) {
        handle().streamChunk(1);
        await settleFrames(1);
      }

      await expect
        .poll(() => distanceFromBottomPx(container), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);
    } finally {
      await screen.unmount();
    }
  });
});
