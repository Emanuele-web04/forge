import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAccountRecord } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAccountResolver, ProviderAccountResolutionError } from "./accountResolver";
import { makeAccountStorage, type AccountStorageShape } from "./accountStorage";

const codexAccount = (input: {
  readonly ordinal: number;
  readonly generation?: number;
  readonly state?: "connected" | "needs-auth";
  readonly authMethod?: "oauth" | "apiKey";
}): ProviderAccountRecord => ({
  schemaVersion: 1,
  provider: "codex",
  ordinal: input.ordinal,
  createdAt: "2026-07-24T00:00:00.000Z",
  agent: {
    generation: input.generation ?? 1,
    state: input.state ?? "connected",
    authMethod: input.authMethod ?? "oauth",
  },
});

const cursorAccount = (input: {
  readonly ordinal: number;
  readonly generation?: number;
  readonly state?: "connected" | "needs-auth";
  readonly authMethod?: "oauth" | "apiKey";
  readonly app?: boolean;
}): ProviderAccountRecord => ({
  schemaVersion: 1,
  provider: "cursor",
  ordinal: input.ordinal,
  createdAt: "2026-07-24T00:00:00.000Z",
  agent: {
    generation: input.generation ?? 1,
    state: input.state ?? "connected",
    authMethod: input.authMethod ?? "apiKey",
  },
  ...(input.app
    ? {
        app: {
          generation: input.generation ?? 1,
          state: "connected" as const,
          authMethod: "oauth" as const,
          supportLevel: "beta" as const,
        },
      }
    : {}),
});

const expectResolutionFailure = async (
  effect: Effect.Effect<unknown, unknown>,
  code: ProviderAccountResolutionError["code"],
) => {
  const result = await Effect.runPromise(Effect.flip(effect));
  expect(result).toBeInstanceOf(ProviderAccountResolutionError);
  expect((result as ProviderAccountResolutionError).code).toBe(code);
};

describe("accountResolver", () => {
  let root: string;
  let storage: AccountStorageShape;
  let resolver: ReturnType<typeof makeAccountResolver>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "synara-resolver-"));
    storage = makeAccountStorage({ root });
    resolver = makeAccountResolver({ storage });
    await Effect.runPromise(storage.ensureRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns native launch for account 0", async () => {
    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent" }),
    );
    expect(resolved.ordinal).toBe(0);
    expect(resolved.environment).toEqual({});
    expect(resolved.profilePath).toBeUndefined();
  });

  it("prefers the thread binding over the active pointer", async () => {
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 1 })));
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 2 })));
    await Effect.runPromise(storage.writeActiveOrdinal("codex", 2));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({
        provider: "codex",
        surface: "agent",
        threadBinding: { ordinal: 1, agentGeneration: 1 },
      }),
    );
    expect(resolved.ordinal).toBe(1);
  });

  it("fails closed when an explicit ordinal conflicts with the thread binding", async () => {
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 1 })));
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 2 })));

    await expectResolutionFailure(
      resolver.resolveAccountLaunch({
        provider: "codex",
        surface: "agent",
        explicitOrdinal: 2,
        threadBinding: { ordinal: 1, agentGeneration: 1 },
      }),
      "binding-conflict",
    );
  });

  it("uses the explicit ordinal over the active pointer", async () => {
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 1 })));
    await Effect.runPromise(storage.writeActiveOrdinal("codex", 1));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 0 }),
    );
    expect(resolved.ordinal).toBe(0);
  });

  it("falls back to the active pointer when nothing is selected", async () => {
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 1 })));
    await Effect.runPromise(storage.writeActiveOrdinal("codex", 1));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent" }),
    );
    expect(resolved.ordinal).toBe(1);
    expect(resolved.environment.CODEX_HOME).toContain(join("accounts", "codex", "1"));
  });

  it("fails closed when the selected account does not exist", async () => {
    await expectResolutionFailure(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 7 }),
      "account-not-found",
    );
  });

  it("fails closed when the binding is not connected", async () => {
    await Effect.runPromise(
      storage.writeAccount(codexAccount({ ordinal: 1, state: "needs-auth" })),
    );
    await expectResolutionFailure(
      resolver.resolveAccountLaunch({
        provider: "codex",
        surface: "agent",
        threadBinding: { ordinal: 1, agentGeneration: 1 },
      }),
      "binding-unavailable",
    );
  });

  it("fails closed on a generation mismatch", async () => {
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 1, generation: 3 })));
    await expectResolutionFailure(
      resolver.resolveAccountLaunch({
        provider: "codex",
        surface: "agent",
        threadBinding: { ordinal: 1, agentGeneration: 2 },
      }),
      "generation-mismatch",
    );
  });

  it("fails closed when an API-key account is missing its secret", async () => {
    await Effect.runPromise(
      storage.writeAccount(codexAccount({ ordinal: 1, authMethod: "apiKey" })),
    );
    await expectResolutionFailure(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 1 }),
      "binding-unavailable",
    );
  });

  it("injects the stored API key for managed API-key accounts", async () => {
    await Effect.runPromise(
      storage.writeAccount(codexAccount({ ordinal: 1, authMethod: "apiKey" })),
    );
    await Effect.runPromise(storage.writeSecret("codex", 1, "agent", "sk-managed"));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 1 }),
    );
    expect(resolved.environment.OPENAI_API_KEY).toBe("sk-managed");
    expect(resolved.environment.CODEX_HOME).toBe(resolved.profilePath);
  });

  it("resolves managed Claude accounts through the registered builder", async () => {
    await Effect.runPromise(
      storage.writeAccount({
        schemaVersion: 1,
        provider: "claudeAgent",
        ordinal: 1,
        createdAt: "2026-07-24T00:00:00.000Z",
        agent: { generation: 1, state: "connected", authMethod: "apiKey" },
      }),
    );
    await Effect.runPromise(storage.writeSecret("claudeAgent", 1, "agent", "sk-ant-managed"));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({
        provider: "claudeAgent",
        surface: "agent",
        explicitOrdinal: 1,
      }),
    );
    expect(resolved.environment.ANTHROPIC_API_KEY).toBe("sk-ant-managed");
    expect(resolved.environment.CLAUDE_CONFIG_DIR).toBe(resolved.profilePath);
    expect(resolved.profilePath).toContain(join("accounts", "claudeAgent", "1"));
    expect(resolved.supportLevel).toBe("supported");
  });

  it("injects the stored Cursor API key for managed Cursor accounts", async () => {
    await Effect.runPromise(storage.writeAccount(cursorAccount({ ordinal: 1 })));
    await Effect.runPromise(storage.writeSecret("cursor", 1, "agent", "key_managed"));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "cursor", surface: "agent", explicitOrdinal: 1 }),
    );
    expect(resolved.environment.CURSOR_API_KEY).toBe("key_managed");
    expect(resolved.environment.CURSOR_CONFIG_DIR).toBe(resolved.profilePath);
    expect(resolved.supportLevel).toBe("supported");
  });

  it("resolves the Cursor app OAuth binding as unsupported without injecting a key", async () => {
    await Effect.runPromise(storage.writeAccount(cursorAccount({ ordinal: 1, app: true })));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "cursor", surface: "app", explicitOrdinal: 1 }),
    );
    expect(resolved.environment.CURSOR_API_KEY).toBe("");
    expect(resolved.supportLevel).toBe("unsupported");
  });

  it("resolves managed Grok accounts through the registered Grok builder", async () => {
    await Effect.runPromise(
      storage.writeAccount({
        schemaVersion: 1,
        provider: "grok",
        ordinal: 1,
        createdAt: "2026-07-24T00:00:00.000Z",
        agent: { generation: 1, state: "connected", authMethod: "apiKey" },
      }),
    );
    await Effect.runPromise(storage.writeSecret("grok", 1, "agent", "xai-managed"));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "grok", surface: "agent", explicitOrdinal: 1 }),
    );
    expect(resolved.environment.XAI_API_KEY).toBe("xai-managed");
    expect(resolved.environment.GROK_HOME).toBe(resolved.profilePath);
    expect(resolved.environment.GROK_HOME).toContain(join("accounts", "grok", "1"));
    expect(resolved.supportLevel).toBe("supported");
  });

  it("keeps Grok OAuth launches free of injected API keys", async () => {
    await Effect.runPromise(
      storage.writeAccount({
        schemaVersion: 1,
        provider: "grok",
        ordinal: 1,
        createdAt: "2026-07-24T00:00:00.000Z",
        agent: { generation: 1, state: "connected", authMethod: "oauth" },
      }),
    );
    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "grok", surface: "agent", explicitOrdinal: 1 }),
    );
    expect(resolved.environment.XAI_API_KEY).toBe("");
    expect(resolved.environment.GROK_CODE_XAI_API_KEY).toBe("");
    expect(resolved.environment.GROK_HOME).toBe(resolved.profilePath);
  });

  it("keeps OAuth launches free of injected API keys", async () => {
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 1 })));
    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 1 }),
    );
    expect(resolved.environment.OPENAI_API_KEY).toBe("");
    expect(resolved.environment.CODEX_HOME).toBe(resolved.profilePath);
  });
});
