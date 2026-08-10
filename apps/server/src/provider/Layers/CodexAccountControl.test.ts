import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CodexProviderTarget, ProviderProfilesSnapshot } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodexAccountProtocolClient,
  CodexAccountProtocolNotification,
} from "../codexAccountProtocolClient";
import {
  makeLegacyCodexLaunchContext,
  makeManagedCodexLaunchContext,
} from "../codexProviderLaunchContext";
import type {
  ProviderProfileRegistryShape,
  ResolvedCodexProviderProfile,
} from "../Services/ProviderProfileRegistry";
import { makeAccountControlRuntime } from "./CodexAccountControl";

const managedTarget = {
  provider: "codex",
  profileId: "codex_11111111111141118111111111111111",
} as CodexProviderTarget;
const defaultTarget = { provider: "codex", profileId: "default" } as CodexProviderTarget;
const temporaryRoots: string[] = [];

interface RequestCall {
  readonly method: string;
  readonly params: unknown;
}

class FakeAccountClient implements CodexAccountProtocolClient {
  readonly requests: RequestCall[] = [];
  closeCalls = 0;
  closeFailuresRemaining = 0;
  private readonly notificationListeners = new Set<
    (notification: CodexAccountProtocolNotification) => void
  >();
  private readonly closeListeners = new Set<(error: Error) => void>();

  constructor(
    private readonly respond: (
      method: string,
      params: unknown,
      client: FakeAccountClient,
    ) => unknown | Promise<unknown>,
  ) {}

  request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return Promise.resolve(this.respond(method, params, this));
  }

  onNotification(
    listener: (notification: CodexAccountProtocolNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onUnexpectedClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  emit(notification: CodexAccountProtocolNotification): void {
    for (const listener of this.notificationListeners) listener(notification);
  }

  emitUnexpectedClose(error = new Error("account process closed unexpectedly")): void {
    for (const listener of this.closeListeners) listener(error);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1;
      throw new Error("process tree still alive");
    }
  }
}

interface RegistryHarness {
  readonly registry: ProviderProfileRegistryShape;
  readonly seal: ReturnType<typeof vi.fn>;
  readonly tombstone: ReturnType<typeof vi.fn>;
  readonly setEnabled: ReturnType<typeof vi.fn>;
  readonly getBound: () => boolean;
}

function makeRegistry(input: {
  readonly root: string;
  readonly defaultOnly?: boolean;
  readonly initiallyBound?: boolean;
}): RegistryHarness {
  let bound = input.initiallyBound ?? false;
  let tombstoned = false;
  const snapshot = (): ProviderProfilesSnapshot => ({
    providerEnabled: true,
    profiles: [
      {
        target: defaultTarget,
        displayName: "Default",
        enabled: true,
        lifecycle: "active",
        storageKind: "legacy-default",
      },
      ...(input.defaultOnly
        ? []
        : [
            {
              target: managedTarget,
              displayName: "Work",
              enabled: false,
              lifecycle: tombstoned ? ("tombstoned" as const) : ("active" as const),
              storageKind: "managed" as const,
            },
          ]),
    ],
  });
  const resolution = (target: CodexProviderTarget): ResolvedCodexProviderProfile => {
    if (target.profileId === "default") {
      return {
        providerEnabled: true,
        summary: snapshot().profiles[0]!,
        launchContext: makeLegacyCodexLaunchContext({
          target,
          binaryPath: "/usr/bin/codex",
          settingsRevision: 1,
          registryRevision: 0,
          sourceHomePath: input.root,
        }),
      };
    }
    const profileRoot = path.join(input.root, "managed");
    const codexHomePath = path.join(profileRoot, "home");
    const codexSqliteHomePath = path.join(profileRoot, "sqlite");
    fs.mkdirSync(codexHomePath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(codexSqliteHomePath, { recursive: true, mode: 0o700 });
    return {
      providerEnabled: true,
      summary: snapshot().profiles[1]!,
      launchContext: makeManagedCodexLaunchContext({
        target,
        binaryPath: "/usr/bin/codex",
        settingsRevision: 1,
        registryRevision: bound ? 2 : 1,
        authenticationBoundAt: bound ? "2026-08-10T00:00:00.000Z" : null,
        continuationNamespaceId: "11111111-1111-4111-8111-111111111111",
        codexHomePath,
        codexSqliteHomePath,
      }),
    };
  };
  const seal = vi.fn(() => {
    bound = true;
    return Effect.void;
  });
  const tombstone = vi.fn(() => {
    tombstoned = true;
    return Effect.succeed(snapshot());
  });
  const setEnabled = vi.fn(() => Effect.succeed(snapshot()));
  return {
    registry: {
      list: () => Effect.succeed(snapshot()),
      create: () => Effect.succeed(snapshot()),
      rename: () => Effect.succeed(snapshot()),
      setEnabled,
      tombstone,
      sealManagedAuthentication: seal,
      resolveForManagement: (target) => Effect.succeed(resolution(target)),
      resolveForRuntime: (target) => Effect.succeed(resolution(target)),
    },
    seal,
    tombstone,
    setEnabled,
    getBound: () => bound,
  };
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synara-account-control-"));
  temporaryRoots.push(root);
  return root;
}

function signedOutResponse() {
  return { account: null, requiresOpenaiAuth: true };
}

function chatGptResponse() {
  return {
    account: { type: "chatgpt", email: "owner@example.test", planType: "plus" },
    requiresOpenaiAuth: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("CodexAccountControl", () => {
  it("keeps the legacy default account read-only", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root, defaultOnly: true });
    const clients: FakeAccountClient[] = [];
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient: async () => {
        const client = new FakeAccountClient((method) => {
          if (method === "account/read") return signedOutResponse();
          throw new Error(`unexpected method ${method}`);
        });
        clients.push(client);
        return client;
      },
    });

    await expect(
      Effect.runPromise(runtime.service.readAccount({ target: defaultTarget })),
    ).resolves.toMatchObject({ authentication: "signed-out", pendingLogin: null });
    for (const operation of [
      runtime.service.startLogin({ target: defaultTarget, method: "browser" }),
      runtime.service.cancelLogin({ target: defaultTarget }),
      runtime.service.logout({ target: defaultTarget }),
      runtime.service.setEnabled({ target: defaultTarget, enabled: false }),
      runtime.service.tombstone({ target: defaultTarget }),
    ]) {
      const error = await Effect.runPromise(operation.pipe(Effect.flip));
      expect(error).toMatchObject({
        code: "PROVIDER_ACCOUNT_TARGET_IMMUTABLE",
        retryable: false,
      });
    }
    expect(clients).toHaveLength(1);
    expect(clients[0]?.requests).toEqual([
      { method: "account/read", params: { refreshToken: false } },
    ]);
    await runtime.shutdown();
  });

  it("returns the same pending challenge only for the same login method", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root });
    const client = new FakeAccountClient((method) => {
      if (method === "account/read") return signedOutResponse();
      if (method === "account/login/start") {
        return {
          type: "chatgptDeviceCode",
          loginId: "login-1",
          verificationUrl: "https://auth.example.test/device",
          userCode: "ABCD-EFGH",
        };
      }
      if (method === "account/login/cancel") return { status: "canceled" };
      throw new Error(`unexpected method ${method}`);
    });
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient: async () => client,
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
    });

    const first = await Effect.runPromise(
      runtime.service.startLogin({ target: managedTarget, method: "device-code" }),
    );
    const retry = await Effect.runPromise(
      runtime.service.startLogin({ target: managedTarget, method: "device-code" }),
    );
    expect(retry).toEqual(first);
    expect(client.requests.filter(({ method }) => method === "account/login/start")).toHaveLength(
      1,
    );

    const conflict = await Effect.runPromise(
      runtime.service
        .startLogin({ target: managedTarget, method: "browser" })
        .pipe(Effect.flip),
    );
    expect(conflict).toMatchObject({
      code: "PROVIDER_ACCOUNT_LOGIN_METHOD_CONFLICT",
      retryable: false,
    });
    await Effect.runPromise(runtime.service.cancelLogin({ target: managedTarget }));
    expect(client.closeCalls).toBe(1);
    await runtime.shutdown();
  });

  it("accepts a 0.144 completion without loginId and seals only after fresh ChatGPT proof", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root });
    let signedIn = false;
    let openCount = 0;
    const clients: FakeAccountClient[] = [];
    const syncManagedAuthState = vi.fn(() => {
      expect(clients.every((client) => client.closeCalls === 1)).toBe(true);
    });
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient: async (launchContext) => {
        openCount += 1;
        const client = new FakeAccountClient((method, _params, current) => {
          if (method === "account/read") {
            if (!signedIn) return signedOutResponse();
            if (launchContext.home.strategy === "managed-direct") {
              fs.writeFileSync(
                path.join(launchContext.home.codexHomePath, "auth.json"),
                "private",
                { mode: 0o600 },
              );
            }
            return chatGptResponse();
          }
          if (method === "account/login/start") {
            signedIn = true;
            queueMicrotask(() =>
              current.emit({
                method: "account/login/completed",
                params: { success: true },
              }),
            );
            return {
              type: "chatgpt",
              loginId: "browser-login",
              authUrl: "https://auth.example.test/start",
            };
          }
          throw new Error(`unexpected method ${method}`);
        });
        clients.push(client);
        return client;
      },
      syncManagedAuthState,
    });

    await Effect.runPromise(
      runtime.service.startLogin({ target: managedTarget, method: "browser" }),
    );
    await vi.waitFor(() => expect(registry.seal).toHaveBeenCalledOnce());

    expect(registry.getBound()).toBe(true);
    expect(openCount).toBe(2);
    expect(clients.every((client) => client.closeCalls === 1)).toBe(true);
    expect(syncManagedAuthState).toHaveBeenCalledOnce();
    expect(syncManagedAuthState.mock.invocationCallOrder[0]).toBeLessThan(
      registry.seal.mock.invocationCallOrder[0]!,
    );
    await runtime.shutdown();
  });

  it.each([
    { account: { type: "apiKey" }, requiresOpenaiAuth: false },
    {
      account: { type: "amazonBedrock", usesCodexManagedCredentials: false },
      requiresOpenaiAuth: true,
    },
    { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
  ])("refuses to seal unsupported $account.type authentication", async (response) => {
    const root = makeRoot();
    const registry = makeRegistry({ root });
    const client = new FakeAccountClient((method) => {
      if (method === "account/read") return response;
      throw new Error(`unexpected method ${method}`);
    });
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient: async () => client,
    });

    const error = await Effect.runPromise(
      runtime.service.readAccount({ target: managedTarget }).pipe(Effect.flip),
    );
    expect(error).toMatchObject({
      code: "PROVIDER_ACCOUNT_UNSUPPORTED_AUTHENTICATION",
      retryable: false,
    });
    expect(registry.seal).not.toHaveBeenCalled();
    expect(client.closeCalls).toBe(1);
    await runtime.shutdown();
  });

  it.each([42, { requiresOpenaiAuth: true }])(
    "does not tombstone after malformed account response %#",
    async (response) => {
      const root = makeRoot();
      const registry = makeRegistry({ root, initiallyBound: true });
      const client = new FakeAccountClient((method) => {
        if (method === "account/read") return response;
        if (method === "account/logout") return {};
        throw new Error(`unexpected method ${method}`);
      });
      const runtime = makeAccountControlRuntime({
        registry: registry.registry,
        cwd: root,
        openClient: async () => client,
      });

      const error = await Effect.runPromise(
        runtime.service.tombstone({ target: managedTarget }).pipe(Effect.flip),
      );
      expect(error).toMatchObject({ code: "PROVIDER_ACCOUNT_PROTOCOL_INVALID" });
      expect(client.closeCalls).toBe(1);
      expect(registry.tombstone).not.toHaveBeenCalled();
      await runtime.shutdown();
    },
  );

  it("logs out and confirms signed-out state before terminally tombstoning", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root, initiallyBound: true });
    let signedIn = true;
    const syncManagedLoggedOutState = vi.fn(() => {
      expect(client.closeCalls).toBe(1);
    });
    const client = new FakeAccountClient((method) => {
      if (method === "account/read") return signedIn ? chatGptResponse() : signedOutResponse();
      if (method === "account/logout") {
        signedIn = false;
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    });
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient: async () => client,
      syncManagedLoggedOutState,
    });

    const result = await Effect.runPromise(runtime.service.logout({ target: managedTarget }));
    expect(result.account.authentication).toBe("signed-out");
    expect(client.requests).toEqual([
      { method: "account/logout", params: undefined },
      { method: "account/read", params: { refreshToken: false } },
    ]);
    expect(client.closeCalls).toBe(1);
    expect(syncManagedLoggedOutState).toHaveBeenCalledOnce();
    expect(syncManagedLoggedOutState.mock.invocationCallOrder[0]).toBeLessThan(
      registry.tombstone.mock.invocationCallOrder[0]!,
    );
    expect(registry.tombstone).toHaveBeenCalledOnce();
    const repeatedLogout = await Effect.runPromise(
      runtime.service.logout({ target: managedTarget }),
    );
    expect(repeatedLogout.account).toMatchObject({
      authentication: "signed-out",
      authMode: null,
      pendingLogin: null,
    });
    await Effect.runPromise(runtime.service.tombstone({ target: managedTarget }));
    expect(client.closeCalls).toBe(1);
    expect(registry.tombstone).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });

  it("tombstones a never-authenticated profile idempotently without account control", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root });
    const client = new FakeAccountClient((method) => {
      if (method === "account/read") return signedOutResponse();
      throw new Error(`unexpected method ${method}`);
    });
    const openClient = vi.fn(async () => client);
    const syncManagedLoggedOutState = vi.fn(() => {
      expect(openClient).not.toHaveBeenCalled();
    });
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient,
      syncManagedLoggedOutState,
    });

    const first = await Effect.runPromise(
      runtime.service.tombstone({ target: managedTarget }),
    );
    const repeated = await Effect.runPromise(
      runtime.service.tombstone({ target: managedTarget }),
    );

    expect(repeated).toEqual(first);
    expect(openClient).not.toHaveBeenCalled();
    expect(client.closeCalls).toBe(0);
    expect(syncManagedLoggedOutState).toHaveBeenCalledOnce();
    expect(syncManagedLoggedOutState.mock.invocationCallOrder[0]).toBeLessThan(
      registry.tombstone.mock.invocationCallOrder[0]!,
    );
    expect(registry.tombstone).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });

  it("revokes discovered authentication even when the initial read reports signed-out", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root });
    const home = path.join(root, "managed", "home");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, "auth.json"), "private", { mode: 0o600 });
    let signedIn = false;
    const client = new FakeAccountClient((method) => {
      if (method === "account/read") return signedIn ? chatGptResponse() : signedOutResponse();
      if (method === "account/logout") {
        signedIn = false;
        fs.rmSync(path.join(home, "auth.json"));
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    });
    const openClient = vi.fn(async () => client);
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient,
    });

    await Effect.runPromise(runtime.service.tombstone({ target: managedTarget }));

    expect(openClient).toHaveBeenCalledOnce();
    expect(client.requests.some(({ method }) => method === "account/logout")).toBe(true);
    expect(registry.tombstone).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });

  it("does not seal when the credential durability boundary fails", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root });
    const clients: FakeAccountClient[] = [];
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient: async (launchContext) => {
        const client = new FakeAccountClient((method) => {
          if (method !== "account/read") throw new Error(`unexpected method ${method}`);
          if (launchContext.home.strategy === "managed-direct") {
            fs.writeFileSync(
              path.join(launchContext.home.codexHomePath, "auth.json"),
              "private",
              { mode: 0o600 },
            );
          }
          return chatGptResponse();
        });
        clients.push(client);
        return client;
      },
      syncManagedAuthState: () => {
        throw Object.assign(new Error("credential fsync failed"), { code: "EIO" });
      },
    });

    const error = await Effect.runPromise(
      runtime.service.readAccount({ target: managedTarget }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "PROVIDER_ACCOUNT_CONTROL_FAILED",
      retryable: true,
    });
    expect(clients).toHaveLength(2);
    expect(clients.every((client) => client.closeCalls === 1)).toBe(true);
    expect(registry.seal).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it("does not tombstone when logged-out credential state cannot be made durable", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root, initiallyBound: true });
    const client = new FakeAccountClient((method) => {
      if (method === "account/read") return signedOutResponse();
      if (method === "account/logout") return {};
      throw new Error(`unexpected method ${method}`);
    });
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient: async () => client,
      syncManagedLoggedOutState: () => {
        throw Object.assign(new Error("credential directory fsync failed"), { code: "EIO" });
      },
    });

    const error = await Effect.runPromise(
      runtime.service.tombstone({ target: managedTarget }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "PROVIDER_ACCOUNT_CONTROL_FAILED",
      retryable: true,
    });
    expect(client.closeCalls).toBe(1);
    expect(client.requests.map(({ method }) => method)).toEqual([
      "account/logout",
      "account/read",
    ]);
    expect(registry.tombstone).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it("does not tombstone when an authentication file survives logout", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root, initiallyBound: true });
    const home = path.join(root, "managed", "home");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, "auth.json"), "private", { mode: 0o600 });
    const client = new FakeAccountClient((method) => {
      if (method === "account/logout") return {};
      if (method === "account/read") return signedOutResponse();
      throw new Error(`unexpected method ${method}`);
    });
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient: async () => client,
    });

    const error = await Effect.runPromise(
      runtime.service.tombstone({ target: managedTarget }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "PROVIDER_ACCOUNT_CONTROL_FAILED",
      retryable: true,
    });
    expect(client.closeCalls).toBe(1);
    expect(registry.tombstone).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, "auth.json"))).toBe(true);
    await runtime.shutdown();
  });

  it("closes a pending process after malformed cancel or account responses", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root });
    const client = new FakeAccountClient((method) => {
      if (method === "account/read") return signedOutResponse();
      if (method === "account/login/start") {
        return {
          type: "chatgpt",
          loginId: "login-1",
          authUrl: "https://auth.example.test/start",
        };
      }
      if (method === "account/login/cancel") return { status: "invalid" };
      throw new Error(`unexpected method ${method}`);
    });
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient: async () => client,
    });
    await Effect.runPromise(
      runtime.service.startLogin({ target: managedTarget, method: "browser" }),
    );

    const error = await Effect.runPromise(
      runtime.service.cancelLogin({ target: managedTarget }).pipe(Effect.flip),
    );
    expect(error).toMatchObject({ code: "PROVIDER_ACCOUNT_PROTOCOL_INVALID" });
    expect(client.closeCalls).toBe(1);
    await runtime.shutdown();
  });

  it("fences a target while an ephemeral process tree cannot be retired", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root });
    const poisoned = new FakeAccountClient((method) => {
      if (method === "account/read") return signedOutResponse();
      throw new Error(`unexpected method ${method}`);
    });
    poisoned.closeFailuresRemaining = 3;
    const replacement = new FakeAccountClient(() => signedOutResponse());
    const openClient = vi
      .fn<() => Promise<CodexAccountProtocolClient>>()
      .mockResolvedValueOnce(poisoned)
      .mockResolvedValue(replacement);
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient,
    });

    await expect(
      Effect.runPromise(runtime.service.readAccount({ target: managedTarget })),
    ).rejects.toMatchObject({ code: "PROVIDER_ACCOUNT_CONTROL_FAILED" });
    await expect(
      Effect.runPromise(runtime.service.readAccount({ target: managedTarget })),
    ).rejects.toMatchObject({ code: "PROVIDER_ACCOUNT_CONTROL_FAILED" });
    expect(openClient).toHaveBeenCalledOnce();

    await runtime.shutdown();
    expect(poisoned.closeCalls).toBe(4);
  });

  it("drops a stale login and retires its poisoned process before opening a replacement", async () => {
    const root = makeRoot();
    const registry = makeRegistry({ root });
    const first = new FakeAccountClient((method) => {
      if (method === "account/read") return signedOutResponse();
      if (method === "account/login/start") {
        return {
          type: "chatgpt",
          loginId: "login-1",
          authUrl: "https://auth.example.test/first",
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    first.closeFailuresRemaining = 1;
    const second = new FakeAccountClient((method) => {
      if (method === "account/read") return signedOutResponse();
      if (method === "account/login/start") {
        return {
          type: "chatgpt",
          loginId: "login-2",
          authUrl: "https://auth.example.test/second",
        };
      }
      if (method === "account/login/cancel") return { status: "canceled" };
      throw new Error(`unexpected method ${method}`);
    });
    const openClient = vi
      .fn<() => Promise<CodexAccountProtocolClient>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    const runtime = makeAccountControlRuntime({
      registry: registry.registry,
      cwd: root,
      openClient,
    });

    const original = await Effect.runPromise(
      runtime.service.startLogin({ target: managedTarget, method: "browser" }),
    );
    first.emitUnexpectedClose();
    await vi.waitFor(() => expect(first.closeCalls).toBe(1));

    const replacement = await Effect.runPromise(
      runtime.service.startLogin({ target: managedTarget, method: "browser" }),
    );

    expect(replacement.challenge).not.toEqual(original.challenge);
    expect(first.closeCalls).toBe(2);
    expect(openClient).toHaveBeenCalledTimes(2);
    await Effect.runPromise(runtime.service.cancelLogin({ target: managedTarget }));
    await runtime.shutdown();
  });
});
