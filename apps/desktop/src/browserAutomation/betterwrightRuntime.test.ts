import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { BrowserAutomationErrorMessages } from "@synara/contracts";
import { runBetterwright } from "./betterwrightRuntime";

const mocks = vi.hoisted(() => ({ run: vi.fn(), browserClose: vi.fn(), connectionClose: vi.fn() }));
vi.mock("betterwright", () => ({
  BetterWright: class {
    run = mocks.run;
    close = mocks.browserClose;
  },
  NetworkPolicy: class {},
}));
vi.mock("./betterwrightConnection", () => ({
  openBetterwrightConnection: async () => ({ provider: {}, close: mocks.connectionClose }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.browserClose.mockResolvedValue(undefined);
  mocks.connectionClose.mockResolvedValue(undefined);
});

const run = () =>
  runBetterwright({
    home: "/synthetic",
    contents: {} as WebContents,
    code: "return null",
    timeoutMs: 30000,
    signal: new AbortController().signal,
  });

describe("Betterwright runtime errors", () => {
  it.each([
    "credential form not-found: private-page-label. Use explicit targets.",
    "credential form ambiguous: private-page-label. Use explicit targets.",
    "credential form detection found no password field.",
    "credential form submit detection failed: private-page-label.",
  ])("returns only fixed guidance for credential target errors (%s)", async (error) => {
    mocks.run.mockResolvedValue({ ok: false, error });
    await expect(run()).rejects.toMatchObject({
      browserError: {
        code: "BrowserCredentialTargetRequired",
        effectMayHaveCommitted: true,
        message: expect.stringContaining("sign in manually"),
      },
    });
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
    expect(mocks.browserClose).toHaveBeenCalledOnce();
  });

  it("preserves fixed guidance when a script requests password access", async () => {
    mocks.run.mockResolvedValue({
      ok: false,
      error: BrowserAutomationErrorMessages.BrowserCredentialUseUnavailable,
    });
    await expect(run()).rejects.toMatchObject({
      browserError: {
        code: "BrowserCredentialUseUnavailable",
        retryable: false,
        effectMayHaveCommitted: true,
      },
    });
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
  });

  it.each(["private-password", { secret: "private-password" }, undefined])(
    "never forwards unknown worker errors",
    async (error) => {
      mocks.run.mockResolvedValue({ ok: false, error });
      const failure = await run().catch((value: unknown) => value);
      expect(failure).toMatchObject({ browserError: { code: "BrowserEvaluationFailed" } });
      expect(JSON.stringify(failure)).not.toContain("private-password");
    },
  );

  it("retains successful values and converts milliseconds to seconds", async () => {
    mocks.run.mockResolvedValue({ ok: true, result: { filled: true } });
    expect(await run()).toEqual({ filled: true });
    expect(mocks.run).toHaveBeenCalledWith("return null", { timeout: 30 });
    expect(mocks.connectionClose).toHaveBeenCalledWith(false);
  });

  it("terminates uncertain execution when the worker transport rejects", async () => {
    mocks.run.mockRejectedValue(new Error("Worker disconnected"));
    await expect(run()).rejects.toThrow("Worker disconnected");
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
  });

  it.each(["Worker exited", "Execution timed out", "Transport failed"])(
    "cancels uncertain execution even when the worker resolves an error: %s",
    async (error) => {
      mocks.run.mockResolvedValue({ ok: false, error });
      await expect(run()).rejects.toMatchObject({
        browserError: { code: "BrowserEvaluationFailed" },
      });
      expect(mocks.connectionClose).toHaveBeenCalledWith(true);
    },
  );

  it("revokes and terminates an active worker on cancellation", async () => {
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    mocks.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = runBetterwright({
      home: "/synthetic",
      contents: {} as WebContents,
      code: "return null",
      timeoutMs: 30000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    const reason = new Error("Human takeover");
    controller.abort(reason);
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
    finish({ ok: true, result: null });
    await expect(result).rejects.toBe(reason);
    expect(mocks.connectionClose).toHaveBeenCalledOnce();
  });
});
