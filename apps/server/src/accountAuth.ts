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

export interface AccountCredentials {
  readonly accountUrl: string;
  readonly deviceToken: string;
  readonly hostToken?: string;
  readonly hostId?: string;
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
 * Reads stored credentials. A missing, unreadable, or malformed file is
 * reported as "not signed in" rather than an error: the CLI must always be
 * able to recover by running `synara auth` again.
 */
export async function readAccountCredentials(
  baseDir: string,
): Promise<AccountCredentials | undefined> {
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
    if (typeof record.accountUrl !== "string" || typeof record.deviceToken !== "string") {
      return undefined;
    }
    return {
      accountUrl: record.accountUrl,
      deviceToken: record.deviceToken,
      ...(typeof record.hostToken === "string" ? { hostToken: record.hostToken } : {}),
      ...(typeof record.hostId === "string" ? { hostId: record.hostId } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function writeAccountCredentials(
  baseDir: string,
  credentials: AccountCredentials,
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
  });

  await writeAccountCredentials(options.baseDir, {
    accountUrl: options.accountUrl,
    deviceToken: token.accessToken,
  });

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
    accountUrl: options.accountUrl,
    deviceToken: token.accessToken,
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

export async function runAuthLogout(options: AccountFlowOptions): Promise<void> {
  const stdout = options.stdout ?? defaultStdout;
  const credentials = await readAccountCredentials(options.baseDir);
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

  try {
    const { sessions } = await client.listSessions(credentials.deviceToken);
    const current = sessions.find((session) => session.current);
    if (current) {
      await client.deleteSession(credentials.deviceToken, current.id);
      stdout("Revoked this device's session.\n");
    }
  } catch (error) {
    stdout(`Could not revoke this device's session: ${describeError(error)}\n`);
  }

  await deleteAccountCredentials(options.baseDir);
  stdout(`Signed out of ${credentials.accountUrl}. Local credentials deleted.\n`);
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

  let me;
  try {
    me = await client.me(credentials.deviceToken);
  } catch (error) {
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
    hosts = (await client.listHosts(credentials.deviceToken)).hosts;
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
