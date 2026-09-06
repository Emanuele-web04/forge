import { SupportedAccountProvider } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { AccountEnvironmentBuildInput } from "./accountEnvironment";
import { accountEnvironmentBuilders } from "./accountEnvironmentBuilders";

const buildInput = (provider: SupportedAccountProvider): AccountEnvironmentBuildInput => ({
  provider,
  ordinal: 1,
  surface: "agent",
  authMethod: "apiKey",
  agentHome: `/root/accounts/${provider}/1/agent/home`,
  appDataDir: `/root/accounts/${provider}/1/app/data`,
  apiKey: "test-key",
});

describe("accountEnvironmentBuilders", () => {
  it("registers a builder for every supported provider", () => {
    for (const provider of SupportedAccountProvider.literals) {
      expect(accountEnvironmentBuilders[provider], provider).toBeTypeOf("function");
    }
    expect(Object.keys(accountEnvironmentBuilders).toSorted()).toEqual(
      [...SupportedAccountProvider.literals].toSorted(),
    );
  });

  it("every builder returns a launch environment rooted in the agent home", () => {
    for (const provider of SupportedAccountProvider.literals) {
      const result = accountEnvironmentBuilders[provider](buildInput(provider));
      expect(result.profilePath, provider).toBe(`/root/accounts/${provider}/1/agent/home`);
      expect(Object.keys(result.environment).length, provider).toBeGreaterThan(0);
    }
  });

  it("has no builder for an unknown provider", () => {
    const builders: Partial<Record<string, unknown>> = accountEnvironmentBuilders;
    expect(builders["not-a-provider"]).toBeUndefined();
  });
});
