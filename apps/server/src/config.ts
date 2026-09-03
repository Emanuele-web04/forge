/**
 * ServerConfig - Runtime configuration services.
 *
 * Defines process-level server configuration and networking helpers used by
 * startup and runtime layers.
 *
 * @module ServerConfig
 */
import { Effect, FileSystem, Layer, Path, ServiceMap } from "effect";
import { existsSync } from "node:fs";
import OS from "node:os";
import path from "node:path";
import pathPosix from "node:path/posix";
import pathWin32 from "node:path/win32";

import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
  repairPrivateTreeSync,
} from "./privatePathPermissions";
import { realpathNearestExisting } from "./realpathNearestExisting";
import { isLoopbackHost } from "./startupAccess";

export const DEFAULT_PORT = 3773;
export const PRIVATE_STATE_REPAIR_MARKER = ".permissions-v1";

export type RuntimeMode = "web" | "desktop";

export function normalizeHttpsPublicOrigin(publicUrl: URL): URL | null {
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.username !== "" ||
    publicUrl.password !== "" ||
    publicUrl.pathname !== "/" ||
    publicUrl.search !== "" ||
    publicUrl.hash !== ""
  ) {
    return null;
  }
  return new URL(publicUrl.origin);
}

export function remoteAccessPolicyError(
  config: Pick<
    ServerConfigShape,
    "host" | "authToken" | "devUrl" | "publicUrl" | "allowInsecureRemote"
  >,
): string | null {
  const isRemoteBind = !isLoopbackHost(config.host);
  if (config.publicUrl && !normalizeHttpsPublicOrigin(config.publicUrl)) {
    return "SYNARA_PUBLIC_URL/--public-url must be an HTTPS root origin without credentials, path, query, or fragment (for example https://synara.example.com).";
  }
  const isPubliclyExposed = isRemoteBind || Boolean(config.publicUrl);
  if (!isPubliclyExposed) return null;
  if (!config.authToken?.trim()) {
    return config.publicUrl
      ? "Refusing to publish Synara through SYNARA_PUBLIC_URL/--public-url without SYNARA_AUTH_TOKEN/--auth-token."
      : `Refusing to bind Synara to non-loopback host ${config.host ?? "<unspecified>"} without SYNARA_AUTH_TOKEN/--auth-token.`;
  }
  if (config.devUrl) {
    return "Remote server binds cannot be combined with VITE_DEV_SERVER_URL/--dev-url yet; use a loopback host for development or run the built web UI for remote access.";
  }
  if (isRemoteBind && !config.publicUrl && !config.allowInsecureRemote) {
    return "Refusing plaintext remote access. Configure an HTTPS reverse-proxy origin with SYNARA_PUBLIC_URL/--public-url, or explicitly accept unencrypted LAN traffic with SYNARA_ALLOW_INSECURE_REMOTE/--allow-insecure-remote.";
  }
  return null;
}

/**
 * ServerDerivedPaths - Derived paths from the base directory.
 */
export interface ServerDerivedPaths {
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly dbPath: string;
  readonly settingsPath: string;
  readonly keybindingsConfigPath: string;
  readonly worktreesDir: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly serverLogPath: string;
  readonly serverRuntimeStatePath: string;
  readonly quitResumeStatePath: string;
  readonly providerLogsDir: string;
  readonly providerEventLogPath: string;
  readonly terminalLogsDir: string;
  readonly environmentIdPath: string;
}

/**
 * ServerConfigShape - Process/runtime configuration required by the server.
 */
export interface ServerConfigShape extends ServerDerivedPaths {
  readonly mode: RuntimeMode;
  readonly port: number;
  readonly host: string | undefined;
  readonly cwd: string;
  readonly homeDir: string;
  readonly chatWorkspaceRoot: string;
  readonly studioWorkspaceRoot: string;
  readonly baseDir: string;
  readonly staticDir: string | undefined;
  readonly devUrl: URL | undefined;
  readonly publicUrl: URL | undefined;
  readonly allowInsecureRemote: boolean;
  readonly noBrowser: boolean;
  readonly authToken: string | undefined;
  readonly desktopShutdownToken?: string | undefined;
  readonly migrationDivergenceConsent?: string | undefined;
  readonly autoBootstrapProjectFromCwd: boolean;
  readonly logProviderEvents: boolean;
  readonly logWebSocketEvents: boolean;
}

export function preparePrivateServerPaths(
  paths: ServerDerivedPaths,
  platform: NodeJS.Platform = process.platform,
): void {
  for (const directoryPath of [
    paths.stateDir,
    paths.secretsDir,
    paths.attachmentsDir,
    paths.logsDir,
    paths.providerLogsDir,
    paths.terminalLogsDir,
  ]) {
    ensurePrivateDirectorySync(directoryPath, platform);
  }
  const repairMarkerPath = path.join(paths.stateDir, PRIVATE_STATE_REPAIR_MARKER);
  if (!existsSync(repairMarkerPath)) {
    repairPrivateTreeSync(paths.stateDir, platform);
  }
  // Create or repair the main database before any SQLite client can open it.
  // SQLite sidecars are created inside this 0700 state directory, which is the
  // portable privacy boundary while SQLite owns their creation; POSIX startup
  // repair additionally narrows existing regular files to 0600.
  ensurePrivateFileSync(paths.dbPath, { platform });
  ensurePrivateFileSync(repairMarkerPath, { platform });
}

export const deriveServerPaths = Effect.fn(function* (
  baseDir: ServerConfigShape["baseDir"],
  devUrl: ServerConfigShape["devUrl"],
): Effect.fn.Return<ServerDerivedPaths, never, Path.Path> {
  const { join } = yield* Path.Path;
  const stateDir = join(baseDir, devUrl !== undefined ? "dev" : "userdata");
  const secretsDir = join(stateDir, "secrets");
  const dbPath = join(stateDir, "state.sqlite");
  const attachmentsDir = join(stateDir, "attachments");
  const logsDir = join(stateDir, "logs");
  const providerLogsDir = join(logsDir, "provider");
  return {
    stateDir,
    secretsDir,
    dbPath,
    settingsPath: join(stateDir, "settings.json"),
    keybindingsConfigPath: join(stateDir, "keybindings.json"),
    worktreesDir: join(baseDir, "worktrees"),
    attachmentsDir,
    logsDir,
    serverLogPath: join(logsDir, "server.log"),
    serverRuntimeStatePath: join(stateDir, "server-runtime.json"),
    quitResumeStatePath: join(stateDir, "quit-resume.json"),
    providerLogsDir,
    providerEventLogPath: join(providerLogsDir, "events.log"),
    terminalLogsDir: join(logsDir, "terminals"),
    environmentIdPath: join(stateDir, "environment-id"),
  };
});

export function resolveDefaultChatWorkspaceRoot(input: {
  readonly homeDir: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const homeDir = input.homeDir.trim();
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? pathWin32 : pathPosix;
  return pathApi.join(homeDir, "Documents", "Synara");
}

export function resolveDefaultStudioWorkspaceRoot(input: {
  readonly homeDir: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const pathApi = (input.platform ?? process.platform) === "win32" ? pathWin32 : pathPosix;
  return pathApi.join(resolveDefaultChatWorkspaceRoot(input), "Studio");
}

export interface ResolvedWorkspaceRoots {
  readonly homeDir: string;
  readonly chatWorkspaceRoot: string;
  readonly studioWorkspaceRoot: string;
}

/**
 * resolveCanonicalWorkspaceRoots - Derives homeDir/chatWorkspaceRoot/studioWorkspaceRoot
 * and canonicalizes each via {@link realpathNearestExisting}.
 *
 * Project rows store REALPATH-canonicalized workspace roots (see
 * `canonicalizeProjectWorkspaceRoot` in wsRpc.ts), so the roots the server
 * reports in config/welcome payloads must be canonicalized the same way.
 * Otherwise a symlinked chat/Studio ancestor (e.g. a symlinked `~/Documents`)
 * makes client-side classifiers mis-detect which container a thread belongs
 * to. The Studio root in particular may not exist yet (it's created lazily),
 * so canonicalization walks up to the nearest existing ancestor and
 * re-appends the not-yet-created remainder.
 */
export const resolveCanonicalWorkspaceRoots = Effect.fn(function* (input: {
  readonly homeDir: string;
  readonly platform?: NodeJS.Platform;
}): Effect.fn.Return<ResolvedWorkspaceRoots, never, FileSystem.FileSystem | Path.Path> {
  const platform = input.platform ?? process.platform;
  const homeDir = yield* realpathNearestExisting(input.homeDir);
  const chatWorkspaceRoot = yield* realpathNearestExisting(
    resolveDefaultChatWorkspaceRoot({ homeDir, platform }),
  );
  const studioWorkspaceRoot = yield* realpathNearestExisting(
    resolveDefaultStudioWorkspaceRoot({ homeDir, platform }),
  );
  return { homeDir, chatWorkspaceRoot, studioWorkspaceRoot };
});

/**
 * ServerConfig - Service tag for server runtime configuration.
 */
export class ServerConfig extends ServiceMap.Service<ServerConfig, ServerConfigShape>()(
  "synara/config/ServerConfig",
) {
  static readonly layerTest = (cwd: string, baseDirOrPrefix: string | { prefix: string }) =>
    Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const devUrl = undefined;

        const fs = yield* FileSystem.FileSystem;
        const baseDir =
          typeof baseDirOrPrefix === "string" && path.resolve(baseDirOrPrefix) !== path.resolve(cwd)
            ? baseDirOrPrefix
            : yield* fs.makeTempDirectoryScoped({
                prefix:
                  typeof baseDirOrPrefix === "string"
                    ? "synara-server-config-test-"
                    : baseDirOrPrefix.prefix,
              });
        const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);

        yield* Effect.sync(() => preparePrivateServerPaths(derivedPaths));

        const { homeDir, chatWorkspaceRoot, studioWorkspaceRoot } =
          yield* resolveCanonicalWorkspaceRoots({ homeDir: OS.homedir() });

        return {
          cwd,
          homeDir,
          chatWorkspaceRoot,
          studioWorkspaceRoot,
          baseDir,
          ...derivedPaths,
          mode: "web",
          autoBootstrapProjectFromCwd: false,
          logProviderEvents: false,
          logWebSocketEvents: false,
          port: 0,
          host: undefined,
          authToken: undefined,
          desktopShutdownToken: undefined,
          migrationDivergenceConsent: undefined,
          staticDir: undefined,
          devUrl,
          publicUrl: undefined,
          allowInsecureRemote: false,
          noBrowser: false,
        } satisfies ServerConfigShape;
      }),
    );
}

export const resolveStaticDir = Effect.fn(function* () {
  const { join, resolve } = yield* Path.Path;
  const { exists } = yield* FileSystem.FileSystem;

  // The desktop shell passes a real-disk snapshot of the bundled client so static
  // serving survives app.asar being replaced beneath the running app (a stale
  // in-process asar header otherwise serves bytes from the wrong offsets).
  // Honored only when it actually contains the client, so a stale or bogus env
  // value degrades to the normal lookup instead of breaking serving.
  const snapshotDir = process.env.SYNARA_STATIC_DIR?.trim();
  if (snapshotDir) {
    const snapshotClient = resolve(snapshotDir);
    const snapshotStat = yield* exists(join(snapshotClient, "index.html")).pipe(
      Effect.orElseSucceed(() => false),
    );
    if (snapshotStat) {
      return snapshotClient;
    }
  }

  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const bundledStat = yield* exists(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (bundledStat) {
    return bundledClient;
  }

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const monorepoStat = yield* exists(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (monorepoStat) {
    return monorepoClient;
  }
  return undefined;
});
