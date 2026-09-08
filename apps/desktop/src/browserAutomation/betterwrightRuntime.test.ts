import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { BrowserAutomationErrorMessages } from "@synara/contracts";
import { runBetterwright } from "./betterwrightRuntime";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  browserClose: vi.fn(),
  connectionClose: vi.fn(),
  openConnection: vi.fn(),
}));
vi.mock("betterwright", () => ({
  BetterWright: class {
    run = mocks.run;
    close = mocks.browserClose;
  },
  NetworkPolicy: class {},
}));
vi.mock("./betterwrightConnection", () => ({
  openBetterwrightConnection: mocks.openConnection,
}));

const contents = {
  getBackgroundThrottling: vi.fn(),
  setBackgroundThrottling: vi.fn(),
  isDestroyed: vi.fn(),
} as unknown as WebContents;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.browserClose.mockResolvedValue(undefined);
  mocks.connectionClose.mockResolvedValue(undefined);
  mocks.openConnection.mockResolvedValue({ provider: {}, close: mocks.connectionClose });
  vi.mocked(contents.getBackgroundThrottling).mockReturnValue(true);
  vi.mocked(contents.isDestroyed).mockReturnValue(false);
});

const run = () =>
  runBetterwright({
    home: "/synthetic",
    contents,
    code: "return null",
    timeoutMs: 30000,
    signal: new AbortController().signal,
  });

describe("Betterwright runtime errors", () => {
  it.each([true, false])(
    "restores the original throttling policy (%s) after the worker drains",
    async (throttled) => {
      vi.mocked(contents.getBackgroundThrottling).mockReturnValue(throttled);
      mocks.run.mockImplementation(async () => {
        if (throttled) expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
        return { ok: true, result: null };
      });
      mocks.connectionClose.mockImplementation(async () => {
        if (throttled) expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
      });
      await run();
      expect(vi.mocked(contents.setBackgroundThrottling).mock.calls).toEqual(
        throttled ? [[false], [true]] : [],
      );
    },
  );

  it("restores throttling when connection setup fails", async () => {
    mocks.openConnection.mockRejectedValue(new Error("setup failed"));
    await expect(run()).rejects.toThrow("setup failed");
    expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it("does not restore a destroyed renderer after a worker error", async () => {
    mocks.run.mockImplementation(async () => {
      vi.mocked(contents.isDestroyed).mockReturnValue(true);
      throw new Error("renderer closed");
    });
    await expect(run()).rejects.toThrow("renderer closed");
    expect(vi.mocked(contents.setBackgroundThrottling).mock.calls).toEqual([[false]]);
  });
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

  it.each([
    "getByRole",
    "getByLabel",
    "getByText",
    "getByPlaceholder",
    "getByTestId",
    "locator",
    "document",
    "window",
    "location",
    "waitForTimeout",
  ])("explains the sandbox API for an unavailable %s global", async (name) => {
    mocks.run.mockResolvedValue({ ok: false, error: `${name} is not defined` });
    await expect(run()).rejects.toMatchObject({
      browserError: {
        code: "BrowserScriptApiUnavailable",
        message: BrowserAutomationErrorMessages.BrowserScriptApiUnavailable,
        retryable: false,
        effectMayHaveCommitted: true,
      },
    });
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
  });

  it("points page.snapshot callers to the global snapshot helper", async () => {
    mocks.run.mockResolvedValue({ ok: false, error: "page.snapshot is not a function" });
    await expect(run()).rejects.toMatchObject({
      browserError: {
        code: "BrowserScriptApiUnavailable",
        message: expect.stringContaining("global snapshot()"),
      },
    });
  });

  it.each([
    "private-password is not defined",
    "getByRole is not defined: private-password",
    "private-password: document is not defined",
  ])("does not classify or expose unknown error text: %s", async (error) => {
    mocks.run.mockResolvedValue({ ok: false, error });
    const failure = await run().catch((value: unknown) => value);
    expect(failure).toMatchObject({ browserError: { code: "BrowserEvaluationFailed" } });
    expect(JSON.stringify(failure)).not.toContain("private-password");
    expect(JSON.stringify(failure)).not.toContain("sign in manually");
  });

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
      contents,
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
