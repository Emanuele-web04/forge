// FILE: providerAccounts.ts
// Purpose: Persist and activate isolated provider logins without storing credentials in settings.
// Layer: Server-owned provider identity boundary.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import OS from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ManagedProviderAccountProvider,
  ProviderAccount,
  ProviderAccountCollection,
  ServerCreateProviderAccountInput,
  ServerProviderAccountInput,
  ServerSetActiveProviderAccountInput,
} from "@synara/contracts";
import { Effect, Layer, PubSub, ServiceMap, Stream } from "effect";

import { ServerConfig } from "./config";
import { acquireClaudeAuthStatusLock } from "./provider/claudeAuthStatusLock";
import { ServerSettingsService } from "./serverSettings";

const execFileAsync = promisify(execFile);
const SYSTEM_ACCOUNT_ID = "system";
const METADATA_VERSION = 1;
const COMMAND_TIMEOUT_MS = 20_000;
const AUTH_STATUS_PROBE_INTERVAL_MS = 30_000;

interface PersistedAccount {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastAuthenticatedAt?: string;
  readonly authLabel?: string;
  readonly authStatus: Exclude<ProviderAccount["authStatus"], "authenticating">;
  readonly lastError?: string;
}

interface ProviderAccountState {
  readonly activeAccountId: string;
  readonly accounts: ReadonlyArray<PersistedAccount>;
}

interface ProviderAccountsMetadata {
  readonly version: number;
  readonly providers: Record<ManagedProviderAccountProvider, ProviderAccountState>;
}

export interface ResolvedProviderAccountEnvironment {
  readonly accountId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
}

export interface ProviderAccountServiceShape {
  readonly list: () => Effect.Effect<ReadonlyArray<ProviderAccountCollection>, Error>;
  readonly create: (
    input: ServerCreateProviderAccountInput,
  ) => Effect.Effect<ProviderAccountCollection, Error>;
  readonly setActive: (
    input: ServerSetActiveProviderAccountInput,
  ) => Effect.Effect<ProviderAccountCollection, Error>;
  readonly reauthenticate: (
    input: ServerProviderAccountInput,
  ) => Effect.Effect<ProviderAccountCollection, Error>;
  readonly delete: (
    input: ServerProviderAccountInput,
  ) => Effect.Effect<ProviderAccountCollection, Error>;
  readonly resolveEnvironment: (
    provider: ManagedProviderAccountProvider,
    baseEnv?: NodeJS.ProcessEnv,
  ) => Effect.Effect<ResolvedProviderAccountEnvironment>;
  readonly streamChanges: Stream.Stream<void>;
  readonly dispose: Effect.Effect<void>;
}

export class ProviderAccountService extends ServiceMap.Service<
  ProviderAccountService,
  ProviderAccountServiceShape
>()("synara/providerAccounts/ProviderAccountService") {}

const emptyProviderState = (): ProviderAccountState => ({
  activeAccountId: SYSTEM_ACCOUNT_ID,
  accounts: [],
});

const emptyMetadata = (): ProviderAccountsMetadata => ({
  version: METADATA_VERSION,
  providers: {
    codex: emptyProviderState(),
    claudeAgent: emptyProviderState(),
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePersistedAccount(value: unknown): PersistedAccount | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const label = nonEmptyString(value.label);
  const createdAt = nonEmptyString(value.createdAt);
  if (!id || !label || !createdAt || id === SYSTEM_ACCOUNT_ID) return null;
  const rawStatus = nonEmptyString(value.authStatus);
  const authStatus: PersistedAccount["authStatus"] =
    rawStatus === "authenticated" ||
    rawStatus === "unauthenticated" ||
    rawStatus === "unknown" ||
    rawStatus === "error"
      ? rawStatus
      : "unknown";
  const lastAuthenticatedAt = nonEmptyString(value.lastAuthenticatedAt);
  const authLabel = nonEmptyString(value.authLabel);
  const lastError = nonEmptyString(value.lastError);
  return {
    id,
    label,
    createdAt,
    authStatus,
    ...(lastAuthenticatedAt ? { lastAuthenticatedAt } : {}),
    ...(authLabel ? { authLabel } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

function normalizeProviderState(value: unknown): ProviderAccountState {
  if (!isRecord(value)) return emptyProviderState();
  const accounts = Array.isArray(value.accounts)
    ? value.accounts.flatMap((account) => {
        const normalized = normalizePersistedAccount(account);
        return normalized ? [normalized] : [];
      })
    : [];
  const requestedActive = nonEmptyString(value.activeAccountId) ?? SYSTEM_ACCOUNT_ID;
  return {
    activeAccountId:
      requestedActive === SYSTEM_ACCOUNT_ID || accounts.some((account) => account.id === requestedActive)
        ? requestedActive
        : SYSTEM_ACCOUNT_ID,
    accounts,
  };
}

export function normalizeProviderAccountsMetadata(value: unknown): ProviderAccountsMetadata {
  if (!isRecord(value) || !isRecord(value.providers)) return emptyMetadata();
  return {
    version: METADATA_VERSION,
    providers: {
      codex: normalizeProviderState(value.providers.codex),
      claudeAgent: normalizeProviderState(value.providers.claudeAgent),
    },
  };
}

function errorMessage(cause: unknown, fallback: string): string {
  const message =
    cause === undefined || cause === null
      ? ""
      : cause instanceof Error
        ? cause.message.trim()
        : String(cause).trim();
  return (message || fallback).slice(0, 500);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function identityLabelFromJson(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["email", "emailAddress", "account_email", "userEmail"]) {
    const label = nonEmptyString(value[key]);
    if (label) return label;
  }
  for (const key of ["id_token", "idToken"]) {
    const token = nonEmptyString(value[key]);
    const label = token ? identityLabelFromJson(decodeJwtPayload(token)) : undefined;
    if (label) return label;
  }
  for (const nested of Object.values(value)) {
    if (isRecord(nested)) {
      const label = identityLabelFromJson(nested);
      if (label) return label;
    }
  }
  return undefined;
}

function authLabelFromOutput(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return identityLabelFromJson(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

export function providerStatusOutputIsAuthenticated(
  provider: ManagedProviderAccountProvider,
  stdout: string,
): boolean {
  if (provider === "codex") return !/\bnot\s+logged\s+in\b/iu.test(stdout);
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) && parsed.loggedIn === true;
  } catch {
    return false;
  }
}

function managedAccountHome(rootDir: string, provider: ManagedProviderAccountProvider, id: string) {
  return path.join(rootDir, provider, id);
}

function providerBaseHome(input: {
  provider: ManagedProviderAccountProvider;
  configuredCodexHome?: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): string {
  if (input.provider === "codex") {
    return (
      input.configuredCodexHome?.trim() ||
      input.env.CODEX_HOME?.trim() ||
      path.join(input.homeDir, ".codex")
    );
  }
  return input.env.CLAUDE_CONFIG_DIR?.trim() || path.join(input.homeDir, ".claude");
}

const SHARED_ACCOUNT_ENTRIES: Record<
  ManagedProviderAccountProvider,
  ReadonlyArray<string>
> = {
  claudeAgent: [
    "CLAUDE.md",
    "file-history",
    "history.jsonl",
    "plugins",
    "projects",
    "sessions",
    "settings.json",
    "settings.local.json",
    "skills",
    "tasks",
  ],
  codex: [
    "AGENTS.md",
    "archived_sessions",
    "history.jsonl",
    "memories",
    "plugins",
    "rules",
    "session_index.jsonl",
    "sessions",
    "skills",
  ],
};

async function shareProviderState(
  baseHome: string,
  accountHome: string,
  provider: ManagedProviderAccountProvider,
) {
  for (const entry of SHARED_ACCOUNT_ENTRIES[provider]) {
    const source = path.join(baseHome, entry);
    const target = path.join(accountHome, entry);
    try {
      const stat = await fs.lstat(source);
      await fs.symlink(
        source,
        target,
        stat.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file",
      );
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOENT" || code === "EPERM") continue;
      throw cause;
    }
  }
}

export function ensureCodexFileCredentialStorage(content: string): string {
  const line = 'cli_auth_credentials_store = "file"';
  if (/^\s*cli_auth_credentials_store\s*=/mu.test(content)) {
    return content.replace(/^\s*cli_auth_credentials_store\s*=.*$/mu, line);
  }
  return `${line}\n${content}`;
}

async function prepareAccountHome(input: {
  provider: ManagedProviderAccountProvider;
  accountHome: string;
  baseHome: string;
}) {
  await fs.mkdir(input.accountHome, { recursive: true, mode: 0o700 });
  await shareProviderState(input.baseHome, input.accountHome, input.provider);
  if (input.provider === "codex") {
    const baseConfig = await fs
      .readFile(path.join(input.baseHome, "config.toml"), "utf8")
      .catch(() => "");
    await fs.writeFile(
      path.join(input.accountHome, "config.toml"),
      ensureCodexFileCredentialStorage(baseConfig),
      { encoding: "utf8", mode: 0o600 },
    );
  }
}

export function buildManagedProviderAccountEnvironment(
  provider: ManagedProviderAccountProvider,
  accountHome: string,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (provider === "codex") {
    env.CODEX_HOME = accountHome;
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]) delete env[key];
  } else {
    env.CLAUDE_CONFIG_DIR = accountHome;
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    ]) {
      delete env[key];
    }
  }
  return env;
}

function loginCommand(provider: ManagedProviderAccountProvider, binaryPath: string) {
  return provider === "codex"
    ? { command: binaryPath, args: ["login"] }
    : { command: binaryPath, args: ["auth", "login"] };
}

function statusCommand(provider: ManagedProviderAccountProvider, binaryPath: string) {
  return provider === "codex"
    ? { command: binaryPath, args: ["login", "status"] }
    : { command: binaryPath, args: ["auth", "status", "--json"] };
}

const makeProviderAccountService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const rootDir = path.join(config.baseDir, "provider-accounts");
  const metadataPath = path.join(rootDir, "accounts.json");
  const trashDir = path.join(rootDir, ".trash");
  const jobs = new Map<string, ChildProcess>();
  const lastProbeAtByProvider = new Map<ManagedProviderAccountProvider, number>();
  const changes = yield* PubSub.unbounded<void>();
  let mutationQueue = Promise.resolve();

  const load = async (): Promise<ProviderAccountsMetadata> => {
    try {
      return normalizeProviderAccountsMetadata(
        JSON.parse(await fs.readFile(metadataPath, "utf8")),
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptyMetadata();
      throw cause;
    }
  };

  const save = async (metadata: ProviderAccountsMetadata): Promise<void> => {
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, metadataPath);
  };

  const mutate = <T>(
    operation: (metadata: ProviderAccountsMetadata) => Promise<T>,
  ): Promise<T> => {
    const result = mutationQueue.then(async () => operation(await load()));
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const jobKey = (provider: ManagedProviderAccountProvider, accountId: string) =>
    `${provider}:${accountId}`;

  const binaryPathForProvider = async (provider: ManagedProviderAccountProvider) => {
    const settings = await Effect.runPromise(settingsService.getSettings);
    return provider === "codex"
      ? settings.providers.codex.binaryPath.trim() || "codex"
      : settings.providers.claudeAgent.binaryPath.trim() || "claude";
  };

  const baseHomeForProvider = async (provider: ManagedProviderAccountProvider) => {
    const settings = await Effect.runPromise(settingsService.getSettings);
    return providerBaseHome({
      provider,
      configuredCodexHome: settings.providers.codex.homePath,
      env: process.env,
      homeDir: config.homeDir ?? OS.homedir(),
    });
  };

  const readAccountAuthLabel = async (
    provider: ManagedProviderAccountProvider,
    accountHome: string,
  ): Promise<string | undefined> => {
    const credentialPath = path.join(
      accountHome,
      provider === "codex" ? "auth.json" : ".credentials.json",
    );
    try {
      return identityLabelFromJson(JSON.parse(await fs.readFile(credentialPath, "utf8")));
    } catch {
      return undefined;
    }
  };

  const probe = async (
    provider: ManagedProviderAccountProvider,
    account: PersistedAccount,
  ): Promise<PersistedAccount> => {
    const accountHome = managedAccountHome(rootDir, provider, account.id);
    const binaryPath = await binaryPathForProvider(provider);
    const command = statusCommand(provider, binaryPath);
    const releaseClaudeAuthStatusLock =
      provider === "claudeAgent" ? await acquireClaudeAuthStatusLock() : null;
    try {
      const result = await execFileAsync(command.command, command.args, {
        env: buildManagedProviderAccountEnvironment(provider, accountHome, process.env),
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      if (!providerStatusOutputIsAuthenticated(provider, result.stdout)) {
        throw new Error("Sign-in is required.");
      }
      const authLabel =
        authLabelFromOutput(result.stdout) ?? (await readAccountAuthLabel(provider, accountHome));
      const { lastError: _lastError, ...accountWithoutError } = account;
      return {
        ...accountWithoutError,
        authStatus: "authenticated",
        ...(authLabel ? { authLabel } : {}),
        lastAuthenticatedAt: account.lastAuthenticatedAt ?? new Date().toISOString(),
      };
    } catch {
      return {
        ...account,
        authStatus: "unauthenticated",
        lastError: "Sign-in is required.",
      };
    } finally {
      releaseClaudeAuthStatusLock?.();
    }
  };

  const toCollection = (
    provider: ManagedProviderAccountProvider,
    state: ProviderAccountState,
  ): ProviderAccountCollection => ({
    provider,
    accounts: [
      {
        id: SYSTEM_ACCOUNT_ID,
        provider,
        kind: "system",
        label: "System default",
        active: state.activeAccountId === SYSTEM_ACCOUNT_ID,
        authStatus: "unknown",
      },
      ...state.accounts.map((account): ProviderAccount => ({
        ...account,
        provider,
        kind: "managed",
        active: state.activeAccountId === account.id,
        authStatus: jobs.has(jobKey(provider, account.id)) ? "authenticating" : account.authStatus,
      })),
    ],
  });

  const probeProviderState = async (
    state: ProviderAccountState,
    provider: ManagedProviderAccountProvider,
  ): Promise<ProviderAccountState> => {
    const accounts = await Promise.all(
      state.accounts.map((account) =>
        jobs.has(jobKey(provider, account.id)) ? Promise.resolve(account) : probe(provider, account),
      ),
    );
    lastProbeAtByProvider.set(provider, Date.now());
    return { ...state, accounts };
  };

  const beginAuthentication = async (
    provider: ManagedProviderAccountProvider,
    accountId: string,
  ) => {
    const key = jobKey(provider, accountId);
    if (jobs.has(key)) return;
    const metadata = await load();
    const account = metadata.providers[provider].accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("Provider account was not found.");
    const accountHome = managedAccountHome(rootDir, provider, accountId);
    await prepareAccountHome({
      provider,
      accountHome,
      baseHome: await baseHomeForProvider(provider),
    });
    const command = loginCommand(provider, await binaryPathForProvider(provider));
    const child = spawn(command.command, command.args, {
      env: buildManagedProviderAccountEnvironment(provider, accountHome, process.env),
      stdio: "ignore",
      windowsHide: true,
    });
    jobs.set(key, child);
    const settle = async (successful: boolean, cause?: unknown) => {
      if (jobs.get(key) !== child) return;
      jobs.delete(key);
      await mutate(async (latest) => {
        const state = latest.providers[provider];
        const current = state.accounts.find((item) => item.id === accountId);
        if (!current) return;
        const verified = successful ? await probe(provider, current) : null;
        const nextAccount: PersistedAccount =
          verified?.authStatus === "authenticated"
            ? (() => {
                const { lastError: _lastError, ...accountWithoutError } = verified;
                return {
                  ...accountWithoutError,
                  lastAuthenticatedAt: new Date().toISOString(),
                };
              })()
            : {
                ...current,
                authStatus: "error",
                lastError: errorMessage(cause, "Authentication did not complete."),
              };
        await save({
          ...latest,
          providers: {
            ...latest.providers,
            [provider]: {
              ...state,
              accounts: state.accounts.map((item) =>
                item.id === accountId ? nextAccount : item,
              ),
            },
          },
        });
      });
    };
    child.once("error", (cause) => void settle(false, cause));
    child.once("exit", (code, signal) =>
      void settle(
        code === 0,
        code === 0 ? undefined : new Error(`Login exited with ${signal ?? code}.`),
      ),
    );
  };

  const list: ProviderAccountServiceShape["list"] = () =>
    Effect.tryPromise(async () => {
      const refreshed = await mutate(async (metadata) => {
        const now = Date.now();
        const providersToProbe = (["codex", "claudeAgent"] as const).filter(
          (provider) =>
            now - (lastProbeAtByProvider.get(provider) ?? 0) >= AUTH_STATUS_PROBE_INTERVAL_MS,
        );
        if (providersToProbe.length === 0) return metadata;
        const refreshedStates = await Promise.all(
          providersToProbe.map(async (provider) =>
            [provider, await probeProviderState(metadata.providers[provider], provider)] as const,
          ),
        );
        const next = {
          ...metadata,
          providers: { ...metadata.providers, ...Object.fromEntries(refreshedStates) },
        } as ProviderAccountsMetadata;
        await save(next);
        return next;
      });
      return [
        toCollection("codex", refreshed.providers.codex),
        toCollection("claudeAgent", refreshed.providers.claudeAgent),
      ];
    });

  const create: ProviderAccountServiceShape["create"] = (input) =>
    Effect.tryPromise(async () => {
      const state = await mutate(async (metadata) => {
        const providerState = metadata.providers[input.provider];
        const id = randomUUID();
        const account: PersistedAccount = {
          id,
          label:
            input.label?.trim() ||
            `${input.provider === "codex" ? "Codex" : "Claude"} account ${providerState.accounts.length + 1}`,
          createdAt: new Date().toISOString(),
          authStatus: "unknown",
        };
        const nextState = { ...providerState, accounts: [...providerState.accounts, account] };
        await save({
          ...metadata,
          providers: { ...metadata.providers, [input.provider]: nextState },
        });
        return { state: nextState, accountId: id };
      });
      await beginAuthentication(input.provider, state.accountId);
      return toCollection(input.provider, state.state);
    });

  const setActive: ProviderAccountServiceShape["setActive"] = (input) =>
    Effect.tryPromise(async () => {
      const state = await mutate(async (metadata) => {
        const current = metadata.providers[input.provider];
        if (
          input.accountId !== SYSTEM_ACCOUNT_ID &&
          !current.accounts.some((account) => account.id === input.accountId)
        ) {
          throw new Error("Provider account was not found.");
        }
        const requestedAccount = current.accounts.find(
          (account) => account.id === input.accountId,
        );
        if (requestedAccount && requestedAccount.authStatus !== "authenticated") {
          throw new Error("Authenticate this provider account before selecting it.");
        }
        const nextState = { ...current, activeAccountId: input.accountId };
        await save({
          ...metadata,
          providers: { ...metadata.providers, [input.provider]: nextState },
        });
        return nextState;
      });
      return toCollection(input.provider, state);
    }).pipe(Effect.tap(() => PubSub.publish(changes, undefined)));

  const reauthenticate: ProviderAccountServiceShape["reauthenticate"] = (input) =>
    Effect.tryPromise(async () => {
      if (input.accountId === SYSTEM_ACCOUNT_ID) {
        throw new Error("The system-default account is authenticated outside Synara.");
      }
      await beginAuthentication(input.provider, input.accountId);
      const metadata = await load();
      return toCollection(input.provider, metadata.providers[input.provider]);
    });

  const deleteAccount: ProviderAccountServiceShape["delete"] = (input) =>
    Effect.tryPromise(async () => {
      if (input.accountId === SYSTEM_ACCOUNT_ID) {
        throw new Error("The system-default account cannot be deleted.");
      }
      const key = jobKey(input.provider, input.accountId);
      jobs.get(key)?.kill("SIGTERM");
      jobs.delete(key);
      const state = await mutate(async (metadata) => {
        const current = metadata.providers[input.provider];
        if (!current.accounts.some((account) => account.id === input.accountId)) {
          throw new Error("Provider account was not found.");
        }
        const nextState: ProviderAccountState = {
          activeAccountId:
            current.activeAccountId === input.accountId
              ? SYSTEM_ACCOUNT_ID
              : current.activeAccountId,
          accounts: current.accounts.filter((account) => account.id !== input.accountId),
        };
        await save({
          ...metadata,
          providers: { ...metadata.providers, [input.provider]: nextState },
        });
        return nextState;
      });
      const accountHome = managedAccountHome(rootDir, input.provider, input.accountId);
      await fs.mkdir(trashDir, { recursive: true, mode: 0o700 });
      await fs
        .rename(
          accountHome,
          path.join(trashDir, `${input.provider}-${input.accountId}-${Date.now()}`),
        )
        .catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        });
      return toCollection(input.provider, state);
    }).pipe(Effect.tap(() => PubSub.publish(changes, undefined)));

  const resolveEnvironment: ProviderAccountServiceShape["resolveEnvironment"] = (
    provider,
    baseEnv = process.env,
  ) =>
    Effect.tryPromise(async () => {
      const metadata = await load();
      const state = metadata.providers[provider];
      if (state.activeAccountId === SYSTEM_ACCOUNT_ID) {
        if (provider === "codex") {
          const settings = await Effect.runPromise(settingsService.getSettings);
          const homePath = settings.providers.codex.homePath.trim();
          return {
            accountId: SYSTEM_ACCOUNT_ID,
            env: { ...baseEnv },
            ...(homePath ? { homePath } : {}),
          };
        }
        return { accountId: SYSTEM_ACCOUNT_ID, env: { ...baseEnv } };
      }
      const account = state.accounts.find((item) => item.id === state.activeAccountId);
      if (!account) return { accountId: SYSTEM_ACCOUNT_ID, env: { ...baseEnv } };
      const accountHome = managedAccountHome(rootDir, provider, account.id);
      return {
        accountId: account.id,
        env: buildManagedProviderAccountEnvironment(provider, accountHome, baseEnv),
        ...(provider === "codex" ? { homePath: accountHome } : {}),
      };
    }).pipe(Effect.orDie);

  const dispose = Effect.sync(() => {
    for (const child of jobs.values()) child.kill("SIGTERM");
    jobs.clear();
  });

  return {
    list,
    create,
    setActive,
    reauthenticate,
    delete: deleteAccount,
    resolveEnvironment,
    streamChanges: Stream.fromPubSub(changes),
    dispose,
  } satisfies ProviderAccountServiceShape;
});

export const ProviderAccountServiceLive = Layer.effect(
  ProviderAccountService,
  makeProviderAccountService.pipe(
    Effect.tap((service) => Effect.addFinalizer(() => service.dispose)),
  ),
);
