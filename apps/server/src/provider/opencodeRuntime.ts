// FILE: opencodeRuntime.ts
// Purpose: Starts OpenCode-compatible local servers and adapts their SDK/CLI data.
// Layer: Provider runtime utility
// Exports: OpenCodeRuntime, OpenCodeRuntimeLive, model/auth parsers, SDK helpers

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@synara/contracts";
import {
  type ConsoleState,
  createOpencodeClient,
  type Agent,
  type FilePartInput,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate as P,
  Ref,
  Result,
  ServiceMap,
  Scope,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { NetService, type NetServiceShape } from "@synara/shared/Net";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";
import {
  teardownEffectProcessTree,
  teardownProviderProcessTree,
} from "./supervisedProcessTeardown.ts";
import { isWindowsShellCommandMissingResult } from "../shell-command-detection.ts";

const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 20_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
export const OPENCODE_LOCAL_SERVER_IDLE_TTL_MS = 5 * 60_000;
const OPENCODE_STARTUP_OUTPUT_MAX_CHARS = 4_000;
const REDACTED_STARTUP_SECRET = "[redacted]";
const STARTUP_OUTPUT_AUTHORIZATION_PATTERN =
  /(["']?)(authorization)\1(\s*[:=]\s*)(["']?)(bearer\s+)?[^"'\s,;}]+\4/gi;
const STARTUP_OUTPUT_SECRET_ASSIGNMENT_PATTERN =
  /(["']?)([A-Za-z0-9_-]*(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|token|secret|password)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)(["']?)[^"'\s,;}]+\4/gi;

export interface OpenCodeCompatibleCliSpec {
  readonly defaultBinaryPath: string;
  readonly displayName: string;
  readonly serverReadyPrefix: string;
  readonly configContentEnvVar: string;
  readonly dataDirectoryName: string;
  readonly serverAuthUsername: string;
}

export const OPENCODE_CLI_SPEC: OpenCodeCompatibleCliSpec = {
  defaultBinaryPath: "opencode",
  displayName: "OpenCode",
  serverReadyPrefix: "opencode server listening",
  configContentEnvVar: "OPENCODE_CONFIG_CONTENT",
  dataDirectoryName: "opencode",
  serverAuthUsername: "opencode",
};

export const KILO_CLI_SPEC: OpenCodeCompatibleCliSpec = {
  defaultBinaryPath: "kilo",
  displayName: "Kilo",
  serverReadyPrefix: "kilo server listening",
  configContentEnvVar: "KILO_CONFIG_CONTENT",
  dataDirectoryName: "kilo",
  serverAuthUsername: "kilo",
};

export interface OpenCodeServerProcess {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

interface PooledOpenCodeServer {
  readonly key: string;
  readonly server: OpenCodeServerProcess;
  readonly scope: Scope.Closeable;
  readonly closeOnRelease: boolean;
  refCount: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
  exitWatchFiber: Fiber.Fiber<void, never> | null;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    try {
      return `status=${status ?? "?"} body=${JSON.stringify(body ?? cause)}`;
    } catch {
      // ignore stringify failure
    }
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: () => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
  readonly consoleState: ConsoleState | null;
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeCliModelDescriptor {
  readonly slug: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly name: string;
  readonly variants: ReadonlyArray<string>;
  readonly supportedReasoningEfforts: ReadonlyArray<{
    readonly value: string;
    readonly label?: string;
    readonly description?: string;
  }>;
  readonly defaultReasoningEffort?: string;
  readonly contextWindowOptions?: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly isDefault?: true;
  }>;
  readonly defaultContextWindow?: string;
  readonly isFree?: boolean;
}

export interface OpenCodePathInfo {
  readonly home: string;
  readonly state: string;
  readonly config: string;
  readonly worktree: string;
  readonly directory: string;
}

export interface OpenCodeRuntimeShape {
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly cwd?: string;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
    readonly experimentalWebSockets?: boolean;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly cwd?: string;
    readonly serverUrl?: string | null;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
    readonly experimentalWebSockets?: boolean;
    /**
     * Makes a managed server private to one owner and closes it immediately
     * when that owner's scope ends. Required before installing per-thread MCP
     * credentials into process-scoped configuration.
     */
    readonly poolIsolationKey?: string;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeInventory: (
    client: OpencodeClient,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly listOpenCodeCliModels: (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly cwd?: string;
  }) => Effect.Effect<ReadonlyArray<OpenCodeCliModelDescriptor>, OpenCodeRuntimeError>;
  readonly loadOpenCodeCredentialProviderIDs: (
    client: OpencodeClient,
    cliSpec?: OpenCodeCompatibleCliSpec,
  ) => Effect.Effect<ReadonlyArray<string>, never>;
}

function parseServerUrlFromOutput(output: string, readyPrefix: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(readyPrefix)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

function formatCommandPart(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

// Startup output is user-visible on failures, so keep diagnostics while masking likely secrets.
function redactStartupOutput(value: string): string {
  return value
    .replace(
      STARTUP_OUTPUT_AUTHORIZATION_PATTERN,
      (_match, keyQuote, key, separator, valueQuote, scheme = "") =>
        `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${scheme}${REDACTED_STARTUP_SECRET}${valueQuote}`,
    )
    .replace(
      STARTUP_OUTPUT_SECRET_ASSIGNMENT_PATTERN,
      (_match, keyQuote, key, separator, valueQuote) =>
        `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED_STARTUP_SECRET}${valueQuote}`,
    );
}

function truncateStartupOutput(value: string): string | null {
  const trimmed = redactStartupOutput(value).trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= OPENCODE_STARTUP_OUTPUT_MAX_CHARS) {
    return trimmed;
  }
  const remainingChars = trimmed.length - OPENCODE_STARTUP_OUTPUT_MAX_CHARS;
  return `${trimmed.slice(0, OPENCODE_STARTUP_OUTPUT_MAX_CHARS)}\n\n[truncated ${remainingChars} chars]`;
}

function formatOpenCodeServerStartupDetail(input: {
  readonly displayName: string;
  readonly summary: string;
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly readyPrefix: string;
  readonly stdout: string;
  readonly stderr: string;
}): string {
  const stdout = truncateStartupOutput(input.stdout);
  const stderr = truncateStartupOutput(input.stderr);
  const command = [input.binaryPath, ...input.args].map(formatCommandPart).join(" ");

  return [
    input.summary,
    `command: ${command}`,
    `${input.displayName} ready prefix: ${JSON.stringify(input.readyPrefix)}`,
    stdout ? `stdout:\n${stdout}` : "stdout: <empty>",
    stderr ? `stderr:\n${stderr}` : "stderr: <empty>",
  ].join("\n\n");
}

function pooledOpenCodeServerKey(input: {
  readonly binaryPath: string;
  readonly cliSpec?: OpenCodeCompatibleCliSpec;
  readonly cwd?: string;
  readonly port?: number;
  readonly hostname?: string;
  readonly experimentalWebSockets?: boolean;
  readonly poolIsolationKey?: string;
}): string {
  const cliSpec = input.cliSpec ?? OPENCODE_CLI_SPEC;
  return JSON.stringify({
    binaryPath: input.binaryPath,
    cwd: input.cwd ?? null,
    hostname: input.hostname ?? DEFAULT_HOSTNAME,
    port: input.port ?? null,
    experimentalWebSockets: input.experimentalWebSockets === true,
    poolIsolationKey: input.poolIsolationKey ?? null,
    cliSpec: {
      defaultBinaryPath: cliSpec.defaultBinaryPath,
      displayName: cliSpec.displayName,
      serverReadyPrefix: cliSpec.serverReadyPrefix,
      configContentEnvVar: cliSpec.configContentEnvVar,
      dataDirectoryName: cliSpec.dataDirectoryName,
      serverAuthUsername: cliSpec.serverAuthUsername,
    },
  });
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function fallbackOpenCodeModelName(slug: string, parsedSlug: ParsedOpenCodeModelSlug): string {
  return trimToNull(parsedSlug.modelID) ?? slug;
}

function numberToContextWindowValue(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}m`;
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}k`;
  return String(value);
}

function contextWindowLabel(value: string): string {
  return value.toUpperCase();
}

function parseOpenCodeContextWindowOptions(object: Record<string, unknown>):
  | {
      readonly contextWindowOptions: ReadonlyArray<{
        readonly value: string;
        readonly label: string;
        readonly isDefault?: true;
      }>;
      readonly defaultContextWindow: string;
    }
  | undefined {
  const limit =
    object.limit && typeof object.limit === "object"
      ? (object.limit as Record<string, unknown>)
      : null;
  const context =
    typeof limit?.context === "number"
      ? numberToContextWindowValue(limit.context)
      : trimToNull(limit?.context);
  if (!context) return undefined;
  return {
    contextWindowOptions: [{ value: context, label: contextWindowLabel(context), isDefault: true }],
    defaultContextWindow: context,
  };
}

function readOpenCodeVariantEffort(
  variantKey: string,
  variantObject: Record<string, unknown>,
): string | null {
  const directEffort =
    trimToNull(variantObject.reasoningEffort) ??
    trimToNull(variantObject.reasoning_effort) ??
    trimToNull(variantObject.effort);
  if (directEffort) {
    return directEffort;
  }

  const thinkingConfig =
    variantObject.thinkingConfig &&
    typeof variantObject.thinkingConfig === "object" &&
    !Array.isArray(variantObject.thinkingConfig)
      ? (variantObject.thinkingConfig as Record<string, unknown>)
      : variantObject.thinking_config &&
          typeof variantObject.thinking_config === "object" &&
          !Array.isArray(variantObject.thinking_config)
        ? (variantObject.thinking_config as Record<string, unknown>)
        : null;
  const thinkingLevel =
    trimToNull(thinkingConfig?.thinkingLevel) ?? trimToNull(thinkingConfig?.thinking_level);
  if (thinkingLevel) {
    return thinkingLevel;
  }

  const reasoning =
    variantObject.reasoning &&
    typeof variantObject.reasoning === "object" &&
    !Array.isArray(variantObject.reasoning)
      ? (variantObject.reasoning as Record<string, unknown>)
      : null;
  const reasoningConfig =
    variantObject.reasoningConfig &&
    typeof variantObject.reasoningConfig === "object" &&
    !Array.isArray(variantObject.reasoningConfig)
      ? (variantObject.reasoningConfig as Record<string, unknown>)
      : variantObject.reasoning_config &&
          typeof variantObject.reasoning_config === "object" &&
          !Array.isArray(variantObject.reasoning_config)
        ? (variantObject.reasoning_config as Record<string, unknown>)
        : null;
  const nestedReasoningEffort =
    trimToNull(reasoning?.effort) ??
    trimToNull(reasoningConfig?.maxReasoningEffort) ??
    trimToNull(reasoningConfig?.max_reasoning_effort);
  if (nestedReasoningEffort) {
    return nestedReasoningEffort;
  }

  if (
    "thinking" in variantObject ||
    "thinkingConfig" in variantObject ||
    "thinking_config" in variantObject ||
    "reasoning" in variantObject ||
    "reasoningConfig" in variantObject ||
    "reasoning_config" in variantObject ||
    Object.keys(variantObject).length === 0
  ) {
    return trimToNull(variantKey);
  }
  return null;
}

function resolveOpenCodeDataDirectory(
  homeDirectory: string,
  dataDirectoryName = "opencode",
): string {
  const xdgDataHome =
    trimToNull(process.env.XDG_DATA_HOME) ?? join(homeDirectory, ".local", "share");
  return join(xdgDataHome, dataDirectoryName);
}

export function resolveOpenCodeAuthFilePath(
  pathInfo: Pick<OpenCodePathInfo, "home">,
  cliSpec: OpenCodeCompatibleCliSpec = OPENCODE_CLI_SPEC,
): string {
  return join(resolveOpenCodeDataDirectory(pathInfo.home, cliSpec.dataDirectoryName), "auth.json");
}

export function parseOpenCodeCredentialProviderIDs(content: string): ReadonlyArray<string> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  return Object.entries(parsed as Record<string, unknown>)
    .flatMap(([providerID, value]) =>
      value && typeof value === "object" && !Array.isArray(value) ? [providerID.trim()] : [],
    )
    .filter((providerID) => providerID.length > 0)
    .toSorted((left, right) => left.localeCompare(right));
}

function readJsonObjectBlock(
  source: string,
  startIndex: number,
): { readonly json: string; readonly nextIndex: number } | null {
  if (source[startIndex] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (!char) {
      break;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          json: source.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return null;
}

function parseOpenCodeCliModelJson(
  value: unknown,
  slug: string,
  parsedSlug: ParsedOpenCodeModelSlug,
): OpenCodeCliModelDescriptor {
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const providerID = trimToNull(object.providerID) ?? parsedSlug.providerID;
  const modelID = trimToNull(object.id) ?? parsedSlug.modelID;
  const name = trimToNull(object.name) ?? fallbackOpenCodeModelName(slug, parsedSlug);
  const variantsObject =
    object.variants && typeof object.variants === "object" && !Array.isArray(object.variants)
      ? (object.variants as Record<string, unknown>)
      : {};
  const variants = Object.keys(variantsObject)
    .map((variant) => variant.trim())
    .filter((variant) => variant.length > 0)
    .toSorted((left, right) => left.localeCompare(right));
  const supportedReasoningEfforts = Array.from(
    new Map(
      Object.entries(variantsObject).flatMap(([variantKey, variant]) => {
        const variantObject =
          variant && typeof variant === "object" && !Array.isArray(variant)
            ? (variant as Record<string, unknown>)
            : null;
        if (!variantObject) {
          return [];
        }

        const reasoningValue = readOpenCodeVariantEffort(variantKey, variantObject);
        if (!reasoningValue) {
          return [];
        }

        const label = trimToNull(variantObject.label) ?? undefined;
        const description = trimToNull(variantObject.description) ?? undefined;
        return [
          [
            reasoningValue,
            {
              value: reasoningValue,
              ...(label ? { label } : {}),
              ...(description ? { description } : {}),
            },
          ] as const,
        ];
      }),
    ).values(),
  );
  const defaultReasoningEffort =
    trimToNull(object.defaultReasoningEffort) ??
    trimToNull(object.default_reasoning_effort) ??
    (object.options && typeof object.options === "object" && !Array.isArray(object.options)
      ? (trimToNull((object.options as Record<string, unknown>).reasoningEffort) ??
        trimToNull((object.options as Record<string, unknown>).reasoning_effort) ??
        trimToNull((object.options as Record<string, unknown>).effort))
      : null) ??
    undefined;
  const contextWindowOptions = parseOpenCodeContextWindowOptions(object);
  const isFree = object.isFree;

  return {
    slug,
    providerID,
    modelID,
    name,
    variants,
    supportedReasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(contextWindowOptions ?? {}),
    ...(typeof isFree === "boolean" ? { isFree } : {}),
  };
}

export function parseOpenCodeCliModelsOutput(
  output: string,
): ReadonlyArray<OpenCodeCliModelDescriptor> {
  const models = new Map<string, OpenCodeCliModelDescriptor>();
  let index = 0;

  while (index < output.length) {
    while (index < output.length && /\s/u.test(output[index]!)) {
      index += 1;
    }
    if (index >= output.length) {
      break;
    }

    const lineEnd = output.indexOf("\n", index);
    const nextLineIndex = lineEnd === -1 ? output.length : lineEnd + 1;
    const candidate = output.slice(index, lineEnd === -1 ? output.length : lineEnd).trim();
    index = nextLineIndex;

    const parsedSlug = parseOpenCodeModelSlug(candidate);
    if (!parsedSlug) {
      continue;
    }

    let descriptor: OpenCodeCliModelDescriptor = {
      slug: candidate,
      providerID: parsedSlug.providerID,
      modelID: parsedSlug.modelID,
      name: fallbackOpenCodeModelName(candidate, parsedSlug),
      variants: [],
      supportedReasoningEfforts: [],
    };

    while (index < output.length && /\s/u.test(output[index]!)) {
      index += 1;
    }

    if (output[index] === "{") {
      const block = readJsonObjectBlock(output, index);
      if (block) {
        try {
          descriptor = parseOpenCodeCliModelJson(JSON.parse(block.json), candidate, parsedSlug);
        } catch {
          // Keep the slug-derived fallback descriptor when the JSON block cannot be parsed.
        }
        index = block.nextIndex;
      }
    }

    models.set(descriptor.slug, descriptor);
  }

  return [...models.values()].toSorted(
    (left, right) => left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug),
  );
}

function toListModelsCommandError(input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}): OpenCodeRuntimeError {
  return new OpenCodeRuntimeError({
    operation: "listOpenCodeCliModels",
    detail: [
      `Failed to execute '${input.binaryPath} ${input.args.join(" ")}' (exit code ${String(input.code)}).`,
      input.stdout.trim().length > 0 ? `stdout:\n${input.stdout.trim()}` : null,
      input.stderr.trim().length > 0 ? `stderr:\n${input.stderr.trim()}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    cause: {
      code: input.code,
      stdout: input.stdout,
      stderr: input.stderr,
    },
  });
}

function supportsVerboseModelsCommandFailure(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("unknown argument: verbose") || combined.includes("unknown option: verbose")
  );
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

// OpenCode file parts reject many document MIME types; keep native parts to images.
export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }

    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(
  runtimeMode: RuntimeMode,
  interactionMode: "default" | "plan" = "default",
): PermissionRuleset {
  if (interactionMode === "plan") {
    // OpenCode evaluates the last matching rule. Start closed, then allow only
    // read-only planning tools. This also blocks custom/MCP tools and future
    // mutating tools that a short denylist would accidentally leave enabled.
    return [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "list", pattern: "*", action: "allow" },
      { permission: "lsp", pattern: "*", action: "allow" },
      { permission: "webfetch", pattern: "*", action: "allow" },
      { permission: "websearch", pattern: "*", action: "allow" },
      { permission: "codesearch", pattern: "*", action: "allow" },
      { permission: "todoread", pattern: "*", action: "allow" },
      { permission: "todowrite", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "allow" },
    ];
  }

  const runtimeRules: PermissionRuleset =
    runtimeMode === "full-access"
      ? [{ permission: "*", pattern: "*", action: "allow" }]
      : [
          { permission: "*", pattern: "*", action: "ask" },
          { permission: "bash", pattern: "*", action: "ask" },
          { permission: "edit", pattern: "*", action: "ask" },
          { permission: "webfetch", pattern: "*", action: "ask" },
          { permission: "websearch", pattern: "*", action: "ask" },
          { permission: "codesearch", pattern: "*", action: "ask" },
          { permission: "external_directory", pattern: "*", action: "ask" },
          { permission: "doom_loop", pattern: "*", action: "ask" },
          { permission: "question", pattern: "*", action: "allow" },
        ];

  return runtimeRules;
}

export function buildOpenCodeServerProcessEnv(input: {
  readonly cliSpec?: OpenCodeCompatibleCliSpec;
  readonly experimentalWebSockets?: boolean;
  readonly baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return buildProviderChildEnvironment({
    provider:
      input.cliSpec?.dataDirectoryName === KILO_CLI_SPEC.dataDirectoryName ? "kilo" : "opencode",
    baseEnv: input.baseEnv ?? process.env,
    overrides: input.experimentalWebSockets ? { OPENCODE_EXPERIMENTAL_WEBSOCKETS: "true" } : {},
  });
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

export interface OpenCodeRuntimeLiveOptions {
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
  readonly netService?: NetServiceShape;
}

const makeOpenCodeRuntime = (options?: OpenCodeRuntimeLiveOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const netService = yield* NetService;
    const pooledServerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const pooledServerMutex = yield* Semaphore.make(1);
    const pooledServers = new Map<string, PooledOpenCodeServer>();

    const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
      Effect.gen(function* () {
        const childEnv = buildOpenCodeServerProcessEnv({
          ...(input.cliSpec ? { cliSpec: input.cliSpec } : {}),
        });
        const prepared = prepareWindowsSafeProcess(input.binaryPath, input.args, {
          cwd: input.cwd,
          env: childEnv,
        });
        const child = yield* spawner.spawn(
          ChildProcess.make(prepared.command, prepared.args, {
            shell: prepared.shell,
            ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            env: childEnv,
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectStreamAsString(child.stdout),
            collectStreamAsString(child.stderr),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        const exitCode = Number(code);
        if (isWindowsShellCommandMissingResult({ code: exitCode, stderr })) {
          return yield* new OpenCodeRuntimeError({
            operation: "runOpenCodeCommand",
            detail: `spawn ${input.binaryPath} ENOENT`,
          });
        }
        return {
          stdout,
          stderr,
          code: exitCode,
        } satisfies OpenCodeCommandResult;
      }).pipe(
        Effect.scoped,
        Effect.mapError((cause) =>
          ensureRuntimeError(
            "runOpenCodeCommand",
            `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
            cause,
          ),
        ),
      );

    const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const runtimeScope = yield* Scope.Scope;
        const cliSpec = input.cliSpec ?? OPENCODE_CLI_SPEC;

        const hostname = input.hostname ?? DEFAULT_HOSTNAME;
        const port =
          input.port ??
          (yield* netService.findAvailablePort(0).pipe(
            Effect.mapError(
              (cause) =>
                new OpenCodeRuntimeError({
                  operation: "startOpenCodeServerProcess",
                  detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                  cause,
                }),
            ),
          ));
        const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
        const args = ["serve", "--hostname", hostname, "--port", String(port)];

        const child = yield* spawner
          .spawn(
            ChildProcess.make(input.binaryPath, args, {
              env: buildOpenCodeServerProcessEnv({
                cliSpec,
                ...(input.experimentalWebSockets !== undefined
                  ? { experimentalWebSockets: input.experimentalWebSockets }
                  : {}),
              }),
              ...(input.cwd ? { cwd: input.cwd } : {}),
              detached: false,
              killSignal: "SIGKILL",
              forceKillAfter: "1500 millis",
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, runtimeScope),
            Effect.mapError(
              (cause) =>
                new OpenCodeRuntimeError({
                  operation: "startOpenCodeServerProcess",
                  detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                  cause,
                }),
            ),
          );
        yield* Scope.addFinalizer(
          runtimeScope,
          Effect.tryPromise({
            try: () =>
              teardownEffectProcessTree(
                child,
                options?.teardownProcessTree ?? teardownProviderProcessTree,
              ),
            catch: (cause) =>
              new OpenCodeRuntimeError({
                operation: "stopOpenCodeServerProcess",
                detail: `Failed to prove ${cliSpec.displayName} server process-tree exit: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          }).pipe(Effect.asVoid, Effect.orDie),
        );

        const stdoutRef = yield* Ref.make("");
        const stderrRef = yield* Ref.make("");
        const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

        const setReadyFromStdoutChunk = (chunk: string) =>
          Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
            Effect.flatMap((nextStdout) => {
              const parsed = parseServerUrlFromOutput(nextStdout, cliSpec.serverReadyPrefix);
              return parsed
                ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore)
                : Effect.void;
            }),
          );

        const stdoutFiber = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach(setReadyFromStdoutChunk),
          Effect.ignore,
          Effect.forkIn(runtimeScope),
        );
        const stderrFiber = yield* child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
          Effect.ignore,
          Effect.forkIn(runtimeScope),
        );

        const exitFiber = yield* child.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              const stdout = yield* Ref.get(stdoutRef);
              const stderr = yield* Ref.get(stderrRef);
              const redactedStdout = redactStartupOutput(stdout);
              const redactedStderr = redactStartupOutput(stderr);
              const exitCode = Number(code);
              yield* Deferred.fail(
                readyDeferred,
                new OpenCodeRuntimeError({
                  operation: "startOpenCodeServerProcess",
                  detail: formatOpenCodeServerStartupDetail({
                    displayName: cliSpec.displayName,
                    summary: `${cliSpec.displayName} server exited before startup completed (code: ${String(exitCode)}).`,
                    binaryPath: input.binaryPath,
                    args,
                    readyPrefix: cliSpec.serverReadyPrefix,
                    stdout: redactedStdout,
                    stderr: redactedStderr,
                  }),
                  cause: {
                    exitCode,
                    stdout: redactedStdout,
                    stderr: redactedStderr,
                    binaryPath: input.binaryPath,
                    args,
                    readyPrefix: cliSpec.serverReadyPrefix,
                  },
                }),
              ).pipe(Effect.ignore);
            }),
          ),
          Effect.ignore,
          Effect.forkIn(runtimeScope),
        );

        const readyExit = yield* Effect.exit(
          Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
        );

        yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
        yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);

        if (Exit.isFailure(readyExit)) {
          yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
          const squashed = Cause.squash(readyExit.cause);
          return yield* ensureRuntimeError(
            "startOpenCodeServerProcess",
            [
              `Failed while waiting for ${cliSpec.displayName} server startup:`,
              openCodeRuntimeErrorDetail(squashed),
            ].join(" "),
            squashed,
          );
        }

        const readyOption = readyExit.value;
        if (Option.isNone(readyOption)) {
          yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
          const stdout = yield* Ref.get(stdoutRef);
          const stderr = yield* Ref.get(stderrRef);
          const redactedStdout = redactStartupOutput(stdout);
          const redactedStderr = redactStartupOutput(stderr);
          return yield* new OpenCodeRuntimeError({
            operation: "startOpenCodeServerProcess",
            detail: formatOpenCodeServerStartupDetail({
              displayName: cliSpec.displayName,
              summary: `Timed out waiting for ${cliSpec.displayName} server start after ${timeoutMs}ms.`,
              binaryPath: input.binaryPath,
              args,
              readyPrefix: cliSpec.serverReadyPrefix,
              stdout: redactedStdout,
              stderr: redactedStderr,
            }),
            cause: {
              timeoutMs,
              stdout: redactedStdout,
              stderr: redactedStderr,
              binaryPath: input.binaryPath,
              args,
              readyPrefix: cliSpec.serverReadyPrefix,
            },
          });
        }

        return {
          url: readyOption.value,
          exitCode: child.exitCode.pipe(
            Effect.map(Number),
            Effect.orElseSucceed(() => 0),
          ),
        } satisfies OpenCodeServerProcess;
      });

    const cancelPooledServerIdleClose = Effect.fn("cancelPooledServerIdleClose")(function* (
      pooledServer: PooledOpenCodeServer,
    ) {
      const idleCloseFiber = pooledServer.idleCloseFiber;
      pooledServer.idleCloseFiber = null;
      if (idleCloseFiber !== null) {
        yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
      }
    });

    const detachPooledServer = Effect.fn("detachPooledServer")(function* (
      pooledServer: PooledOpenCodeServer,
    ) {
      pooledServers.delete(pooledServer.key);
      pooledServer.refCount = 0;
      yield* cancelPooledServerIdleClose(pooledServer);
    });

    const closePooledServer = Effect.fn("closePooledServer")(function* (
      pooledServer: PooledOpenCodeServer,
    ) {
      // Keep the pool entry authoritative while scope finalization proves the server tree exited.
      // Acquirers serialize on pooledServerMutex and cannot observe a replacement before proof.
      yield* cancelPooledServerIdleClose(pooledServer);

      const exitWatchFiber = pooledServer.exitWatchFiber;
      pooledServer.exitWatchFiber = null;
      if (exitWatchFiber !== null) {
        yield* Fiber.interrupt(exitWatchFiber).pipe(Effect.ignore);
      }

      yield* Scope.close(pooledServer.scope, Exit.void);
      yield* detachPooledServer(pooledServer);
    });

    const schedulePooledServerIdleClose = Effect.fn("schedulePooledServerIdleClose")(function* (
      pooledServer: PooledOpenCodeServer,
    ) {
      yield* cancelPooledServerIdleClose(pooledServer);
      const idleCloseFiber = yield* Effect.sleep(OPENCODE_LOCAL_SERVER_IDLE_TTL_MS).pipe(
        Effect.andThen(
          pooledServerMutex.withPermit(
            Effect.gen(function* () {
              if (
                pooledServers.get(pooledServer.key) !== pooledServer ||
                pooledServer.refCount > 0
              ) {
                return;
              }
              pooledServer.idleCloseFiber = null;
              yield* closePooledServer(pooledServer);
            }),
          ),
        ),
        Effect.forkIn(pooledServerScope),
      );
      pooledServer.idleCloseFiber = idleCloseFiber;
    });

    const watchPooledServerExit = Effect.fn("watchPooledServerExit")(function* (
      pooledServer: PooledOpenCodeServer,
    ) {
      const exitWatchFiber = yield* pooledServer.server.exitCode.pipe(
        Effect.flatMap(() =>
          pooledServerMutex.withPermit(
            Effect.gen(function* () {
              if (pooledServers.get(pooledServer.key) !== pooledServer) {
                return;
              }
              pooledServer.exitWatchFiber = null;
              yield* Scope.close(pooledServer.scope, Exit.void);
              yield* detachPooledServer(pooledServer);
            }),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(pooledServerScope),
      );
      pooledServer.exitWatchFiber = exitWatchFiber;
    });

    const acquirePooledServer = (input: {
      readonly binaryPath: string;
      readonly cliSpec?: OpenCodeCompatibleCliSpec;
      readonly cwd?: string;
      readonly port?: number;
      readonly hostname?: string;
      readonly timeoutMs?: number;
      readonly experimentalWebSockets?: boolean;
      readonly poolIsolationKey?: string;
    }) =>
      pooledServerMutex.withPermit(
        Effect.gen(function* () {
          const key = pooledOpenCodeServerKey(input);
          const existing = pooledServers.get(key);
          if (existing) {
            yield* cancelPooledServerIdleClose(existing);
            existing.refCount += 1;
            return existing;
          }

          // Start lazily on first real use, then keep warm only while recent sessions need it.
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const serverScope = yield* Scope.make();
              const startedExit = yield* Effect.exit(
                restore(
                  startOpenCodeServerProcess(input).pipe(
                    Effect.provideService(Scope.Scope, serverScope),
                  ),
                ),
              );

              if (Exit.isFailure(startedExit)) {
                yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
                return yield* Effect.failCause(startedExit.cause);
              }

              const pooledServer: PooledOpenCodeServer = {
                key,
                server: startedExit.value,
                scope: serverScope,
                closeOnRelease: input.poolIsolationKey !== undefined,
                refCount: 1,
                idleCloseFiber: null,
                exitWatchFiber: null,
              };
              pooledServers.set(key, pooledServer);
              yield* watchPooledServerExit(pooledServer);
              return pooledServer;
            }),
          );
        }),
      );

    const releasePooledServer = (pooledServer: PooledOpenCodeServer) =>
      pooledServerMutex.withPermit(
        Effect.gen(function* () {
          if (pooledServers.get(pooledServer.key) !== pooledServer) {
            return;
          }
          pooledServer.refCount = Math.max(0, pooledServer.refCount - 1);
          if (pooledServer.refCount === 0) {
            if (pooledServer.closeOnRelease) {
              yield* closePooledServer(pooledServer);
            } else {
              yield* schedulePooledServerIdleClose(pooledServer);
            }
          }
        }),
      );

    yield* Effect.addFinalizer(() =>
      pooledServerMutex.withPermit(
        Effect.gen(function* () {
          for (const pooledServer of Array.from(pooledServers.values())) {
            yield* closePooledServer(pooledServer);
          }
        }),
      ),
    );

    const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
      const serverUrl = input.serverUrl?.trim();
      if (serverUrl) {
        return Effect.succeed({
          url: serverUrl,
          exitCode: null,
          external: true,
        });
      }

      return Effect.gen(function* () {
        const callerScope = yield* Scope.Scope;
        const pooledServer = yield* acquirePooledServer({
          binaryPath: input.binaryPath,
          ...(input.cliSpec !== undefined ? { cliSpec: input.cliSpec } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.experimentalWebSockets !== undefined
            ? { experimentalWebSockets: input.experimentalWebSockets }
            : {}),
          ...(input.poolIsolationKey !== undefined
            ? { poolIsolationKey: input.poolIsolationKey }
            : {}),
        });
        yield* Scope.addFinalizer(callerScope, releasePooledServer(pooledServer));
        return {
          url: pooledServer.server.url,
          exitCode: pooledServer.server.exitCode,
          external: false,
        };
      });
    };

    const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
      createOpencodeClient({
        baseUrl: input.baseUrl,
        directory: input.directory,
        ...(input.serverPassword
          ? {
              headers: {
                Authorization: `Basic ${Buffer.from(`${(input.cliSpec ?? OPENCODE_CLI_SPEC).serverAuthUsername}:${input.serverPassword}`, "utf8").toString("base64")}`,
              },
            }
          : {}),
        throwOnError: true,
      });

    const loadProviders = (client: OpencodeClient) =>
      runOpenCodeSdk("provider.list", () => client.provider.list()).pipe(
        Effect.filterMapOrFail(
          (list) =>
            list.data
              ? Result.succeed(list.data)
              : Result.fail(
                  new OpenCodeRuntimeError({
                    operation: "provider.list",
                    detail: "OpenCode provider list was empty.",
                  }),
                ),
          (result) => result,
        ),
      );

    const loadAgents = (client: OpencodeClient) =>
      runOpenCodeSdk("app.agents", () => client.app.agents()).pipe(
        Effect.map((result) => result.data ?? []),
      );

    const loadOptionalAgents = (client: OpencodeClient) =>
      loadAgents(client).pipe(
        Effect.timeoutOption("2 seconds"),
        Effect.map(Option.getOrElse((): ReadonlyArray<Agent> => [])),
        Effect.catch((cause) =>
          Effect.logDebug("OpenCode agent discovery skipped", {
            reason: openCodeRuntimeErrorDetail(cause),
          }).pipe(Effect.as([] as ReadonlyArray<Agent>)),
        ),
      );

    const loadConsoleState = (client: OpencodeClient) =>
      runOpenCodeSdk("experimental.console.get", () => client.experimental.console.get()).pipe(
        Effect.map((result) => result.data ?? null),
        // Console metadata is optional and should not block model discovery.
        Effect.catch(() => Effect.succeed(null)),
      );

    const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (client) =>
      Effect.all([loadProviders(client), loadOptionalAgents(client), loadConsoleState(client)], {
        concurrency: "unbounded",
      }).pipe(
        Effect.map(([providerList, agents, consoleState]) => ({
          providerList,
          agents,
          consoleState,
        })),
      );

    const loadOpenCodePaths = (client: OpencodeClient) =>
      runOpenCodeSdk("path.get", () => client.path.get()).pipe(
        Effect.filterMapOrFail(
          (response) =>
            response.data
              ? Result.succeed(response.data as OpenCodePathInfo)
              : Result.fail(
                  new OpenCodeRuntimeError({
                    operation: "path.get",
                    detail: "OpenCode path.get returned no path payload.",
                  }),
                ),
          (result) => result,
        ),
      );

    const listOpenCodeCliModelsFromArgs = (input: {
      readonly binaryPath: string;
      readonly cliSpec?: OpenCodeCompatibleCliSpec;
      readonly cwd?: string;
      readonly args: ReadonlyArray<string>;
    }) =>
      runOpenCodeCommand({
        binaryPath: input.binaryPath,
        ...(input.cliSpec !== undefined ? { cliSpec: input.cliSpec } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        args: input.args,
      }).pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(parseOpenCodeCliModelsOutput(result.stdout))
            : Effect.fail(
                toListModelsCommandError({
                  binaryPath: input.binaryPath,
                  args: input.args,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  code: result.code,
                }),
              ),
        ),
      );

    const listOpenCodeCliModels: OpenCodeRuntimeShape["listOpenCodeCliModels"] = (input) =>
      listOpenCodeCliModelsFromArgs({
        binaryPath: input.binaryPath,
        ...(input.cliSpec !== undefined ? { cliSpec: input.cliSpec } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        args: ["models", "--verbose"],
      }).pipe(
        Effect.catch((error) => {
          if (!OpenCodeRuntimeError.is(error)) {
            return Effect.fail(error);
          }

          const cause = error.cause as
            | {
                readonly stdout?: string;
                readonly stderr?: string;
              }
            | undefined;
          if (
            !supportsVerboseModelsCommandFailure(cause?.stdout ?? "", cause?.stderr ?? "") &&
            !supportsVerboseModelsCommandFailure("", error.detail)
          ) {
            return Effect.fail(error);
          }

          return listOpenCodeCliModelsFromArgs({
            binaryPath: input.binaryPath,
            ...(input.cliSpec !== undefined ? { cliSpec: input.cliSpec } : {}),
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            args: ["models"],
          });
        }),
      );

    const loadOpenCodeCredentialProviderIDs: OpenCodeRuntimeShape["loadOpenCodeCredentialProviderIDs"] =
      (client, cliSpec = OPENCODE_CLI_SPEC) =>
        loadOpenCodePaths(client).pipe(
          Effect.flatMap((pathInfo) =>
            Effect.tryPromise({
              try: () => readFile(resolveOpenCodeAuthFilePath(pathInfo, cliSpec), "utf8"),
              catch: (cause) =>
                new OpenCodeRuntimeError({
                  operation: "readOpenCodeCredentialProviderIDs",
                  detail: openCodeRuntimeErrorDetail(cause),
                  cause,
                }),
            }),
          ),
          Effect.flatMap((content) =>
            Effect.try({
              try: () => parseOpenCodeCredentialProviderIDs(content),
              catch: (cause) =>
                new OpenCodeRuntimeError({
                  operation: "parseOpenCodeCredentialProviderIDs",
                  detail: openCodeRuntimeErrorDetail(cause),
                  cause,
                }),
            }),
          ),
          // Explicit credential metadata is optional. Discovery should still work when
          // the auth file does not exist, is unreadable, or belongs to another machine.
          Effect.catch(() => Effect.succeed([])),
        );

    return {
      startOpenCodeServerProcess,
      connectToOpenCodeServer,
      runOpenCodeCommand,
      createOpenCodeSdkClient,
      loadOpenCodeInventory,
      listOpenCodeCliModels,
      loadOpenCodeCredentialProviderIDs,
    } satisfies OpenCodeRuntimeShape;
  });

export class OpenCodeRuntime extends ServiceMap.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "synara/provider/opencodeRuntime",
) {}

export const makeOpenCodeRuntimeLive = (options?: OpenCodeRuntimeLiveOptions) =>
  Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime(options)).pipe(
    Layer.provide(
      options?.netService ? Layer.succeed(NetService, options.netService) : NetService.layer,
    ),
  );

export const OpenCodeRuntimeLive = makeOpenCodeRuntimeLive();
