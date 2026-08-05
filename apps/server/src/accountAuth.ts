/**
 * accountAuth - `synara auth` / `synara status` flows.
 *
 * Plain async functions so the CLI handlers stay thin and the flows are
 * testable without a network or an Effect runtime. Every collaborator the
 * flows touch (account client, stdout, platform, hostname) is injectable.
 *
 * @module accountAuth
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import OS from "node:os";
import path from "node:path";

import {
  type AccountHost,
  type AccountHostEndpoint,
  type AccountHostPlatform,
  EnvironmentId,
} from "@synara/contracts";
import { AccountApiError, createAccountClient, type AccountClient } from "@synara/shared/account";
import { Effect, Path } from "effect";

import { writeFileStringAtomically } from "./atomicWrite";
import { deriveServerPaths } from "./config";
import { PRIVATE_FILE_MODE } from "./privatePathPermissions";
import { isLoopbackHost, isWildcardHost } from "./startupAccess";
import serverPackageJson from "../package.json" with { type: "json" };

export const ACCOUNT_URL_ENV_NAME = "SYNARA_ACCOUNT_URL";
const CREDENTIALS_FILE_NAME = "account-credentials.json";

/** What the user sees when a rotated refresh token can no longer be redeemed. */
export const SESSION_EXPIRED_MESSAGE = "Session expired — run `synara auth` to sign in again.";

/**
 * The stored account file. The user session (`accessToken`/`refreshToken`) and
 * the host registration (`hostToken`/`hostId`) have independent lifetimes: a
 * WorkOS refresh token can be spent or revoked while the host token this
 * machine registered with stays valid, so the two halves are optional
 * separately and an expired session leaves the host fields in place.
 */
export interface StoredAccountFile {
  readonly accountUrl: string;
  readonly workosClientId: string;
  readonly workosApiUrl: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly hostToken?: string;
  readonly hostId?: string;
}

/** A {@link StoredAccountFile} that carries a usable user session. */
export interface AccountCredentials extends StoredAccountFile {
  readonly accessToken: string;
  readonly refreshToken: string;
}

type Stdout = (text: string) => void;

const defaultStdout: Stdout = (text) => {
  process.stdout.write(text);
};

/** Runs an Effect that only needs the Node path service (no scope, no filesystem layer). */
const runWithPath = <A, E>(effect: Effect.Effect<A, E, Path.Path>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Path.layer)));

export function accountCredentialsPath(baseDir: string): string {
  return path.join(baseDir, CREDENTIALS_FILE_NAME);
}

/**
 * Reads the stored account file. A missing, unreadable, or malformed file is
 * reported as absent rather than an error: the CLI must always be able to
 * recover by running `synara auth` again.
 *
 * A pre-WorkOS file (identified by its `deviceToken`) is also treated as
 * absent. Those tokens were minted by an endpoint that no longer exists, so
 * there is nothing to migrate — re-authenticating is the only path forward.
 */
export async function readAccountFile(baseDir: string): Promise<StoredAccountFile | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(accountCredentialsPath(baseDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.deviceToken === "string") return undefined;
    if (
      typeof record.accountUrl !== "string" ||
      typeof record.workosClientId !== "string" ||
      typeof record.workosApiUrl !== "string"
    ) {
      return undefined;
    }
    return {
      accountUrl: record.accountUrl,
      workosClientId: record.workosClientId,
      workosApiUrl: record.workosApiUrl,
      ...(typeof record.accessToken === "string" ? { accessToken: record.accessToken } : {}),
      ...(typeof record.refreshToken === "string" ? { refreshToken: record.refreshToken } : {}),
      ...(typeof record.hostToken === "string" ? { hostToken: record.hostToken } : {}),
      ...(typeof record.hostId === "string" ? { hostId: record.hostId } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The stored file, but only when it carries a redeemable user session. */
export async function readAccountCredentials(
  baseDir: string,
): Promise<AccountCredentials | undefined> {
  const stored = await readAccountFile(baseDir);
  if (!stored?.accessToken || !stored.refreshToken) return undefined;
  return { ...stored, accessToken: stored.accessToken, refreshToken: stored.refreshToken };
}

export async function writeAccountCredentials(
  baseDir: string,
  credentials: StoredAccountFile,
): Promise<void> {
  await Effect.runPromise(
    writeFileStringAtomically({
      filePath: accountCredentialsPath(baseDir),
      contents: `${JSON.stringify(credentials, null, 2)}\n`,
      mode: PRIVATE_FILE_MODE,
    }),
  );
}

export async function deleteAccountCredentials(baseDir: string): Promise<void> {
  await fs.rm(accountCredentialsPath(baseDir), { force: true });
}

export function resolveAccountUrl(input: {
  readonly flag?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): string | undefined {
  const flag = input.flag?.trim();
  if (flag) return flag;
  const fromEnv = (input.env ?? process.env)[ACCOUNT_URL_ENV_NAME]?.trim();
  return fromEnv || undefined;
}

/**
 * Resolves the environment id the server persists at
 * `<stateDir>/environment-id`, generating and persisting it in the same format
 * when the server has never started. Registering a host under a different id
 * would leave the account with a phantom host once the server does start.
 */
export async function resolveEnvironmentId(
  baseDir: string,
  devUrl?: URL | undefined,
): Promise<string> {
  const { environmentIdPath } = await runWithPath(deriveServerPaths(baseDir, devUrl));
  try {
    const persisted = (await fs.readFile(environmentIdPath, "utf8")).trim();
    if (persisted.length > 0) return persisted;
  } catch {
    // Falls through to generation below.
  }
  const generated = randomUUID();
  await Effect.runPromise(
    writeFileStringAtomically({ filePath: environmentIdPath, contents: `${generated}\n` }),
  );
  return generated;
}

const SUPPORTED_PLATFORMS: Record<string, AccountHostPlatform> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

export function toAccountHostPlatform(
  platform: NodeJS.Platform | string,
): AccountHostPlatform | undefined {
  return SUPPORTED_PLATFORMS[platform];
}

/**
 * Derives this machine's reachable LAN endpoint from a running server's
 * persisted runtime state. Loopback and wildcard binds are not reachable from
 * another device, so they yield no endpoint at all rather than a URL that
 * silently fails for every other host on the account.
 */
export async function resolveLanEndpoints(
  baseDir: string,
  devUrl?: URL | undefined,
): Promise<AccountHostEndpoint[]> {
  const { serverRuntimeStatePath } = await runWithPath(deriveServerPaths(baseDir, devUrl));
  let state: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(serverRuntimeStatePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    state = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const host = typeof state.host === "string" ? state.host : undefined;
  if (!host || isWildcardHost(host) || isLoopbackHost(host)) return [];
  return typeof state.origin === "string" ? [{ url: state.origin, transport: "lan" }] : [];
}

function describeError(error: unknown): string {
  if (error instanceof AccountApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export interface AccountFlowOptions {
  readonly accountUrl: string;
  readonly baseDir: string;
  readonly client?: AccountClient;
  readonly stdout?: Stdout;
  readonly devUrl?: URL | undefined;
  readonly platform?: NodeJS.Platform | string;
  readonly hostname?: string;
  readonly appVersion?: string;
}

function clientFor(accountUrl: string, injected: AccountClient | undefined): AccountClient {
  return injected ?? createAccountClient({ baseUrl: accountUrl });
}

/**
 * Thrown when the stored session can no longer be renewed. Distinct from a
 * transient failure: the only cure is signing in again.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super(SESSION_EXPIRED_MESSAGE);
    this.name = "SessionExpiredError";
  }
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof AccountApiError && (error.status === 401 || error.status === 403);
}

export interface WithFreshAccessTokenOptions {
  readonly baseDir: string;
  readonly client: AccountClient;
}

/**
 * Runs `fn` with the stored access token, renewing it once if the account
 * rejects it. WorkOS access tokens live about five minutes, so any CLI command
 * run more than a few minutes after `synara auth` needs this.
 *
 * Credentials are re-read per call rather than captured by the caller: a
 * rotation performed for one call must be visible to the next one, and the
 * spent refresh token must never be presented twice.
 *
 * The rotated pair is persisted *before* the retry, not after. WorkOS refresh
 * tokens are single-use: if the process died between redeeming one and writing
 * the replacement, the stored token would already be spent and the user would
 * be silently signed out with no way to tell why.
 */
export async function withFreshAccessToken<A>(
  options: WithFreshAccessTokenOptions,
  fn: (accessToken: string) => Promise<A>,
): Promise<A> {
  const { baseDir, client } = options;
  const credentials = await readAccountCredentials(baseDir);
  if (!credentials) throw new SessionExpiredError();
  try {
    return await fn(credentials.accessToken);
  } catch (error) {
    if (!isUnauthorized(error)) throw error;

    let refreshed;
    try {
      refreshed = await client.refreshAccessToken({
        refreshToken: credentials.refreshToken,
        clientId: credentials.workosClientId,
        workosApiUrl: credentials.workosApiUrl,
      });
    } catch {
      // The refresh token is spent or revoked. Drop only the session half of
      // the file: the host registration is still real, and keeping it lets a
      // later `synara auth` re-link this machine instead of stranding a
      // phantom host on the account.
      const { accessToken: _accessToken, refreshToken: _refreshToken, ...rest } = credentials;
      await writeAccountCredentials(baseDir, rest);
      throw new SessionExpiredError();
    }

    await writeAccountCredentials(baseDir, {
      ...credentials,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
    });
    return await fn(refreshed.accessToken);
  }
}

export async function runAuthLogin(options: AccountFlowOptions): Promise<void> {
  const stdout = options.stdout ?? defaultStdout;
  const existing = await readAccountCredentials(options.baseDir);
  if (existing) {
    stdout(
      `Already signed in to ${existing.accountUrl}.\nRun \`synara auth logout\` first to sign in as someone else.\n`,
    );
    return;
  }

  const client = clientFor(options.accountUrl, options.client);
  const instance = await client.instance();
  const device = await client.requestDeviceCode();

  stdout(
    [
      "",
      `  Sign in to ${options.accountUrl}`,
      "",
      `  Open:  ${device.verificationUriComplete}`,
      `  Code:  ${device.userCode}`,
      "",
      "  Waiting for approval...",
      "",
    ].join("\n"),
  );

  const token = await client.pollDeviceToken(device.deviceCode, {
    interval: device.interval,
    expiresIn: device.expiresIn,
    clientId: instance.clientId,
    workosApiUrl: instance.workosApiUrl,
  });

  // A file left behind by an expired session still holds this machine's host
  // registration; carrying it forward keeps the re-link intact if registering
  // again fails.
  const previous = await readAccountFile(options.baseDir);
  const session = {
    accountUrl: options.accountUrl,
    workosClientId: instance.clientId,
    workosApiUrl: instance.workosApiUrl,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    ...(previous?.hostToken ? { hostToken: previous.hostToken } : {}),
    ...(previous?.hostId ? { hostId: previous.hostId } : {}),
  } satisfies StoredAccountFile;
  await writeAccountCredentials(options.baseDir, session);

  const platform = toAccountHostPlatform(options.platform ?? process.platform);
  if (!platform) {
    stdout(
      `Signed in, but this host was not registered: platform "${String(options.platform ?? process.platform)}" is not supported for remote hosts (darwin, linux, windows).\n`,
    );
    return;
  }

  const environmentId = await resolveEnvironmentId(options.baseDir, options.devUrl);
  const name = options.hostname ?? OS.hostname();
  const endpoints = await resolveLanEndpoints(options.baseDir, options.devUrl);
  const appVersion = options.appVersion ?? serverPackageJson.version;

  let registered;
  try {
    registered = await client.registerHost(token.accessToken, {
      environmentId: EnvironmentId.makeUnsafe(environmentId),
      name,
      platform,
      kind: "local",
      endpoints,
      appVersion,
    });
  } catch (error) {
    stdout(
      `Signed in, but registering this host failed: ${describeError(error)}\nRun \`synara auth logout\` and try again, or register the host from the Synara UI.\n`,
    );
    return;
  }

  await writeAccountCredentials(options.baseDir, {
    ...session,
    hostToken: registered.hostToken,
    hostId: registered.host.id,
  });

  stdout(
    [
      `Signed in to ${options.accountUrl}.`,
      `Registered this host as "${registered.host.name}" (${registered.host.platform}, ${registered.host.id}).`,
      endpoints.length === 0
        ? "No reachable endpoint was advertised — start the server on a LAN address to make this host reachable."
        : `Advertising ${endpoints.map((endpoint) => endpoint.url).join(", ")}.`,
      "",
    ].join("\n"),
  );
}

export interface RefreshHostRegistrationOptions {
  readonly baseDir: string;
  readonly client?: AccountClient;
  readonly devUrl?: URL | undefined;
  readonly appVersion?: string;
}

/**
 * Re-advertises this machine's reachable endpoints and bumps `lastSeenAt`.
 *
 * Called once per server start, best effort: a host that ran `synara auth`
 * before ever starting the server registered with no endpoints at all, and
 * nothing else would ever fix that. Failure is silent by design — the account
 * is an optional add-on and must never be able to hold up or fail a boot.
 */
export async function refreshHostRegistration(
  options: RefreshHostRegistrationOptions,
): Promise<void> {
  // The host token authenticates this call, not the user session, so an
  // expired session must not stop a running server from advertising itself.
  const credentials = await readAccountFile(options.baseDir);
  if (!credentials?.hostToken || !credentials.hostId) return;

  const client = clientFor(credentials.accountUrl, options.client);
  const endpoints = await resolveLanEndpoints(options.baseDir, options.devUrl);
  try {
    await client.updateHost(credentials.hostToken, credentials.hostId, {
      endpoints,
      appVersion: options.appVersion ?? serverPackageJson.version,
    });
  } catch {
    // Intentionally silent: no retry, no log noise on every offline start.
  }
}

/**
 * Sign-out talks to the account the credentials were minted against, never an
 * ambient one: unsetting `SYNARA_ACCOUNT_URL` after signing in must not strand
 * a user with credentials they cannot revoke.
 */
export interface LogoutOptions {
  readonly baseDir: string;
  readonly client?: AccountClient;
  readonly stdout?: Stdout;
}

export async function runAuthLogout(options: LogoutOptions): Promise<void> {
  const stdout = options.stdout ?? defaultStdout;
  // Deliberately the raw file, not a live session: a user whose session
  // expired still has a host registration to tear down and a file to delete.
  const credentials = await readAccountFile(options.baseDir);
  if (!credentials) {
    stdout("Not signed in — nothing to do.\n");
    return;
  }

  // Every remote call here is best effort: local credentials must be dropped
  // even when the account server is unreachable, otherwise a user with a dead
  // network can never sign out.
  const client = clientFor(credentials.accountUrl, options.client);

  if (credentials.hostToken && credentials.hostId) {
    try {
      await client.deleteHost(credentials.hostToken, credentials.hostId);
      stdout(`Removed host ${credentials.hostId} from the account.\n`);
    } catch (error) {
      stdout(`Could not remove host ${credentials.hostId}: ${describeError(error)}\n`);
    }
  }

  // The account service no longer brokers session listing or revocation —
  // WorkOS owns sessions, and the access token is short-lived. Dropping the
  // local credentials is what sign-out means here.
  await deleteAccountCredentials(options.baseDir);
  stdout(
    `Signed out of ${credentials.accountUrl}. Local credentials deleted.\nThe browser session at the identity provider expires on its own.\n`,
  );
}

export interface StatusOptions {
  readonly accountUrl?: string | undefined;
  readonly baseDir: string;
  readonly client?: AccountClient;
  readonly stdout?: Stdout;
  readonly devUrl?: URL | undefined;
}

function formatEndpoints(host: AccountHost): string {
  return host.endpoints.length === 0
    ? "—"
    : host.endpoints.map((endpoint) => `${endpoint.url} (${endpoint.transport})`).join(", ");
}

function renderHostTable(hosts: readonly AccountHost[], thisHostId: string | undefined): string {
  const header = ["", "NAME", "PLATFORM", "KIND", "ENDPOINTS", "LAST SEEN"];
  const rows = hosts.map((host) => [
    host.id === thisHostId ? "*" : "",
    host.name,
    host.platform,
    host.kind,
    formatEndpoints(host),
    host.lastSeenAt,
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const renderRow = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [renderRow(header), ...rows.map(renderRow)].join("\n");
}

export async function runStatus(options: StatusOptions): Promise<void> {
  const stdout = options.stdout ?? defaultStdout;
  if (!options.accountUrl) {
    stdout(
      `Account features are not configured — set ${ACCOUNT_URL_ENV_NAME} (or pass --account-url) to point at a Synara account server.\n`,
    );
    return;
  }

  const credentials = await readAccountCredentials(options.baseDir);
  if (!credentials) {
    stdout(`Not signed in to ${options.accountUrl} — run \`synara auth\`.\n`);
    return;
  }

  const client = clientFor(credentials.accountUrl, options.client);
  const withToken = <A>(fn: (accessToken: string) => Promise<A>) =>
    withFreshAccessToken({ baseDir: options.baseDir, client }, fn);

  let me;
  try {
    me = await withToken((accessToken) => client.me(accessToken));
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      stdout(`${SESSION_EXPIRED_MESSAGE}\n`);
      return;
    }
    // Only a rejected token is worth telling the user to sign in again for;
    // an unreachable server would make that advice actively wrong.
    const rejected =
      error instanceof AccountApiError && (error.status === 401 || error.status === 403);
    stdout(
      rejected
        ? `Signed in to ${credentials.accountUrl}, but the account rejected the stored token: ${describeError(error)}\nRun \`synara auth logout\` then \`synara auth\` to sign in again.\n`
        : `Signed in to ${credentials.accountUrl}, but could not reach the account: ${describeError(error)}\n`,
    );
    return;
  }

  stdout(`Account:  ${credentials.accountUrl}\nSigned in: ${me.name} <${me.email}>\n`);

  let hosts: readonly AccountHost[];
  try {
    hosts = (await withToken((accessToken) => client.listHosts(accessToken))).hosts;
  } catch (error) {
    stdout(`Could not list hosts: ${describeError(error)}\n`);
    return;
  }

  const thisHost = credentials.hostId
    ? hosts.find((host) => host.id === credentials.hostId)
    : undefined;
  stdout(
    thisHost
      ? `This host: ${thisHost.name} (${thisHost.platform}, ${thisHost.kind}) — ${formatEndpoints(thisHost)}\n`
      : "This host: not registered — run `synara auth logout` then `synara auth` to register it.\n",
  );

  stdout(
    hosts.length === 0
      ? "\nNo hosts registered on this account.\n"
      : `\nHosts (${hosts.length}):\n${renderHostTable(hosts, credentials.hostId)}\n`,
  );
}
