import { describe, expect, it } from "vitest";

import { ACCOUNT_ENV_UNSET } from "@synara/shared/providerAccounts/accountEnvironment";
import { accountEnvironmentBuilders } from "@synara/shared/providerAccounts/accountEnvironmentBuilders";
import { buildCursorAccountEnvironment } from "./cursorAccountEnvironment";

const agentHome = "/accounts/cursor/2/agent/home";

describe("buildCursorAccountEnvironment", () => {
  it("is the registry entry for the cursor provider", () => {
    expect(accountEnvironmentBuilders.cursor).toBe(buildCursorAccountEnvironment);
  });

  it("injects the managed API key and isolates the config dir", () => {
    const launch = buildCursorAccountEnvironment({
      provider: "cursor",
      ordinal: 2,
      surface: "agent",
      authMethod: "apiKey",
      agentHome,
      appDataDir: "/accounts/cursor/2/app/data",
      apiKey: "key_managed",
    });
    expect(launch.environment.CURSOR_API_KEY).toBe("key_managed");
    expect(launch.environment.CURSOR_CONFIG_DIR).toBe(agentHome);
    expect(launch.profilePath).toBe(agentHome);
  });

  it("strips inherited Cursor auth overrides for OAuth launches", () => {
    const launch = buildCursorAccountEnvironment({
      provider: "cursor",
      ordinal: 2,
      surface: "agent",
      authMethod: "oauth",
      agentHome,
      appDataDir: "/accounts/cursor/2/app/data",
    });
    expect(launch.environment.CURSOR_API_KEY).toBe(ACCOUNT_ENV_UNSET);
    expect(launch.environment.CURSOR_CONFIG_DIR).toBe(agentHome);
    expect(launch.profilePath).toBe(agentHome);
  });
});
