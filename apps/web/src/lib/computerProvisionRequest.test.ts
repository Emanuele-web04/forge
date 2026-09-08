import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./serverReactQuery";

const provision = vi.hoisted(() => vi.fn());
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ computer: { provision } }) }));
afterEach(() => provision.mockReset());

describe("computer setup across surfaces", () => {
  it("shares an in-flight request and allows a new attempt once it settles", async () => {
    let finish!: () => void;
    provision.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const fromSettings = provisionComputer();
    const fromTranscript = provisionComputer();
    expect(fromSettings).toBe(fromTranscript);
    expect(provision).toHaveBeenCalledTimes(1);
    finish();
    await fromSettings;
    provision.mockResolvedValueOnce(undefined);
    await provisionComputer();
    expect(provision).toHaveBeenCalledTimes(2);
  });

  it("clears failed requests so setup can be retried", async () => {
    provision.mockRejectedValueOnce(new Error("Helper disconnected"));
    await expect(provisionComputer()).rejects.toThrow("Helper disconnected");
    provision.mockResolvedValueOnce(undefined);
    await provisionComputer();
    expect(provision).toHaveBeenCalledTimes(2);
  });
});
