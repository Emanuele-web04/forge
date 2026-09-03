// FILE: useSmoothStreamedText.browser.tsx
// Purpose: Hook-level regressions for the smooth streamed-text reveal — completion
//          snap, reduced-motion bypass, non-append reset, and mount-text passthrough.
// Layer: Web browser tests
// Depends on: useSmoothStreamedText and a real React/browser rAF loop. The pure
//             stepper math is pinned separately in useSmoothStreamedText.test.ts;
//             these tests cover the wiring the stepper tests cannot see.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useSmoothStreamedText } from "~/hooks/useSmoothStreamedText";

interface SmoothTextProps {
  readonly text: string;
  readonly isStreaming: boolean;
}

// Large enough that the rAF loop (≤2000 chars/s, ≤100 chars per clamped frame)
// needs many quantized commits to drain it, so partially-revealed states are
// reliably observable between polls and a handful of stray frames cannot
// accidentally finish the reveal before an assertion runs.
const LONG_DELTA = "x".repeat(1_200);

function renderSmoothText(initialProps: SmoothTextProps) {
  return renderHook(
    (props?: SmoothTextProps) =>
      useSmoothStreamedText(
        props?.text ?? initialProps.text,
        props?.isStreaming ?? initialProps.isStreaming,
      ),
    { initialProps },
  );
}

describe("useSmoothStreamedText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the raw text with no animation when not streaming", async () => {
    const hook = await renderSmoothText({ text: "finished reply", isStreaming: false });
    expect(hook.result.current).toBe("finished reply");

    await hook.rerender({ text: "finished reply, repaired", isStreaming: false });
    expect(hook.result.current).toBe("finished reply, repaired");

    await hook.unmount();
  });

  it("shows mount text immediately and reveals appended deltas gradually", async () => {
    const mountText = "Hello ";
    const hook = await renderSmoothText({ text: mountText, isStreaming: true });
    expect(hook.result.current).toBe(mountText);

    const full = mountText + LONG_DELTA;
    await hook.rerender({ text: full, isStreaming: true });
    // The append only wakes the rAF loop — the backlog must not snap in at once.
    expect(hook.result.current.length).toBeLessThan(full.length);
    expect(full.startsWith(hook.result.current)).toBe(true);

    // The reveal passes through intermediate prefixes on its way to the target.
    let intermediate = "";
    await expect
      .poll(
        () => {
          const value = hook.result.current;
          if (value.length > mountText.length && value.length < full.length) {
            intermediate = value;
          }
          return intermediate.length > 0;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(full.startsWith(intermediate)).toBe(true);

    await expect.poll(() => hook.result.current, { timeout: 10_000 }).toBe(full);

    await hook.unmount();
  });

  it("snaps to the full text the instant streaming ends", async () => {
    const mountText = "Partial ";
    const hook = await renderSmoothText({ text: mountText, isStreaming: true });

    const full = mountText + LONG_DELTA;
    await hook.rerender({ text: full, isStreaming: true });
    expect(hook.result.current.length).toBeLessThan(full.length);

    // No trailing typewriter once the agent is done: the flip to settled must
    // return the complete text synchronously, mid-animation backlog and all.
    await hook.rerender({ text: full, isStreaming: false });
    expect(hook.result.current).toBe(full);

    await hook.unmount();
  });

  it("resets instantly on a non-append replacement while streaming", async () => {
    const hook = await renderSmoothText({ text: "Original draft", isStreaming: true });
    expect(hook.result.current).toBe("Original draft");

    // A projection repair can rewrite the text in place; a non-append target
    // must not be typewriter-animated from a stale prefix.
    await hook.rerender({ text: "Rewritten from scratch", isStreaming: true });
    expect(hook.result.current).toBe("Rewritten from scratch");

    await hook.unmount();
  });

  it("returns the raw text under prefers-reduced-motion even while streaming", async () => {
    const originalMatchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
      query === "(prefers-reduced-motion: reduce)"
        ? ({
            matches: true,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          } as unknown as MediaQueryList)
        : originalMatchMedia(query),
    );

    const mountText = "Hello ";
    const hook = await renderSmoothText({ text: mountText, isStreaming: true });
    expect(hook.result.current).toBe(mountText);

    const full = mountText + LONG_DELTA;
    await hook.rerender({ text: full, isStreaming: true });
    expect(hook.result.current).toBe(full);

    await hook.unmount();
  });
});
