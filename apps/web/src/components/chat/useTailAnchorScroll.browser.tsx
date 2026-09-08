import { MessageId } from "@synara/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { useTailAnchorScroll } from "./useTailAnchorScroll";

const ANCHOR_ID = MessageId.makeUnsafe("delayed-steer");

function DelayedLayout({ revision, onFinished }: { revision: number; onFinished: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef({ getScrollableNode: () => containerRef.current } as LegendListRef);
  useTailAnchorScroll({
    listRef,
    timelineRootRef: rootRef,
    anchorMessageId: ANCHOR_ID,
    animateAnchorSlide: false,
    contentChangeSignal: revision,
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
    flushSync(() => root.render(<DelayedLayout revision={0} onFinished={onFinished} />));
    await vi.advanceTimersByTimeAsync(400);
    const viewport = host.querySelector<HTMLElement>('[data-testid="viewport"]')!;
    const anchor = host.querySelector<HTMLElement>(`[data-message-id="${ANCHOR_ID}"]`)!;
    const offset = () => anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    expect(Math.abs(offset())).toBeLessThanOrEqual(1);

    // A new chunk reaches React before deferred Markdown changes the row height.
    flushSync(() => root.render(<DelayedLayout revision={1} onFinished={onFinished} />));
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
