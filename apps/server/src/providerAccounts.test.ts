import { describe, expect, it } from "vitest";

import {
  buildManagedProviderAccountEnvironment,
  ensureCodexFileCredentialStorage,
  normalizeProviderAccountsMetadata,
  providerStatusOutputIsAuthenticated,
} from "./providerAccounts";

describe("provider account isolation", () => {
  it("isolates Codex credentials while preserving unrelated process configuration", () => {
    const env = buildManagedProviderAccountEnvironment("codex", "/private/codex-a", {
      OPENAI_API_KEY: "secret",
      CODEX_API_KEY: "secret",
      CODEX_ACCESS_TOKEN: "secret",
      PATH: "/usr/bin",
    });

    expect(env).toMatchObject({ CODEX_HOME: "/private/codex-a", PATH: "/usr/bin" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
  });

  it("isolates Claude credentials while preserving unrelated process configuration", () => {
    const env = buildManagedProviderAccountEnvironment("claudeAgent", "/private/claude-a", {
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_AUTH_TOKEN: "secret",
      CLAUDE_CODE_OAUTH_TOKEN: "secret",
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "secret",
      PATH: "/usr/bin",
    });

    expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: "/private/claude-a", PATH: "/usr/bin" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBeUndefined();
  });

  it("forces managed Codex homes to use private file-backed credentials", () => {
    expect(ensureCodexFileCredentialStorage('model = "gpt-5"\n')).toBe(
      'cli_auth_credentials_store = "file"\nmodel = "gpt-5"\n',
    );
    expect(
      ensureCodexFileCredentialStorage('model = "gpt-5"\ncli_auth_credentials_store = "keyring"\n'),
    ).toBe('model = "gpt-5"\ncli_auth_credentials_store = "file"\n');
  });

  it("does not treat a successful Claude status command as an authenticated login", () => {
    expect(
      providerStatusOutputIsAuthenticated(
        "claudeAgent",
        JSON.stringify({ loggedIn: false, authMethod: "none" }),
      ),
    ).toBe(false);
    expect(
      providerStatusOutputIsAuthenticated(
        "claudeAgent",
        JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      ),
    ).toBe(true);
    expect(providerStatusOutputIsAuthenticated("codex", "Not logged in")).toBe(false);
    expect(providerStatusOutputIsAuthenticated("codex", "Logged in using ChatGPT")).toBe(true);
  });

  it("falls back to the system account when persisted active metadata is invalid", () => {
    const normalized = normalizeProviderAccountsMetadata({
      providers: {
        codex: {
          activeAccountId: "missing",
          accounts: [
            {
              id: "codex-a",
              label: "Codex A",
              createdAt: "2026-08-30T00:00:00.000Z",
              authStatus: "authenticated",
            },
          ],
        },
        claudeAgent: {
          activeAccountId: "system",
          accounts: [],
        },
      },
    });

    expect(normalized.providers.codex.activeAccountId).toBe("system");
    expect(normalized.providers.codex.accounts).toHaveLength(1);
  });
});
