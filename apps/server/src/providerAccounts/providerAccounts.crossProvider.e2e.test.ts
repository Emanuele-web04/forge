import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ACCOUNT_ENV_UNSET } from "@synara/shared/providerAccounts/accountEnvironment";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAccountConnect, type AccountConnectShape } from "./accountConnect";
import { makeAccountResolver } from "./accountResolver";
import { makeAccountStorage, type AccountStorageShape } from "./accountStorage";

/** Applies launch overrides the way a real spawn does (unset markers delete). */
const applyToChildEnv = (
  parent: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> => {
  const env: Record<string, string> = { ...parent };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === ACCOUNT_ENV_UNSET) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
};

describe("provider accounts cross-provider isolation end to end", () => {
  let root: string;
  let storage: AccountStorageShape;
  let connect: AccountConnectShape;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "synara-accounts-xp-e2e-"));
    storage = makeAccountStorage({ root });
    connect = makeAccountConnect({ storage });
    await Effect.runPromise(storage.ensureRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps Claude and Grok launch environments disjoint after concurrent connects", async () => {
    const [claudeOp, grokOp] = await Promise.all([
      Effect.runPromise(
        connect.beginConnect({
          kind: "agent-api-key",
          provider: "claudeAgent",
          apiKey: "sk-ant-claude-1",
        }),
      ),
      Effect.runPromise(
        connect.beginConnect({ kind: "agent-api-key", provider: "grok", apiKey: "xai-grok-1" }),
      ),
    ]);
    const claudeStatus = await Effect.runPromise(connect.getConnectStatus(claudeOp.operationId));
    const grokStatus = await Effect.runPromise(connect.getConnectStatus(grokOp.operationId));
    expect(claudeStatus).toMatchObject({ state: "succeeded", ordinal: 1 });
    expect(grokStatus).toMatchObject({ state: "succeeded", ordinal: 1 });

    // Each provider owns its own ordinal-1 slot and secret; neither clobbered
    // the other despite sharing the same account root.
    await expect(Effect.runPromise(storage.readSecret("claudeAgent", 1, "agent"))).resolves.toBe(
      "sk-ant-claude-1",
    );
    await expect(Effect.runPromise(storage.readSecret("grok", 1, "agent"))).resolves.toBe(
      "xai-grok-1",
    );

    const resolver = makeAccountResolver({ storage });
    const claudeLaunch = await Effect.runPromise(
      resolver.resolveAccountLaunch({
        provider: "claudeAgent",
        surface: "agent",
        explicitOrdinal: 1,
      }),
    );
    const grokLaunch = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "grok", surface: "agent", explicitOrdinal: 1 }),
    );

    // Own credentials and isolated homes.
    expect(claudeLaunch.environment.ANTHROPIC_API_KEY).toBe("sk-ant-claude-1");
    expect(claudeLaunch.environment.CLAUDE_CONFIG_DIR).toBe(
      join(root, "accounts", "claudeAgent", "1", "agent", "home"),
    );
    expect(grokLaunch.environment.XAI_API_KEY).toBe("xai-grok-1");
    expect(grokLaunch.environment.GROK_HOME).toBe(
      join(root, "accounts", "grok", "1", "agent", "home"),
    );

    // Neither launch environment mentions the other provider's variables.
    const claudeVars = Object.keys(claudeLaunch.environment);
    const grokVars = Object.keys(grokLaunch.environment);
    for (const grokVar of ["XAI_API_KEY", "GROK_HOME", "GROK_CODE_XAI_API_KEY"]) {
      expect(claudeVars).not.toContain(grokVar);
    }
    for (const claudeVar of ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL"]) {
      expect(grokVars).not.toContain(claudeVar);
    }

    // Applied onto a shell that inherited native keys for both providers,
    // each launch replaces or unsets its own provider's inherited auth and
    // leaves the other provider's variables untouched.
    const inherited = {
      ANTHROPIC_API_KEY: "native-anthropic",
      ANTHROPIC_BASE_URL: "https://native-anthropic.example.com",
      XAI_API_KEY: "native-xai",
      GROK_HOME: "/native/grok/home",
    };
    const claudeChild = applyToChildEnv(inherited, claudeLaunch.environment);
    expect(claudeChild.ANTHROPIC_API_KEY).toBe("sk-ant-claude-1");
    expect(claudeChild.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(claudeChild.XAI_API_KEY).toBe("native-xai");

    const grokChild = applyToChildEnv(inherited, grokLaunch.environment);
    expect(grokChild.XAI_API_KEY).toBe("xai-grok-1");
    expect(grokChild.GROK_HOME).toBe(join(root, "accounts", "grok", "1", "agent", "home"));
    expect(grokChild.ANTHROPIC_API_KEY).toBe("native-anthropic");
  });
});
