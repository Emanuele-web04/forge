import crypto from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type AntigravityModelOptions,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, Option, Queue, Stream } from "effect";

import {
  type AcpStdioProxySpawn,
  buildAntigravityMcpPluginConfig,
  SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV,
  SYNARA_AGENT_GATEWAY_URL_ENV,
} from "../../agentGateway/mcpInjection.ts";
import {
  type SynaraHarnessPolicyDeliveryState,
  takeSynaraHarnessPolicyForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayMcpConnection,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  AntigravityAdapter,
  type AntigravityAdapterShape,
} from "../Services/AntigravityAdapter.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { makeBoundedCallbackIngress } from "../boundedCallbackIngress.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import {
  compactProviderRuntimeEventForIngress,
  isTerminalProviderRuntimeEvent,
  PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
  PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
  type SizedProviderRuntimeEvent,
} from "../providerRuntimeEventIngress.ts";
import { teardownChildProcessTree } from "../supervisedProcessTeardown.ts";

const PROVIDER = "antigravity" as const;
const DEFAULT_MODEL = "Gemini 3.5 Flash";
const PRINT_TIMEOUT = "30m";
const POLL_INTERVAL_MS = 75;
const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const PLUGIN_INSTALL_TIMEOUT_MS = 45_000;
const HELPER_OUTPUT_MAX_CHARS = 128 * 1024;
const WINDOWS_PROMPT_MAX_CHARS = 24_000;

type TranscriptStep = {
  readonly step_index?: number;
  readonly source?: string;
  readonly type?: string;
  readonly status?: string;
  readonly content?: string;
  readonly tool_calls?: ReadonlyArray<{
    readonly name?: string;
    readonly args?: Record<string, unknown>;
  }> | null;
  readonly [key: string]: unknown;
};

type PendingTool = {
  readonly stepIndex: number;
  readonly itemId: RuntimeItemId;
  readonly itemType: "command_execution" | "file_change" | "dynamic_tool_call" | "web_search";
  readonly name: string;
  readonly args?: Record<string, unknown>;
};

type StoredTurn = {
  readonly id: TurnId;
  readonly items: unknown[];
};

export type AntigravityTrackedBackgroundTask = {
  readonly taskId: string;
  readonly taskType: string;
  readonly description?: string;
  readonly startedAt: string;
};

type ToolSurfaceCounters = {
  /** Highest occurrence already rendered for each `${stepIndex}:${toolName}` pair. */
  surfacedToolCallCounts: Map<string, number>;
  /** Occurrence order observed specifically from pre-tool hook events. */
  hookToolCallCounts: Map<string, number>;
};

type ForeignConversationState = ToolSurfaceCounters & {
  pendingTools: PendingTool[];
  nextToolSequence: number;
  terminalEmitted: boolean;
};

type AntigravitySessionContext = ToolSurfaceCounters & {
  session: ProviderSession;
  gatewaySessionLease?: AgentGatewaySessionLease;
  harnessPolicyDelivered?: boolean;
  readonly lifecycleGeneration?: string;
  readonly binaryPath: string;
  readonly turns: StoredTurn[];
  activeTurnId?: TurnId | undefined;
  activeProcess?: ChildProcess | undefined;
  activePrompt?: string | undefined;
  eventFile?: string | undefined;
  transcriptPath?: string | undefined;
  conversationId?: string | undefined;
  modelName?: string | undefined;
  modelOptions?: AntigravityModelOptions | undefined;
  processedHookBytes: number;
  hookPollPromise?: Promise<void>;
  processedTranscriptBytes: number;
  processedTranscriptPath?: string | undefined;
  processedSteps: Set<number>;
  pendingTools: PendingTool[];
  nextToolSequence: number;
  pendingBackgroundTasks: Map<string, AntigravityTrackedBackgroundTask>;
  pendingAnonymousBackgroundTasks: number;
  pendingBackgroundTaskCompletions: AntigravitySystemMessageInfo[];
  backgroundCompletionSequence: number;
  latestBackgroundCompletionStepIndex?: number;
  /**
   * Conversations owned by spawned subagents, keyed by conversation id.
   * The capture hook is installed globally, so a subagent CLI spawned by the
   * session's own CLI inherits `SYNARA_ANTIGRAVITY_EVENTS` and writes its
   * pre-invocation/tool/stop events into this session's hook stream. Those
   * events describe a different process and conversation and must never
   * rebind the session; they are forwarded as child-thread events carrying
   * `providerParentThreadId` so the ingestion layer materializes a visible
   * subagent thread.
   */
  foreignConversations: Map<string, ForeignConversationState>;
  /**
   * Both the capture-hook stream (pre-tool events) and the transcript body
   * (PLANNER_RESPONSE.tool_calls) feed occurrence counters so the same call is
   * rendered exactly once regardless of which source arrives first, while two
   * calls with the same name in one planner step still render independently.
   */
  sawAssistant: boolean;
  interrupted: boolean;
  stopped: boolean;
  /** Guards against double turn.completed (process close + interrupt/stop). */
  turnTerminalEmitted: boolean;
};

function messageFromCause(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

function trim(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function nextToolOccurrence(counts: Map<string, number>, key: string): number {
  const occurrence = (counts.get(key) ?? 0) + 1;
  counts.set(key, occurrence);
  return occurrence;
}

function claimToolOccurrence(
  surfacedCounts: Map<string, number>,
  key: string,
  occurrence: number,
): boolean {
  if ((surfacedCounts.get(key) ?? 0) >= occurrence) return false;
  surfacedCounts.set(key, occurrence);
  return true;
}

function resumeConversationId(value: unknown): string | undefined {
  if (typeof value === "string") return trim(value);
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["conversationId", "providerThreadId", "id"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return undefined;
}

function transcriptPathForConversation(conversationId: string): string {
  return path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Hook output when capture is inactive (the session is not Synara-managed).
 * Antigravity requires PreToolUse output to carry a `decision`: an empty
 * object is treated as a denial with an empty reason, which blocks every tool
 * call because the hook is installed globally with `matcher: "*"` (#490).
 * "ask" preserves the permission flow the user would have without the hook.
 *
 * PreInvocation fires immediately before an LLM invocation and is a veto
 * point with the same decision semantics: an empty object is treated as a
 * denial that aborts the invocation. The CLI raises a PreInvocation for the
 * subagent's first model call when the parent agent invokes a subagent, so
 * `{}` there denies the subagent launch and the parent CLI exits with code 1
 * ("Antigravity CLI exited with code 1."). Synara-managed sessions spawn
 * subagents deliberately, so pre-invocation must answer "allow".
 *
 * `{}` stays correct for the other hook points, including Stop, where an
 * inactive hook must not force a decision over Antigravity's default.
 *
 * Active Stop hooks must also stay neutral (`{}`). Returning
 * `{"decision":"stop"}` is not a valid Antigravity/Claude stop decision
 * (only `"block"` is recognized to prevent exit) and can leave the print
 * process hung after the assistant has already finished, so the UI stays
 * "Working" and Cancel has nothing left to kill (#465).
 */
function inactiveHookOutput(event: string): string {
  if (event === "pre-tool") return '{"decision":"ask"}';
  if (event === "pre-invocation") return '{"decision":"allow"}';
  return "{}";
}

export function buildAntigravityCaptureCommand(
  executablePath: string,
  scriptPath: string,
  event: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const fallback = inactiveHookOutput(event);
  if (platform === "win32") {
    // The Antigravity CLI passes hook command strings to cmd.exe without
    // decoding JSON escapes, so any `"` in the command arrives as `\"` and
    // breaks cmd's quote handling: a quoted program path is executed literally
    // ("...exe" is not recognized as an internal or external command) and the
    // hook never runs. Keep the invocation free of double quotes; the helper
    // paths are space-free in every supported install layout (dev bun/electron
    // binaries and packaged apps under %LOCALAPPDATA%\Programs).
    const invocation = `${executablePath} ${scriptPath} ${event}`;
    return `if not defined SYNARA_ANTIGRAVITY_EVENTS (more >nul 2>nul & echo ${fallback}) else (set ELECTRON_RUN_AS_NODE=1&& ${invocation})`;
  }
  const invocation = `${shellQuote(executablePath, platform)} ${shellQuote(scriptPath, platform)} ${shellQuote(event, platform)}`;
  return `if [ -z "\${SYNARA_ANTIGRAVITY_EVENTS:-}" ]; then cat >/dev/null 2>&1 || :; printf '%s\\n' '${fallback}'; else ELECTRON_RUN_AS_NODE=1 ${invocation}; fi`;
}

export function hookScriptSource(): string {
  return `const fs = require("node:fs");
const event = process.argv[2] || "unknown";
let payload = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { payload += chunk; });
process.stdin.on("end", () => {
  const target = process.env.SYNARA_ANTIGRAVITY_EVENTS;
  if (!target) {
    // Mirrors the shell wrapper's inactive fallback: PreToolUse must carry a
    // decision or Antigravity denies the tool call with an empty reason, and
    // PreInvocation must carry "allow" or the subagent launch it gates is
    // denied and the parent CLI exits with code 1.
    process.stdout.write(
      (event === "pre-tool"
        ? '{"decision":"ask"}'
        : event === "pre-invocation"
          ? '{"decision":"allow"}'
          : "{}") + "\\n",
    );
    return;
  }
  let capturedPayload = payload.trim();
  try {
    const input = JSON.parse(capturedPayload);
    const sanitized = {};
    for (const key of ["conversationId", "transcriptPath", "modelName"]) {
      if (typeof input[key] === "string" && input[key].trim()) sanitized[key] = input[key];
    }
    if (Number.isInteger(input.stepIdx) && input.stepIdx >= 0) sanitized.stepIdx = input.stepIdx;
    if (event === "pre-tool") {
      const name = input.toolCall && typeof input.toolCall.name === "string"
        ? input.toolCall.name.trim()
        : "";
      if (name) {
        sanitized.toolCall = {
          name,
          ...(input.toolCall.args && typeof input.toolCall.args === "object"
            ? { args: input.toolCall.args }
            : {}),
        };
      }
    } else if (event === "post-tool") {
      const name = input.toolCall && typeof input.toolCall.name === "string"
        ? input.toolCall.name.trim()
        : "";
      if (name) {
        sanitized.toolCall = {
          name,
          ...(input.toolCall.args && typeof input.toolCall.args === "object"
            ? { args: input.toolCall.args }
            : {}),
        };
      }
      sanitized.failed = typeof input.error === "string" && input.error.trim().length > 0;
      if (typeof input.error === "string" && input.error.trim()) sanitized.error = input.error;
      if (input.toolOutput !== undefined) sanitized.toolOutput = input.toolOutput;
      if (input.result !== undefined) sanitized.result = input.result;
    }
    capturedPayload = JSON.stringify(sanitized);
  } catch {
    capturedPayload = "{}";
  }
  fs.appendFileSync(target, event + "\\t" + capturedPayload + "\\n");
  if (event === "pre-tool") {
    const decision = process.env.SYNARA_ANTIGRAVITY_HOOK_DECISION === "allow" ? "allow" : "ask";
    process.stdout.write(JSON.stringify({ decision }) + "\\n");
  } else if (event === "pre-invocation") {
    // PreInvocation vetoes the upcoming LLM invocation; Synara-managed
    // sessions run subagents deliberately, so never block them here. An
    // empty object would deny the launch and the parent CLI exits 1.
    process.stdout.write('{"decision":"allow"}\\n');
  } else {
    // Stop and other non-tool hooks: empty object allows the agent to exit.
    // Do not emit decision:"stop" — it is not a recognized stop decision and
    // can hang the print process after the reply is already visible (#465).
    process.stdout.write("{}\\n");
  }
});
`;
}

export function buildAntigravityHookConfig(
  command: (event: string) => string,
): Record<string, unknown> {
  const hook = (event: string) => ({ type: "command", command: command(event) });
  return {
    "synara-capture": {
      PreToolUse: [{ matcher: "*", hooks: [hook("pre-tool")] }],
      PostToolUse: [{ matcher: "*", hooks: [hook("post-tool")] }],
      PreInvocation: [hook("pre-invocation")],
      PostInvocation: [hook("post-invocation")],
      Stop: [hook("stop")],
    },
  };
}

function appendBoundedOutput(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  return next.length > HELPER_OUTPUT_MAX_CHARS ? next.slice(-HELPER_OUTPUT_MAX_CHARS) : next;
}

export async function runAntigravityHelperProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildProviderChildEnvironment({ provider: PROVIDER }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new Error(
            `Antigravity helper timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`,
          ),
        ),
      );
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout = appendBoundedOutput(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = appendBoundedOutput(stderr, chunk)));
    child.once("error", (cause) => finish(() => reject(cause)));
    child.once("close", (code) => finish(() => resolve({ stdout, stderr, code: code ?? 1 })));
  });
}

export async function readCompleteAntigravityLines(
  filePath: string,
  offset: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  const file = await fs.open(filePath, "r");
  try {
    const stats = await file.stat();
    const start = offset <= stats.size ? offset : 0;
    const remaining = stats.size - start;
    if (remaining === 0) return { lines: [], nextOffset: start };
    const buffer = Buffer.allocUnsafe(remaining);
    const { bytesRead } = await file.read(buffer, 0, remaining, start);
    const contents = buffer.subarray(0, bytesRead);
    const lastNewline = contents.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], nextOffset: start };
    return {
      lines: contents
        .subarray(0, lastNewline + 1)
        .toString("utf8")
        .split(/\r?\n/g)
        .filter(Boolean),
      nextOffset: start + lastNewline + 1,
    };
  } finally {
    await file.close();
  }
}

type AntigravityHelperRunner = typeof runAntigravityHelperProcess;

export async function ensureCapturePlugin(
  binaryPath: string,
  stdioProxy?: AcpStdioProxySpawn,
  options: {
    readonly homeDir?: string;
    readonly runHelper?: AntigravityHelperRunner;
  } = {},
): Promise<void> {
  const pluginDir = path.join(
    options.homeDir ?? os.homedir(),
    ".gemini",
    "antigravity-cli",
    "plugins",
    "synara-capture",
  );
  const scriptPath = path.join(pluginDir, "capture.cjs");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    `${JSON.stringify(
      {
        $schema: "https://antigravity.google/schemas/v1/plugin.json",
        name: "synara-capture",
        description: "Streams Antigravity CLI lifecycle events to Synara when requested.",
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
  const command = (event: string) =>
    buildAntigravityCaptureCommand(process.execPath, scriptPath, event);
  await fs.writeFile(
    path.join(pluginDir, "hooks.json"),
    `${JSON.stringify(buildAntigravityHookConfig(command), null, 2)}\n`,
  );
  const mcpConfigPath = path.join(pluginDir, "mcp_config.json");
  if (stdioProxy) {
    await fs.writeFile(
      mcpConfigPath,
      `${JSON.stringify(buildAntigravityMcpPluginConfig(stdioProxy), null, 2)}\n`,
    );
  } else {
    await fs.rm(mcpConfigPath, { force: true });
  }
  const installed = await (options.runHelper ?? runAntigravityHelperProcess)(
    binaryPath,
    ["plugin", "install", pluginDir],
    { timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS },
  );
  if (installed.code !== 0) {
    throw new Error(installed.stderr.trim() || installed.stdout.trim() || "Plugin install failed.");
  }
}

export function buildAntigravityTurnProcessEnvironment(input: {
  readonly eventFile: string;
  readonly gatewayConnection?: Pick<AgentGatewayMcpConnection, "url">;
  readonly gatewayBootstrapToken?: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const hasGatewayBootstrap =
    input.gatewayConnection !== undefined && input.gatewayBootstrapToken !== undefined;
  const gatewayKeys = hasGatewayBootstrap
    ? [SYNARA_AGENT_GATEWAY_URL_ENV, SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV]
    : [];
  const gatewayEnvironment = hasGatewayBootstrap
    ? {
        [SYNARA_AGENT_GATEWAY_URL_ENV]: input.gatewayConnection!.url,
        [SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV]: input.gatewayBootstrapToken!,
      }
    : {};
  return buildProviderChildEnvironment({
    provider: PROVIDER,
    ...(input.baseEnv === undefined ? {} : { baseEnv: input.baseEnv }),
    inheritedSynaraKeys: [
      "SYNARA_ANTIGRAVITY_EVENTS",
      "SYNARA_ANTIGRAVITY_HOOK_DECISION",
      ...gatewayKeys,
    ],
    overrides: {
      SYNARA_ANTIGRAVITY_EVENTS: input.eventFile,
      SYNARA_ANTIGRAVITY_HOOK_DECISION: "allow",
      ...gatewayEnvironment,
    },
  });
}

export function buildAntigravityTurnPrompt(
  state: SynaraHarnessPolicyDeliveryState,
  input: {
    readonly prompt: string;
    readonly hasGatewaySessionLease: boolean;
  },
): string {
  const harnessPolicy = takeSynaraHarnessPolicyForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable: input.hasGatewaySessionLease,
  });
  return [harnessPolicy, input.prompt].filter(Boolean).join("\n\n");
}

const DEFAULT_EFFORT_BY_MODEL: Readonly<Record<string, string>> = {
  "Gemini 3.7 Flash": "high",
  "Gemini 3.6 Flash": "medium",
  "Gemini 3.5 Flash": "medium",
  "Gemini 3.1 Pro": "low",
  "Claude Sonnet 4.6": "thinking",
  "Claude Opus 4.6": "thinking",
  "Claude 3.7 Sonnet": "thinking",
  "DeepSeek V4 Flash Max": "high",
  "GPT-OSS 120B": "medium",
};

const EFFORT_ORDER = ["low", "medium", "high", "thinking"] as const;

function effortLabel(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function parseAntigravityCliModelLabel(
  value: string,
): { model: string; effort?: string } | null {
  const stripped = value.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!stripped) return null;

  // Newer `agy models` rows are `slug<TAB>Display Name (Effort)`. Older builds
  // printed only the display label. Prefer the display column when present so
  // Synara never treats `slug\tName` as a single model id at dispatch.
  const tabIndex = stripped.indexOf("\t");
  const labelColumn =
    tabIndex >= 0 ? stripped.slice(tabIndex + 1).trim() : stripped.replace(/^(?:[*•-]\s+)+/u, "");
  const trimmed = labelColumn.replace(/^(?:[*•-]\s+)+/u, "").trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(.*?)\s+\(([^()]+)\)$/u);
  if (!match?.[1] || !match[2]) return { model: trimmed };
  return {
    model: match[1].trim(),
    effort: match[2].trim().toLowerCase(),
  };
}

export function antigravityPromptCommandLineIssue(
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32" || prompt.length <= WINDOWS_PROMPT_MAX_CHARS) {
    return null;
  }
  return `Antigravity prompts on Windows are limited to ${WINDOWS_PROMPT_MAX_CHARS.toLocaleString("en-US")} characters because the CLI accepts print-mode prompts as command-line arguments. Shorten the prompt or attach the content as files.`;
}

export function parseAntigravityModelLines(output: string): ProviderListModelsResult["models"] {
  const groups = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/g)) {
    const parsed = parseAntigravityCliModelLabel(line);
    if (!parsed) continue;
    const efforts = groups.get(parsed.model) ?? [];
    if (parsed.effort && !efforts.includes(parsed.effort)) efforts.push(parsed.effort);
    groups.set(parsed.model, efforts);
  }
  return [...groups.entries()].map(([model, discoveredEfforts]) => {
    const efforts = discoveredEfforts.toSorted((left, right) => {
      const leftIndex = EFFORT_ORDER.indexOf(left as (typeof EFFORT_ORDER)[number]);
      const rightIndex = EFFORT_ORDER.indexOf(right as (typeof EFFORT_ORDER)[number]);
      return (
        (leftIndex < 0 ? EFFORT_ORDER.length : leftIndex) -
        (rightIndex < 0 ? EFFORT_ORDER.length : rightIndex)
      );
    });
    const defaultEffort = DEFAULT_EFFORT_BY_MODEL[model] ?? efforts[0];
    return {
      slug: model,
      name: model,
      ...(efforts.length > 0
        ? {
            supportedReasoningEfforts: efforts.map((effort) => ({
              value: effort,
              label: effortLabel(effort),
            })),
            ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
          }
        : {}),
    };
  });
}

export function resolveAntigravityCliModelLabel(
  model: string,
  options?: AntigravityModelOptions,
  discoveredDefaultEffort?: string,
): string {
  const parsed = parseAntigravityCliModelLabel(model);
  if (!parsed) return model;
  const effort =
    parsed.effort ??
    options?.reasoningEffort?.trim().toLowerCase() ??
    discoveredDefaultEffort?.trim().toLowerCase() ??
    DEFAULT_EFFORT_BY_MODEL[parsed.model];
  // Always rebuild the CLI display label. Returning the raw input would preserve
  // corrupted `slug\tName (Effort)` rows from older discovery parsing.
  return effort ? `${parsed.model} (${effortLabel(effort)})` : parsed.model;
}

function parseModelLines(output: string): ProviderListModelsResult["models"] {
  return parseAntigravityModelLines(output);
}

function toolItemType(name: string): PendingTool["itemType"] {
  if (name === "run_command") return "command_execution";
  if (
    name === "write_to_file" ||
    name === "replace_file_content" ||
    name === "multi_replace_file_content"
  ) {
    return "file_change";
  }
  if (name === "search_web" || name.startsWith("browser_")) return "web_search";
  return "dynamic_tool_call";
}

function buildAntigravityToolItemData(
  name: string,
  _itemType: PendingTool["itemType"],
  itemId: RuntimeItemId,
  args?: Record<string, unknown>,
  postPayload?: Record<string, unknown>,
): Record<string, unknown> {
  const command =
    typeof args?.CommandLine === "string"
      ? args.CommandLine
      : typeof args?.command === "string"
        ? args.command
        : typeof args?.cmd === "string"
          ? args.cmd
          : undefined;
  const cwd =
    typeof args?.Cwd === "string" ? args.Cwd : typeof args?.cwd === "string" ? args.cwd : undefined;
  const pathValue =
    typeof args?.TargetFile === "string"
      ? args.TargetFile
      : typeof args?.AbsolutePath === "string"
        ? args.AbsolutePath
        : typeof args?.DirectoryPath === "string"
          ? args.DirectoryPath
          : typeof args?.SearchPath === "string"
            ? args.SearchPath
            : typeof args?.path === "string"
              ? args.path
              : typeof args?.file === "string"
                ? args.file
                : undefined;
  const query =
    typeof args?.Query === "string"
      ? args.Query
      : typeof args?.query === "string"
        ? args.query
        : undefined;

  const rawOutput =
    postPayload?.toolOutput ?? postPayload?.result ?? postPayload?.error ?? undefined;

  return {
    toolCallId: itemId,
    toolName: name,
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(pathValue ? { path: pathValue, file: pathValue } : {}),
    ...(query ? { query } : {}),
    ...(args ? { arguments: args, input: args, rawInput: args } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
  };
}

export interface AntigravitySystemMessageInfo {
  readonly isSystemMessage: boolean;
  readonly fullContent: string;
  readonly taskId?: string;
  readonly sender?: string;
  readonly exitCode?: number;
  readonly isFailure: boolean;
}

export function parseAntigravitySystemMessage(
  content: string | undefined,
): AntigravitySystemMessageInfo | null {
  if (!content || typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed.includes("<SYSTEM_MESSAGE>")) return null;

  const senderMatch = trimmed.match(/sender=([^\s]+)/u);
  const sender = senderMatch?.[1];

  const taskIdMatch =
    trimmed.match(/Task id ["']([^"']+)["']/iu) ??
    trimmed.match(/Task ID:?\s*["']?([^\s\n,"']+)["']?/iu);
  const rawTaskId = taskIdMatch?.[1] ?? (sender?.includes("task-") ? sender : undefined);
  const taskId = rawTaskId?.trim();

  const exitCodeMatch = trimmed.match(/exited with code (\d+)/iu);
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1] ?? "0", 10) : undefined;
  const failureText = trimmed
    .replace(/\b(?:0|no)(?:\s+[\p{L}\p{N}_-]+){0,3}\s+failed\b/giu, "")
    .replace(/\b(?:no|without)\s+errors?\b/giu, "");
  const isFailure =
    exitCode !== undefined ? exitCode !== 0 : /\bfailed\b|\berror\b/iu.test(failureText);

  return {
    isSystemMessage: true,
    fullContent: trimmed,
    ...(taskId ? { taskId } : {}),
    ...(sender ? { sender } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    isFailure,
  };
}

export function detectAntigravityBackgroundTaskStart(
  name: string,
  args?: Record<string, unknown>,
  postPayload?: Record<string, unknown>,
): { taskId?: string; description?: string; isBackground: boolean } | null {
  const failed =
    postPayload?.failed === true ||
    (typeof postPayload?.error === "string" && postPayload.error.trim().length > 0);
  if (failed) return null;

  if (name === "run_command") {
    const rawOutput =
      typeof postPayload?.toolOutput === "string"
        ? postPayload.toolOutput
        : typeof postPayload?.result === "string"
          ? postPayload.result
          : undefined;
    const command =
      typeof args?.CommandLine === "string"
        ? args.CommandLine
        : typeof args?.command === "string"
          ? args.command
          : typeof args?.cmd === "string"
            ? args.cmd
            : undefined;

    if (rawOutput) {
      const match =
        rawOutput.match(/Task id ["']?([\w.-]+)["']?/iu) ?? rawOutput.match(/\b(task-[\w.-]+)\b/iu);
      if (/background task|sent to the background|running in the background/iu.test(rawOutput)) {
        const taskId = match?.[1] ?? match?.[0];
        return {
          ...(taskId ? { taskId } : {}),
          ...(command ? { description: command } : {}),
          isBackground: true,
        };
      }
    }
    if (
      postPayload !== undefined &&
      typeof args?.WaitMsBeforeAsync === "number" &&
      (!rawOutput || !/exited with code/iu.test(rawOutput))
    ) {
      const match = rawOutput?.match(/\b(task-[\w.-]+)\b/iu);
      return {
        ...(match?.[0] ? { taskId: match[0] } : {}),
        ...(command ? { description: command } : {}),
        isBackground: true,
      };
    }
  }

  if (name === "schedule") {
    const prompt = typeof args?.Prompt === "string" ? args.Prompt : undefined;
    const rawOutput =
      typeof postPayload?.toolOutput === "string"
        ? postPayload.toolOutput
        : typeof postPayload?.result === "string"
          ? postPayload.result
          : undefined;
    const match = rawOutput
      ? (rawOutput.match(/\b(task-[\w.-]+)\b/iu) ?? rawOutput.match(/\b(timer-[\w.-]+)\b/iu))
      : undefined;
    return {
      ...(match?.[0] ? { taskId: match[0] } : {}),
      description: prompt ?? "Scheduled timer",
      isBackground: true,
    };
  }

  return null;
}

export function matchAntigravityTrackedTaskId(
  candidateId: string | undefined,
  trackedTaskIds: Iterable<string>,
): string | undefined {
  const ids = Array.from(trackedTaskIds);
  if (ids.length === 0) return undefined;
  if (!candidateId) {
    return ids.length === 1 ? ids[0] : undefined;
  }
  const cleanCandidate = candidateId.trim();
  if (ids.includes(cleanCandidate)) return cleanCandidate;
  for (const id of ids) {
    if (cleanCandidate.endsWith(`/${id}`) || cleanCandidate.endsWith(`:${id}`)) {
      return id;
    }
  }
  for (const id of ids) {
    if (id.endsWith(`/${cleanCandidate}`) || id.endsWith(`:${cleanCandidate}`)) {
      return id;
    }
  }
  return undefined;
}

export function makeAntigravityRuntimeEventBase(input: {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  readonly eventId?: EventId;
  readonly createdAt?: string;
}) {
  return {
    eventId: input.eventId ?? EventId.makeUnsafe(crypto.randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.lifecycleGeneration !== undefined
      ? { lifecycleGeneration: input.lifecycleGeneration }
      : {}),
  };
}

type AntigravityChildProcess = ChildProcess & {
  readonly stdout: NonNullable<ChildProcess["stdout"]>;
  readonly stderr: NonNullable<ChildProcess["stderr"]>;
};

export interface AntigravityAdapterDependencies {
  readonly ensurePlugin?: typeof ensureCapturePlugin;
  readonly readCompleteLines?: typeof readCompleteAntigravityLines;
  readonly teardownProcessTree?: typeof teardownChildProcessTree;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => AntigravityChildProcess;
}

const makeAntigravityAdapter = (dependencies: AntigravityAdapterDependencies = {}) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const readCompleteLines = dependencies.readCompleteLines ?? readCompleteAntigravityLines;
    const teardownProcessTree = dependencies.teardownProcessTree ?? teardownChildProcessTree;
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const eventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    const sessions = new Map<ThreadId, AntigravitySessionContext>();
    const defaultEffortByModel = new Map(Object.entries(DEFAULT_EFFORT_BY_MODEL));

    const eventIngress = yield* makeBoundedCallbackIngress<SizedProviderRuntimeEvent, never, never>(
      (item) => Queue.offer(eventQueue, item.event).pipe(Effect.asVoid),
      {
        capacity: PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
        maxBufferedBytes: PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
        terminalReserve: PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
        isTerminal: (item) => isTerminalProviderRuntimeEvent(item.event),
        sizeOf: (item) => item.bytes,
      },
    );

    const offer = (event: ProviderRuntimeEvent) => {
      eventIngress.offer(compactProviderRuntimeEventForIngress(event));
    };

    const base = (
      context: AntigravitySessionContext,
      options?: { includeTurn?: boolean; itemId?: RuntimeItemId },
    ) => ({
      ...makeAntigravityRuntimeEventBase({
        threadId: context.session.threadId,
        ...(context.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: context.lifecycleGeneration }
          : {}),
      }),
      ...(options?.includeTurn !== false && context.activeTurnId
        ? { turnId: context.activeTurnId }
        : {}),
      ...(options?.itemId ? { itemId: options.itemId } : {}),
      ...(context.conversationId
        ? { providerRefs: { providerThreadId: context.conversationId } }
        : {}),
    });

    const raw = (messageType: string, payload: unknown) => ({
      source: "antigravity.cli.event" as const,
      messageType,
      payload,
    });

    const withForeignProviderRefs = (
      event: ProviderRuntimeEvent,
      conversationId: string,
      parentConversationId: string,
    ): ProviderRuntimeEvent => ({
      ...event,
      providerRefs: {
        providerThreadId: conversationId,
        providerParentThreadId: parentConversationId,
      },
    });

    const settleForeignConversation = (
      context: AntigravitySessionContext,
      conversationId: string,
      parentConversationId: string,
      child: ForeignConversationState,
      input: {
        readonly state: "completed" | "interrupted" | "failed";
        readonly errorMessage?: string;
        readonly raw: ReturnType<typeof raw>;
      },
    ): boolean => {
      if (child.terminalEmitted || context.activeTurnId === undefined) return false;

      const itemStatus = input.state === "completed" ? "completed" : "failed";
      for (const pending of child.pendingTools.splice(0)) {
        offer(
          withForeignProviderRefs(
            {
              ...base(context, { itemId: pending.itemId }),
              type: "item.completed",
              payload: {
                itemType: pending.itemType,
                status: itemStatus,
                title: pending.name,
                data: buildAntigravityToolItemData(
                  pending.name,
                  pending.itemType,
                  pending.itemId,
                  pending.args,
                ),
              },
              raw: raw("tool-lifecycle-parent-terminal", {
                conversationId,
                name: pending.name,
                state: input.state,
              }),
            } satisfies ProviderRuntimeEvent,
            conversationId,
            parentConversationId,
          ),
        );
      }

      child.terminalEmitted = true;
      offer(
        withForeignProviderRefs(
          {
            ...base(context),
            type: "turn.completed",
            payload:
              input.state === "interrupted"
                ? { state: "interrupted", stopReason: "interrupted" }
                : input.state === "failed"
                  ? {
                      state: "failed",
                      stopReason: "error",
                      errorMessage: input.errorMessage ?? "Antigravity child turn failed.",
                    }
                  : { state: "completed", stopReason: "model_stop" },
            raw: input.raw,
          } satisfies ProviderRuntimeEvent,
          conversationId,
          parentConversationId,
        ),
      );
      return true;
    };

    const settleForeignConversations = (
      context: AntigravitySessionContext,
      input: {
        readonly state: "completed" | "interrupted" | "failed";
        readonly errorMessage?: string;
        readonly raw: ReturnType<typeof raw>;
      },
    ): void => {
      const parentConversationId = context.conversationId;
      if (!parentConversationId) return;
      for (const [conversationId, child] of context.foreignConversations) {
        settleForeignConversation(context, conversationId, parentConversationId, child, input);
      }
    };

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AntigravitySessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const releaseTurnGatewayLease = (
      context: AntigravitySessionContext,
      lease: AgentGatewaySessionLease | undefined = context.gatewaySessionLease,
    ): void => {
      lease?.release();
      if (context.gatewaySessionLease === lease) delete context.gatewaySessionLease;
    };

    const teardownActiveProcess = (
      context: AntigravitySessionContext,
      method: string,
    ): Effect.Effect<void, ProviderAdapterRequestError> => {
      const child = context.activeProcess;
      if (!child) return Effect.void;
      return Effect.tryPromise({
        try: () => teardownProcessTree(child),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: messageFromCause(cause, "Failed to stop the Antigravity process tree."),
            cause,
          }),
      }).pipe(Effect.asVoid);
    };

    const completePendingBackgroundTasks = (
      context: AntigravitySessionContext,
      status: "completed" | "failed" | "stopped",
      source: string,
    ): void => {
      for (const [taskId, tracked] of context.pendingBackgroundTasks) {
        offer({
          ...base(context),
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(taskId),
            status,
          },
          raw: raw(source, { taskId, tracked, status }),
        } satisfies ProviderRuntimeEvent);
      }
      context.pendingBackgroundTasks.clear();
      context.pendingAnonymousBackgroundTasks = 0;
      context.pendingBackgroundTaskCompletions.length = 0;
    };

    const killPendingBackgroundTasks = (
      context: AntigravitySessionContext,
      source: string,
    ): void => {
      for (const [taskId, tracked] of context.pendingBackgroundTasks) {
        offer({
          ...base(context),
          type: "task.updated",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(taskId),
            status: "killed",
          },
          raw: raw(source, { taskId, tracked }),
        } satisfies ProviderRuntimeEvent);
      }
      context.pendingBackgroundTasks.clear();
      context.pendingAnonymousBackgroundTasks = 0;
      context.pendingBackgroundTaskCompletions.length = 0;
    };

    const backgroundCompletionCandidate = (
      message: AntigravitySystemMessageInfo,
    ): string | undefined => message.taskId ?? message.sender;

    const settleTrackedBackgroundTask = (
      context: AntigravitySessionContext,
      taskId: string,
      systemMessage: AntigravitySystemMessageInfo,
    ): boolean => {
      const tracked = context.pendingBackgroundTasks.get(taskId);
      if (!tracked) return false;
      context.pendingBackgroundTasks.delete(taskId);
      offer({
        ...base(context),
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe(taskId),
          status: systemMessage.isFailure ? "failed" : "completed",
        },
        raw: raw("background-task-completed", {
          taskId,
          systemMessage,
          tracked,
        }),
      } satisfies ProviderRuntimeEvent);
      return true;
    };

    const registerBackgroundTask = (
      context: AntigravitySessionContext,
      start: { readonly taskId?: string; readonly description?: string },
      taskType: string,
      source: { readonly name: string; readonly args?: Record<string, unknown> },
    ): void => {
      if (context.stopped) return;
      if (!start.taskId) {
        context.pendingAnonymousBackgroundTasks += 1;
        return;
      }
      const taskId = start.taskId;
      if (context.pendingBackgroundTasks.has(taskId)) return;
      context.pendingBackgroundTasks.set(taskId, {
        taskId,
        taskType,
        ...(start.description ? { description: start.description } : {}),
        startedAt: new Date().toISOString(),
      });
      offer({
        ...base(context),
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe(taskId),
          taskType,
          ...(start.description ? { description: start.description } : {}),
        },
        raw: raw("background-task-started", { taskId, ...source }),
      } satisfies ProviderRuntimeEvent);

      const completionIndex = context.pendingBackgroundTaskCompletions.findIndex(
        (message) =>
          matchAntigravityTrackedTaskId(
            backgroundCompletionCandidate(message),
            context.pendingBackgroundTasks.keys(),
          ) === taskId,
      );
      if (completionIndex < 0) return;
      const [completion] = context.pendingBackgroundTaskCompletions.splice(completionIndex, 1);
      if (completion) settleTrackedBackgroundTask(context, taskId, completion);
    };

    const teardownStoppedTurnIfIdle = (context: AntigravitySessionContext): void => {
      if (
        !context.activeProcess ||
        context.turnTerminalEmitted ||
        context.pendingBackgroundTasks.size > 0 ||
        context.pendingAnonymousBackgroundTasks > 0
      ) {
        return;
      }
      const child = context.activeProcess;
      void teardownProcessTree(child).catch(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may already be gone.
        }
      });
    };

    /**
     * Emit a single terminal turn.completed for the active turn and mark the
     * session idle. Idempotent so process-close, interrupt, and stop-hook
     * paths can all call it without double-settling (#465).
     */
    const settleActiveTurn = (
      context: AntigravitySessionContext,
      input: {
        readonly state: "completed" | "interrupted" | "failed";
        readonly stopReason: "model_stop" | "interrupted" | "error";
        readonly errorMessage?: string;
        readonly raw?: ReturnType<typeof raw>;
      },
    ): boolean => {
      if (context.turnTerminalEmitted || context.activeTurnId === undefined) {
        return false;
      }
      const completionBase = base(context);
      completePendingBackgroundTasks(
        context,
        input.state === "interrupted"
          ? "stopped"
          : input.state === "failed"
            ? "failed"
            : "completed",
        "parent-turn-background-task-terminal",
      );
      settleForeignConversations(context, {
        state: input.state,
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        raw: raw("parent-turn-terminal", {
          state: input.state,
          stopReason: input.stopReason,
        }),
      });
      context.turnTerminalEmitted = true;
      delete context.activeProcess;
      delete context.activeTurnId;
      const {
        activeTurnId: _activeTurnId,
        lastError: _lastError,
        ...inactiveSession
      } = context.session;
      const failed = input.state === "failed";
      context.session = {
        ...inactiveSession,
        status: failed ? "error" : "ready",
        ...(context.conversationId ? { resumeCursor: context.conversationId } : {}),
        updatedAt: new Date().toISOString(),
        ...(failed && input.errorMessage ? { lastError: input.errorMessage } : {}),
      };
      offer({
        ...completionBase,
        type: "turn.completed",
        payload:
          input.state === "interrupted"
            ? { state: "interrupted", stopReason: "interrupted" }
            : input.state === "failed"
              ? {
                  state: "failed",
                  stopReason: "error",
                  errorMessage: input.errorMessage ?? "Antigravity turn failed.",
                }
              : { state: "completed", stopReason: "model_stop" },
        ...(input.raw ? { raw: input.raw } : {}),
      } satisfies ProviderRuntimeEvent);
      return true;
    };

    const currentTurn = (context: AntigravitySessionContext): StoredTurn | undefined =>
      context.activeTurnId
        ? context.turns.find((turn) => turn.id === context.activeTurnId)
        : undefined;

    const emitTextItem = (
      context: AntigravitySessionContext,
      step: TranscriptStep,
      itemType: "assistant_message" | "reasoning",
      streamKind: "assistant_text" | "reasoning_text",
      explicitContent?: string,
    ) => {
      const content = trim(explicitContent ?? step.content);
      if (!content) return;
      const itemId = RuntimeItemId.makeUnsafe(
        `antigravity-${context.activeTurnId ?? "turn"}-${step.step_index ?? crypto.randomUUID()}-${itemType}`,
      );
      offer({
        ...base(context, { itemId }),
        type: "item.started",
        payload: {
          itemType,
          status: "inProgress",
          title: itemType === "reasoning" ? "Reasoning" : "Assistant",
        },
        raw: raw(step.type ?? "transcript", step),
      } satisfies ProviderRuntimeEvent);
      offer({
        ...base(context, { itemId }),
        type: "content.delta",
        payload: { streamKind, delta: content },
        raw: raw(step.type ?? "transcript", step),
      } satisfies ProviderRuntimeEvent);
      offer({
        ...base(context, { itemId }),
        type: "item.completed",
        payload: {
          itemType,
          status: "completed",
          title: itemType === "reasoning" ? "Reasoning" : "Assistant",
          ...(itemType === "reasoning" ? { detail: content } : {}),
          data: step,
        },
        raw: raw(step.type ?? "transcript", step),
      } satisfies ProviderRuntimeEvent);
      if (itemType === "assistant_message") context.sawAssistant = true;
    };

    /**
     * Surface tool calls recorded in the transcript body as tool lifecycle
     * items. This is the fallback for calls the capture hook never reported
     * (plugin not installed this session, hook payload missing stepIdx, ...).
     * Occurrence counters dedupe against the hook stream so a call the hook
     * already rendered — or will render — is not emitted twice.
     */
    const emitTranscriptToolCalls = (
      context: AntigravitySessionContext,
      stepIndex: number,
      calls: ReadonlyArray<NonNullable<TranscriptStep["tool_calls"]>[number]>,
    ) => {
      const transcriptCounts = new Map<string, number>();
      for (const call of calls) {
        const name = typeof call?.name === "string" ? trim(call.name) : undefined;
        if (!name) continue;
        const surfaceKey = `${stepIndex}:${name}`;
        const occurrence = nextToolOccurrence(transcriptCounts, surfaceKey);
        if (!claimToolOccurrence(context.surfacedToolCallCounts, surfaceKey, occurrence)) continue;
        const args =
          call.args && typeof call.args === "object"
            ? (call.args as Record<string, unknown>)
            : undefined;
        const itemId = RuntimeItemId.makeUnsafe(
          `antigravity-${context.activeTurnId ?? "turn"}-tool-${context.nextToolSequence++}`,
        );
        const itemType = toolItemType(name);
        const data = buildAntigravityToolItemData(name, itemType, itemId, args);
        offer({
          ...base(context, { itemId }),
          type: "item.started",
          payload: {
            itemType,
            status: "inProgress",
            title: name,
            data,
          },
          raw: raw("transcript-tool-call", { stepIdx: stepIndex, name, args }),
        } satisfies ProviderRuntimeEvent);
        offer({
          ...base(context, { itemId }),
          type: "item.completed",
          payload: {
            itemType,
            status: "completed",
            title: name,
            data,
          },
          raw: raw("transcript-tool-call", { stepIdx: stepIndex, name, args }),
        } satisfies ProviderRuntimeEvent);
      }
    };

    const processTranscriptStep = (context: AntigravitySessionContext, step: TranscriptStep) => {
      if (context.stopped) return;
      const stepIndex = step.step_index;
      if (typeof stepIndex === "number") {
        if (context.processedSteps.has(stepIndex)) return;
        context.processedSteps.add(stepIndex);
      }
      currentTurn(context)?.items.push(step);

      const systemMessage = parseAntigravitySystemMessage(
        typeof step.content === "string" ? step.content : undefined,
      );
      if (systemMessage?.isSystemMessage) {
        const candidateId = backgroundCompletionCandidate(systemMessage);
        if (candidateId) {
          context.backgroundCompletionSequence += 1;
          if (typeof stepIndex === "number") {
            context.latestBackgroundCompletionStepIndex = Math.max(
              context.latestBackgroundCompletionStepIndex ?? -1,
              stepIndex,
            );
          } else {
            delete context.latestBackgroundCompletionStepIndex;
          }
        }
        const matchedTaskId = matchAntigravityTrackedTaskId(
          candidateId,
          context.pendingBackgroundTasks.keys(),
        );
        if (matchedTaskId) {
          settleTrackedBackgroundTask(context, matchedTaskId, systemMessage);
        } else if (candidateId && context.pendingAnonymousBackgroundTasks > 0) {
          context.pendingAnonymousBackgroundTasks -= 1;
        } else if (candidateId) {
          context.pendingBackgroundTaskCompletions.push(systemMessage);
          if (context.pendingBackgroundTaskCompletions.length > 32) {
            context.pendingBackgroundTaskCompletions.shift();
          }
        }
        return;
      }

      if (step.type === "PLANNER_RESPONSE") {
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        if (calls.length > 0) {
          const reasoning = trim(
            typeof step.thinking === "string"
              ? step.thinking
              : typeof step.thought === "string"
                ? step.thought
                : step.content,
          );
          if (reasoning) {
            emitTextItem(context, step, "reasoning", "reasoning_text", reasoning);
          }
          emitTranscriptToolCalls(context, stepIndex ?? 0, calls);
        } else {
          const assistantText = trim(
            typeof step.content === "string"
              ? step.content
              : typeof step.thinking === "string"
                ? step.thinking
                : undefined,
          );
          if (assistantText) {
            emitTextItem(context, step, "assistant_message", "assistant_text", assistantText);
          }
        }
        return;
      }
    };

    const readTranscript = async (context: AntigravitySessionContext) => {
      if (!context.transcriptPath) return;
      const isInitialRead = context.processedTranscriptPath !== context.transcriptPath;
      if (isInitialRead) context.processedTranscriptBytes = 0;
      let batch: Awaited<ReturnType<typeof readCompleteAntigravityLines>>;
      try {
        batch = await readCompleteLines(context.transcriptPath, context.processedTranscriptBytes);
      } catch {
        return;
      }
      if (context.stopped) return;
      context.processedTranscriptBytes = batch.nextOffset;
      context.processedTranscriptPath = context.transcriptPath;
      const steps = batch.lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as TranscriptStep];
        } catch {
          return [];
        }
      });
      const latestUserIndex = isInitialRead
        ? steps.reduce(
            (latest, step) =>
              step.type === "USER_INPUT" && typeof step.step_index === "number"
                ? Math.max(latest, step.step_index)
                : latest,
            -1,
          )
        : -1;
      for (const step of steps) {
        const idx = typeof step.step_index === "number" ? step.step_index : Number.MAX_SAFE_INTEGER;
        if (idx > latestUserIndex) {
          processTranscriptStep(context, step);
        }
      }
    };

    const markExistingTranscriptStepsProcessed = async (context: AntigravitySessionContext) => {
      if (!context.transcriptPath) return;
      try {
        const batch = await readCompleteLines(context.transcriptPath, 0);
        context.processedTranscriptBytes = batch.nextOffset;
        context.processedTranscriptPath = context.transcriptPath;
      } catch {
        return;
      }
    };

    /**
     * Forward a hook event that belongs to a subagent conversation spawned by
     * the session's own CLI. The capture hook is installed globally, so the
     * subagent CLI inherits `SYNARA_ANTIGRAVITY_EVENTS` and writes its
     * events into this session's hook stream. Those events describe a
     * different process and conversation: they must never rebind the session
     * (cursor, transcript, thread) — instead they are surfaced as child-thread
     * events carrying `providerParentThreadId` so the ingestion layer
     * materializes a visible subagent thread.
     */
    const handleForeignHookEvent = async (
      context: AntigravitySessionContext,
      input: {
        readonly eventName: string;
        readonly payload: Record<string, unknown>;
        readonly conversationId: string;
        readonly ownConversationId: string;
        readonly modelName?: string;
      },
    ): Promise<void> => {
      const { eventName, payload, conversationId, ownConversationId, modelName } = input;
      let child = context.foreignConversations.get(conversationId);
      if (!child) {
        child = {
          pendingTools: [],
          surfacedToolCallCounts: new Map(),
          hookToolCallCounts: new Map(),
          nextToolSequence: 0,
          terminalEmitted: false,
        };
        context.foreignConversations.set(conversationId, child);
        offer(
          withForeignProviderRefs(
            {
              ...base(context, { includeTurn: false }),
              type: "thread.started",
              payload: { providerThreadId: conversationId },
              raw: raw(eventName, payload),
            } satisfies ProviderRuntimeEvent,
            conversationId,
            ownConversationId,
          ),
        );
        offer(
          withForeignProviderRefs(
            {
              ...base(context),
              type: "turn.started",
              payload: { model: modelName ?? context.modelName ?? DEFAULT_MODEL },
              raw: raw(eventName, payload),
            } satisfies ProviderRuntimeEvent,
            conversationId,
            ownConversationId,
          ),
        );
      }
      if (child.terminalEmitted) return;
      const stepIndex =
        typeof payload.stepIdx === "number" &&
        Number.isInteger(payload.stepIdx) &&
        payload.stepIdx >= 0
          ? payload.stepIdx
          : undefined;
      if (eventName === "pre-tool" && stepIndex !== undefined) {
        const toolCall =
          payload.toolCall && typeof payload.toolCall === "object"
            ? (payload.toolCall as Record<string, unknown>)
            : undefined;
        const name = typeof toolCall?.name === "string" ? trim(toolCall.name) : undefined;
        const toolArgs =
          toolCall?.args && typeof toolCall.args === "object"
            ? (toolCall.args as Record<string, unknown>)
            : undefined;
        if (name) {
          const surfaceKey = `${stepIndex}:${name}`;
          const occurrence = nextToolOccurrence(child.hookToolCallCounts, surfaceKey);
          if (!claimToolOccurrence(child.surfacedToolCallCounts, surfaceKey, occurrence)) return;
          const itemId = RuntimeItemId.makeUnsafe(
            `antigravity-${context.activeTurnId ?? "turn"}-tool-${child.nextToolSequence++}`,
          );
          const itemType = toolItemType(name);
          child.pendingTools.push({
            stepIndex,
            itemId,
            itemType,
            name,
            ...(toolArgs ? { args: toolArgs } : {}),
          } satisfies PendingTool);
          offer(
            withForeignProviderRefs(
              {
                ...base(context, { itemId }),
                type: "item.started",
                payload: {
                  itemType,
                  status: "inProgress",
                  title: name,
                  data: buildAntigravityToolItemData(name, itemType, itemId, toolArgs),
                },
                raw: raw("tool-lifecycle", {
                  eventName,
                  stepIdx: stepIndex,
                  name,
                  args: toolArgs,
                }),
              } satisfies ProviderRuntimeEvent,
              conversationId,
              ownConversationId,
            ),
          );
        }
      } else if (eventName === "post-tool" && stepIndex !== undefined) {
        const toolCall =
          payload.toolCall && typeof payload.toolCall === "object"
            ? (payload.toolCall as Record<string, unknown>)
            : undefined;
        const name = typeof toolCall?.name === "string" ? trim(toolCall.name) : undefined;
        const pendingIndex = child.pendingTools.findIndex(
          (pending) => pending.stepIndex === stepIndex && (!name || pending.name === name),
        );
        const pending =
          pendingIndex >= 0 ? child.pendingTools.splice(pendingIndex, 1)[0] : undefined;
        if (pending) {
          const failed =
            payload.failed === true ||
            (typeof payload.error === "string" && payload.error.trim().length > 0);
          offer(
            withForeignProviderRefs(
              {
                ...base(context, { itemId: pending.itemId }),
                type: "item.completed",
                payload: {
                  itemType: pending.itemType,
                  status: failed ? "failed" : "completed",
                  title: pending.name,
                  data: buildAntigravityToolItemData(
                    pending.name,
                    pending.itemType,
                    pending.itemId,
                    pending.args,
                    payload,
                  ),
                },
                raw: raw("tool-lifecycle", {
                  eventName,
                  stepIdx: stepIndex,
                  name: pending.name,
                  failed,
                }),
              } satisfies ProviderRuntimeEvent,
              conversationId,
              ownConversationId,
            ),
          );
        }
      } else if (eventName === "stop") {
        // The subagent finished; settle its child turn. Never tear down the
        // session's own CLI process for a foreign stop.
        settleForeignConversation(context, conversationId, ownConversationId, child, {
          state: "completed",
          raw: raw(eventName, payload),
        });
      }
    };

    const pollHookFileOnce = async (context: AntigravitySessionContext) => {
      if (context.stopped) return;
      if (!context.eventFile) return;
      const completionSequenceBeforePoll = context.backgroundCompletionSequence;
      let latestStopStepIndex: number | undefined;
      let sawStopWithoutStepIndex = false;
      let batch: Awaited<ReturnType<typeof readCompleteAntigravityLines>>;
      try {
        batch = await readCompleteLines(context.eventFile, context.processedHookBytes);
      } catch {
        return;
      }
      if (context.stopped) return;
      context.processedHookBytes = batch.nextOffset;
      for (const line of batch.lines) {
        if (context.stopped) return;
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const eventName = line.slice(0, tab);
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(line.slice(tab + 1)) as Record<string, unknown>;
        } catch {
          continue;
        }
        const conversationId =
          typeof payload.conversationId === "string" ? payload.conversationId : undefined;
        const transcriptPath =
          typeof payload.transcriptPath === "string" ? payload.transcriptPath : undefined;
        const modelName = typeof payload.modelName === "string" ? payload.modelName : undefined;
        const ownConversationId = context.conversationId;
        if (
          conversationId !== undefined &&
          ownConversationId !== undefined &&
          conversationId !== ownConversationId
        ) {
          // The session's CLI spawned a subagent that writes into the same
          // hook stream. Forward the event to the subagent's child thread and
          // never rebind this session.
          await handleForeignHookEvent(context, {
            eventName,
            payload,
            conversationId,
            ownConversationId,
            ...(modelName ? { modelName } : {}),
          });
          continue;
        }
        const learnedConversation = conversationId && conversationId !== context.conversationId;
        if (conversationId) context.conversationId = conversationId;
        if (transcriptPath && transcriptPath !== context.transcriptPath) {
          context.transcriptPath = transcriptPath;
          context.processedTranscriptBytes = 0;
          delete context.processedTranscriptPath;
        }
        if (modelName) context.modelName = modelName;
        if (learnedConversation) {
          context.session = {
            ...context.session,
            resumeCursor: conversationId,
            updatedAt: new Date().toISOString(),
          };
          offer({
            ...base(context, { includeTurn: false }),
            type: "thread.started",
            payload: { providerThreadId: conversationId },
            raw: raw(eventName, payload),
          } satisfies ProviderRuntimeEvent);
        }
        const stepIndex =
          typeof payload.stepIdx === "number" &&
          Number.isInteger(payload.stepIdx) &&
          payload.stepIdx >= 0
            ? payload.stepIdx
            : undefined;
        if (eventName === "pre-tool" && stepIndex !== undefined) {
          const toolCall =
            payload.toolCall && typeof payload.toolCall === "object"
              ? (payload.toolCall as Record<string, unknown>)
              : undefined;
          const name = typeof toolCall?.name === "string" ? trim(toolCall.name) : undefined;
          const toolArgs =
            toolCall?.args && typeof toolCall.args === "object"
              ? (toolCall.args as Record<string, unknown>)
              : undefined;
          if (name) {
            const surfaceKey = `${stepIndex}:${name}`;
            const occurrence = nextToolOccurrence(context.hookToolCallCounts, surfaceKey);
            if (!claimToolOccurrence(context.surfacedToolCallCounts, surfaceKey, occurrence)) {
              // The transcript already surfaced this call as a completed item;
              // there is no pending lifecycle to open or close for it.
              continue;
            }
            const itemId = RuntimeItemId.makeUnsafe(
              `antigravity-${context.activeTurnId ?? "turn"}-tool-${context.nextToolSequence++}`,
            );
            const itemType = toolItemType(name);
            const pending = {
              stepIndex,
              itemId,
              itemType,
              name,
              ...(toolArgs ? { args: toolArgs } : {}),
            } satisfies PendingTool;
            context.pendingTools.push(pending);
            offer({
              ...base(context, { itemId }),
              type: "item.started",
              payload: {
                itemType: pending.itemType,
                status: "inProgress",
                title: pending.name,
                data: buildAntigravityToolItemData(name, itemType, itemId, toolArgs),
              },
              raw: raw("tool-lifecycle", { eventName, stepIdx: stepIndex, name, args: toolArgs }),
            } satisfies ProviderRuntimeEvent);
          }
        } else if (eventName === "post-tool") {
          const toolCall =
            payload.toolCall && typeof payload.toolCall === "object"
              ? (payload.toolCall as Record<string, unknown>)
              : undefined;
          const name = typeof toolCall?.name === "string" ? trim(toolCall.name) : undefined;
          const hookArgs =
            toolCall?.args && typeof toolCall.args === "object"
              ? (toolCall.args as Record<string, unknown>)
              : undefined;
          const pendingIndex =
            stepIndex === undefined
              ? -1
              : context.pendingTools.findIndex(
                  (pending) => pending.stepIndex === stepIndex && (!name || pending.name === name),
                );
          const pending =
            pendingIndex >= 0 ? context.pendingTools.splice(pendingIndex, 1)[0] : undefined;
          const toolName = pending?.name ?? name;
          const toolArgs = pending?.args ?? hookArgs;
          const failed =
            payload.failed === true ||
            (typeof payload.error === "string" && payload.error.trim().length > 0);
          if (pending) {
            offer({
              ...base(context, { itemId: pending.itemId }),
              type: "item.completed",
              payload: {
                itemType: pending.itemType,
                status: failed ? "failed" : "completed",
                title: pending.name,
                data: buildAntigravityToolItemData(
                  pending.name,
                  pending.itemType,
                  pending.itemId,
                  pending.args,
                  payload,
                ),
              },
              raw: raw("tool-lifecycle", {
                eventName,
                stepIdx: stepIndex,
                name: pending.name,
                failed,
              }),
            } satisfies ProviderRuntimeEvent);
          }

          if (!failed && toolName) {
            const bgStart = detectAntigravityBackgroundTaskStart(toolName, toolArgs, payload);
            if (bgStart?.isBackground) {
              registerBackgroundTask(context, bgStart, toolItemType(toolName), {
                name: toolName,
                ...(toolArgs ? { args: toolArgs } : {}),
              });
            } else if (toolName === "manage_task") {
              const action = typeof toolArgs?.Action === "string" ? toolArgs.Action : undefined;
              const targetTaskId =
                typeof toolArgs?.TaskId === "string" ? toolArgs.TaskId : undefined;
              const matchedId =
                action === "kill" && targetTaskId
                  ? matchAntigravityTrackedTaskId(
                      targetTaskId,
                      context.pendingBackgroundTasks.keys(),
                    )
                  : undefined;
              if (matchedId) {
                context.pendingBackgroundTasks.delete(matchedId);
                offer({
                  ...base(context),
                  type: "task.updated",
                  payload: {
                    taskId: RuntimeTaskId.makeUnsafe(matchedId),
                    status: "killed",
                  },
                  raw: raw("background-task-killed", { taskId: matchedId }),
                } satisfies ProviderRuntimeEvent);
              } else if (action === "kill" && targetTaskId) {
                context.pendingAnonymousBackgroundTasks = Math.max(
                  0,
                  context.pendingAnonymousBackgroundTasks - 1,
                );
              }
            }
          }
        }
        // Agent finished: if the print process lingers, tear it down so the
        // close handler (or interrupt fallback) can settle the turn (#465).
        // Skip the teardown while background tasks are pending: the CLI stays
        // alive by design to wait for the background completion and stream the
        // follow-up response; killing it aborts the task and fails the turn
        // with "Error: timeout waiting for response" (#752).
        if (eventName === "stop") {
          if (stepIndex === undefined) {
            sawStopWithoutStepIndex = true;
          } else {
            latestStopStepIndex = Math.max(latestStopStepIndex ?? -1, stepIndex);
          }
        }
      }
      await readTranscript(context);
      if (context.stopped) return;
      const completionStepIndex = context.latestBackgroundCompletionStepIndex;
      const completionObservedDuringPoll =
        context.backgroundCompletionSequence > completionSequenceBeforePoll;
      const indexedStopFollowsLatestCompletion =
        latestStopStepIndex !== undefined &&
        (completionStepIndex !== undefined
          ? latestStopStepIndex > completionStepIndex
          : !completionObservedDuringPoll);
      const unindexedStopFollowsLatestCompletion =
        sawStopWithoutStepIndex && !completionObservedDuringPoll;
      const stopFollowsLatestCompletion =
        indexedStopFollowsLatestCompletion || unindexedStopFollowsLatestCompletion;
      if (stopFollowsLatestCompletion) teardownStoppedTurnIfIdle(context);
    };

    const pollHookFile = (context: AntigravitySessionContext): Promise<void> => {
      if (context.hookPollPromise) return context.hookPollPromise;
      const poll = pollHookFileOnce(context).finally(() => {
        if (context.hookPollPromise === poll) delete context.hookPollPromise;
      });
      context.hookPollPromise = poll;
      return poll;
    };

    const startSession: AntigravityAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.runtimeMode !== "full-access") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session/start",
            issue:
              "Antigravity CLI print mode cannot pause for interactive approvals. Select Full access to use this provider.",
          });
        }
        const binaryPath = trim(input.providerOptions?.antigravity?.binaryPath) ?? "agy";
        yield* Effect.tryPromise({
          try: () =>
            (dependencies.ensurePlugin ?? ensureCapturePlugin)(
              binaryPath,
              agentGatewayCredentials?.stdioProxy,
            ),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "plugin/install",
              detail: messageFromCause(cause, "Failed to install the Synara capture hook."),
              cause,
            }),
        });
        const existing = sessions.get(input.threadId);
        if (existing) {
          existing.stopped = true;
          existing.interrupted = true;
          killPendingBackgroundTasks(existing, "session-restart-background-task-killed");
          settleForeignConversations(existing, {
            state: "interrupted",
            raw: raw("session-restart", { threadId: input.threadId }),
          });
          yield* cancelAgentGatewayTurn(existing.gatewaySessionLease, existing.activeTurnId);
          yield* teardownActiveProcess(existing, "session/restart");
          releaseTurnGatewayLease(existing);
        }
        const now = new Date().toISOString();
        const conversationId = resumeConversationId(input.resumeCursor);
        const modelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = modelSelection?.model ?? DEFAULT_MODEL;
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: trim(input.cwd) ?? serverConfig.cwd,
          model,
          threadId: input.threadId,
          ...(conversationId ? { resumeCursor: conversationId } : {}),
          createdAt: now,
          updatedAt: now,
        };
        const context: AntigravitySessionContext = {
          session,
          ...(input.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: input.lifecycleGeneration }
            : {}),
          binaryPath,
          turns: [],
          ...(conversationId ? { conversationId } : {}),
          ...(modelSelection?.options ? { modelOptions: modelSelection.options } : {}),
          ...(conversationId
            ? { transcriptPath: transcriptPathForConversation(conversationId) }
            : {}),
          processedHookBytes: 0,
          processedTranscriptBytes: 0,
          processedSteps: new Set(),
          pendingTools: [],
          nextToolSequence: 0,
          pendingBackgroundTasks: new Map(),
          pendingAnonymousBackgroundTasks: 0,
          pendingBackgroundTaskCompletions: [],
          backgroundCompletionSequence: 0,
          foreignConversations: new Map(),
          surfacedToolCallCounts: new Map(),
          hookToolCallCounts: new Map(),
          sawAssistant: false,
          interrupted: false,
          stopped: false,
          turnTerminalEmitted: false,
        };
        sessions.set(input.threadId, context);
        offer({
          ...base(context, { includeTurn: false }),
          type: "session.started",
          payload: {
            message: "Antigravity CLI session started",
            ...(conversationId ? { resume: conversationId } : {}),
          },
        } satisfies ProviderRuntimeEvent);
        offer({
          ...base(context, { includeTurn: false }),
          type: "thread.started",
          payload: { ...(conversationId ? { providerThreadId: conversationId } : {}) },
        } satisfies ProviderRuntimeEvent);
        return session;
      });

    const sendTurn: AntigravityAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.activeProcess) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "turn/start",
            issue: "An Antigravity turn is already active for this thread.",
          });
        }
        const prompt = appendFileAttachmentsPromptBlock({
          text: input.input,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        });
        const normalizedPrompt = trim(prompt);
        if (!normalizedPrompt) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "turn/start",
            issue: "A prompt or file attachment is required.",
          });
        }
        const canBootstrapGateway = agentGatewayCredentials !== undefined;
        const providerPrompt = buildAntigravityTurnPrompt(context, {
          prompt: normalizedPrompt,
          hasGatewaySessionLease: canBootstrapGateway,
        });
        const promptIssue = antigravityPromptCommandLineIssue(providerPrompt);
        if (promptIssue) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "turn/start",
            issue: promptIssue,
          });
        }
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const modelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = modelSelection?.model ?? context.session.model ?? DEFAULT_MODEL;
        const modelOptions = modelSelection?.options ?? context.modelOptions;
        const cliModel = resolveAntigravityCliModelLabel(
          model,
          modelOptions,
          defaultEffortByModel.get(model),
        );
        const runDir = yield* Effect.tryPromise({
          try: () => fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-")),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/prepare",
              detail: messageFromCause(cause, "Failed to prepare Antigravity turn files."),
              cause,
            }),
        });
        const eventFile = path.join(runDir, "hooks.ndjson");
        const logFile = path.join(runDir, "agy.log");
        yield* Effect.tryPromise({
          try: () => fs.writeFile(eventFile, ""),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/prepare",
              detail: messageFromCause(cause, "Failed to create the Antigravity hook stream."),
              cause,
            }),
        });
        const gatewaySessionLease = acquireAgentGatewaySessionLease(
          agentGatewayCredentials,
          input.threadId,
          PROVIDER,
        );
        const gatewayBootstrapToken = gatewaySessionLease?.issueStdioBootstrapToken?.();
        if (gatewaySessionLease && !gatewayBootstrapToken) {
          gatewaySessionLease.release();
          yield* Effect.promise(() => fs.rm(runDir, { recursive: true, force: true }));
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/prepare",
            detail: "The Synara gateway credential is no longer active for this provider turn.",
          });
        }
        if (gatewaySessionLease) context.gatewaySessionLease = gatewaySessionLease;
        context.activeTurnId = turnId;
        context.activePrompt = providerPrompt;
        if (modelOptions) {
          context.modelOptions = modelOptions;
        } else {
          delete context.modelOptions;
        }
        context.eventFile = eventFile;
        context.processedHookBytes = 0;
        context.processedSteps.clear();
        yield* Effect.promise(() => markExistingTranscriptStepsProcessed(context));
        context.pendingTools = [];
        context.pendingAnonymousBackgroundTasks = 0;
        context.pendingBackgroundTaskCompletions.length = 0;
        context.backgroundCompletionSequence = 0;
        delete context.latestBackgroundCompletionStepIndex;
        context.nextToolSequence = 0;
        context.foreignConversations.clear();
        context.surfacedToolCallCounts.clear();
        context.hookToolCallCounts.clear();
        context.sawAssistant = false;
        context.interrupted = false;
        context.turnTerminalEmitted = false;
        context.turns.push({ id: turnId, items: [] });
        context.session = {
          ...context.session,
          status: "running",
          model,
          activeTurnId: turnId,
          updatedAt: new Date().toISOString(),
        };
        offer({
          ...base(context),
          type: "turn.started",
          payload: { model },
        } satisfies ProviderRuntimeEvent);

        const conversationId = context.conversationId;
        const args: string[] = [
          ...(conversationId ? ["--conversation", conversationId] : ["--new-project"]),
          "--dangerously-skip-permissions",
          "--model",
          cliModel,
          "--log-file",
          logFile,
          "--print-timeout",
          PRINT_TIMEOUT,
          "-p",
          providerPrompt,
        ];
        let child: AntigravityChildProcess;
        try {
          const spawnProcess =
            dependencies.spawnProcess ??
            ((command: string, spawnArgs: readonly string[], options: SpawnOptions) =>
              spawn(command, spawnArgs, options) as AntigravityChildProcess);
          child = spawnProcess(context.binaryPath, args, {
            cwd: context.session.cwd ?? serverConfig.cwd,
            env: buildAntigravityTurnProcessEnvironment({
              eventFile,
              ...(gatewaySessionLease && gatewayBootstrapToken
                ? {
                    gatewayConnection: gatewaySessionLease.connection,
                    gatewayBootstrapToken,
                  }
                : {}),
            }),
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (cause) {
          releaseTurnGatewayLease(context, gatewaySessionLease);
          yield* Effect.promise(() => fs.rm(runDir, { recursive: true, force: true }));
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: messageFromCause(cause, "Failed to launch Antigravity CLI."),
            cause,
          });
        }
        context.activeProcess = child;
        const ownsTurn = () =>
          sessions.get(input.threadId) === context &&
          context.activeProcess === child &&
          context.activeTurnId === turnId;
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const timer = setInterval(() => {
          if (ownsTurn()) void pollHookFile(context);
        }, POLL_INTERVAL_MS);
        child.once("error", (cause) => {
          clearInterval(timer);
          if (!ownsTurn()) return;
          offer({
            ...base(context, { includeTurn: false }),
            type: "runtime.error",
            payload: {
              message: messageFromCause(cause, "Failed to launch Antigravity CLI."),
              class: "transport_error",
            },
            raw: raw("process-error", cause),
          } satisfies ProviderRuntimeEvent);
        });
        child.once("close", (code, signal) => {
          clearInterval(timer);
          void (async () => {
            if (!ownsTurn()) {
              releaseTurnGatewayLease(context, gatewaySessionLease);
              await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
              return;
            }
            // Another path may already have settled (interrupt / stop-hook kill).
            // Still drain hooks/stdout before deciding, but never double-complete.
            const completedTurnId = turnId;
            await Effect.runPromise(cancelAgentGatewayTurn(gatewaySessionLease, completedTurnId));
            if (!ownsTurn()) {
              releaseTurnGatewayLease(context, gatewaySessionLease);
              await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
              return;
            }
            // Each `agy -p` invocation owns a fresh gateway session. Revoke it as
            // soon as that process exits, before post-processing or a later turn
            // can begin, so an unconsumed bootstrap from this turn cannot cross
            // into the next turn's authority.
            releaseTurnGatewayLease(context, gatewaySessionLease);
            const pollInFlightAtClose = context.hookPollPromise;
            if (pollInFlightAtClose) {
              await pollInFlightAtClose.catch(() => undefined);
              if (!ownsTurn()) {
                await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
                return;
              }
            }
            await pollHookFile(context).catch(() => undefined);
            if (!ownsTurn()) {
              await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
              return;
            }
            if (!context.sawAssistant && stdout.trim()) {
              emitTextItem(
                context,
                {
                  step_index: Number.MAX_SAFE_INTEGER,
                  type: "PRINT_OUTPUT",
                  content: stdout.trim(),
                },
                "assistant_message",
                "assistant_text",
              );
            }
            if (context.turnTerminalEmitted) {
              if (context.activeProcess === child) delete context.activeProcess;
              await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
              return;
            }
            const interrupted = context.interrupted || signal !== null;
            const failed = !interrupted && (code ?? 1) !== 0;
            if (failed && stderr.trim()) {
              offer({
                ...base(context, { includeTurn: false }),
                type: "runtime.error",
                payload: { message: stderr.trim(), class: "provider_error" },
                raw: raw("stderr", { code, stderr }),
              } satisfies ProviderRuntimeEvent);
            }
            settleActiveTurn(context, {
              state: interrupted ? "interrupted" : failed ? "failed" : "completed",
              stopReason: interrupted ? "interrupted" : failed ? "error" : "model_stop",
              ...(failed
                ? {
                    errorMessage: stderr.trim() || `Antigravity CLI exited with code ${code ?? 1}.`,
                  }
                : {}),
              raw: raw("process-exit", { code, signal, stdout, stderr }),
            });
            await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
          })();
        });
        return {
          threadId: input.threadId,
          turnId,
          ...(context.conversationId ? { resumeCursor: context.conversationId } : {}),
        };
      });

    const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== context.activeTurnId) {
          yield* Effect.logWarning("antigravity.stale_interrupt_ignored", {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: context.activeTurnId,
          });
          return;
        }
        killPendingBackgroundTasks(context, "interrupt-background-task-killed");
        const activeTurnId = turnId ?? context.activeTurnId;
        yield* withAgentGatewayTurnCancellation(
          context.gatewaySessionLease,
          activeTurnId,
          Effect.gen(function* () {
            context.interrupted = true;
            const hadProcess = context.activeProcess !== undefined;
            if (hadProcess) {
              // Prefer process close for settlement so stdout/hooks still drain.
              // If teardown cannot prove exit, force-settle so Cancel never no-ops (#465).
              yield* teardownActiveProcess(context, "turn/interrupt").pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    const detail =
                      error instanceof ProviderAdapterRequestError
                        ? error.detail
                        : messageFromCause(error, "interrupt teardown failed");
                    yield* Effect.logWarning("antigravity.interrupt_teardown_failed", {
                      threadId,
                      detail,
                    });
                    settleActiveTurn(context, {
                      state: "interrupted",
                      stopReason: "interrupted",
                      raw: raw("interrupt-teardown-failed", { detail }),
                    });
                  }),
                ),
              );
            }
            // Process already gone (or never attached) but turn still open — Cancel
            // must still unlock the composer.
            if (!context.turnTerminalEmitted && context.activeTurnId !== undefined) {
              settleActiveTurn(context, {
                state: "interrupted",
                stopReason: "interrupted",
                raw: raw("interrupt-without-process", {
                  hadProcess,
                }),
              });
            }
          }),
        );
      });

    const unsupported = (threadId: ThreadId, method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `Antigravity CLI print mode does not expose interactive requests for ${threadId}.`,
        }),
      );

    const stopSession: AntigravityAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        context.stopped = true;
        context.interrupted = true;
        killPendingBackgroundTasks(context, "session-stop-background-task-killed");
        settleForeignConversations(context, {
          state: "interrupted",
          raw: raw("session-stop", { threadId }),
        });
        yield* cancelAgentGatewayTurn(context.gatewaySessionLease, context.activeTurnId);
        yield* teardownActiveProcess(context, "session/stop");
        releaseTurnGatewayLease(context);
        sessions.delete(threadId);
        offer({
          ...base(context, { includeTurn: false }),
          type: "session.exited",
          payload: { reason: "stopped", exitKind: "graceful" },
        } satisfies ProviderRuntimeEvent);
      });

    const snapshot = (context: AntigravitySessionContext): ProviderThreadSnapshot => ({
      threadId: context.session.threadId,
      ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
      turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    });

    const rollbackThread: AntigravityAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      requireSession(threadId).pipe(
        Effect.map((context) => {
          context.turns.splice(Math.max(0, context.turns.length - Math.max(0, numTurns)));
          // Antigravity has no rollback cursor; ProviderService will rebuild local context.
          delete context.conversationId;
          delete context.transcriptPath;
          delete context.processedTranscriptPath;
          context.processedTranscriptBytes = 0;
          context.processedSteps.clear();
          const { resumeCursor: _resumeCursor, ...sessionWithoutResume } = context.session;
          context.session = sessionWithoutResume;
          return snapshot(context);
        }),
      );

    const listModels: NonNullable<AntigravityAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const result = await runAntigravityHelperProcess(
            trim(input.binaryPath) ?? "agy",
            ["models"],
            {
              ...(input.cwd ? { cwd: input.cwd } : {}),
              timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
            },
          );
          if (result.code !== 0) throw new Error(result.stderr || "agy models failed");
          const models = parseModelLines(result.stdout);
          for (const model of models) {
            if (model.defaultReasoningEffort) {
              defaultEffortByModel.set(model.slug, model.defaultReasoningEffort);
            }
          }
          return {
            models,
            source: "antigravity.cli",
            cached: false,
          } satisfies ProviderListModelsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: messageFromCause(cause, "Failed to list Antigravity models."),
            cause,
          }),
      });

    const stopAll = () => settleConcurrentTeardowns(sessions.keys(), stopSession);

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.ignore,
        Effect.andThen(eventIngress.stop),
        Effect.andThen(Queue.shutdown(eventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
        conversationRollback: "restart-session",
        supportsRuntimeModelList: true,
        supportsLiveTurnDiffPatch: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (threadId) => unsupported(threadId, "request/respond"),
      respondToUserInput: (threadId) => unsupported(threadId, "user-input/respond"),
      stopSession,
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) => requireSession(threadId).pipe(Effect.map(snapshot)),
      rollbackThread,
      stopAll,
      listModels,
      getComposerCapabilities: () =>
        Effect.succeed({
          provider: PROVIDER,
          supportsSkillMentions: true,
          supportsSkillDiscovery: true,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          supportsThreadCompaction: false,
          supportsThreadImport: false,
        } satisfies ProviderComposerCapabilities),
      get streamEvents() {
        return Stream.fromQueue(eventQueue);
      },
    } satisfies AntigravityAdapterShape;
  });

export const AntigravityAdapterLive = Layer.effect(AntigravityAdapter, makeAntigravityAdapter());

export function makeAntigravityAdapterLive(dependencies: AntigravityAdapterDependencies = {}) {
  return Layer.effect(AntigravityAdapter, makeAntigravityAdapter(dependencies));
}
