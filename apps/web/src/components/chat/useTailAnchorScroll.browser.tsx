import { MessageId } from "@synara/contracts";
import { useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { useTailAnchorScroll } from "./useTailAnchorScroll";

const ANCHOR_ID = MessageId.makeUnsafe("delayed-steer");

function DelayedLayout({
  contentRevision,
  messageRevision,
  onFinished,
}: {
  contentRevision: number;
  messageRevision: number;
  onFinished: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef({ getScrollableNode: (): HTMLElement => containerRef.current! });
  useTailAnchorScroll({
    listRef,
    timelineRootRef: rootRef,
    anchorMessageId: ANCHOR_ID,
    animateAnchorSlide: false,
    contentChangeSignal: contentRevision,
    messageChangeSignal: messageRevision,
    onAnchorSlideFinished: onFinished,
  });
  return (
    <div ref={rootRef}>
      <div
        ref={containerRef}
        data-testid="viewport"
        style={{ height: 200, overflow: "auto", overflowAnchor: "none" }}
      >
        <div data-testid="delayed-content" style={{ height: 300 }} />
        <div data-message-id={ANCHOR_ID} style={{ height: 20 }} />
        <div style={{ height: 180 }} />
      </div>
    </div>
  );
}

it("holds a steer while newly received content is still waiting for layout", async () => {
  vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onFinished = vi.fn();
  try {
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={0} messageRevision={0} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(400);
    const viewport = host.querySelector<HTMLElement>('[data-testid="viewport"]')!;
    const anchor = host.querySelector<HTMLElement>(`[data-message-id="${ANCHOR_ID}"]`)!;
    const offset = () => anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    expect(Math.abs(offset())).toBeLessThanOrEqual(1);

    // A new chunk reaches React before deferred Markdown changes the row height.
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={1} messageRevision={1} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(onFinished).not.toHaveBeenCalled();

    host.querySelector<HTMLElement>('[data-testid="delayed-content"]')!.style.height = "350px";
    await vi.advanceTimersByTimeAsync(16);
    expect(Math.abs(offset())).toBeLessThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onFinished).toHaveBeenCalledTimes(1);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});

it("does not let tool or work activity extend the anchor hold", async () => {
  vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onFinished = vi.fn();
  try {
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={0} messageRevision={0} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(onFinished).not.toHaveBeenCalled();

    // Tool or work activity updates the full timeline without a new message.
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={1} messageRevision={0} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(onFinished).not.toHaveBeenCalled();

    // The original message hold window should expire; the work activity did not restart it.
    await vi.advanceTimersByTimeAsync(200);
    expect(onFinished).toHaveBeenCalledTimes(1);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});
