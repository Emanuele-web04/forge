import { describe, expect, it } from "vitest";

import { ACCOUNT_ENV_UNSET } from "./accountEnvironment";
import { buildGrokAccountEnvironment } from "./grokAccountEnvironment";

const AGENT_HOME = "/accounts/grok/1/agent/home";

describe("buildGrokAccountEnvironment", () => {
  it("pins GROK_HOME and strips conflicting xAI keys for OAuth accounts", () => {
    const result = buildGrokAccountEnvironment({
      provider: "grok",
      ordinal: 1,
      surface: "agent",
      authMethod: "oauth",
      agentHome: AGENT_HOME,
      appDataDir: "/accounts/grok/1/app/data",
    });

    expect(result.environment.GROK_HOME).toBe(AGENT_HOME);
    expect(result.environment.XAI_API_KEY).toBe(ACCOUNT_ENV_UNSET);
    expect(result.environment.GROK_CODE_XAI_API_KEY).toBe(ACCOUNT_ENV_UNSET);
    expect(result.profilePath).toBe(AGENT_HOME);
  });

  it("injects only the selected XAI_API_KEY for API-key accounts", () => {
    const result = buildGrokAccountEnvironment({
      provider: "grok",
      ordinal: 2,
      surface: "agent",
      authMethod: "apiKey",
      agentHome: AGENT_HOME,
      appDataDir: "/accounts/grok/1/app/data",
      apiKey: "xai-managed-key",
    });

    expect(result.environment.GROK_HOME).toBe(AGENT_HOME);
    expect(result.environment.XAI_API_KEY).toBe("xai-managed-key");
    expect(result.environment.GROK_CODE_XAI_API_KEY).toBe(ACCOUNT_ENV_UNSET);
  });

  it("does not inject an API key when the secret is absent", () => {
    const result = buildGrokAccountEnvironment({
      provider: "grok",
      ordinal: 3,
      surface: "agent",
      authMethod: "apiKey",
      agentHome: AGENT_HOME,
      appDataDir: "/accounts/grok/1/app/data",
    });

    expect(result.environment.XAI_API_KEY).toBe(ACCOUNT_ENV_UNSET);
  });
});
