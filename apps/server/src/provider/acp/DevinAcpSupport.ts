/**
 * Devin ACP support - builds the Devin CLI stdio command and resolves auth.
 *
 * Devin speaks the Agent Client Protocol over stdio via `devin acp`, launched
 * by an ACP-aware host as a subprocess. Credentials come from WINDSURF_API_KEY
 * when set, otherwise from the API key stored by `devin auth login`.
 *
 * @module DevinAcpSupport
 */
import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import { type ProviderListCommandsResult, type RuntimeMode } from "@synara/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export interface DevinAcpRuntimeSettings {
  readonly binaryPath?: string;
  readonly model?: string;
}

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeSettings | null | undefined;
  readonly runtimeMode: RuntimeMode;
}

export interface DevinAcpModelSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

const DEVIN_API_KEY_AUTH_METHOD_IDS = new Set([
  "windsurf-api-key",
  "windsurf.api_key",
  "devin.api_key",
  "api_key",
]);
const DEVIN_PRIMARY_API_KEY_AUTH_METHOD_ID = "windsurf-api-key";
const DEVIN_CACHED_TOKEN_AUTH_METHOD_ID = "cached_token";
const DEVIN_INTERACTIVE_AUTH_METHOD_IDS = new Set([
  "browser_login",
  "devin-browser",
  "devin.com",
  "oauth",
]);
const DEVIN_API_KEY_ENV_KEYS = ["WINDSURF_API_KEY", "DEVIN_API_KEY"] as const;
const DEVIN_API_SERVER_URL_ENV_KEYS = ["WINDSURF_API_SERVER_URL", "DEVIN_API_SERVER_URL"] as const;
const DEVIN_COMPACT_COMMAND_NAME = "compact";
const DEVIN_COMPACT_PROMPT = "/compact";

export interface DevinAcpCredentials {
  readonly apiKey?: string;
  readonly apiServerUrl?: string;
}

export interface DevinAcpAuthInput {
  readonly apiKey?: string;
}

export function mapDevinAcpCommands(
  commands: ReadonlyArray<Acp.AvailableCommand>,
): ProviderListCommandsResult["commands"] {
  return commands.map((command) => ({
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
  }));
}

export function getDevinApiKeyEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of DEVIN_API_KEY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function hasDevinApiKeyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return getDevinApiKeyEnv(env) !== undefined;
}

export function getDevinApiServerUrlEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of DEVIN_API_SERVER_URL_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseDevinTomlString(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (value.startsWith('"')) {
    const end = value.lastIndexOf('"');
    if (end <= 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(value.slice(0, end + 1));
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'")) {
    const end = value.lastIndexOf("'");
    if (end <= 0) return undefined;
    const parsed = value.slice(1, end).trim();
    return parsed || undefined;
  }
  const parsed = value.split("#", 1)[0]?.trim();
  return parsed || undefined;
}

/** Parse only the stable credential fields Devin writes to its TOML store. */
export function parseDevinCredentialsToml(raw: string): DevinAcpCredentials | undefined {
  let apiKey: string | undefined;
  let apiServerUrl: string | undefined;

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(windsurf_api_key|api_server_url)\s*=\s*(.+)$/u);
    if (!match) continue;
    const value = parseDevinTomlString(match[2] ?? "");
    if (!value) continue;
    if (match[1] === "windsurf_api_key") apiKey = value;
    else apiServerUrl = value;
  }

  if (!apiKey && !apiServerUrl) return undefined;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(apiServerUrl ? { apiServerUrl } : {}),
  };
}

export function resolveDevinCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData) return nodePath.join(appData, "devin", "credentials.toml");
  }
  if (!home) return undefined;
  const dataHome = env.XDG_DATA_HOME?.trim() || nodePath.join(home, ".local", "share");
  return nodePath.join(dataHome, "devin", "credentials.toml");
}

export async function readDevinStoredCredentials(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<DevinAcpCredentials | undefined> {
  const credentialsPath = resolveDevinCredentialsPath(env, platform);
  if (!credentialsPath) return undefined;
  const raw = await readFile(credentialsPath, "utf8").catch(() => undefined);
  return raw === undefined ? undefined : parseDevinCredentialsToml(raw);
}

export function buildDevinAcpAuthenticateMeta(
  input: {
    readonly credentials?: DevinAcpCredentials;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Record<string, unknown> {
  const env = input.env ?? process.env;
  const apiKey = getDevinApiKeyEnv(env) ?? input.credentials?.apiKey;
  const apiServerUrl = getDevinApiServerUrlEnv(env) ?? input.credentials?.apiServerUrl;
  return {
    headless: true,
    ...(apiKey ? { api_key: apiKey } : {}),
    ...(apiServerUrl ? { api_server_url: apiServerUrl } : {}),
  };
}

export function runDevinAcpCompactionCommand(
  runtime: Pick<AcpSessionRuntimeShape, "getAvailableCommands" | "prompt">,
): Effect.Effect<Acp.PromptResponse, AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const commands = yield* runtime.getAvailableCommands;
    const compactAvailable = commands.some(
      (command) => command.name.trim().toLowerCase() === DEVIN_COMPACT_COMMAND_NAME,
    );

    // Devin advertises its slash commands over ACP. Reject a definitive
    // non-support signal, but keep the direct prompt path when the list is
    // empty so older builds keep working.
    if (commands.length > 0 && !compactAvailable) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32601,
        errorMessage:
          "This Devin CLI does not advertise the /compact command. Update Devin and restart the session.",
      });
    }

    return yield* runtime.prompt({
      prompt: [{ type: "text", text: DEVIN_COMPACT_PROMPT }],
      _meta: { mode: "agent" },
    });
  });
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeSettings | null | undefined,
  cwd: string,
  runtimeMode: RuntimeMode,
): AcpSpawnInput {
  // Devin's permission prompts surface through ACP request_permission events;
  // the session itself needs no permission-mode flag to keep that flow intact.
  void runtimeMode;
  const args = ["acp"];
  const model = devinSettings?.model?.trim();
  if (model) {
    args.push("--model", model);
  }

  return {
    command: devinSettings?.binaryPath || "devin",
    args,
    cwd,
    env: buildProviderChildEnvironment({ provider: "devin" }),
  };
}

function availableAuthMethodIds(initializeResult: Acp.InitializeResponse): ReadonlySet<string> {
  return new Set(
    (initializeResult.authMethods ?? [])
      .map((method) => method.id.trim())
      .filter((methodId) => methodId.length > 0),
  );
}

function describeAuthMethodIds(authMethodIds: ReadonlySet<string>): string {
  return authMethodIds.size > 0 ? [...authMethodIds].join(", ") : "none";
}

export const resolveDevinAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
  input: DevinAcpAuthInput = {},
): Effect.Effect<string, AcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    const hasApiKey = (input.apiKey?.trim() || getDevinApiKeyEnv()) !== undefined;
    if (hasApiKey) {
      const apiKeyMethod = [...authMethodIds].find((methodId) =>
        DEVIN_API_KEY_AUTH_METHOD_IDS.has(methodId),
      );
      if (apiKeyMethod) {
        return apiKeyMethod;
      }
      // Devin 3000.3.x advertises only `devin-browser` even when the ACP host
      // supplies a valid API key. The CLI still accepts the canonical
      // `windsurf-api-key` method with `_meta.api_key`, so keep auth headless.
      if (authMethodIds.has("devin-browser")) {
        return DEVIN_PRIMARY_API_KEY_AUTH_METHOD_ID;
      }
    }
    if (authMethodIds.has(DEVIN_CACHED_TOKEN_AUTH_METHOD_ID)) {
      return DEVIN_CACHED_TOKEN_AUTH_METHOD_ID;
    }
    // Devin also accepts `devin auth login` stored credentials. Prefer any
    // advertised non-interactive method before giving up.
    const nonInteractive = [...authMethodIds].find(
      (methodId) => !DEVIN_INTERACTIVE_AUTH_METHOD_IDS.has(methodId),
    );
    if (nonInteractive) {
      return nonInteractive;
    }
    const advertised = describeAuthMethodIds(authMethodIds);
    if (!hasApiKey && authMethodIds.size > 0) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Devin ACP advertised only interactive auth (${advertised}). Synara will not open a browser during a message send. Set WINDSURF_API_KEY or log in with Devin CLI so its saved API key is available, then retry.`,
        data: { authMethods: [...authMethodIds], reason: "credentials_missing" },
      });
    }
    return yield* new AcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: `Devin ACP advertised no supported headless authentication method (advertised: ${advertised}). Synara supports API-key and cached-token auth; update Devin and retry.`,
      data: { authMethods: [...authMethodIds], reason: "compatibility_mismatch" },
    });
  });

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const storedCredentials = yield* Effect.tryPromise(() => readDevinStoredCredentials()).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const authenticateMeta = buildDevinAcpAuthenticateMeta({ credentials: storedCredentials });
    const apiKey = authenticateMeta.api_key;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.runtimeMode),
        resolveAuthMethodId: (initializeResult) =>
          resolveDevinAcpAuthMethodId(initializeResult, {
            ...(typeof apiKey === "string" ? { apiKey } : {}),
          }),
        authenticateMeta,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "setConfigOption" | "setModel"
  >;
  readonly model: string;
  readonly options?: { readonly fastMode?: boolean } | null | undefined;
  readonly mapError: (context: DevinAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  void input;
  // Model selection is a process-start flag (`devin acp --model`); Devin does
  // not implement `session/set_config_option` for models. The flag is supplied
  // by `buildDevinAcpSpawnInput`.
  return Effect.void;
}
