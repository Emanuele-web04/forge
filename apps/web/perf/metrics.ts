// FILE: perf/metrics.ts
// Purpose: Shared measurement helpers for the transcript performance harnesses.
// Exports: FrameReport, DurationStats, percentile, frameReport, durationStats, nextFrame,
//          createFrameCollector, sleep, installCostToggleStyles

export type FrameReport = {
  count: number;
  droppedFrames: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
};

export type DurationStats = {
  count: number;
  totalMs: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
};

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0;
}

export function frameReport(durations: readonly number[]): FrameReport {
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    count: durations.length,
    droppedFrames: durations.filter((duration) => duration > 20).length,
    meanMs: durations.length > 0 ? total / durations.length : 0,
    p95Ms: percentile(durations, 0.95),
    maxMs: Math.max(0, ...durations),
  };
}

export function durationStats(durations: readonly number[]): DurationStats {
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    count: durations.length,
    totalMs: total,
    meanMs: durations.length > 0 ? total / durations.length : 0,
    p95Ms: percentile(durations, 0.95),
    maxMs: Math.max(0, ...durations),
  };
}

export function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

export function createFrameCollector(
  input: {
    requestFrame?: typeof requestAnimationFrame;
    cancelFrame?: typeof cancelAnimationFrame;
  } = {},
) {
  const requestFrame = input.requestFrame ?? requestAnimationFrame;
  const cancelFrame = input.cancelFrame ?? cancelAnimationFrame;
  const durations: number[] = [];
  let running = false;
  let generation = 0;
  let previous = 0;
  let frameId: number | null = null;

  const schedule = (runGeneration: number) => {
    frameId = requestFrame((now) => {
      if (!running || generation !== runGeneration) return;
      if (previous > 0) durations.push(now - previous);
      previous = now;
      schedule(runGeneration);
    });
  };

  return {
    start() {
      if (frameId !== null) cancelFrame(frameId);
      generation += 1;
      durations.length = 0;
      previous = 0;
      running = true;
      schedule(generation);
    },
    stop(): readonly number[] {
      running = false;
      generation += 1;
      if (frameId !== null) {
        cancelFrame(frameId);
        frameId = null;
      }
      return [...durations];
    },
  };
}

/** Drive the mounted transcript scroll container through full top<->bottom sweeps and
 *  report per-frame durations. Shared by both harnesses so scroll numbers stay comparable. */
export async function scrollCycleOnTranscript(cycles = 2): Promise<FrameReport> {
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
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Style-level cost toggles driven by URL params (animations=off, shimmer=off, scrollFade=off,
 *  glass=off|<filter>, mask=off) so paired runs can isolate a single cost without code changes. */
export function installCostToggleStyles(): void {
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
  // Composer glass: `glass=off` drops the backdrop blur; any other value is used verbatim
  // as the filter (e.g. `glass=blur(20px)`), so paired runs can cost alternative radii.
  const glass = params.get("glass");
  if (glass !== null) {
    style.textContent += `
      :root {
        --composer-glass-filter: ${glass === "off" ? "none" : glass} !important;
      }
    `;
  }
  if (params.get("mask") === "off") {
    style.textContent += `
      [data-chat-scroll-container] {
        -webkit-mask-image: none !important;
        mask-image: none !important;
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
