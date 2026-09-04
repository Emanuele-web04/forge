import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAccountsBeginConnectInput } from "@synara/contracts";
import {
  accountDir,
  accountSecretPath,
  secretsDir,
} from "@synara/shared/providerAccounts/accountPaths";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAccountConnect, type AccountConnectShape } from "./accountConnect";
import { makeAccountResolver } from "./accountResolver";
import { makeAccountStorage, type AccountStorageShape } from "./accountStorage";
import { makeCliIntegration } from "./cliIntegration";
import { makeDoctorReport } from "./doctorReport";
import type { OAuthLoginOutcome, OAuthLoginRunner } from "./oauthLogin";

const expectFailureDetail = async (
  effect: Effect.Effect<unknown, { readonly detail: string }>,
  pattern: RegExp,
) => {
  const failure = await Effect.runPromise(Effect.flip(effect));
  expect(failure.detail).toMatch(pattern);
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("accountConnect", () => {
  let root: string;
  let storage: AccountStorageShape;
  let connect: AccountConnectShape;
  let resolveLogin: ((outcome: OAuthLoginOutcome) => void) | null;
  let cancelled: boolean;
  let profileHomes: string[];

  const fakeOauthRunner: OAuthLoginRunner = (request) => {
    profileHomes.push(request.profileHome);
    const done = new Promise<OAuthLoginOutcome>((resolve) => {
      resolveLogin = resolve;
    });
    request.onVerification({ verificationUrl: "https://example.com/device", userCode: "AB-12" });
    return {
      done,
      cancel: () => {
        cancelled = true;
      },
    };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "synara-connect-"));
    storage = makeAccountStorage({ root });
    connect = makeAccountConnect({
      storage,
      oauthLoginRunners: { codex: fakeOauthRunner },
    });
    resolveLogin = null;
    cancelled = false;
    profileHomes = [];
    await Effect.runPromise(storage.ensureRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects unsupported provider/surface/auth combinations", async () => {
    await expectFailureDetail(
      connect.beginConnect({ kind: "agent-oauth", provider: "cursor" }),
      /not supported/,
    );
    await expectFailureDetail(
      connect.beginConnect({ kind: "app-oauth", provider: "codex" }),
      /not supported/,
    );
  });

  it("connects an API-key account transactionally and activates the first one", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "cursor", apiKey: "key_test1234" }),
    );
    const status = await Effect.runPromise(connect.getConnectStatus(operationId));
    expect(status.state).toBe("succeeded");
    expect(status.ordinal).toBe(1);

    const record = await Effect.runPromise(storage.readAccount("cursor", 1));
    expect(record?.agent?.state).toBe("connected");
    expect(record?.agent?.authMethod).toBe("apiKey");
    await expect(Effect.runPromise(storage.readSecret("cursor", 1, "agent"))).resolves.toBe(
      "key_test1234",
    );
    await expect(Effect.runPromise(storage.readActiveOrdinal("cursor"))).resolves.toBe(1);
  });

  it("reconnects an existing API-key account in place with a new key", async () => {
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "grok", apiKey: "xai-old" }),
    );
    const before = await Effect.runPromise(storage.readAccount("grok", 1));
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({
        kind: "agent-api-key",
        provider: "grok",
        ordinal: 1,
        apiKey: "xai-new",
      }),
    );
    const status = await Effect.runPromise(connect.getConnectStatus(operationId));
    expect(status.state).toBe("succeeded");
    expect(status.ordinal).toBe(1);
    const after = await Effect.runPromise(storage.readAccount("grok", 1));
    expect(after?.agent?.generation).toBe((before?.agent?.generation ?? 0) + 1);
    await expect(Effect.runPromise(storage.readSecret("grok", 1, "agent"))).resolves.toBe(
      "xai-new",
    );
  });

  it("rejects reconnecting a slot that does not exist", async () => {
    await expectFailureDetail(
      connect.beginConnect({ kind: "agent-api-key", provider: "grok", ordinal: 9, apiKey: "x" }),
      /missing account/,
    );
  });

  it("drives the OAuth lifecycle: verification info, finalize, success", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    const waiting = await Effect.runPromise(connect.getConnectStatus(operationId));
    expect(waiting.state).toBe("waiting-for-user");
    expect(waiting.verificationUrl).toBe("https://example.com/device");
    expect(waiting.userCode).toBe("AB-12");

    resolveLogin!({ ok: true, identityHint: "k***@example.com" });
    let status = waiting;
    await waitFor(() => {
      status = Effect.runSync(connect.getConnectStatus(operationId));
      return status.state === "succeeded";
    });
    expect(status.ordinal).toBe(1);
    const record = await Effect.runPromise(storage.readAccount("codex", 1));
    expect(record?.agent?.state).toBe("connected");
    expect(record?.identity?.hint).toBe("k***@example.com");
  });

  it("marks the operation failed when the login process fails", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    resolveLogin!({ ok: false, error: "login exited with code 1" });
    let status = await Effect.runPromise(connect.getConnectStatus(operationId));
    await waitFor(() => {
      status = Effect.runSync(connect.getConnectStatus(operationId));
      return status.state === "failed";
    });
    expect(status.error).toContain("login exited");
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([]);
  });

  it("cancels a waiting OAuth operation and cleans its pending directory", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    const status = await Effect.runPromise(connect.cancelConnect(operationId));
    expect(status.state).toBe("cancelled");
    expect(cancelled).toBe(true);
    await expect(Effect.runPromise(storage.listPendingOperations("codex"))).resolves.toEqual([]);
  });

  it("refuses to activate accounts without a connected agent binding", async () => {
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "cursor", apiKey: "key_a" }),
    );
    await Effect.runPromise(connect.disconnectBinding("cursor", 1, "agent"));
    await expectFailureDetail(connect.setActive("cursor", 1), /agent binding/);
    await expectFailureDetail(connect.setActive("cursor", 9), /missing/);
    await Effect.runPromise(connect.setActive("cursor", 0));
    await expect(Effect.runPromise(storage.readActiveOrdinal("cursor"))).resolves.toBe(0);
  });

  it("disconnects surfaces independently and deletes the agent secret", async () => {
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "cursor", apiKey: "key_b" }),
    );
    await Effect.runPromise(connect.disconnectBinding("cursor", 1, "agent"));
    const record = await Effect.runPromise(storage.readAccount("cursor", 1));
    expect(record?.agent?.state).toBe("needs-auth");
    expect(record?.agent?.generation).toBe(2);
    await expect(Effect.runPromise(storage.readSecret("cursor", 1, "agent"))).resolves.toBeNull();
  });

  it("persists non-secret operation metadata into the pending directory", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    const raw = await Effect.runPromise(storage.readPendingOperation("codex", operationId));
    expect(raw).not.toBeNull();
    const metadata = JSON.parse(raw!) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      operationId,
      provider: "codex",
      surface: "agent",
      authMethod: "oauth",
    });
    expect(JSON.stringify(metadata)).not.toContain("apiKey");
  });

  it("does not leak operation.json into the finalized account directory", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    resolveLogin!({ ok: true });
    await waitFor(
      () => Effect.runSync(connect.getConnectStatus(operationId)).state === "succeeded",
    );
    const leaked = await Effect.runPromise(
      storage.readPendingOperation("codex", operationId).pipe(Effect.orElseSucceed(() => null)),
    );
    expect(leaked).toBeNull();
    expect(existsSync(join(root, "accounts", "codex", "1", "operation.json"))).toBe(false);
  });

  it("recovers an interrupted OAuth connect as terminal after a restart", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    // Simulate a server restart: a fresh service over the same root.
    const restarted = makeAccountConnect({ storage: makeAccountStorage({ root }) });
    await Effect.runPromise(restarted.recoverInterruptedOperations);
    const status = await Effect.runPromise(restarted.getConnectStatus(operationId));
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/interrupted by a server restart/);
    expect(status.provider).toBe("codex");
    await expect(Effect.runPromise(storage.listPendingOperations("codex"))).resolves.toEqual([]);
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([]);
  });

  describe("OAuth reconnect staging", () => {
    const liveAuthPath = () => join(root, "accounts", "codex", "1", "agent", "home", "auth.json");

    const finishLogin = (credentials: string) => {
      const home = profileHomes.at(-1)!;
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "auth.json"), credentials);
      resolveLogin!({ ok: true });
    };

    const connectFirstAccount = async () => {
      const { operationId } = await Effect.runPromise(
        connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
      );
      finishLogin("old-credentials");
      await waitFor(
        () => Effect.runSync(connect.getConnectStatus(operationId)).state === "succeeded",
      );
    };

    const beginReconnect = async () => {
      const { operationId } = await Effect.runPromise(
        connect.beginConnect({ kind: "agent-oauth", provider: "codex", ordinal: 1 }),
      );
      return operationId;
    };

    it("runs the login in a pending directory, never the live home", async () => {
      await connectFirstAccount();
      await beginReconnect();
      const reconnectHome = profileHomes.at(-1)!;
      expect(reconnectHome).toContain(join(root, "pending", "codex"));
      expect(readFileSync(liveAuthPath(), "utf8")).toBe("old-credentials");
    });

    it("swaps staged credentials into the live home only on success", async () => {
      await connectFirstAccount();
      const before = await Effect.runPromise(storage.readAccount("codex", 1));
      const operationId = await beginReconnect();
      expect(readFileSync(liveAuthPath(), "utf8")).toBe("old-credentials");
      finishLogin("new-credentials");
      await waitFor(
        () => Effect.runSync(connect.getConnectStatus(operationId)).state === "succeeded",
      );
      expect(readFileSync(liveAuthPath(), "utf8")).toBe("new-credentials");
      const after = await Effect.runPromise(storage.readAccount("codex", 1));
      expect(after?.agent?.generation).toBe((before?.agent?.generation ?? 0) + 1);
      await expect(Effect.runPromise(storage.listPendingOperations("codex"))).resolves.toEqual([]);
      await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([1]);
    });

    it("leaves live credentials untouched when the reconnect login fails", async () => {
      await connectFirstAccount();
      const operationId = await beginReconnect();
      resolveLogin!({ ok: false, error: "login timed out" });
      await waitFor(() => Effect.runSync(connect.getConnectStatus(operationId)).state === "failed");
      expect(readFileSync(liveAuthPath(), "utf8")).toBe("old-credentials");
      await expect(Effect.runPromise(storage.listPendingOperations("codex"))).resolves.toEqual([]);
    });

    it("leaves live credentials untouched when the reconnect is cancelled", async () => {
      await connectFirstAccount();
      const operationId = await beginReconnect();
      const status = await Effect.runPromise(connect.cancelConnect(operationId));
      expect(status.state).toBe("cancelled");
      expect(cancelled).toBe(true);
      expect(readFileSync(liveAuthPath(), "utf8")).toBe("old-credentials");
      await expect(Effect.runPromise(storage.listPendingOperations("codex"))).resolves.toEqual([]);
    });

    it("recovers an interrupted reconnect after a restart without touching live credentials", async () => {
      await connectFirstAccount();
      const operationId = await beginReconnect();
      // Simulate a server restart: a fresh service over the same root.
      const restarted = makeAccountConnect({ storage: makeAccountStorage({ root }) });
      await Effect.runPromise(restarted.recoverInterruptedOperations);
      const status = await Effect.runPromise(restarted.getConnectStatus(operationId));
      expect(status.state).toBe("failed");
      expect(status.error).toMatch(/interrupted by a server restart/);
      expect(readFileSync(liveAuthPath(), "utf8")).toBe("old-credentials");
      await expect(Effect.runPromise(storage.listPendingOperations("codex"))).resolves.toEqual([]);
    });

    it("repairs a reconnect swap that died mid-commit on the next startup", async () => {
      await connectFirstAccount();
      const liveHome = join(root, "accounts", "codex", "1", "agent", "home");
      const backup = join(root, "accounts", "codex", "1", "agent", "home.reconnect-backup");
      // Simulate a crash between parking the live home and installing the
      // staged one: only the backup remains.
      renameSync(liveHome, backup);
      const restarted = makeAccountConnect({ storage: makeAccountStorage({ root }) });
      await Effect.runPromise(restarted.recoverInterruptedOperations);
      expect(readFileSync(liveAuthPath(), "utf8")).toBe("old-credentials");
      expect(existsSync(backup)).toBe(false);
    });
  });

  it("protects the native account 0 from disconnect and hide", async () => {
    await expectFailureDetail(connect.disconnectBinding("codex", 0, "agent"), /native account/);
    await expectFailureDetail(connect.hide("codex", 0), /native account/);
  });

  describe("capability matrix at beginConnect", () => {
    const matrix: ReadonlyArray<{
      readonly request: ProviderAccountsBeginConnectInput;
      readonly supported: boolean;
    }> = [
      { request: { kind: "agent-api-key", provider: "codex", apiKey: "k" }, supported: true },
      { request: { kind: "agent-api-key", provider: "claudeAgent", apiKey: "k" }, supported: true },
      { request: { kind: "agent-api-key", provider: "cursor", apiKey: "k" }, supported: true },
      { request: { kind: "agent-api-key", provider: "grok", apiKey: "k" }, supported: true },
      { request: { kind: "agent-oauth", provider: "codex" }, supported: true },
      { request: { kind: "agent-oauth", provider: "claudeAgent" }, supported: false },
      { request: { kind: "agent-oauth", provider: "cursor" }, supported: false },
      { request: { kind: "agent-oauth", provider: "grok" }, supported: false },
      { request: { kind: "app-oauth", provider: "codex" }, supported: false },
      { request: { kind: "app-oauth", provider: "claudeAgent" }, supported: false },
      { request: { kind: "app-oauth", provider: "cursor" }, supported: false },
      { request: { kind: "app-oauth", provider: "grok" }, supported: false },
    ];

    it.each(matrix)("$request.kind for $request.provider", async ({ request, supported }) => {
      if (supported) {
        const { operationId } = await Effect.runPromise(connect.beginConnect(request));
        expect(operationId).toBeTruthy();
      } else {
        await expectFailureDetail(connect.beginConnect(request), /not supported/);
      }
    });
  });

  describe("secret hygiene", () => {
    const apiKey = "sk-hygiene-secret-000042";

    it("never echoes the API key in connect status objects", async () => {
      const { operationId } = await Effect.runPromise(
        connect.beginConnect({ kind: "agent-api-key", provider: "cursor", apiKey }),
      );
      const status = await Effect.runPromise(connect.getConnectStatus(operationId));
      expect(JSON.stringify(status)).not.toContain(apiKey);
    });

    it("never echoes the API key in connect failure details", async () => {
      const failure = await Effect.runPromise(
        Effect.flip(
          connect.beginConnect({ kind: "agent-api-key", provider: "grok", ordinal: 9, apiKey }),
        ),
      );
      expect(JSON.stringify(failure)).not.toContain(apiKey);
    });

    it("never echoes the API key when the secret write itself fails", async () => {
      // A directory squatting on the secret path makes the write fail.
      mkdirSync(accountSecretPath(root, "grok", 1, "agent"), { recursive: true });
      const failure = await Effect.runPromise(
        Effect.flip(connect.beginConnect({ kind: "agent-api-key", provider: "grok", apiKey })),
      );
      expect(JSON.stringify(failure.detail)).not.toContain(apiKey);
    });

    it("never echoes the API key in resolver error details", async () => {
      await Effect.runPromise(
        connect.beginConnect({ kind: "agent-api-key", provider: "cursor", apiKey }),
      );
      await Effect.runPromise(storage.deleteSecret("cursor", 1, "agent"));
      const resolver = makeAccountResolver({ storage });
      const failure = await Effect.runPromise(
        Effect.flip(resolver.resolveAccountLaunch({ provider: "cursor", surface: "agent" })),
      );
      expect(JSON.stringify(failure)).not.toContain(apiKey);
    });

    it("never echoes the API key in the doctor report", async () => {
      await Effect.runPromise(
        connect.beginConnect({ kind: "agent-api-key", provider: "cursor", apiKey }),
      );
      const doctor = makeDoctorReport({
        storage,
        cliIntegration: makeCliIntegration({ root, env: { PATH: "" } }),
      });
      const report = await Effect.runPromise(doctor.generate);
      expect(JSON.stringify(report)).not.toContain(apiKey);
    });

    it("writes secrets 0o600 inside 0o700 directories", async () => {
      await Effect.runPromise(
        connect.beginConnect({ kind: "agent-api-key", provider: "cursor", apiKey }),
      );
      const secretMode = statSync(accountSecretPath(root, "cursor", 1, "agent")).mode & 0o777;
      expect(secretMode).toBe(0o600);
      expect(statSync(secretsDir(root)).mode & 0o777).toBe(0o700);
      expect(statSync(accountDir(root, "cursor", 1)).mode & 0o777).toBe(0o700);
    });
  });

  describe("cross-provider isolation", () => {
    it("keeps concurrent same-ordinal accounts of different providers fully separate", async () => {
      await Promise.all([
        Effect.runPromise(
          connect.beginConnect({ kind: "agent-api-key", provider: "codex", apiKey: "sk-codex-1" }),
        ),
        Effect.runPromise(
          connect.beginConnect({ kind: "agent-api-key", provider: "grok", apiKey: "xai-grok-1" }),
        ),
      ]);
      await expect(Effect.runPromise(storage.readActiveOrdinal("codex"))).resolves.toBe(1);
      await expect(Effect.runPromise(storage.readActiveOrdinal("grok"))).resolves.toBe(1);

      const resolver = makeAccountResolver({ storage });
      const codexLaunch = await Effect.runPromise(
        resolver.resolveAccountLaunch({ provider: "codex", surface: "agent" }),
      );
      const grokLaunch = await Effect.runPromise(
        resolver.resolveAccountLaunch({ provider: "grok", surface: "agent" }),
      );

      expect(codexLaunch.environment.OPENAI_API_KEY).toBe("sk-codex-1");
      expect(codexLaunch.environment.CODEX_HOME).toContain(join("codex", "1"));
      // Conflicting inherited codex vars are marked unset, and no grok
      // credentials appear anywhere in the codex launch environment.
      expect(codexLaunch.environment.OPENAI_BASE_URL).toBe("");
      expect(JSON.stringify(codexLaunch.environment)).not.toContain("xai-grok-1");
      expect(codexLaunch.environment.XAI_API_KEY).toBeUndefined();

      expect(grokLaunch.environment.XAI_API_KEY).toBe("xai-grok-1");
      expect(grokLaunch.environment.GROK_HOME).toContain(join("grok", "1"));
      expect(grokLaunch.environment.GROK_CODE_XAI_API_KEY).toBe("");
      expect(JSON.stringify(grokLaunch.environment)).not.toContain("sk-codex-1");
      expect(grokLaunch.environment.OPENAI_API_KEY).toBeUndefined();
    });
  });
});
