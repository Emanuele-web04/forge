// FILE: useTimelineRowOverlapGuard.browser.tsx
// Purpose: Direct browser regression for the pre-paint overlap guard. The
//          timeline-level test can't discriminate the guard's effect when the
//          virtualizer self-corrects before paint, so this harness recreates
//          the failure state the guard exists for: absolutely positioned
//          containers whose `top`s were computed from stale row heights (the
//          virtualizer's write-back deferred past the paint). The guard must
//          push the stale containers down within the same frame — and must
//          never pull a container up when a row shrinks.
// Layer: Vitest browser tests

import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useTimelineRowOverlapGuard } from "./useTimelineRowOverlapGuard";

const INITIAL_ROW_HEIGHT_PX = 40;

interface HarnessHandle {
  setRowHeight: (index: number, heightPx: number) => void;
}

/**
 * Three rows in absolutely positioned containers, tops laid out for the
 * initial heights. Row heights change via state; container tops deliberately
 * stay stale — the guard is the only thing allowed to move them.
 */
function StaleContainers({ handleRef }: { handleRef: { current: HarnessHandle | null } }) {
  const observeRow = useTimelineRowOverlapGuard();
  const [rowHeights, setRowHeights] = useState([
    INITIAL_ROW_HEIGHT_PX,
    INITIAL_ROW_HEIGHT_PX,
    INITIAL_ROW_HEIGHT_PX,
  ]);

  handleRef.current = {
    setRowHeight: (index, heightPx) => {
      setRowHeights((current) => current.map((height, at) => (at === index ? heightPx : height)));
    },
  };

  return (
    <div style={{ position: "relative", height: 400, width: 300 }}>
      {rowHeights.map((height, index) => (
        <div
          key={index}
          data-overlap-container={index}
          style={{
            position: "absolute",
            top: index * INITIAL_ROW_HEIGHT_PX,
            left: 0,
            right: 0,
          }}
        >
          <div ref={observeRow} style={{ height }} />
        </div>
      ))}
    </div>
  );
}

function containerTop(index: number): number {
  const container = document.querySelector<HTMLElement>(`[data-overlap-container="${index}"]`);
  if (!container) throw new Error(`container ${index} not mounted`);
  return Number.parseFloat(container.style.top);
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

describe("useTimelineRowOverlapGuard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("pushes stale containers down in the frame a row grows", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<StaleContainers handleRef={handleRef} />);

    try {
      await expect.poll(() => handleRef.current != null).toBe(true);
      // Let the observer's initial delivery settle before mutating.
      await nextFrame();
      await nextFrame();

      handleRef.current!.setRowHeight(0, 100);
      // The ResizeObserver fires pre-paint in the frame the growth lays out;
      // two frames later its corrections are unambiguously visible.
      await nextFrame();
      await nextFrame();

      // Rows below the grown row cascade down to sit flush under it.
      expect(containerTop(1)).toBeCloseTo(100, 0);
      expect(containerTop(2)).toBeCloseTo(140, 0);
    } finally {
      await screen.unmount();
    }
  });

  it("leaves a gap alone when a row shrinks", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<StaleContainers handleRef={handleRef} />);

    try {
      await expect.poll(() => handleRef.current != null).toBe(true);
      await nextFrame();
      await nextFrame();

      handleRef.current!.setRowHeight(0, 10);
      await nextFrame();
      await nextFrame();

      // Pulling rows up is the virtualizer's call (it defers shrink handling
      // deliberately); the guard must not move anything.
      expect(containerTop(1)).toBe(INITIAL_ROW_HEIGHT_PX);
      expect(containerTop(2)).toBe(INITIAL_ROW_HEIGHT_PX * 2);
    } finally {
      await screen.unmount();
    }
  });
});
