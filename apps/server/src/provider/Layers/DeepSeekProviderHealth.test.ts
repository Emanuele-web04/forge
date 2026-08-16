import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeCheckDeepSeekProviderStatus } from "./ProviderHealth.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("makeCheckDeepSeekProviderStatus", () => {
  it("defers authentication to a custom Harness composition", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");

    const status = await Effect.runPromise(
      makeCheckDeepSeekProviderStatus(process.execPath, "/tmp/deepseek/cordis.yml"),
    );

    expect(status).toMatchObject({
      provider: "deepseek",
      status: "ready",
      available: true,
      authStatus: "unknown",
    });
  });

  it("requires DEEPSEEK_API_KEY for Synara's generated composition", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");

    const status = await Effect.runPromise(makeCheckDeepSeekProviderStatus(process.execPath));

    expect(status).toMatchObject({
      provider: "deepseek",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
    });
  });
});
