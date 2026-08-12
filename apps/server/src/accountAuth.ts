/**
 * accountAuth - the credential file, token refresh, host linking, and the
 * `synara auth` (host link) / `synara status` CLI flows. Sign-in itself is
 * app-only.
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
  type OrganizationSummary,
} from "@synara/contracts";
import {
  AccountApiError,
  ACCOUNT_URL_ENV_NAME,
  createAccountClient,
  OrganizationRequiredError,
  resolveConfiguredAccountUrl,
  type AccountClient,
} from "@synara/shared/account";
import { Effect, Path } from "effect";

import { withCredentialFileLock } from "./accountCredentialLock";
import { createFileStringExclusively, writeFileStringAtomically } from "./atomicWrite";
import { deriveServerPaths } from "./config";
import { PRIVATE_FILE_MODE } from "./privatePathPermissions";
import { isLoopbackHost, isWildcardHost } from "./startupAccess";
import serverPackageJson from "../package.json" with { type: "json" };

// Re-exported so CLI wiring keeps naming the variable through the module that
// owns the auth flows; the value itself lives with the client that reads it.
export { ACCOUNT_URL_ENV_NAME };

const CREDENTIALS_FILE_NAME = "account-credentials.json";

/** What the user sees when a rotated refresh token can no longer be redeemed. */
export const SESSION_EXPIRED_MESSAGE = "Session expired — sign in again from the Synara app.";

/** What the user sees when the workspace they signed in to is no longer theirs. */
export const WORKSPACE_CHANGED_MESSAGE =
  "Your workspace access changed — sign in again from the Synara app.";

/**
 * The stored account file (v3). The user session (`accessToken`/
 * `refreshToken`/`organizationId`) and the host registration (`hostToken`/
 * `hostId`) have independent lifetimes: a WorkOS refresh token can be spent or
 * revoked while the host token this machine registered with stays valid, so
 * the two halves are optional separately and an expired session leaves the
 * host fields in place.
 *
 * `organizationId` is part of the session, not an extra: hosts belong to
 * organizations, and every refresh must name the same one or the renewed token
 * comes back unable to reach anything.
 */
export interface StoredAccountFile {
  readonly accountUrl: string;
  readonly workosClientId: string;
  readonly workosApiUrl: string;
  readonly organizationId?: string;
  /**
   * The signed-in user's id, recorded so machine-local state keyed to the
   * session (the usage reporter's watermark identity) can tell two users of
   * the same workspace apart. Optional: files written before it existed lack
   * it, and the next sign-in or token rotation backfills it.
   */
  readonly userId?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly hostToken?: string;
  readonly hostId?: string;
}

/** A {@link StoredAccountFile} that carries a usable user session. */
export interface AccountCredentials extends StoredAccountFile {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly organizationId: string;
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
      ...(typeof record.organizationId === "string"
        ? { organizationId: record.organizationId }
        : {}),
      ...(typeof record.userId === "string" ? { userId: record.userId } : {}),
      ...(typeof record.accessToken === "string" ? { accessToken: record.accessToken } : {}),
      ...(typeof record.refreshToken === "string" ? { refreshToken: record.refreshToken } : {}),
      ...(typeof record.hostToken === "string" ? { hostToken: record.hostToken } : {}),
      ...(typeof record.hostId === "string" ? { hostId: record.hostId } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The stored file, but only when it carries a redeemable user session.
 *
 * A v2 file — tokens but no `organizationId` — is deliberately not one. Its
 * refresh token is still live, but every renewal from it would produce an
 * org-less token the account refuses, so the user would see failures with no
 * hint that the file is the problem. Treating it as signed out sends them
 * through `synara auth`, which is the only thing that fixes it. The host
 * fields survive, exactly as they do after an ordinary session expiry.
 */
export async function readAccountCredentials(
  baseDir: string,
): Promise<AccountCredentials | undefined> {
  const stored = await readAccountFile(baseDir);
  if (!stored?.accessToken || !stored.refreshToken || !stored.organizationId) return undefined;
  return {
    ...stored,
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    organizationId: stored.organizationId,
  };
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

/** Deletes the credentials file, reporting whether there was one to delete. */
async function deleteAccountCredentialsIfPresent(baseDir: string): Promise<boolean> {
  try {
    await fs.rm(accountCredentialsPath(baseDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * The account service the CLI was pointed at, or `undefined` when it was
 * pointed at none. The CLI deliberately does not fall back to
 * `DEFAULT_ACCOUNT_URL`: `synara status` must be able to say "account features
 * are not configured" rather than report on a hosted service the operator
 * never opted into. The in-app flow, which the user reaches by clicking sign
 * in, does take the default.
 */
export function resolveAccountUrl(input: {
  readonly flag?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): string | undefined {
  return resolveConfiguredAccountUrl(input);
}

/**
 * Resolves the environment id the server persists at
 * `<stateDir>/environment-id`, generating and persisting it in the same format
 * when the server has never started. Registering a host under a different id
 * would leave the account with a phantom host once the server does start.
 *
 * Creation is exclusive, not last-writer-wins: `synara auth` and a starting
 * server can both find the file missing and generate different UUIDs, and the
 * loser of a plain overwrite would register a host under an id nobody
 * persisted. Whoever creates the file first wins; everyone else reads the
 * winner's id back.
 */
export async function resolveEnvironmentId(
  baseDir: string,
  devUrl?: URL | undefined,
): Promise<string> {
  const { environmentIdPath } = await runWithPath(deriveServerPaths(baseDir, devUrl));
  const readPersisted = async (): Promise<string | undefined> => {
    try {
      const persisted = (await fs.readFile(environmentIdPath, "utf8")).trim();
      return persisted.length > 0 ? persisted : undefined;
    } catch {
      return undefined;
    }
  };

  const persisted = await readPersisted();
  if (persisted !== undefined) return persisted;

  const generated = randomUUID();
  const created = await Effect.runPromise(
    createFileStringExclusively({ filePath: environmentIdPath, contents: `${generated}\n` }),
  );
  if (created) return generated;
  // Lost the creation race: the other writer's id is the persisted identity.
  const winner = await readPersisted();
  if (winner !== undefined) return winner;
  // The file exists but is empty/unreadable — a truncated write from a
  // crashed process. Fail loudly rather than mint an unpersisted id.
  throw new Error(`Environment id file at ${environmentIdPath} exists but holds no id`);
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

/**
 * Thrown when the account stops accepting the workspace this machine signed in
 * to — the membership was revoked, or the organization was removed. The stored
 * refresh token may well still be good, so this is not an expiry; what is
 * stale is the organization choice, and only a fresh `synara auth` can make a
 * new one.
 */
export class WorkspaceAccessChangedError extends Error {
  constructor() {
    super(WORKSPACE_CHANGED_MESSAGE);
    this.name = "WorkspaceAccessChangedError";
  }
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof AccountApiError && (error.status === 401 || error.status === 403);
}

/**
 * Statuses that are 4xx by number but transient by meaning. WorkOS answers 408
 * when it gave up waiting and 429 when it wants the caller to slow down —
 * neither says anything about whether the refresh token is still redeemable, so
 * treating them as a refusal would sign a user out over a rate limit.
 */
const TRANSIENT_GRANT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/**
 * Whether a refresh failure says nothing about the token — a transient 4xx
 * (408/429), any 5xx, or a network error (no AccountApiError at all). Worth
 * one bounded retry with the SAME token: the provider only rotates on
 * success, so re-presenting it is safe.
 */
function isTransientRefreshFailure(error: unknown): boolean {
  if (!(error instanceof AccountApiError)) return true;
  return TRANSIENT_GRANT_STATUSES.has(error.status) || error.status >= 500;
}

/** Bounded backoff between refresh retries; injectable clock not needed — one step. */
const REFRESH_RETRY_DELAY_MS = 1_000;
const REFRESH_ATTEMPTS = 2;

/**
 * Whether the identity provider actually refused the grant, as opposed to
 * failing to answer. Only a terminal 4xx means the stored refresh token is
 * genuinely spent; a 5xx, a timeout, a rate limit, or a DNS failure says
 * nothing about it.
 */
function isGrantRejected(error: unknown): boolean {
  return (
    error instanceof AccountApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    !TRANSIENT_GRANT_STATUSES.has(error.status)
  );
}

export interface WithFreshAccessTokenOptions {
  readonly baseDir: string;
  readonly client: AccountClient;
  /** Delay before the one transient-refresh retry; injectable for tests. */
  readonly refreshRetryDelayMs?: number;
}

/** Strips the session half of a stored file, keeping the host registration. */
function withoutSession(credentials: StoredAccountFile): StoredAccountFile {
  const {
    accessToken: _accessToken,
    refreshToken: _refreshToken,
    organizationId: _organizationId,
    userId: _userId,
    ...rest
  } = credentials;
  return rest;
}

/**
 * Runs `fn` under the credential-file lock (see accountCredentialLock.ts).
 * Every read-modify-write of the stored file goes through here so concurrent
 * operations — this process's or another's — cannot interleave between the
 * read and the write.
 */
export function withLockedAccountFile<A>(baseDir: string, fn: () => Promise<A>): Promise<A> {
  return withCredentialFileLock(accountCredentialsPath(baseDir), fn);
}

/**
 * Drops the session half of the stored file, keeping the host registration —
 * but only if the on-disk refresh token is still `consumedRefreshToken`.
 *
 * The compare-and-swap is what makes a concurrent rotation safe: a caller
 * that decided "this session is dead" from a stale snapshot must not clear
 * the fresh pair another caller has stored since. If the token on disk has
 * moved on, the clear is silently skipped — the on-disk session is not the
 * one that was rejected.
 *
 * The registration is kept because it is still real, and keeping it lets a
 * later `synara auth` re-link this machine instead of stranding a phantom
 * host on the account. The organization goes with the session: it was chosen
 * for that sign-in, and carrying it into the next one would silently re-pick
 * a workspace the user may no longer have.
 */
async function clearStoredSessionIfCurrent(
  baseDir: string,
  consumedRefreshToken: string,
): Promise<void> {
  await withLockedAccountFile(baseDir, async () => {
    const current = await readAccountFile(baseDir);
    if (!current || current.refreshToken !== consumedRefreshToken) return;
    await writeAccountCredentials(baseDir, withoutSession(current));
  });
}

/** What renewing the session produced: a usable token, or a dead session. */
type SessionRenewal = { kind: "renewed"; accessToken: string } | { kind: "expired" };

/**
 * The refresh grant with one bounded retry on a transient failure. Refresh
 * is safe to re-attempt with the same token — the provider only rotates on
 * success — and a single retry absorbs the blip (a timed-out attempt, a
 * rate-limit tick, a 5xx) that would otherwise fail a user's command while
 * their session was perfectly renewable.
 */
async function refreshWithBoundedRetry(
  client: AccountClient,
  request: { refreshToken: string; organizationId: string },
  retryDelayMs: number,
): ReturnType<AccountClient["refreshAccessToken"]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.refreshAccessToken(request);
    } catch (error) {
      if (attempt >= REFRESH_ATTEMPTS || !isTransientRefreshFailure(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

/**
 * Renews the stored session after `consumed` was rejected, serialized under
 * the credential-file lock and committed compare-and-swap.
 *
 * Inside the lock the file is re-read first: if the refresh token on disk no
 * longer equals the one this caller consumed, another caller already
 * refreshed — the loser of that race must use the winner's stored pair, not
 * spend a token of its own (WorkOS refresh tokens are single-use, so a
 * second redemption would be refused and, without this check, would clear
 * the winner's perfectly valid session).
 *
 * The rotated pair is persisted while still inside the lock and *before* the
 * caller retries: if the process died between redeeming a token and writing
 * the replacement, the stored token would already be spent and the user
 * silently signed out with no way to tell why. The write merges into the
 * re-read file, not the caller's snapshot, so host fields stored concurrently
 * survive.
 */
async function renewSession(
  baseDir: string,
  client: AccountClient,
  consumed: AccountCredentials,
  retryDelayMs: number,
): Promise<SessionRenewal> {
  return withLockedAccountFile(baseDir, async (): Promise<SessionRenewal> => {
    const current = await readAccountFile(baseDir);
    // Signed out (or the file vanished) while this caller was in flight:
    // there is no session left to renew.
    if (!current?.refreshToken || !current.organizationId) return { kind: "expired" };
    // Someone else rotated first — their stored pair is the live one.
    if (current.refreshToken !== consumed.refreshToken) {
      return current.accessToken
        ? { kind: "renewed", accessToken: current.accessToken }
        : { kind: "expired" };
    }

    let refreshed;
    try {
      refreshed = await refreshWithBoundedRetry(
        client,
        { refreshToken: current.refreshToken, organizationId: current.organizationId },
        retryDelayMs,
      );
    } catch (refreshError) {
      // Only a refusal proves the token is dead. On an outage or a network
      // failure the stored token is probably still good, and keeping a
      // possibly-spent token costs one failed command, where discarding a
      // possibly-valid one costs a full re-authentication.
      if (!isGrantRejected(refreshError)) throw refreshError;
      await writeAccountCredentials(baseDir, withoutSession(current));
      return { kind: "expired" };
    }

    await writeAccountCredentials(baseDir, {
      ...current,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      // Backfills files written before userId existed; on current files this
      // rewrites the same id.
      userId: refreshed.user.id,
    });
    return { kind: "renewed", accessToken: refreshed.accessToken };
  });
}

/**
 * Runs `fn` with the stored access token, renewing it once if the account
 * rejects it. WorkOS access tokens live about five minutes, so any CLI command
 * run more than a few minutes after `synara auth` needs this.
 *
 * Credentials are re-read per call rather than captured by the caller: a
 * rotation performed for one call must be visible to the next one, and the
 * spent refresh token must never be presented twice. Renewal itself runs
 * under the credential-file lock with compare-and-swap semantics — see
 * {@link renewSession} — so concurrent expired-token operations cannot
 * double-spend the single-use refresh token or clobber each other's writes.
 *
 * Renewal is driven purely by a rejected call, not by reading `exp` off the
 * JWT first. The deliberate trade is one wasted round trip per expiry against
 * having to parse and trust token internals here.
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
    // The workspace, not the token, is what the account rejected. Renewing
    // would mint another token for the same dead organization, so the retry
    // is skipped and the session dropped in favour of a fresh sign-in.
    if (error instanceof OrganizationRequiredError) {
      await clearStoredSessionIfCurrent(baseDir, credentials.refreshToken);
      throw new WorkspaceAccessChangedError();
    }
    if (!isUnauthorized(error)) throw error;

    const renewal = await renewSession(
      baseDir,
      client,
      credentials,
      options.refreshRetryDelayMs ?? REFRESH_RETRY_DELAY_MS,
    );
    if (renewal.kind === "expired") throw new SessionExpiredError();
    return await fn(renewal.accessToken);
  }
}

/**
 * Resolves which workspace to use, fail-closed. V1 is personal-org-only:
 * one organization answers itself; several are refused with a classified
 * error rather than silently taking whichever the provider listed first
 * (membership order is not a tenant-selection contract). None means the
 * account is unusable until a workspace exists.
 */
export async function selectOrganization(
  organizations: readonly OrganizationSummary[],
): Promise<OrganizationSummary> {
  const first = organizations[0];
  if (!first) {
    throw new Error(
      "Your account has no workspace to sign in to. Contact your administrator, or create one in the WorkOS dashboard.",
    );
  }
  if (organizations.length > 1) {
    throw new AccountApiError({
      code: "multiple_organizations_unsupported",
      status: 403,
      message: "Multiple workspaces aren't supported yet",
    });
  }
  return first;
}

/**
 * Registers this machine against the stored session and records the host
 * fields, leaving the session half of the file exactly as it found it.
 *
 * The credentials are re-read from disk after the call rather than merged into
 * a captured copy: `withFreshAccessToken` may have rotated and persisted a new
 * token pair on the way through, and writing a stale pair back over it would
 * spend the user's session for nothing.
 */
async function registerThisHost(
  options: AccountFlowOptions,
  client: AccountClient,
  stdout: Stdout,
): Promise<void> {
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
    registered = await withFreshAccessToken({ baseDir: options.baseDir, client }, (accessToken) =>
      client.registerHost(accessToken, {
        environmentId: EnvironmentId.makeUnsafe(environmentId),
        name,
        platform,
        kind: "local",
        endpoints,
        appVersion,
      }),
    );
  } catch (error) {
    stdout(
      `Signed in, but registering this host failed: ${describeError(error)}\nRun \`synara auth\` to try again.\n`,
    );
    return;
  }

  // Read-modify-write under the credential lock, so a concurrent session
  // rotation or sign-out cannot interleave between the read and the write.
  // The file can be gone if something removed it mid-flight (a concurrent
  // `synara auth logout`, say). The account now has a host this machine has no
  // token for, so saying "registered" would be a lie the user acts on.
  const saved = await withLockedAccountFile(options.baseDir, async () => {
    const current = await readAccountFile(options.baseDir);
    if (!current) return false;
    await writeAccountCredentials(options.baseDir, {
      ...current,
      hostToken: registered.hostToken,
      hostId: registered.host.id,
    });
    return true;
  });
  if (!saved) {
    stdout(
      `Registered this host as "${registered.host.name}" (${registered.host.id}), but the local credentials file disappeared before the host token could be saved.\nRun \`synara auth\` again; remove the stale host if it lingers.\n`,
    );
    return;
  }

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

/**
 * Which account URL `synara auth` must register the host against.
 *
 * Once a session exists, the URL persisted at sign-in wins — exactly as
 * refresh, status, and logout resolve theirs — because the stored tokens were
 * minted by THAT service and registering through any other URL would send
 * them somewhere they do not belong. An explicit `--account-url`/env value
 * that CONTRADICTS the stored one is refused loudly rather than silently
 * overridden in either direction: the user asked for a service the session
 * does not belong to, and only signing out resolves that.
 *
 * With no session stored, the explicit value (possibly `undefined`) is
 * returned unchanged — the caller keeps its configured-URL requirement.
 */
export async function resolveAuthLoginAccountUrl(options: {
  readonly baseDir: string;
  readonly explicitUrl: string | undefined;
}): Promise<string | undefined> {
  const stored = await readAccountCredentials(options.baseDir);
  if (!stored) return options.explicitUrl;
  if (options.explicitUrl !== undefined && options.explicitUrl !== stored.accountUrl) {
    throw new Error(
      `This machine is signed in to ${stored.accountUrl}, but ${options.explicitUrl} was requested. Run \`synara auth logout\` first to link against a different account service.`,
    );
  }
  return stored.accountUrl;
}

/**
 * `synara auth` — links this machine as a host using the app's signed-in
 * session. Sign-in itself is app-only (email OTP or SSO in the Synara UI);
 * the CLI and the app share the credentials file, so once the app has signed
 * in, this command has a session to register the host with.
 */
export async function runAuthLogin(options: AccountFlowOptions): Promise<void> {
  const stdout = options.stdout ?? defaultStdout;
  const existing = await readAccountCredentials(options.baseDir);
  if (!existing) {
    stdout(
      "Not signed in — sign in from the Synara app first (account menu), then run `synara auth` to link this machine.\n",
    );
    return;
  }

  if (existing.hostToken && existing.hostId) {
    stdout(
      `Already signed in to ${existing.accountUrl} and this host is registered.\nRun \`synara auth logout\` first to link as someone else.\n`,
    );
    return;
  }

  const client = clientFor(options.accountUrl, options.client);
  stdout("Signed in — completing host registration.\n");
  await registerThisHost(options, client, stdout);
}

/** A scoped session: tokens that name a workspace, which one, and whose. */
export interface ScopedSessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly organizationId: string;
  /** The signed-in user's id, persisted alongside the session. */
  readonly userId: string;
}

export interface ScopeTokenToWorkspaceOptions {
  readonly client: AccountClient;
  /**
   * Resolves the workspace from the account's list. Both callers — the CLI
   * and the in-app flow — fail closed on more than one workspace in V1
   * (personal-org-only); the seam stays injected so a future workspace
   * picker slots in without touching probing, refreshing, or how the token
   * is spent.
   */
  readonly chooseOrganization: (
    organizations: readonly OrganizationSummary[],
  ) => Promise<OrganizationSummary>;
  /** Told which workspace was chosen, once, after the scoped token is minted. */
  readonly onOrganizationChosen?: (organization: OrganizationSummary) => void;
}

/**
 * Turns an org-less token a sign-in grant returns into one scoped to a
 * workspace.
 *
 * The probe is a real `/me` call rather than an assumption: WorkOS mints
 * sign-in tokens without `org_id`, so the account answers 403 with the
 * memberships to choose from — and, on a first-ever sign-in, provisions the
 * personal workspace as a side effect of being asked. A token that already
 * carries a workspace skips the whole dance.
 */
export async function scopeTokenToWorkspace(
  token: { accessToken: string; refreshToken: string },
  options: ScopeTokenToWorkspaceOptions,
): Promise<ScopedSessionTokens> {
  const { client, chooseOrganization, onOrganizationChosen } = options;

  let organizations: readonly OrganizationSummary[];
  try {
    const me = await client.me(token.accessToken);
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      organizationId: me.organization.id,
      userId: me.id,
    };
  } catch (error) {
    if (!(error instanceof OrganizationRequiredError)) throw error;
    organizations = error.organizations;
  }

  const organization = await chooseOrganization(organizations);
  // Redeeming the refresh token here spends it, so the rotated pair this
  // returns is the only usable one — the caller must persist it, not the
  // pair it started with.
  const refreshed = await client.refreshAccessToken({
    refreshToken: token.refreshToken,
    organizationId: organization.id,
  });

  onOrganizationChosen?.(organization);
  return {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    organizationId: organization.id,
    userId: refreshed.user.id,
  };
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
 * Called once per server start, best effort: a host that was linked before
 * ever starting the server registered with no endpoints at all, and
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
    // A file that exists but does not parse as v2 is a leftover from a
    // previous version or a corrupt write. Deleting it is the whole point of
    // logout, and leaving it behind would also keep `synara auth` from ever
    // reporting a clean "Not signed in".
    const stale = await deleteAccountCredentialsIfPresent(options.baseDir);
    stdout(
      stale
        ? "Removed stale credentials from a previous version. The host record may need manual removal.\n"
        : "Not signed in — nothing to do.\n",
    );
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
    stdout(`Not signed in to ${options.accountUrl} — sign in from the Synara app.\n`);
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
    if (error instanceof WorkspaceAccessChangedError) {
      stdout(`${WORKSPACE_CHANGED_MESSAGE}\n`);
      return;
    }
    // Only a rejected token is worth telling the user to sign in again for;
    // an unreachable server would make that advice actively wrong.
    const rejected =
      error instanceof AccountApiError && (error.status === 401 || error.status === 403);
    stdout(
      rejected
        ? `Signed in to ${credentials.accountUrl}, but the account rejected the stored token: ${describeError(error)}\nRun \`synara auth logout\`, then sign in again from the Synara app.\n`
        : `Signed in to ${credentials.accountUrl}, but could not reach the account: ${describeError(error)}\n`,
    );
    return;
  }

  stdout(
    `Account:  ${credentials.accountUrl}\nSigned in: ${me.name} <${me.email}>\nWorkspace: ${me.organization.name}\n`,
  );

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
      : "This host: not registered — run `synara auth` to register it.\n",
  );

  stdout(
    hosts.length === 0
      ? "\nNo hosts registered on this account.\n"
      : `\nHosts (${hosts.length}):\n${renderHostTable(hosts, credentials.hostId)}\n`,
  );
}
