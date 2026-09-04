import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAccountConnect, type AccountConnectShape } from "./accountConnect";
import { makeAccountResolver } from "./accountResolver";
import { makeAccountStorage, type AccountStorageShape } from "./accountStorage";
import { makeCliIntegration } from "./cliIntegration";
import type { OAuthLoginOutcome, OAuthLoginRunner } from "./oauthLogin";

const LAUNCHER_ENTRY = resolve(import.meta.dirname, "../../../account-launcher/src/launcher.ts");

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
};

describe("provider accounts end to end", () => {
  let root: string;
  let storage: AccountStorageShape;
  let connect: AccountConnectShape;
  let resolveLogin: ((outcome: OAuthLoginOutcome) => void) | null;
  let loginCancelled: boolean;

  const fakeOauthRunner: OAuthLoginRunner = (request) => {
    const done = new Promise<OAuthLoginOutcome>((resolveOutcome) => {
      resolveLogin = resolveOutcome;
    });
    request.onVerification({
      verificationUrl: "https://example.com/device",
      userCode: "WX-99",
    });
    return {
      done,
      cancel: () => {
        loginCancelled = true;
      },
    };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "synara-accounts-e2e-"));
    storage = makeAccountStorage({ root });
    connect = makeAccountConnect({ storage, oauthLoginRunners: { codex: fakeOauthRunner } });
    resolveLogin = null;
    loginCancelled = false;
    await Effect.runPromise(storage.ensureRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("connects an API-key account end to end: reserve, secret, record, activate-if-first", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "codex", apiKey: "sk-e2e-1" }),
    );
    const status = await Effect.runPromise(connect.getConnectStatus(operationId));
    expect(status).toMatchObject({ state: "succeeded", ordinal: 1 });
    const record = await Effect.runPromise(storage.readAccount("codex", 1));
    expect(record?.agent).toMatchObject({ state: "connected", authMethod: "apiKey" });
    await expect(Effect.runPromise(storage.readSecret("codex", 1, "agent"))).resolves.toBe(
      "sk-e2e-1",
    );
    await expect(Effect.runPromise(storage.readActiveOrdinal("codex"))).resolves.toBe(1);
    // A second connect does not steal the active pointer.
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "codex", apiKey: "sk-e2e-2" }),
    );
    await expect(Effect.runPromise(storage.readActiveOrdinal("codex"))).resolves.toBe(1);
  });

  it("drives OAuth end to end: verification URL, cancel, and failure rollback", async () => {
    // Verification surfacing.
    const first = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    const waiting = await Effect.runPromise(connect.getConnectStatus(first.operationId));
    expect(waiting).toMatchObject({
      state: "waiting-for-user",
      verificationUrl: "https://example.com/device",
      userCode: "WX-99",
    });

    // Cancel: pending directory removed, runner cancelled, no ordinal used.
    const cancelled = await Effect.runPromise(connect.cancelConnect(first.operationId));
    expect(cancelled.state).toBe("cancelled");
    expect(loginCancelled).toBe(true);
    await expect(Effect.runPromise(storage.listPendingOperations("codex"))).resolves.toEqual([]);
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([]);

    // Failure: login process fails, operation terminal, no ordinal consumed.
    const second = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    resolveLogin!({ ok: false, error: "login exited with code 7" });
    await waitFor(
      () => Effect.runSync(connect.getConnectStatus(second.operationId)).state === "failed",
    );
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([]);
    await expect(Effect.runPromise(storage.listPendingOperations("codex"))).resolves.toEqual([]);

    // Success: ordinal allocated only at finalization.
    const third = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    resolveLogin!({ ok: true, identityHint: "e***@example.com" });
    await waitFor(
      () => Effect.runSync(connect.getConnectStatus(third.operationId)).state === "succeeded",
    );
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([1]);
  });

  it("switches the active account across managed ordinals and back to zero", async () => {
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "grok", apiKey: "xai-a" }),
    );
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "grok", apiKey: "xai-b" }),
    );
    await Effect.runPromise(connect.setActive("grok", 2));
    await expect(Effect.runPromise(storage.readActiveOrdinal("grok"))).resolves.toBe(2);
    await Effect.runPromise(connect.setActive("grok", 0));
    await expect(Effect.runPromise(storage.readActiveOrdinal("grok"))).resolves.toBe(0);

    // A needs-auth binding cannot be activated.
    await Effect.runPromise(connect.disconnectBinding("grok", 1, "agent"));
    const failure = await Effect.runPromise(Effect.flip(connect.setActive("grok", 1)));
    expect(failure.detail).toMatch(/agent binding is 'needs-auth'/);
  });

  it("isolates resolved environments per account: disjoint homes and keys", async () => {
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "codex", apiKey: "sk-acct-1" }),
    );
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "codex", apiKey: "sk-acct-2" }),
    );

    const resolver = makeAccountResolver({ storage });
    const launchOne = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 1 }),
    );
    const launchTwo = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 2 }),
    );
    expect(launchOne.environment.CODEX_HOME).toBe(
      join(root, "accounts", "codex", "1", "agent", "home"),
    );
    expect(launchOne.environment.CODEX_HOME).not.toBe(launchTwo.environment.CODEX_HOME);
    expect(launchOne.environment.OPENAI_API_KEY).toBe("sk-acct-1");
    expect(launchTwo.environment.OPENAI_API_KEY).toBe("sk-acct-2");
  });

  it("spawns the fake provider binary through the real shim with the managed environment", async () => {
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "codex", apiKey: "sk-shim-1" }),
    );

    const cliIntegration = makeCliIntegration({ root, launcherEntry: LAUNCHER_ENTRY });
    await Effect.runPromise(cliIntegration.install);

    const fakeBinDir = join(root, "fake-bin");
    mkdirSync(fakeBinDir);
    writeFileSync(
      join(fakeBinDir, "codex"),
      [
        "#!/bin/sh",
        'echo "CODEX_HOME=$CODEX_HOME"',
        'echo "OPENAI_API_KEY=$OPENAI_API_KEY"',
        'echo "SYNARA_LAUNCHER_SHIM=${SYNARA_LAUNCHER_SHIM:-unset}"',
        'echo "OPENAI_BASE_URL=${OPENAI_BASE_URL:-unset}"',
      ].join("\n"),
      { mode: 0o755 },
    );

    // The shim runs `bun <launcher entry>`, so bun's directory must stay on PATH.
    const bunPath = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();
    expect(bunPath.length).toBeGreaterThan(0);
    const childPath = [
      cliIntegration.shimDir,
      fakeBinDir,
      dirname(bunPath),
      "/usr/bin",
      "/bin",
    ].join(delimiter);

    const result = spawnSync(join(cliIntegration.shimDir, "codex"), [], {
      encoding: "utf8",
      env: {
        PATH: childPath,
        SYNARA_ACCOUNT_HOME: root,
        OPENAI_API_KEY: "native-key",
        OPENAI_BASE_URL: "https://native.example.com",
      },
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `CODEX_HOME=${join(root, "accounts", "codex", "1", "agent", "home")}`,
    );
    expect(result.stdout).toContain("OPENAI_API_KEY=sk-shim-1");
    expect(result.stdout).toContain("SYNARA_LAUNCHER_SHIM=unset");
    expect(result.stdout).toContain("OPENAI_BASE_URL=unset");
  });

  it("recovers a mid-OAuth connect as terminal after a service restart", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    await expect(Effect.runPromise(storage.listPendingOperations("codex"))).resolves.toEqual([
      operationId,
    ]);

    // "Kill" the service: a fresh storage + connect over the same root.
    const restartedStorage = makeAccountStorage({ root });
    const restarted = makeAccountConnect({ storage: restartedStorage });
    await Effect.runPromise(restarted.recoverInterruptedOperations);

    const status = await Effect.runPromise(restarted.getConnectStatus(operationId));
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/interrupted by a server restart/);
    await expect(
      Effect.runPromise(restartedStorage.listPendingOperations("codex")),
    ).resolves.toEqual([]);
    expect(existsSync(join(root, "pending", "codex"))).toBe(false);
    await expect(Effect.runPromise(restartedStorage.listOrdinals("codex"))).resolves.toEqual([]);
  });

  it("gives concurrent API-key connects distinct ordinals and secrets with no overwrites", async () => {
    const keys = Array.from({ length: 6 }, (_, index) => `sk-concurrent-${index}`);
    const operationIds = await Promise.all(
      keys.map((apiKey) =>
        Effect.runPromise(
          connect.beginConnect({ kind: "agent-api-key", provider: "codex", apiKey }),
        ),
      ),
    );
    const statuses = await Promise.all(
      operationIds.map(({ operationId }) =>
        Effect.runPromise(connect.getConnectStatus(operationId)),
      ),
    );
    const ordinals = statuses.map((status) => status.ordinal).toSorted((a, b) => a! - b!);
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6]);
    for (const status of statuses) {
      expect(status.state).toBe("succeeded");
      const index = statuses.indexOf(status);
      await expect(
        Effect.runPromise(storage.readSecret("codex", status.ordinal!, "agent")),
      ).resolves.toBe(keys[index]);
    }
  });
});
