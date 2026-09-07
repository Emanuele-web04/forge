import { afterEach, describe, expect, it } from "vitest";

import { syncAnimationsToTimelineOrigin } from "./animationTimelineSync";

const STYLE_ID = "animation-timeline-sync-test-style";

function mountSpinner(): HTMLElement {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes timeline-sync-test-spin { to { transform: rotate(360deg); } }
      .timeline-sync-test { width: 12px; height: 12px; animation: timeline-sync-test-spin 1.3s steps(24, end) infinite; }
    `;
    document.head.append(style);
  }
  const element = document.createElement("div");
  element.className = "timeline-sync-test";
  document.body.append(element);
  return element;
}

afterEach(() => {
  for (const element of document.querySelectorAll(".timeline-sync-test")) element.remove();
});

describe("syncAnimationsToTimelineOrigin", () => {
  it("pins every mounted instance to the same start time regardless of mount order", async () => {
    const first = mountSpinner();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
    const second = mountSpinner();

    const firstBefore = first.getAnimations()[0];
    const secondBefore = second.getAnimations()[0];
    expect(firstBefore).toBeDefined();
    expect(secondBefore).toBeDefined();
    // Mounted ~120ms apart, the two animations do not share a start time.
    expect(firstBefore!.startTime).not.toBe(secondBefore!.startTime);

    syncAnimationsToTimelineOrigin(first);
    syncAnimationsToTimelineOrigin(second);

    expect(first.getAnimations()[0]!.startTime).toBe(0);
    expect(second.getAnimations()[0]!.startTime).toBe(0);
    expect(first.getAnimations()[0]!.playState).toBe("running");
  });

  it("is a no-op for elements without animations and for null", () => {
    const plain = document.createElement("div");
    document.body.append(plain);
    plain.className = "timeline-sync-test-plain";
    expect(() => syncAnimationsToTimelineOrigin(plain)).not.toThrow();
    expect(() => syncAnimationsToTimelineOrigin(null)).not.toThrow();
    plain.remove();
  });
});
