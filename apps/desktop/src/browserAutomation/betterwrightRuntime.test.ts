import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
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

const run = () => runBetterwright({ home: "/synthetic", contents: {} as WebContents,
  code: "return null", timeoutMs: 30000, signal: new AbortController().signal });

describe("Betterwright runtime errors", () => {
  it.each([
    "credential form not-found: private-page-label. Use explicit targets.",
    "credential form ambiguous: private-page-label. Use explicit targets.",
    "credential form detection found no password field.",
    "credential form submit detection failed: private-page-label.",
  ])("returns only fixed guidance for credential target errors (%s)", async (error) => {
    mocks.run.mockResolvedValue({ ok: false, error });
    await expect(run()).rejects.toMatchObject({ browserError: {
      code: "BrowserCredentialTargetRequired", effectMayHaveCommitted: true,
      message: expect.stringContaining("passwordSelector"),
    } });
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
    expect(mocks.browserClose).toHaveBeenCalledOnce();
  });

  it.each(["private-password", { secret: "private-password" }, undefined])("never forwards unknown worker errors", async (error) => {
    mocks.run.mockResolvedValue({ ok: false, error });
    const failure = await run().catch((value: unknown) => value);
    expect(failure).toMatchObject({ browserError: { code: "BrowserEvaluationFailed" } });
    expect(JSON.stringify(failure)).not.toContain("private-password");
  });

  it("retains successful values and converts milliseconds to seconds", async () => {
    mocks.run.mockResolvedValue({ ok: true, result: { filled: true } });
    expect(await run()).toEqual({ filled: true });
    expect(mocks.run).toHaveBeenCalledWith("return null", { timeout: 30 });
    expect(mocks.connectionClose).toHaveBeenCalledWith(false);
  });
});
