/**
 * Grok ACP support - builds the Grok Build stdio command and resolves auth.
 *
 * @module GrokAcpSupport
 */
import {
  type GrokModelOptions,
  type ProviderAccountLaunchContext,
  type RuntimeMode,
} from "@synara/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { ChildProcessSpawner } from "effect/unstable/process";

import { applyAccountEnvironmentOverrides } from "@synara/shared/providerAccounts/accountEnvironment";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export interface GrokAcpRuntimeSettings {
  readonly binaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: GrokModelOptions["reasoningEffort"];
}

export interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "freshSessionRetry" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeSettings | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly accountLaunch?: ProviderAccountLaunchContext;
}

export interface GrokAcpModelSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

const GROK_API_KEY_AUTH_METHOD_ID = "xai.api_key";
const GROK_CACHED_TOKEN_AUTH_METHOD_ID = "cached_token";
const GROK_INTERACTIVE_AUTH_METHOD_IDS = new Set(["browser_login", "grok.com"]);
const GROK_API_KEY_ENV_KEYS = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"] as const;
const GROK_COMPACT_COMMAND_NAME = "compact";
const GROK_COMPACT_PROMPT = "/compact";
const GROK_SESSION_STORAGE_NOT_FOUND_CODE = "FS_NOT_FOUND";
const GROK_SESSION_STORAGE_RETRY_DELAY_MS = 100;

export function isGrokSessionStoragePathNotFoundError(error: AcpErrors.AcpError): boolean {
  if (error._tag !== "AcpRequestError" || typeof error.data !== "object" || error.data === null) {
    return false;
  }
  return (error.data as { readonly code?: unknown }).code === GROK_SESSION_STORAGE_NOT_FOUND_CODE;
}

export function getGrokApiKeyEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of GROK_API_KEY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function hasGrokApiKeyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return getGrokApiKeyEnv(env) !== undefined;
}

export function runGrokAcpCompactionCommand(
  runtime: Pick<AcpSessionRuntimeShape, "getAvailableCommands" | "prompt">,
): Effect.Effect<Acp.PromptResponse, AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const commands = yield* runtime.getAvailableCommands;
    const compactAvailable = commands.some(
      (command) => command.name.trim().toLowerCase() === GROK_COMPACT_COMMAND_NAME,
    );

    // Older Grok ACP releases did not advertise commands reliably. Preserve
    // their working /compact path when the list is empty, but reject a
    // definitive non-support signal with an actionable error.
    if (commands.length > 0 && !compactAvailable) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32601,
        errorMessage:
          "This Grok CLI does not advertise the /compact command. Update Grok and restart the session.",
      });
    }

    // Maintenance commands must not inherit a native Plan-mode tracker left
    // behind by an earlier turn. Grok uses this metadata to reconcile its
    // interaction mode; the normal default-mode prompt path does the same.
    return yield* runtime.prompt({
      prompt: [{ type: "text", text: GROK_COMPACT_PROMPT }],
      _meta: { mode: "agent" },
    });
  });
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeSettings | null | undefined,
  cwd: string,
  runtimeMode: RuntimeMode,
  accountLaunch?: ProviderAccountLaunchContext,
): AcpSpawnInput {
  // Keep Grok's request-based mode as the explicit baseline. Full Access also
  // needs the process-scoped override because some Grok builds deny before
  // emitting an ACP permission request. Runtime-mode changes restart the Grok
  // process, while native Plan mode plus Synara's pre-tool hook still gate
  // writes on Plan turns.
  const args = ["--permission-mode", "default", "agent", "--no-leader"];
  if (runtimeMode === "full-access") {
    args.push("--always-approve");
  }
  const model = grokSettings?.model?.trim();
  if (model) {
    args.push("-m", model);
  }
  const reasoningEffort = grokSettings?.reasoningEffort?.trim();
  if (reasoningEffort) {
    args.push("--reasoning-effort", reasoningEffort);
  }
  args.push("stdio");

  const env = buildProviderChildEnvironment({ provider: "grok" });
  if (accountLaunch !== undefined) {
    // Applied last so managed-account auth (GROK_HOME, XAI_API_KEY) always
    // beats inherited env.
    applyAccountEnvironmentOverrides(env, accountLaunch.environment);
  }

  return {
    command: grokSettings?.binaryPath || "grok",
    args,
    cwd,
    env,
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

export const resolveGrokAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<string, AcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    const hasApiKey = hasGrokApiKeyEnv(env);
    if (hasApiKey && authMethodIds.has(GROK_API_KEY_AUTH_METHOD_ID)) {
      return GROK_API_KEY_AUTH_METHOD_ID;
    }
    if (authMethodIds.has(GROK_CACHED_TOKEN_AUTH_METHOD_ID)) {
      return GROK_CACHED_TOKEN_AUTH_METHOD_ID;
    }
    const advertised = describeAuthMethodIds(authMethodIds);
    if (!hasApiKey && authMethodIds.has(GROK_API_KEY_AUTH_METHOD_ID)) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage:
          "Grok ACP requires API-key authentication, but XAI_API_KEY is not set. Set XAI_API_KEY and restart Synara, or run `grok login` to create a cached login.",
        data: { authMethods: [...authMethodIds], reason: "credentials_missing" },
      });
    }
    if (
      !hasApiKey &&
      authMethodIds.size > 0 &&
      [...authMethodIds].every((methodId) => GROK_INTERACTIVE_AUTH_METHOD_IDS.has(methodId))
    ) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Grok is not authenticated for headless ACP. Run \`grok login\` (or launch \`grok\`) and retry. Grok advertised only interactive auth methods: ${advertised}.`,
        data: { authMethods: [...authMethodIds], reason: "credentials_missing" },
      });
    }
    if (hasApiKey && !authMethodIds.has(GROK_API_KEY_AUTH_METHOD_ID)) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Grok did not advertise API-key authentication even though XAI_API_KEY is set (advertised: ${advertised}). Update Grok or check its login policy, then restart Synara.`,
        data: { authMethods: [...authMethodIds], reason: "compatibility_mismatch" },
      });
    }
    return yield* new AcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: `Grok ACP advertised no supported headless authentication method (advertised: ${advertised}). Synara supports cached_token and xai.api_key; update Grok and retry.`,
      data: {
        authMethods: [...authMethodIds],
        reason: "compatibility_mismatch",
      },
    });
  });

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const spawn = buildGrokAcpSpawnInput(
      input.grokSettings,
      input.cwd,
      input.runtimeMode,
      input.accountLaunch,
    );
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn,
        // Authentication selection must examine the exact environment supplied
        // to the child process, not process-global credentials.
        resolveAuthMethodId: (initializeResult) =>
          resolveGrokAcpAuthMethodId(initializeResult, spawn.env),
        authenticateMeta: { headless: true },
        freshSessionRetry: {
          shouldRetry: isGrokSessionStoragePathNotFoundError,
          delayMs: GROK_SESSION_STORAGE_RETRY_DELAY_MS,
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "setConfigOption" | "setModel"
  >;
  readonly model: string;
  readonly options?: GrokModelOptions | null | undefined;
  readonly mapError: (context: GrokAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  void input;
  // Grok ACP 0.1.210 advertises models in initialize/session responses but does
  // not implement `session/set_config_option`. Model and effort are therefore
  // process-start settings supplied by `buildGrokAcpSpawnInput`.
  return Effect.void;
}
