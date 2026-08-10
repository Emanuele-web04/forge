import type {
  CodexProviderAccountAuthMode,
  CodexProviderAccountStatus,
  CodexProviderLoginChallenge,
  CodexProviderLoginMethod,
  CodexProviderTarget,
  ProviderProfileLoginCancelResult,
  ProviderProfileLoginStartResult,
  ProviderProfileLogoutResult,
  ProviderProfilesSnapshot,
} from "@synara/contracts";
import { DEFAULT_PROVIDER_PROFILE_ID } from "@synara/contracts";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config";
import type { CodexProviderLaunchContext } from "../codexProviderLaunchContext";
import {
  CodexAccountProtocolOpenError,
  CodexAccountProtocolRequestError,
  CodexAccountProtocolVersionError,
  openCodexAccountProtocolClient,
  type CodexAccountProtocolClient,
  type CodexAccountProtocolNotification,
} from "../codexAccountProtocolClient";
import {
  assertManagedCodexAuthFilePrivate,
  inspectManagedCodexAuthFile,
  syncManagedCodexAuthState,
  syncManagedCodexLoggedOutState,
} from "../codexManagedProfileHome";
import {
  CodexAccountControl,
  CodexAccountControlError,
  type CodexAccountControlErrorCode,
  type CodexAccountControlShape,
} from "../Services/CodexAccountControl";
import {
  ProviderProfileRegistry,
  ProviderProfileRegistryError,
  type ResolvedCodexProviderProfile,
} from "../Services/ProviderProfileRegistry";

const LOGIN_LIFETIME_MS = 15 * 60 * 1_000;
const LOGIN_ID_MAX_LENGTH = 512;
const LOGIN_URL_MAX_LENGTH = 4_096;
const LOGIN_USER_CODE_MAX_LENGTH = 256;
const ACCOUNT_EMAIL_MAX_LENGTH = 320;
const ACCOUNT_PLAN_MAX_LENGTH = 80;

interface LoginCompletion {
  readonly success: boolean;
}

interface DecodedAccountStatus {
  readonly status: CodexProviderAccountStatus;
  readonly bindableChatGptShape: boolean;
}

interface ActiveLogin {
  readonly target: CodexProviderTarget;
  readonly loginId: string;
  readonly method: CodexProviderLoginMethod;
  readonly client: CodexAccountProtocolClient;
  readonly resolution: ResolvedCodexProviderProfile;
  readonly result: ProviderProfileLoginStartResult;
  readonly expiresTimer: ReturnType<typeof setTimeout>;
  readonly detachNotification: () => void;
  readonly detachUnexpectedClose: () => void;
  completion?: LoginCompletion;
}

type OpenAccountClient = (
  launchContext: CodexProviderLaunchContext,
  cwd: string,
) => Promise<CodexAccountProtocolClient>;

interface AccountControlRuntime {
  readonly service: CodexAccountControlShape;
  readonly shutdown: () => Promise<void>;
}

export const makeCodexAccountControl = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const registry = yield* ProviderProfileRegistry;
  return makeAccountControlRuntime({
    registry,
    cwd: config.homeDir,
    openClient: (launchContext, cwd) =>
      openCodexAccountProtocolClient({ launchContext, cwd }),
  });
});

export function makeAccountControlRuntime(input: {
  readonly registry: typeof ProviderProfileRegistry.Service;
  readonly cwd: string;
  readonly openClient: OpenAccountClient;
  readonly now?: () => number;
  readonly loginLifetimeMs?: number;
  readonly syncManagedAuthState?: (codexHomePath: string) => void;
  readonly syncManagedLoggedOutState?: (codexHomePath: string) => void;
}): AccountControlRuntime {
  const now = input.now ?? Date.now;
  const loginLifetimeMs = input.loginLifetimeMs ?? LOGIN_LIFETIME_MS;
  const syncManagedAuthState = input.syncManagedAuthState ?? syncManagedCodexAuthState;
  const syncManagedLoggedOutState =
    input.syncManagedLoggedOutState ?? syncManagedCodexLoggedOutState;
  const activeLogins = new Map<string, ActiveLogin>();
  const unretiredClients = new Map<
    string,
    { readonly target: CodexProviderTarget; readonly client: CodexAccountProtocolClient }
  >();
  const targetQueues = new Map<string, Promise<void>>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const retireClient = async (
    target: CodexProviderTarget,
    client: CodexAccountProtocolClient,
  ): Promise<void> => {
    const key = targetKey(target);
    try {
      await client.close();
    } catch (cause) {
      unretiredClients.set(key, { target, client });
      throw cause;
    }
    if (unretiredClients.get(key)?.client === client) unretiredClients.delete(key);
  };

  const retirePoisonedClient = async (target: CodexProviderTarget): Promise<void> => {
    const unretired = unretiredClients.get(targetKey(target));
    if (unretired) await retireClient(unretired.target, unretired.client);
  };

  const serialize = <A>(target: CodexProviderTarget, operation: () => Promise<A>): Promise<A> => {
    if (shuttingDown) {
      return Promise.reject(
        controlError(
          "PROVIDER_ACCOUNT_CONTROL_FAILED",
          "Codex account control is shutting down.",
          true,
        ),
      );
    }
    const key = targetKey(target);
    const previous = targetQueues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(async () => {
      await retirePoisonedClient(target);
      return operation();
    });
    const barrier = result.then(
      () => undefined,
      () => undefined,
    );
    targetQueues.set(key, barrier);
    void barrier.finally(() => {
      if (targetQueues.get(key) === barrier) targetQueues.delete(key);
    });
    return result;
  };

  const resolve = (target: CodexProviderTarget) =>
    Effect.runPromise(input.registry.resolveForManagement(target));

  const openTrackedClient = async (
    target: CodexProviderTarget,
    launchContext: CodexProviderLaunchContext,
  ): Promise<CodexAccountProtocolClient> => {
    try {
      return await input.openClient(launchContext, input.cwd);
    } catch (cause) {
      if (cause instanceof CodexAccountProtocolOpenError) {
        unretiredClients.set(targetKey(target), {
          target,
          client: cause.unretiredClient,
        });
      }
      throw cause;
    }
  };

  const withTrackedAccountClient = async <A>(
    resolution: ResolvedCodexProviderProfile,
    operation: (client: CodexAccountProtocolClient) => Promise<A>,
  ): Promise<A> => {
    const target = resolution.summary.target;
    const client = await openTrackedClient(target, resolution.launchContext);
    let result: A;
    try {
      result = await operation(client);
    } catch (cause) {
      await retireClient(target, client);
      throw cause;
    }
    await retireClient(target, client);
    return result;
  };

  const assertMutableTarget = (target: CodexProviderTarget): void => {
    if (target.profileId === DEFAULT_PROVIDER_PROFILE_ID) {
      throw controlError(
        "PROVIDER_ACCOUNT_TARGET_IMMUTABLE",
        "Synara does not mutate the legacy default Codex account.",
        false,
      );
    }
  };

  const assertBindableAccount = (account: DecodedAccountStatus): void => {
    if (
      account.status.authentication !== "signed-in" ||
      account.status.authMode !== "chatgpt" ||
      account.status.requiresOpenaiAuth !== true ||
      !account.bindableChatGptShape
    ) {
      throw controlError(
        "PROVIDER_ACCOUNT_UNSUPPORTED_AUTHENTICATION",
        "Managed Codex profiles require a ChatGPT account.",
        false,
      );
    }
  };

  const verifyAndSealManagedAccount = async (
    resolution: ResolvedCodexProviderProfile,
    account: DecodedAccountStatus,
  ): Promise<void> => {
    if (resolution.launchContext.home.strategy !== "managed-direct") return;
    if (account.status.authentication !== "signed-in") return;
    assertBindableAccount(account);
    if (resolution.launchContext.authenticationBoundAt !== null) return;
    assertManagedCodexAuthFilePrivate(resolution.launchContext.home.codexHomePath);
    const verified = await withTrackedAccountClient(
      resolution,
      async (client) =>
        readAccountResponse(
          resolution.summary.target,
          await client.request("account/read", { refreshToken: false }),
        ),
    );
    assertBindableAccount(verified);
    assertManagedCodexAuthFilePrivate(resolution.launchContext.home.codexHomePath);
    syncManagedAuthState(resolution.launchContext.home.codexHomePath);
    await Effect.runPromise(
      input.registry.sealManagedAuthentication(resolution.summary.target),
    );
  };

  const closeActiveLogin = async (active: ActiveLogin): Promise<void> => {
    try {
      await retireClient(active.target, active.client);
    } finally {
      clearTimeout(active.expiresTimer);
      active.detachNotification();
      active.detachUnexpectedClose();
      if (activeLogins.get(targetKey(active.target)) === active) {
        activeLogins.delete(targetKey(active.target));
      }
    }
  };

  const settleCompletedLogin = async (
    active: ActiveLogin,
  ): Promise<CodexProviderAccountStatus | undefined> => {
    if (!active.completion) return undefined;
    if (!active.completion.success) {
      await closeActiveLogin(active);
      return undefined;
    }
    let account: DecodedAccountStatus;
    try {
      account = readAccountResponse(
        active.target,
        await active.client.request("account/read", { refreshToken: false }),
      );
    } finally {
      await closeActiveLogin(active);
    }
    if (account.status.authentication !== "signed-in") {
      throw controlError(
        "PROVIDER_ACCOUNT_LOGIN_RESPONSE_INVALID",
        "Codex reported a completed login without a signed-in account.",
        false,
      );
    }
    await verifyAndSealManagedAccount(active.resolution, account);
    return account.status;
  };

  const scheduleCompletion = (active: ActiveLogin): void => {
    void serialize(active.target, async () => {
      if (activeLogins.get(targetKey(active.target)) !== active) return;
      await settleCompletedLogin(active);
    }).catch(() => undefined);
  };

  const cancelActiveLogin = async (
    target: CodexProviderTarget,
  ): Promise<ProviderProfileLoginCancelResult> => {
    const active = activeLogins.get(targetKey(target));
    if (!active) return { target, status: "not-pending" };
    if (active.completion) {
      await settleCompletedLogin(active);
      return { target, status: "not-pending" };
    }

    let canceled = false;
    let account: DecodedAccountStatus | undefined;
    try {
      const response = await active.client.request("account/login/cancel", {
        loginId: active.loginId,
      });
      if (active.completion) {
        await settleCompletedLogin(active);
        return { target, status: "not-pending" };
      }
      canceled = readCancelResponse(response);
      if (!canceled) {
        account = readAccountResponse(
          target,
          await active.client.request("account/read", { refreshToken: false }),
        );
      }
    } finally {
      if (activeLogins.get(targetKey(target)) === active) {
        await closeActiveLogin(active);
      }
    }
    if (account) await verifyAndSealManagedAccount(active.resolution, account);
    return { target, status: canceled ? "canceled" : "not-pending" };
  };

  const readAccount = (target: CodexProviderTarget) =>
    serialize(target, async () => {
      const active = activeLogins.get(targetKey(target));
      if (active?.completion) {
        const settled = await settleCompletedLogin(active);
        if (settled) return settled;
      }
      const pending = activeLogins.get(targetKey(target));
      if (pending) {
        const account = readAccountResponse(
          target,
          await pending.client.request("account/read", { refreshToken: false }),
          pending,
        );
        if (account.status.authentication === "signed-in") {
          await closeActiveLogin(pending);
          const settledAccount = {
            ...account,
            status: { ...account.status, pendingLogin: null },
          } as const;
          await verifyAndSealManagedAccount(pending.resolution, settledAccount);
          return settledAccount.status;
        }
        return account.status;
      }

      const resolution = await resolve(target);
      const account = await withTrackedAccountClient(
        resolution,
        async (client) =>
          readAccountResponse(
            target,
            await client.request("account/read", { refreshToken: false }),
          ),
      );
      await verifyAndSealManagedAccount(resolution, account);
      return account.status;
    });

  const startLogin = (request: {
    readonly target: CodexProviderTarget;
    readonly method: CodexProviderLoginMethod;
  }): Promise<ProviderProfileLoginStartResult> =>
    serialize(request.target, async () => {
      assertMutableTarget(request.target);
      const existing = activeLogins.get(targetKey(request.target));
      if (existing?.completion) await settleCompletedLogin(existing);
      const pending = activeLogins.get(targetKey(request.target));
      if (pending) {
        if (pending.method === request.method) return pending.result;
        throw controlError(
          "PROVIDER_ACCOUNT_LOGIN_METHOD_CONFLICT",
          "A different Codex account login method is already pending for this profile.",
          false,
        );
      }

      const resolution = await resolve(request.target);
      if (
        resolution.launchContext.home.strategy === "managed-direct" &&
        resolution.launchContext.authenticationBoundAt !== null
      ) {
        throw controlError(
          "PROVIDER_ACCOUNT_AUTHENTICATION_BOUND",
          "This managed Codex profile is permanently bound to its original account.",
          false,
        );
      }

      const client = await openTrackedClient(request.target, resolution.launchContext);
      let clientRetired = false;
      let detachNotification = () => undefined;
      let detachUnexpectedClose = () => undefined;
      try {
        const currentAccount = readAccountResponse(
          request.target,
          await client.request("account/read", { refreshToken: false }),
        );
        if (currentAccount.status.authentication === "signed-in") {
          await retireClient(request.target, client);
          clientRetired = true;
          await verifyAndSealManagedAccount(resolution, currentAccount);
          throw controlError(
            "PROVIDER_ACCOUNT_ALREADY_SIGNED_IN",
            "The Codex provider profile is already signed in.",
            false,
          );
        }

        const bufferedCompletions: CodexAccountProtocolNotification[] = [];
        detachNotification = client.onNotification((notification) => {
          if (
            notification.method === "account/login/completed" &&
            bufferedCompletions.length < 8
          ) {
            bufferedCompletions.push(notification);
          }
        });
        const response = await client.request(
          "account/login/start",
          loginParams(request.method),
        );
        const started = readLoginStartResponse(request.method, response);
        const expiresAtMs = now() + loginLifetimeMs;
        let active: ActiveLogin;
        const expiresTimer = setTimeout(() => {
          void serialize(request.target, async () => {
            if (activeLogins.get(targetKey(request.target)) !== active) return;
            await cancelActiveLogin(request.target);
          }).catch(() => undefined);
        }, loginLifetimeMs);
        expiresTimer.unref();

        active = {
          target: request.target,
          loginId: started.loginId,
          method: request.method,
          client,
          resolution,
          result: {
            target: request.target,
            challenge: started.challenge,
            expiresAt: new Date(expiresAtMs).toISOString(),
          },
          expiresTimer,
          detachNotification,
          detachUnexpectedClose: () => undefined,
        };
        detachNotification();
        active.detachNotification = client.onNotification((notification) => {
          const completion = readLoginCompletion(notification, active.loginId);
          if (!completion || active.completion) return;
          active.completion = completion;
          scheduleCompletion(active);
        });
        detachUnexpectedClose = client.onUnexpectedClose(() => {
          void serialize(request.target, async () => {
            if (activeLogins.get(targetKey(request.target)) !== active) return;
            await closeActiveLogin(active);
          }).catch(() => undefined);
        });
        active.detachUnexpectedClose = detachUnexpectedClose;
        activeLogins.set(targetKey(request.target), active);
        const buffered = bufferedCompletions
          .map((notification) => readLoginCompletion(notification, active.loginId))
          .filter((completion): completion is LoginCompletion => completion !== undefined)
          .at(-1);
        if (buffered) {
          active.completion = buffered;
          scheduleCompletion(active);
        }
        return active.result;
      } catch (cause) {
        detachNotification();
        detachUnexpectedClose();
        if (!clientRetired) await retireClient(request.target, client);
        throw cause;
      }
    });

  const logoutResolvedProfile = async (
    resolution: ResolvedCodexProviderProfile,
  ): Promise<{
    readonly account: CodexProviderAccountStatus;
    readonly snapshot: ProviderProfilesSnapshot;
  }> => {
    const target = resolution.summary.target;
    const account = await withTrackedAccountClient(
      resolution,
      async (client) => {
        await client.request("account/logout");
        const after = readAccountResponse(
          target,
          await client.request("account/read", { refreshToken: false }),
        );
        if (after.status.authentication !== "signed-out") {
          throw controlError(
            "PROVIDER_ACCOUNT_LOGOUT_UNCONFIRMED",
            "Codex account logout could not be confirmed.",
            true,
          );
        }
        return after.status;
      },
    );
    if (resolution.launchContext.home.strategy === "managed-direct") {
      syncManagedLoggedOutState(resolution.launchContext.home.codexHomePath);
    }
    const snapshot = await Effect.runPromise(input.registry.tombstone({ target }));
    return { account, snapshot };
  };

  const logoutAndTombstone = async (target: CodexProviderTarget) => {
    assertMutableTarget(target);
    await cancelActiveLogin(target);
    return logoutResolvedProfile(await resolve(target));
  };

  const service: CodexAccountControlShape = {
    readAccount: ({ target }) => accountEffect(() => readAccount(target)),
    startLogin: (request) => accountEffect(() => startLogin(request)),
    cancelLogin: ({ target }) =>
      accountEffect(() =>
        serialize(target, () => {
          assertMutableTarget(target);
          return cancelActiveLogin(target);
        }),
      ),
    logout: ({ target }) =>
      accountEffect(() =>
        serialize(target, async (): Promise<ProviderProfileLogoutResult> => {
          assertMutableTarget(target);
          const existing = await Effect.runPromise(
            input.registry.list({ provider: "codex" }),
          );
          if (
            existing.profiles.some(
              (profile) =>
                profile.target.profileId === target.profileId &&
                profile.lifecycle === "tombstoned",
            )
          ) {
            return { target, account: signedOutAccount(target) };
          }
          const result = await logoutAndTombstone(target);
          return { target, account: result.account };
        }),
      ),
    setEnabled: (request) =>
      accountEffect(() =>
        serialize(request.target, async () => {
          assertMutableTarget(request.target);
          if (!request.enabled) await cancelActiveLogin(request.target);
          return Effect.runPromise(input.registry.setEnabled(request));
        }),
      ),
    tombstone: ({ target }) =>
      accountEffect(() =>
        serialize(target, async () => {
          assertMutableTarget(target);
          const existing = await Effect.runPromise(
            input.registry.list({ provider: "codex" }),
          );
          if (
            existing.profiles.some(
              (profile) =>
                profile.target.profileId === target.profileId &&
                profile.lifecycle === "tombstoned",
            )
          ) {
            return existing;
          }
          await cancelActiveLogin(target);
          const resolution = await resolve(target);
          if (
            resolution.launchContext.home.strategy === "managed-direct" &&
            resolution.launchContext.authenticationBoundAt === null &&
            !inspectManagedCodexAuthFile(resolution.launchContext.home.codexHomePath)
          ) {
            syncManagedLoggedOutState(resolution.launchContext.home.codexHomePath);
            return Effect.runPromise(input.registry.tombstone({ target }));
          }
          return (await logoutResolvedProfile(resolution)).snapshot;
        }),
      ),
  };

  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      await Promise.allSettled([...targetQueues.values()]);
      const active = [...activeLogins.values()];
      const poisoned = [...unretiredClients.values()];
      const retirements = await Promise.allSettled([
        ...active.map((login) => retryOnce(() => closeActiveLogin(login))),
        ...poisoned.map(({ target, client }) =>
          retryOnce(() => retireClient(target, client)),
        ),
      ]);
      if (retirements.some((result) => result.status === "rejected")) {
        throw new Error("One or more Codex account process trees could not be retired.");
      }
    })();
    try {
      await shutdownPromise;
    } catch (cause) {
      shutdownPromise = undefined;
      throw cause;
    }
  };

  return { service, shutdown };
}

export const CodexAccountControlLive = Layer.effect(
  CodexAccountControl,
  Effect.gen(function* () {
    const runtime = yield* makeCodexAccountControl;
    yield* Effect.addFinalizer(() => Effect.promise(runtime.shutdown));
    return runtime.service;
  }),
);

function accountEffect<A>(
  operation: () => Promise<A>,
): Effect.Effect<A, CodexAccountControlError | ProviderProfileRegistryError> {
  return Effect.tryPromise({
    try: operation,
    catch: normalizeAccountControlError,
  });
}

function normalizeAccountControlError(
  cause: unknown,
): CodexAccountControlError | ProviderProfileRegistryError {
  if (cause instanceof CodexAccountControlError || cause instanceof ProviderProfileRegistryError) {
    return cause;
  }
  if (cause instanceof CodexAccountProtocolVersionError) {
    return controlError(
      "PROVIDER_ACCOUNT_VERSION_UNSUPPORTED",
      "Codex CLI v0.144.0 or newer is required for account control.",
      false,
      cause,
    );
  }
  if (cause instanceof CodexAccountProtocolRequestError) {
    if (cause.rpcCode === -32601) {
      return controlError(
        "PROVIDER_ACCOUNT_VERSION_UNSUPPORTED",
        "The installed Codex CLI does not support account control.",
        false,
        cause,
      );
    }
    const unsupportedLoginMethod =
      cause.method === "account/login/start" &&
      cause.rpcCode === -32602;
    return unsupportedLoginMethod
      ? controlError(
          "PROVIDER_ACCOUNT_LOGIN_METHOD_UNAVAILABLE",
          "This Codex CLI does not support the requested account login method.",
          false,
          cause,
        )
      : controlError(
          "PROVIDER_ACCOUNT_CONTROL_FAILED",
          "The Codex account operation failed.",
          true,
          cause,
        );
  }
  return controlError(
    "PROVIDER_ACCOUNT_CONTROL_FAILED",
    "The Codex account operation failed.",
    true,
    cause,
  );
}

function controlError(
  code: CodexAccountControlErrorCode,
  message: string,
  retryable: boolean,
  cause?: unknown,
): CodexAccountControlError {
  return new CodexAccountControlError({
    code,
    message,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });
}

async function retryOnce(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    await operation();
  }
}

function readAccountResponse(
  target: CodexProviderTarget,
  response: unknown,
  pending?: ActiveLogin,
): DecodedAccountStatus {
  const record = asRecord(response);
  if (
    !record ||
    typeof record.requiresOpenaiAuth !== "boolean" ||
    !("account" in record) ||
    (record.account !== null && !asRecord(record.account))
  ) {
    throw controlError(
      "PROVIDER_ACCOUNT_PROTOCOL_INVALID",
      "Codex returned an invalid account status.",
      false,
    );
  }
  const account = record.account === null ? undefined : asRecord(record.account);
  const authMode = readAuthMode(account?.type);
  return {
    status: {
      target,
      authentication: account ? "signed-in" : "signed-out",
      requiresOpenaiAuth: record.requiresOpenaiAuth,
      authMode,
      email: boundedOptionalString(account?.email, ACCOUNT_EMAIL_MAX_LENGTH),
      planType: boundedOptionalString(account?.planType, ACCOUNT_PLAN_MAX_LENGTH),
      pendingLogin: pending
        ? { method: pending.method, expiresAt: pending.result.expiresAt }
        : null,
    },
    bindableChatGptShape: hasBindableChatGptShape(account),
  };
}

function hasBindableChatGptShape(
  account: Record<string, unknown> | undefined,
): boolean {
  if (!account || account.type !== "chatgpt") return false;
  const hasEmail = Object.prototype.hasOwnProperty.call(account, "email");
  const email = account.email;
  const validEmail = email === null || boundedRequiredString(email, ACCOUNT_EMAIL_MAX_LENGTH);
  const hasPlanType = Object.prototype.hasOwnProperty.call(account, "planType");
  return Boolean(
    hasEmail &&
      validEmail &&
      hasPlanType &&
      boundedRequiredString(account.planType, ACCOUNT_PLAN_MAX_LENGTH),
  );
}

function signedOutAccount(target: CodexProviderTarget): CodexProviderAccountStatus {
  return {
    target,
    authentication: "signed-out",
    requiresOpenaiAuth: true,
    authMode: null,
    email: null,
    planType: null,
    pendingLogin: null,
  };
}

function readAuthMode(type: unknown): CodexProviderAccountAuthMode | null {
  if (type === "apiKey") return "api-key";
  if (type === "chatgpt") return "chatgpt";
  if (type === "amazonBedrock") return "amazon-bedrock";
  return typeof type === "string" ? "other" : null;
}

function loginParams(method: CodexProviderLoginMethod): unknown {
  return method === "browser" ? { type: "chatgpt" } : { type: "chatgptDeviceCode" };
}

function readLoginStartResponse(
  method: CodexProviderLoginMethod,
  response: unknown,
): { readonly loginId: string; readonly challenge: CodexProviderLoginChallenge } {
  const record = asRecord(response);
  const loginId = boundedRequiredString(record?.loginId, LOGIN_ID_MAX_LENGTH);
  if (!record || !loginId) throw invalidLoginStartResponse();
  if (method === "browser") {
    const authUrl = readHttpUrl(record.authUrl);
    if (record.type !== "chatgpt" || !authUrl) throw invalidLoginStartResponse();
    return { loginId, challenge: { method, authUrl } };
  }
  const verificationUrl = readHttpUrl(record.verificationUrl);
  const userCode = boundedRequiredString(record.userCode, LOGIN_USER_CODE_MAX_LENGTH);
  if (record.type !== "chatgptDeviceCode" || !verificationUrl || !userCode) {
    throw invalidLoginStartResponse();
  }
  return { loginId, challenge: { method, verificationUrl, userCode } };
}

function invalidLoginStartResponse(): CodexAccountControlError {
  return controlError(
    "PROVIDER_ACCOUNT_LOGIN_RESPONSE_INVALID",
    "Codex returned an invalid account login challenge.",
    false,
  );
}

function readLoginCompletion(
  notification: CodexAccountProtocolNotification,
  expectedLoginId?: string,
): LoginCompletion | undefined {
  if (notification.method !== "account/login/completed") return undefined;
  const params = asRecord(notification.params);
  if (!params || typeof params.success !== "boolean") return undefined;
  const loginId = params.loginId;
  if (
    loginId !== undefined &&
    loginId !== null &&
    (typeof loginId !== "string" || loginId.length > LOGIN_ID_MAX_LENGTH)
  ) {
    return undefined;
  }
  if (
    expectedLoginId !== undefined &&
    typeof loginId === "string" &&
    loginId !== expectedLoginId
  ) {
    return undefined;
  }
  return { success: params.success };
}

function readCancelResponse(response: unknown): boolean {
  const status = asRecord(response)?.status;
  if (status === "canceled") return true;
  if (status === "notFound") return false;
  throw controlError(
    "PROVIDER_ACCOUNT_PROTOCOL_INVALID",
    "Codex returned an invalid login cancellation result.",
    false,
  );
}

function readHttpUrl(value: unknown): string | undefined {
  const text = boundedRequiredString(value, LOGIN_URL_MAX_LENGTH);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? text : undefined;
  } catch {
    return undefined;
  }
}

function boundedRequiredString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return undefined;
  }
  return trimmed;
}

function boundedOptionalString(value: unknown, maxLength: number): string | null {
  return boundedRequiredString(value, maxLength) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function targetKey(target: CodexProviderTarget): string {
  return `${target.provider}:${target.profileId}`;
}
