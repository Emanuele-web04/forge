import { describe, expect, it, vi } from "vitest";

import { startEndpointReporter } from "./endpointReporter";

describe("startEndpointReporter", () => {
  it("reports on startup and on network changes only", async () => {
    let tick: (() => void) | undefined;
    let fingerprint = "a";
    const report = vi.fn(async () => {});
    const stop = startEndpointReporter({
      report,
      fingerprint: () => fingerprint,
      setIntervalFn: ((callback: () => void) => {
        tick = callback;
        return { unref() {} };
      }) as unknown as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
    });
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    tick?.();
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
    fingerprint = "b";
    tick?.();
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    stop();
  });
});
