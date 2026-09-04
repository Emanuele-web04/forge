import { describe, expect, it } from "vitest";

import { ACCOUNT_ENV_UNSET } from "./accountEnvironment";
import { buildClaudeAccountEnvironment } from "./claudeAccountEnvironment";

describe("buildClaudeAccountEnvironment", () => {
  it("pins CLAUDE_CONFIG_DIR to the account agent home", () => {
    const result = buildClaudeAccountEnvironment({
      provider: "claudeAgent",
      ordinal: 1,
      surface: "agent",
      authMethod: "oauth",
      agentHome: "/accounts/claudeAgent/1/agent",
      appDataDir: "/accounts/claudeAgent/1/app/data",
    });
    expect(result.environment.CLAUDE_CONFIG_DIR).toBe("/accounts/claudeAgent/1/agent");
    expect(result.profilePath).toBe("/accounts/claudeAgent/1/agent");
  });

  it("strips conflicting inherited auth overrides", () => {
    const result = buildClaudeAccountEnvironment({
      provider: "claudeAgent",
      ordinal: 1,
      surface: "agent",
      authMethod: "oauth",
      agentHome: "/accounts/claudeAgent/1/agent",
      appDataDir: "/accounts/claudeAgent/1/app/data",
    });
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    ]) {
      expect(result.environment[name]).toBe(ACCOUNT_ENV_UNSET);
    }
  });

  it("injects the resolved API key for API-key accounts", () => {
    const result = buildClaudeAccountEnvironment({
      provider: "claudeAgent",
      ordinal: 2,
      surface: "agent",
      authMethod: "apiKey",
      agentHome: "/accounts/claudeAgent/2/agent",
      appDataDir: "/accounts/claudeAgent/2/app/data",
      apiKey: "sk-ant-managed",
    });
    expect(result.environment.ANTHROPIC_API_KEY).toBe("sk-ant-managed");
  });

  it("keeps OAuth launches free of injected API keys", () => {
    const result = buildClaudeAccountEnvironment({
      provider: "claudeAgent",
      ordinal: 1,
      surface: "agent",
      authMethod: "oauth",
      agentHome: "/accounts/claudeAgent/1/agent",
      appDataDir: "/accounts/claudeAgent/1/app/data",
    });
    expect(result.environment.ANTHROPIC_API_KEY).toBe(ACCOUNT_ENV_UNSET);
  });

  it("pins the app surface to the account app data dir without API keys", () => {
    const result = buildClaudeAccountEnvironment({
      provider: "claudeAgent",
      ordinal: 1,
      surface: "app",
      authMethod: "oauth",
      agentHome: "/accounts/claudeAgent/1/agent",
      appDataDir: "/accounts/claudeAgent/1/app/data",
    });
    expect(result.environment.CLAUDE_CONFIG_DIR).toBe("/accounts/claudeAgent/1/app/data");
    expect(result.profilePath).toBe("/accounts/claudeAgent/1/app/data");
    expect(result.environment.ANTHROPIC_API_KEY).toBe(ACCOUNT_ENV_UNSET);
    expect(result.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe(ACCOUNT_ENV_UNSET);
  });
});
