import { randomUUID } from "node:crypto";
import * as path from "node:path";

import {
  SupportedAccountProvider,
  type AccountSurface,
  type AgentAuthMethod,
  type ProviderAccountsBeginConnectInput,
  type ProviderAccountsConnectStatus,
  type ProviderAccountRecord,
} from "@synara/contracts";
import { isConnectSupported, supportLevelFor } from "@synara/shared/providerAccounts/capabilities";
import { pendingPath } from "@synara/shared/providerAccounts/accountPaths";
import { Cause, Data, Effect } from "effect";

import type { AccountStorageShape, ProviderAccountStorageError } from "./accountStorage";
import {
  defaultOauthLoginRunners,
  OAUTH_LOGIN_TIMEOUT_MS,
  type OAuthLoginHandle,
  type OAuthLoginRunner,
} from "./oauthLogin";

export class ProviderAccountConnectError extends Data.TaggedError("ProviderAccountConnectError")<{
  readonly operation: string;
  readonly detail: string;
}> {}

type ConnectOperation = {
  readonly operationId: string;
  readonly provider: SupportedAccountProvider;
  readonly surface: AccountSurface;
  readonly authMethod: AgentAuthMethod;
  readonly reconnectOrdinal?: number;
  // Held in memory only until finalization; never echoed back to clients.
  apiKey?: string;
  state: ProviderAccountsConnectStatus["state"];
  ordinal?: number;
  verificationUrl?: string;
  userCode?: string;
  error?: string;
  loginHandle?: OAuthLoginHandle;
  // Epoch millis when the operation reached a terminal state; used to evict
  // old entries so the operations map cannot grow without bound.
  finishedAt?: number;
};

// Terminal operations stay queryable for a grace period, then are evicted.
const TERMINAL_OPERATION_TTL_MS = 30 * 60 * 1000;

const isTerminalState = (state: ProviderAccountsConnectStatus["state"]): boolean =>
  state === "succeeded" || state === "failed" || state === "cancelled";

const toStatus = (operation: ConnectOperation): ProviderAccountsConnectStatus => ({
  operationId: operation.operationId,
  state: operation.state,
  provider: operation.provider,
  surface: operation.surface,
  ...(operation.ordinal !== undefined ? { ordinal: operation.ordinal } : {}),
  ...(operation.verificationUrl !== undefined
    ? { verificationUrl: operation.verificationUrl }
    : {}),
  ...(operation.userCode !== undefined ? { userCode: operation.userCode } : {}),
  ...(operation.error !== undefined ? { error: operation.error } : {}),
});

export interface AccountConnectInput {
  readonly storage: AccountStorageShape;
  readonly now?: () => string;
  readonly oauthLoginRunners?: Partial<Record<SupportedAccountProvider, OAuthLoginRunner>>;
}

export type AccountConnectShape = ReturnType<typeof makeAccountConnect>;

export function makeAccountConnect(input: AccountConnectInput) {
  const { storage } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const oauthLoginRunners = input.oauthLoginRunners ?? defaultOauthLoginRunners;
  const operations = new Map<string, ConnectOperation>();

  const evictExpiredOperations = () => {
    const cutoff = Date.now() - TERMINAL_OPERATION_TTL_MS;
    for (const [operationId, operation] of operations) {
      if (
        isTerminalState(operation.state) &&
        operation.finishedAt !== undefined &&
        operation.finishedAt < cutoff
      ) {
        operations.delete(operationId);
      }
    }
  };

  const connectError = (operation: string, detail: string) =>
    new ProviderAccountConnectError({ operation, detail });

  const requireOperation = (
    operation: string,
    operationId: string,
  ): Effect.Effect<ConnectOperation, ProviderAccountConnectError> => {
    const found = operations.get(operationId);
    return found === undefined
      ? Effect.fail(connectError(operation, `Unknown connect operation '${operationId}'.`))
      : Effect.succeed(found);
  };

  const buildConnectedRecord = (
    operation: ConnectOperation,
    existing: ProviderAccountRecord | null,
    ordinal: number,
    identity?: {
      readonly hint?: string;
      readonly fingerprint?: string;
      readonly verification?: "provider-verified" | "user-confirmed" | "unknown";
    },
  ): ProviderAccountRecord => {
    const { provider, surface, authMethod } = operation;
    const previous = surface === "agent" ? existing?.agent : existing?.app;
    const generation = (previous?.generation ?? 0) + 1;
    return {
      schemaVersion: 1,
      provider,
      ordinal,
      createdAt: existing?.createdAt ?? now(),
      ...(identity?.hint !== undefined
        ? {
            identity: {
              hint: identity.hint,
              verification: identity.verification ?? ("provider-verified" as const),
            },
          }
        : existing?.identity !== undefined
          ? { identity: existing.identity }
          : {}),
      ...(surface === "agent"
        ? {
            agent: {
              generation,
              state: "connected" as const,
              authMethod,
              ...(identity?.fingerprint !== undefined
                ? { identityFingerprint: identity.fingerprint }
                : {}),
            },
            ...(existing?.app !== undefined ? { app: existing.app } : {}),
          }
        : {
            app: {
              generation,
              state: "connected" as const,
              authMethod: "oauth" as const,
              supportLevel: supportLevelFor(provider, "app", "oauth"),
              ...(identity?.fingerprint !== undefined
                ? { identityFingerprint: identity.fingerprint }
                : {}),
            },
            ...(existing?.agent !== undefined ? { agent: existing.agent } : {}),
          }),
    };
  };

  const activateIfFirst = (provider: SupportedAccountProvider, ordinal: number) =>
    Effect.gen(function* () {
      // First connected account becomes active so new threads use it. A
      // corrupted pointer read must not fail the connect itself (the doctor
      // report and pointer repair handle it), but a failed pointer write is
      // surfaced: silently swallowing it would leave the user believing the
      // new account is active while launches keep using the native account.
      const active = yield* storage.readActiveOrdinal(provider).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("providerAccounts.active_pointer_read_failed", { cause }),
        ),
        Effect.orElseSucceed(() => undefined),
      );
      if (active === null) {
        yield* storage.writeActiveOrdinal(provider, ordinal);
      }
    });

  // API-key connects are transactional: the ordinal directory is reserved
  // atomically under the provider lock, the secret is written before the
  // record is marked connected, and any failure rolls the reservation back.
  const finalizeApiKeyConnect = (
    operation: ConnectOperation,
  ): Effect.Effect<
    ProviderAccountsConnectStatus,
    ProviderAccountConnectError | ProviderAccountStorageError
  > =>
    storage.withProviderLock(
      operation.provider,
      Effect.gen(function* () {
        const { provider } = operation;
        const apiKey = operation.apiKey;
        if (apiKey === undefined) {
          return yield* connectError(
            "accountConnect.finalizeApiKeyConnect",
            "API-key connect requires an apiKey.",
          );
        }
        const reservedOrdinal =
          operation.reconnectOrdinal === undefined
            ? yield* storage.reserveOrdinalDirectory(provider)
            : undefined;
        const ordinal = operation.reconnectOrdinal ?? reservedOrdinal!;

        // Reconnects overwrite the existing secret: capture it first so a
        // failed record write can restore it instead of leaving the account
        // pointing at a key that was never recorded.
        const previousSecret =
          operation.reconnectOrdinal !== undefined
            ? yield* storage
                .readSecret(provider, ordinal, "agent")
                .pipe(Effect.orElseSucceed(() => null))
            : null;

        const writeAll = Effect.gen(function* () {
          const existing = yield* storage.readAccount(provider, ordinal);
          yield* storage.writeSecret(provider, ordinal, "agent", apiKey);
          const identityHint = `API key ending ${apiKey.slice(-4)}`;
          yield* storage.writeAccount(
            buildConnectedRecord(operation, existing, ordinal, {
              hint: identityHint,
              verification: "unknown",
            }),
          );
          yield* activateIfFirst(provider, ordinal);
        });

        const rollback =
          reservedOrdinal !== undefined
            ? // Releasing the reserved directory also removes the freshly
              // written secret file, so no orphaned key survives a failure.
              storage.releaseOrdinalDirectory(provider, reservedOrdinal).pipe(Effect.ignore)
            : previousSecret !== null
              ? storage.writeSecret(provider, ordinal, "agent", previousSecret).pipe(Effect.ignore)
              : storage.deleteSecret(provider, ordinal, "agent").pipe(Effect.ignore);

        yield* writeAll.pipe(Effect.tapError(() => rollback));

        delete operation.apiKey;
        operation.state = "succeeded";
        operation.ordinal = ordinal;
        operation.finishedAt = Date.now();
        return toStatus(operation);
      }),
    );

  const finalizeOauthConnect = (
    operationId: string,
    identity?: { readonly hint?: string; readonly fingerprint?: string },
  ): Effect.Effect<
    ProviderAccountsConnectStatus,
    ProviderAccountConnectError | ProviderAccountStorageError
  > =>
    Effect.gen(function* () {
      const operation = yield* requireOperation("accountConnect.finalizeOauthConnect", operationId);
      if (operation.state !== "pending" && operation.state !== "waiting-for-user") {
        return yield* connectError(
          "accountConnect.finalizeOauthConnect",
          `Connect operation '${operationId}' is already ${operation.state}.`,
        );
      }
      const { provider } = operation;
      // Reconnects committed here have already passed the runner's own
      // verification: the swap only happens after a successful login.
      let ordinal: number;
      if (operation.reconnectOrdinal !== undefined) {
        ordinal = operation.reconnectOrdinal;
        yield* storage.commitReconnectHome(provider, operationId, ordinal);
      } else {
        ordinal = yield* storage.finalizePendingDirectory(provider, operationId);
      }
      const existing = yield* storage.readAccount(provider, ordinal);
      yield* storage.writeAccount(buildConnectedRecord(operation, existing, ordinal, identity));
      yield* activateIfFirst(provider, ordinal);
      operation.state = "succeeded";
      operation.ordinal = ordinal;
      operation.finishedAt = Date.now();
      return toStatus(operation);
    });

  const failOperation = (operation: ConnectOperation, detail: string) => {
    if (operation.state === "pending" || operation.state === "waiting-for-user") {
      operation.state = "failed";
      operation.error = detail;
      operation.finishedAt = Date.now();
      delete operation.apiKey;
    }
  };

  const startOauthLogin = (operation: ConnectOperation, profileHome: string) => {
    const runner = oauthLoginRunners[operation.provider];
    if (runner === undefined) {
      failOperation(
        operation,
        `Managed OAuth login is not implemented for provider '${operation.provider}'.`,
      );
      return;
    }
    const handle = runner({
      provider: operation.provider,
      profileHome,
      onVerification: (info) => {
        if (info.verificationUrl !== undefined) operation.verificationUrl = info.verificationUrl;
        if (info.userCode !== undefined) operation.userCode = info.userCode;
        if (operation.state === "pending") operation.state = "waiting-for-user";
      },
    });
    operation.loginHandle = handle;
    void handle.done.then(async (outcome) => {
      if (operation.state !== "pending" && operation.state !== "waiting-for-user") return;
      if (!outcome.ok) {
        failOperation(operation, outcome.error);
        await Effect.runPromise(
          storage
            .cancelPendingDirectory(operation.provider, operation.operationId)
            .pipe(Effect.ignore),
        );
        return;
      }
      await Effect.runPromise(
        finalizeOauthConnect(
          operation.operationId,
          outcome.identityHint !== undefined ? { hint: outcome.identityHint } : undefined,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("providerAccounts.oauth_finalize_failed", { cause });
              const failure = Cause.findErrorOption(cause);
              const detail =
                failure._tag === "Some" ? failure.value.detail : "An unexpected error occurred.";
              failOperation(operation, `Failed to finalize the OAuth connection: ${detail}`);
              // The staged login directory is dead either way; live
              // credentials were never touched, so discarding it is safe.
              yield* storage
                .cancelPendingDirectory(operation.provider, operation.operationId)
                .pipe(Effect.ignore);
              return toStatus(operation);
            }),
          ),
        ),
      ).catch(() => undefined);
    });
  };

  const beginConnect = (connectInput: ProviderAccountsBeginConnectInput) =>
    Effect.gen(function* () {
      const surface: AccountSurface = connectInput.kind === "app-oauth" ? "app" : "agent";
      const authMethod: AgentAuthMethod =
        connectInput.kind === "agent-api-key" ? "apiKey" : "oauth";
      const { provider } = connectInput;

      // Capability validation happens before any operation or filesystem
      // state exists: unsupported combinations are rejected outright.
      if (!isConnectSupported(provider, surface, authMethod)) {
        return yield* connectError(
          "accountConnect.beginConnect",
          `Connecting a managed '${provider}' account via ${surface} ${authMethod === "apiKey" ? "API key" : "OAuth"} is not supported.`,
        );
      }
      if (connectInput.ordinal !== undefined) {
        if (connectInput.ordinal === 0) {
          return yield* connectError(
            "accountConnect.beginConnect",
            "The native account 0 is not managed by Synara and cannot be reconnected.",
          );
        }
        if ((yield* storage.readAccount(provider, connectInput.ordinal)) === null) {
          return yield* connectError(
            "accountConnect.beginConnect",
            `Cannot reconnect missing account '${provider}' ordinal ${connectInput.ordinal}.`,
          );
        }
      }

      evictExpiredOperations();

      const operation: ConnectOperation = {
        operationId: randomUUID(),
        provider,
        surface,
        authMethod,
        ...(connectInput.ordinal !== undefined ? { reconnectOrdinal: connectInput.ordinal } : {}),
        ...(connectInput.kind === "agent-api-key" ? { apiKey: connectInput.apiKey } : {}),
        state: "pending",
      };
      operations.set(operation.operationId, operation);

      if (connectInput.kind === "agent-api-key") {
        // API-key connects need no external login step; finalize immediately.
        // On failure the operation is marked failed and the in-memory key is
        // dropped so it cannot linger past its only use.
        yield* finalizeApiKeyConnect(operation).pipe(
          Effect.tapError((error) => Effect.sync(() => failOperation(operation, error.detail))),
        );
        return { operationId: operation.operationId };
      }

      // OAuth logins always run inside a pending directory so a failed,
      // cancelled, or interrupted login never touches live credentials: new
      // accounts turn the pending directory into a numbered slot on success,
      // reconnects atomically swap the staged home into the existing slot.
      yield* storage.createPendingDirectory(provider, operation.operationId);
      // Persist non-secret metadata so a restart can surface the interrupted
      // operation as a truthful terminal state instead of "unknown".
      yield* storage.writePendingOperation(
        provider,
        operation.operationId,
        JSON.stringify({
          operationId: operation.operationId,
          provider,
          surface,
          authMethod,
          ...(connectInput.ordinal !== undefined ? { reconnectOrdinal: connectInput.ordinal } : {}),
          startedAt: now(),
          // Owner pid so sibling server instances sharing the account root
          // can tell a live in-flight login from an interrupted one.
          pid: process.pid,
        }),
      );
      const profileHome = path.join(
        pendingPath(storage.root, provider, operation.operationId),
        "agent",
        "home",
      );
      startOauthLogin(operation, profileHome);
      return { operationId: operation.operationId };
    });

  const getConnectStatus = (operationId: string) =>
    requireOperation("accountConnect.getConnectStatus", operationId).pipe(Effect.map(toStatus));

  const cancelConnect = (operationId: string) =>
    requireOperation("accountConnect.cancelConnect", operationId).pipe(
      Effect.flatMap((operation) =>
        Effect.gen(function* () {
          if (operation.state === "waiting-for-user" || operation.state === "pending") {
            operation.state = "cancelled";
            operation.finishedAt = Date.now();
            operation.loginHandle?.cancel();
            if (operation.authMethod === "oauth") {
              yield* storage.cancelPendingDirectory(operation.provider, operation.operationId);
            }
            delete operation.apiKey;
          }
          return toStatus(operation);
        }),
      ),
    );

  const setActive = (provider: SupportedAccountProvider, ordinal: number) =>
    Effect.gen(function* () {
      if (ordinal !== 0) {
        const record = yield* storage.readAccount(provider, ordinal);
        if (record === null) {
          return yield* connectError(
            "accountConnect.setActive",
            `Cannot activate missing account '${provider}' ordinal ${ordinal}.`,
          );
        }
        // Activating an account without a usable agent binding would make
        // every new session fail; require a connected agent binding.
        if (record.agent === undefined || record.agent.state !== "connected") {
          return yield* connectError(
            "accountConnect.setActive",
            `Cannot activate account '${provider}' ordinal ${ordinal}: its agent binding is ${record.agent === undefined ? "not configured" : `'${record.agent.state}'`}. Reconnect it first.`,
          );
        }
      }
      yield* storage.writeActiveOrdinal(provider, ordinal);
    });

  const disconnectBinding = (
    provider: SupportedAccountProvider,
    ordinal: number,
    surface: AccountSurface,
  ) =>
    Effect.gen(function* () {
      if (ordinal === 0) {
        return yield* connectError(
          "accountConnect.disconnectBinding",
          "The native account 0 is not managed by Synara and cannot be disconnected.",
        );
      }
      const existing = yield* storage.readAccount(provider, ordinal);
      if (existing === null) {
        return yield* connectError(
          "accountConnect.disconnectBinding",
          `Cannot disconnect missing account '${provider}' ordinal ${ordinal}.`,
        );
      }
      const binding = surface === "agent" ? existing.agent : existing.app;
      if (binding === undefined) return;
      // Bumping the generation invalidates existing thread bindings so they
      // fail closed instead of reusing stale credentials.
      const disconnected = {
        ...binding,
        state: "needs-auth" as const,
        generation: binding.generation + 1,
      };
      yield* storage.writeAccount(
        surface === "agent"
          ? { ...existing, agent: disconnected as typeof existing.agent }
          : { ...existing, app: disconnected as typeof existing.app },
      );
      if (surface === "agent") {
        yield* storage.deleteSecret(provider, ordinal, "agent");
      }
    });

  const hide = (provider: SupportedAccountProvider, ordinal: number) =>
    Effect.gen(function* () {
      if (ordinal === 0) {
        return yield* connectError("accountConnect.hide", "The native account 0 cannot be hidden.");
      }
      yield* storage.hideAccount(provider, ordinal);
      if ((yield* storage.readActiveOrdinal(provider)) === ordinal) {
        yield* storage.writeActiveOrdinal(provider, 0);
      }
    });

  const isPidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // Startup recovery: pending directories left behind by a previous process
  // are interrupted OAuth connects. Register each as a failed operation so
  // status queries return a truthful terminal state, then remove the
  // directory. The account root is machine-global, so a pending directory
  // whose owner process is still alive (or which is younger than the login
  // timeout) belongs to a live sibling instance and must be left alone.
  const recoverInterruptedOperations = Effect.gen(function* () {
    for (const provider of SupportedAccountProvider.literals) {
      // Ordinal directories whose finalize never committed are removed first
      // so a crashed move can neither shadow an ordinal nor resurrect later.
      yield* storage.recoverIncompleteFinalizations(provider).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("providerAccounts.finalize_recovery_failed", { cause }),
        ),
        Effect.ignore,
      );
      // Repair reconnect swaps interrupted mid-commit so every account has a
      // usable agent home again.
      yield* storage.recoverReconnectBackups(provider).pipe(Effect.ignore);
      const pendingIds = yield* storage
        .listPendingOperations(provider)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const operationId of pendingIds) {
        const raw = yield* storage
          .readPendingOperation(provider, operationId)
          .pipe(Effect.orElseSucceed(() => null));
        let surface: AccountSurface = "agent";
        let authMethod: AgentAuthMethod = "oauth";
        let ownerPid: number | undefined;
        let startedAtMs: number | undefined;
        if (raw !== null) {
          try {
            const parsed = JSON.parse(raw) as {
              surface?: AccountSurface;
              authMethod?: AgentAuthMethod;
              pid?: number;
              startedAt?: string;
            };
            if (parsed.surface === "agent" || parsed.surface === "app") surface = parsed.surface;
            if (parsed.authMethod === "oauth" || parsed.authMethod === "apiKey") {
              authMethod = parsed.authMethod;
            }
            if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
              ownerPid = parsed.pid;
            }
            if (typeof parsed.startedAt === "string") {
              const ms = Date.parse(parsed.startedAt);
              if (!Number.isNaN(ms)) startedAtMs = ms;
            }
          } catch {
            // Corrupted metadata still yields a terminal failed status.
          }
        }
        // A pending directory owned by a live sibling process is in-flight and
        // must be left alone. When ownership is unknown (legacy metadata), the
        // login timeout is the only signal: leave fresh directories for their
        // (possibly live) owner and only reap them once they are stale.
        const ownedByLiveSibling =
          ownerPid !== undefined && ownerPid !== process.pid && isPidAlive(ownerPid);
        const unknownOwnerStillFresh =
          ownerPid === undefined &&
          startedAtMs !== undefined &&
          Date.now() - startedAtMs < OAUTH_LOGIN_TIMEOUT_MS;
        if (ownedByLiveSibling || unknownOwnerStillFresh) {
          continue;
        }
        operations.set(operationId, {
          operationId,
          provider,
          surface,
          authMethod,
          state: "failed",
          finishedAt: Date.now(),
          error: "The connect operation was interrupted by a server restart. Start a new connect.",
        });
        yield* storage.cancelPendingDirectory(provider, operationId).pipe(Effect.ignore);
      }
      // Remove the provider's pending directory once nothing is left in it;
      // a directory that still holds live sibling operations is kept.
      const remaining = yield* storage
        .listPendingOperations(provider)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      if (pendingIds.length > 0 && remaining.length === 0) {
        yield* storage.cleanupPendingDirectories(provider).pipe(Effect.ignore);
      }
    }
  });

  return {
    beginConnect,
    recoverInterruptedOperations,
    getConnectStatus,
    cancelConnect,
    setActive,
    disconnectBinding,
    hide,
  };
}
