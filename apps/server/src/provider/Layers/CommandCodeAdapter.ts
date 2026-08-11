import crypto from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import {
  type CommandCodeModelOptions,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  type ThreadTokenUsageSnapshot,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, Option, Queue, Stream } from "effect";

import {
  type SynaraHarnessPolicyDeliveryState,
  takeSynaraHarnessPolicyForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  CommandCodeAdapter,
  type CommandCodeAdapterShape,
} from "../Services/CommandCodeAdapter.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { makeBoundedCallbackIngress } from "../boundedCallbackIngress.ts";
import {
  compactProviderRuntimeEventForIngress,
  isTerminalProviderRuntimeEvent,
  PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
  PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
  providerRuntimeEventBytes,
} from "../providerRuntimeEventIngress.ts";
import { teardownChildProcessTree } from "../supervisedProcessTeardown.ts";
import { nonNegativeInteger } from "../tokenUsage.ts";

const PROVIDER = "commandcode" as const;
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const PRINT_MAX_TURNS = 100;
const COMMANDCODE_REASONING_EFFORTS = ["low", "medium", "high"] as const;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const HELPER_OUTPUT_MAX_CHARS = 128 * 1024;
const WINDOWS_PROMPT_MAX_CHARS = 24_000;

type StoredTurn = {
  readonly id: TurnId;
  readonly items: unknown[];
};

type CommandCodeSessionContext = {
  harnessPolicyDelivered?: boolean | undefined;
  session: ProviderSession;
  readonly lifecycleGeneration?: string;
  readonly binaryPath: string;
  readonly turns: StoredTurn[];
  activeTurnId?: TurnId | undefined;
  activeProcess?: ChildProcess | undefined;
  sessionId?: string | undefined;
  modelName?: string | undefined;
  modelOptions?: CommandCodeModelOptions | undefined;
  openReasoningItemId?: RuntimeItemId | undefined;
  openAssistantItemId?: RuntimeItemId | undefined;
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

function resumeSessionId(value: unknown): string | undefined {
  if (typeof value === "string") return trim(value);
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["sessionId", "providerThreadId", "id"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cliModelFromSelection(
  model: string | undefined,
  options: CommandCodeModelOptions | undefined,
): { readonly model?: string; readonly effort?: string } {
  const resolvedModel = trim(model);
  const effort = trim(options?.reasoningEffort);
  return {
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(effort ? { effort } : {}),
  };
}

/**
 * Command Code `-p --output-format json` emits NDJSON frames: either
 * `{"type":"event","event":{...}}` for streaming lifecycle events or a final
 * `{"type":"result",...}` line carrying the session id, usage, and final text.
 * Result frames can be interleaved with events, so both are parsed by the same
 * line splitter and dispatched here.
 */
type CommandCodeFrame = Record<string, unknown> & { readonly type?: unknown };

function parseCommandCodeFrame(line: string): CommandCodeFrame | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CommandCodeFrame)
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolItemType(toolName: string): "command_execution" | "file_change" | "dynamic_tool_call" {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("shell") || normalized.includes("command") || normalized === "bash") {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("file")
  ) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

function normalizeCommandCodeUsage(input: unknown): ThreadTokenUsageSnapshot | undefined {
  if (!isRecord(input)) return undefined;
  const inputTokens = nonNegativeInteger(input.inputTokens);
  const outputTokens = nonNegativeInteger(input.outputTokens);
  const cacheReadTokens = nonNegativeInteger(input.cacheReadTokens);
  const cacheWriteTokens = nonNegativeInteger(input.cacheWriteTokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  const cachedInputTokens = cacheReadTokens + cacheWriteTokens;
  const totalProcessedTokens = inputTokens + cachedInputTokens + outputTokens;
  if (totalProcessedTokens <= 0) {
    return undefined;
  }
  return {
    usedTokens: totalProcessedTokens,
    totalProcessedTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    lastUsedTokens: totalProcessedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
    lastReasoningOutputTokens: 0,
  };
}

/**
 * Parse the grouped `cmd --list-models` table. Each model line is
 * `<slug>\s+<description>`; section headers ("Open Source", "Anthropic", ...)
 * are capitalized words without a trailing description and are skipped.
 */
export function parseCommandCodeModelLines(output: string): ProviderListModelsResult["models"] {
  const models: Array<ProviderListModelsResult["models"][number]> = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || /^available models/i.test(trimmed)) continue;
    const match = /^(\S+)\s+(\S.*)$/u.exec(trimmed);
    if (!match?.[1] || !match[2]) continue;
    const slug = match[1];
    const description = match[2].trim();
    // Section headers are capitalized words; model slugs are lowercase ids
    // (possibly `provider/model`). "Open Source" -> slug "Open" -> skipped.
    if (slug.toLowerCase() !== slug && !slug.includes("/")) continue;
    if (!/^[a-z0-9][a-z0-9._/-]*$/iu.test(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: slug,
      ...(description ? { description } : {}),
      supportedReasoningEfforts: COMMANDCODE_REASONING_EFFORTS.map((value) => ({ value })),
    });
  }
  return models;
}

export function commandCodePromptCommandLineIssue(
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32" || prompt.length <= WINDOWS_PROMPT_MAX_CHARS) {
    return null;
  }
  return `Command Code prompts on Windows are limited to ${WINDOWS_PROMPT_MAX_CHARS.toLocaleString("en-US")} characters because the CLI accepts print-mode prompts as command-line arguments. Shorten the prompt or attach the content as files.`;
}

function makeCommandCodeRuntimeEventBase(input: {
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

function appendBoundedOutput(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  return next.length > HELPER_OUTPUT_MAX_CHARS ? next.slice(-HELPER_OUTPUT_MAX_CHARS) : next;
}

export async function runCommandCodeHelperProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
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
            `Command Code helper timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`,
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

type CommandCodeChildProcess = ChildProcess & {
  readonly stdout: NonNullable<ChildProcess["stdout"]>;
  readonly stderr: NonNullable<ChildProcess["stderr"]>;
};

export interface CommandCodeAdapterDependencies {
  readonly teardownProcessTree?: typeof teardownChildProcessTree;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => CommandCodeChildProcess;
  readonly runHelper?: typeof runCommandCodeHelperProcess;
}

export function buildCommandCodeTurnPrompt(
  state: SynaraHarnessPolicyDeliveryState,
  input: { readonly prompt: string },
): string {
  const harnessPolicy = takeSynaraHarnessPolicyForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable: false,
  });
  return [harnessPolicy, input.prompt].filter(Boolean).join("\n\n");
}

const makeCommandCodeAdapter = (dependencies: CommandCodeAdapterDependencies = {}) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const teardownProcessTree = dependencies.teardownProcessTree ?? teardownChildProcessTree;
    const eventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    const sessions = new Map<ThreadId, CommandCodeSessionContext>();

    const eventIngress = yield* makeBoundedCallbackIngress<ProviderRuntimeEvent, never, never>(
      (event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid),
      {
        capacity: PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
        maxBufferedBytes: PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
        terminalReserve: PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
        isTerminal: isTerminalProviderRuntimeEvent,
        sizeOf: providerRuntimeEventBytes,
      },
    );

    const offer = (event: ProviderRuntimeEvent) => {
      eventIngress.offer(compactProviderRuntimeEventForIngress(event));
    };

    const base = (
      context: CommandCodeSessionContext,
      options?: { includeTurn?: boolean; itemId?: RuntimeItemId },
    ) => ({
      ...makeCommandCodeRuntimeEventBase({
        threadId: context.session.threadId,
        ...(context.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: context.lifecycleGeneration }
          : {}),
      }),
      ...(options?.includeTurn !== false && context.activeTurnId
        ? { turnId: context.activeTurnId }
        : {}),
      ...(options?.itemId ? { itemId: options.itemId } : {}),
      ...(context.sessionId
        ? { providerRefs: { providerThreadId: context.sessionId } }
        : {}),
    });

    const raw = (messageType: string, payload: unknown) => ({
      source: "commandcode.cli.event" as const,
      messageType,
      payload,
    });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CommandCodeSessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const teardownActiveProcess = (
      context: CommandCodeSessionContext,
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
            detail: messageFromCause(cause, "Failed to stop the Command Code process tree."),
            cause,
          }),
      }).pipe(Effect.asVoid);
    };

    /**
     * Emit a single terminal turn.completed for the active turn and mark the
     * session idle. Idempotent so process-close, interrupt, and stop paths can
     * all call it without double-settling.
     */
    const settleActiveTurn = (
      context: CommandCodeSessionContext,
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
      context.turnTerminalEmitted = true;
      delete context.activeProcess;
      delete context.activeTurnId;
      context.openReasoningItemId = undefined;
      context.openAssistantItemId = undefined;
      const {
        activeTurnId: _activeTurnId,
        lastError: _lastError,
        ...inactiveSession
      } = context.session;
      const failed = input.state === "failed";
      context.session = {
        ...inactiveSession,
        status: failed ? "error" : "ready",
        ...(context.sessionId ? { resumeCursor: context.sessionId } : {}),
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
                  errorMessage: input.errorMessage ?? "Command Code turn failed.",
                }
              : { state: "completed", stopReason: "model_stop" },
        ...(input.raw ? { raw: input.raw } : {}),
      } satisfies ProviderRuntimeEvent);
      return true;
    };

    const currentTurn = (context: CommandCodeSessionContext): StoredTurn | undefined =>
      context.activeTurnId
        ? context.turns.find((turn) => turn.id === context.activeTurnId)
        : undefined;

    const startStreamingItem = (
      context: CommandCodeSessionContext,
      kind: "reasoning" | "assistant",
    ): RuntimeItemId => {
      const openItemId =
        kind === "reasoning" ? context.openReasoningItemId : context.openAssistantItemId;
      if (openItemId) return openItemId;
  const itemId = RuntimeItemId.makeUnsafe(
    `commandcode-${context.activeTurnId ?? "turn"}-${kind}-${crypto.randomUUID()}`,
  );
  if (kind === "reasoning") {
    context.openReasoningItemId = itemId;
  } else {
    context.openAssistantItemId = itemId;
    context.sawAssistant = true;
  }
  currentTurn(context)?.items.push({ kind, itemId });
  offer({
    ...base(context, { itemId }),
    type: "item.started",
    payload: {
      itemType: kind === "reasoning" ? "reasoning" : "assistant_message",
      status: "inProgress",
      title: kind === "reasoning" ? "Reasoning" : "Assistant",
    },
    raw: raw("stream-item-started", { kind }),
  } satisfies ProviderRuntimeEvent);
  return itemId;
};

    const completeStreamingItem = (
      context: CommandCodeSessionContext,
      kind: "reasoning" | "assistant",
      detail?: string,
    ): void => {
      const itemId = kind === "reasoning" ? context.openReasoningItemId : context.openAssistantItemId;
      if (!itemId) return;
      if (kind === "reasoning") {
        context.openReasoningItemId = undefined;
      } else {
        context.openAssistantItemId = undefined;
      }
      offer({
        ...base(context, { itemId }),
        type: "item.completed",
        payload: {
          itemType: kind === "reasoning" ? "reasoning" : "assistant_message",
          status: "completed",
          title: kind === "reasoning" ? "Reasoning" : "Assistant",
          ...(detail ? { detail } : {}),
        },
        raw: raw("stream-item-completed", { kind }),
      } satisfies ProviderRuntimeEvent);
    };

    const pendingToolIds = new Map<string, RuntimeItemId>();

    const startToolItem = (
      context: CommandCodeSessionContext,
      toolCallId: string,
      toolName: string,
    ): RuntimeItemId => {
      const existing = pendingToolIds.get(toolCallId);
      if (existing) return existing;
      const itemId = RuntimeItemId.makeUnsafe(
        `commandcode-${context.activeTurnId ?? "turn"}-tool-${crypto.randomUUID()}`,
      );
      pendingToolIds.set(toolCallId, itemId);
      currentTurn(context)?.items.push({ toolCallId, toolName, itemId });
      offer({
        ...base(context, { itemId }),
        type: "item.started",
        payload: {
          itemType: toolItemType(toolName),
          status: "inProgress",
          title: toolName,
          data: { toolCallId, toolName },
        },
        raw: raw("tool-lifecycle", { event: "tool_running", toolCallId, toolName }),
      } satisfies ProviderRuntimeEvent);
      return itemId;
    };

    const completeToolItem = (
      context: CommandCodeSessionContext,
      toolCallId: string,
      toolName: string,
      result: unknown,
      failed: boolean,
    ): void => {
      const itemId = pendingToolIds.get(toolCallId);
      if (!itemId) return;
      pendingToolIds.delete(toolCallId);
      const resultText = Array.isArray(result)
        ? result
            .filter((part) => isRecord(part) && typeof part.text === "string")
            .map((part) => String(part.text))
            .join("\n")
            .trim()
        : undefined;
      offer({
        ...base(context, { itemId }),
        type: "item.completed",
        payload: {
          itemType: toolItemType(toolName),
          status: failed ? "failed" : "completed",
          title: toolName,
          ...(resultText ? { detail: resultText } : {}),
          data: { toolCallId, toolName },
        },
        raw: raw("tool-lifecycle", {
          event: "tool_completed",
          toolCallId,
          toolName,
          failed,
        }),
      } satisfies ProviderRuntimeEvent);
    };

    const handleCliEvent = (context: CommandCodeSessionContext, event: CommandCodeFrame): void => {
      const eventType = typeof event.type === "string" ? event.type : "";
      const sessionId =
        typeof event.sessionId === "string" && event.sessionId.trim()
          ? event.sessionId.trim()
          : undefined;
      if (sessionId) {
        const learned = !context.sessionId && sessionId !== context.session.resumeCursor;
        context.sessionId = sessionId;
        if (learned) {
          context.session = {
            ...context.session,
            resumeCursor: sessionId,
            updatedAt: new Date().toISOString(),
          };
          offer({
            ...base(context, { includeTurn: false }),
            type: "thread.started",
            payload: { providerThreadId: sessionId },
            raw: raw(eventType, event),
          } satisfies ProviderRuntimeEvent);
        }
      }
      if (typeof event.model === "string" && event.model.trim()) {
        context.modelName = event.model.trim();
      }
      switch (eventType) {
        case "thinking_delta": {
          const delta = nonEmptyText(event.delta);
          if (!delta) return;
          const itemId = startStreamingItem(context, "reasoning");
          offer({
            ...base(context, { itemId }),
            type: "content.delta",
            payload: { streamKind: "reasoning_text", delta },
            raw: raw(eventType, event),
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "thinking_end": {
          completeStreamingItem(context, "reasoning", nonEmptyText(event.text));
          return;
        }
        case "text_delta": {
          const delta = nonEmptyText(event.delta);
          if (!delta) return;
          const itemId = startStreamingItem(context, "assistant");
          offer({
            ...base(context, { itemId }),
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta },
            raw: raw(eventType, event),
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "message_end": {
          completeStreamingItem(context, "reasoning");
          completeStreamingItem(context, "assistant");
          return;
        }
        case "turn_end": {
          completeStreamingItem(context, "reasoning");
          completeStreamingItem(context, "assistant");
          const usage = normalizeCommandCodeUsage(event.usage);
          if (usage) {
            offer({
              ...base(context, { includeTurn: false }),
              type: "thread.token-usage.updated",
              payload: { usage },
              raw: raw(eventType, event),
            } satisfies ProviderRuntimeEvent);
          }
          return;
        }
        case "tool_queued":
        case "tool_running": {
          const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
          const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
          if (toolCallId) {
            startToolItem(context, toolCallId, toolName);
          }
          return;
        }
        case "tool_update": {
          // Streamed partial tool output (e.g. shell stdout) is progress detail
          // for the open tool row; the terminal result arrives via tool_completed.
          return;
        }
        case "tool_completed":
        case "tool_error": {
          const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
          const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
          if (toolCallId) {
            completeToolItem(
              context,
              toolCallId,
              toolName,
              event.result ?? event.error,
              eventType === "tool_error" || isRecord(event.error),
            );
          }
          return;
        }
        case "run_end": {
          const result = isRecord(event.result) ? event.result : undefined;
          const nextState = isRecord(result?.nextState) ? result.nextState : undefined;
          const runSessionId =
            typeof result?.sessionId === "string"
              ? result.sessionId
              : typeof nextState?.sessionId === "string"
                ? nextState.sessionId
                : undefined;
          if (runSessionId && !context.sessionId) {
            context.sessionId = runSessionId;
            context.session = {
              ...context.session,
              resumeCursor: runSessionId,
              updatedAt: new Date().toISOString(),
            };
          }
          const finalText = nonEmptyText(result?.finalText);
          if (finalText && !context.sawAssistant) {
            // Fallback: a run that produced only tool output still reports text.
            const itemId = startStreamingItem(context, "assistant");
            offer({
              ...base(context, { itemId }),
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta: finalText },
              raw: raw(eventType, event),
            } satisfies ProviderRuntimeEvent);
          }
          completeStreamingItem(context, "reasoning");
          completeStreamingItem(context, "assistant");
          return;
        }
        default:
          return;
      }
    };

    const startSession: CommandCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.runtimeMode !== "full-access") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session/start",
            issue:
              "Command Code CLI print mode cannot pause for interactive approvals. Select Full access to use this provider.",
          });
        }
        const binaryPath = trim(input.providerOptions?.commandcode?.binaryPath) ?? "cmd";
        const existing = sessions.get(input.threadId);
        if (existing) {
          existing.stopped = true;
          existing.interrupted = true;
          yield* teardownActiveProcess(existing, "session/restart");
        }
        const now = new Date().toISOString();
        const conversationId = resumeSessionId(input.resumeCursor);
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
        const context: CommandCodeSessionContext = {
          session,
          ...(input.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: input.lifecycleGeneration }
            : {}),
          binaryPath,
          turns: [],
          ...(conversationId ? { sessionId: conversationId } : {}),
          ...(modelSelection?.options ? { modelOptions: modelSelection.options } : {}),
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
            message: "Command Code CLI session started",
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

    const sendTurn: CommandCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.activeProcess) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "turn/start",
            issue: "A Command Code turn is already active for this thread.",
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
        const providerPrompt = buildCommandCodeTurnPrompt(context, { prompt: normalizedPrompt });
        const promptIssue = commandCodePromptCommandLineIssue(providerPrompt);
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
        const { model: cliModel, effort } = cliModelFromSelection(model, modelOptions);
        context.activeTurnId = turnId;
        if (modelOptions) {
          context.modelOptions = modelOptions;
        } else {
          delete context.modelOptions;
        }
        context.openReasoningItemId = undefined;
        context.openAssistantItemId = undefined;
        pendingToolIds.clear();
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

        const sessionId = context.sessionId;
        const args: string[] = [
          ...(sessionId ? ["--session", sessionId] : []),
          "-p",
          providerPrompt,
          "--output-format",
          "json",
          "--max-turns",
          String(PRINT_MAX_TURNS),
          "--skip-onboarding",
          "--yolo",
          ...(cliModel ? ["--model", cliModel] : []),
          ...(effort ? ["--effort", effort] : []),
        ];
        let child: CommandCodeChildProcess;
        try {
          const spawnProcess =
            dependencies.spawnProcess ??
            ((command: string, spawnArgs: readonly string[], options: SpawnOptions) =>
              spawn(command, spawnArgs, options) as CommandCodeChildProcess);
          child = spawnProcess(context.binaryPath, args, {
            cwd: context.session.cwd ?? serverConfig.cwd,
            env: buildProviderChildEnvironment({ provider: PROVIDER }),
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (cause) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: messageFromCause(cause, "Failed to launch Command Code CLI."),
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
        let lineBuffer = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          lineBuffer += chunk;
          let newlineIndex = lineBuffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = lineBuffer.slice(0, newlineIndex).trimEnd();
            lineBuffer = lineBuffer.slice(newlineIndex + 1);
            if (line) {
              const frame = parseCommandCodeFrame(line);
              if (frame && ownsTurn()) {
                if (frame.type === "event" && isRecord(frame.event)) {
                  handleCliEvent(context, frame.event);
                } else if (frame.type === "result" || frame.type === "error") {
                  handleCliEvent(context, frame);
                }
              }
            }
            newlineIndex = lineBuffer.indexOf("\n");
          }
        });
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", (cause) => {
          if (!ownsTurn()) return;
          offer({
            ...base(context, { includeTurn: false }),
            type: "runtime.error",
            payload: {
              message: messageFromCause(cause, "Failed to launch Command Code CLI."),
              class: "transport_error",
            },
            raw: raw("process-error", cause),
          } satisfies ProviderRuntimeEvent);
        });
        child.once("close", (code, signal) => {
          void (async () => {
            if (!ownsTurn()) return;
            const completedTurnId = turnId;
            if (!ownsTurn()) return;
            // Drain any trailing buffered NDJSON line before settling.
            if (lineBuffer) {
              const frame = parseCommandCodeFrame(lineBuffer.trimEnd());
              if (frame && ownsTurn()) {
                if (frame.type === "event" && isRecord(frame.event)) {
                  handleCliEvent(context, frame.event);
                } else if (frame.type === "result" || frame.type === "error") {
                  handleCliEvent(context, frame);
                }
              }
              lineBuffer = "";
            }
            if (!ownsTurn()) return;
            if (context.turnTerminalEmitted) {
              if (context.activeProcess === child) delete context.activeProcess;
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
            if (!interrupted && !failed && stdout.trim() && !context.sawAssistant) {
              // Fallback for print output that skipped the NDJSON event frames.
              const itemId = startStreamingItem(context, "assistant");
              offer({
                ...base(context, { itemId }),
                type: "content.delta",
                payload: { streamKind: "assistant_text", delta: stdout.trim() },
                raw: raw("print-output", { code }),
              } satisfies ProviderRuntimeEvent);
            }
            settleActiveTurn(context, {
              state: interrupted ? "interrupted" : failed ? "failed" : "completed",
              stopReason: interrupted ? "interrupted" : failed ? "error" : "model_stop",
              ...(failed
                ? {
                    errorMessage:
                      stderr.trim() || `Command Code CLI exited with code ${code ?? 1}.`,
                  }
                : {}),
              raw: raw("process-exit", { code, signal, turnId: completedTurnId }),
            });
          })();
        });
        return {
          threadId: input.threadId,
          turnId,
          ...(context.sessionId ? { resumeCursor: context.sessionId } : {}),
        };
      });

    const interruptTurn: CommandCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== context.activeTurnId) {
          yield* Effect.logWarning("commandcode.stale_interrupt_ignored", {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: context.activeTurnId,
          });
          return;
        }
        context.interrupted = true;
        yield* teardownActiveProcess(context, "turn/interrupt").pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const detail =
                error instanceof ProviderAdapterRequestError
                  ? error.detail
                  : messageFromCause(error, "interrupt teardown failed");
              yield* Effect.logWarning("commandcode.interrupt_teardown_failed", {
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
        // Process already gone (or never attached) but turn still open — Cancel
        // must still unlock the composer.
        if (!context.turnTerminalEmitted && context.activeTurnId !== undefined) {
          settleActiveTurn(context, {
            state: "interrupted",
            stopReason: "interrupted",
            raw: raw("interrupt-without-process", {}),
          });
        }
      });

    const unsupported = (threadId: ThreadId, method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `Command Code CLI print mode does not expose interactive requests for ${threadId}.`,
        }),
      );

    const stopSession: CommandCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        context.stopped = true;
        context.interrupted = true;
        yield* teardownActiveProcess(context, "session/stop");
        sessions.delete(threadId);
        offer({
          ...base(context, { includeTurn: false }),
          type: "session.exited",
          payload: { reason: "stopped", exitKind: "graceful" },
        } satisfies ProviderRuntimeEvent);
      });

    const snapshot = (context: CommandCodeSessionContext): ProviderThreadSnapshot => ({
      threadId: context.session.threadId,
      ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
      turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    });

    const rollbackThread: CommandCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      requireSession(threadId).pipe(
        Effect.map((context) => {
          context.turns.splice(Math.max(0, context.turns.length - Math.max(0, numTurns)));
          // Command Code has no rollback cursor; ProviderService rebuilds local context.
          delete context.sessionId;
          const { resumeCursor: _resumeCursor, ...sessionWithoutResume } = context.session;
          context.session = sessionWithoutResume;
          return snapshot(context);
        }),
      );

    const listModels: NonNullable<CommandCodeAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const result = await (dependencies.runHelper ?? runCommandCodeHelperProcess)(
            trim(input.binaryPath) ?? "cmd",
            ["--list-models"],
            {
              ...(input.cwd ? { cwd: input.cwd } : {}),
              timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
            },
          );
          if (result.code !== 0) throw new Error(result.stderr || "cmd --list-models failed");
          return {
            models: parseCommandCodeModelLines(result.stdout),
            source: "commandcode.cli",
            cached: false,
          } satisfies ProviderListModelsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: messageFromCause(cause, "Failed to list Command Code models."),
            cause,
          }),
      });

    const stopAll = () =>
      Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.asVoid);

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
    } satisfies CommandCodeAdapterShape;
  });

export const CommandCodeAdapterLive = Layer.effect(CommandCodeAdapter, makeCommandCodeAdapter());

export function makeCommandCodeAdapterLive(dependencies: CommandCodeAdapterDependencies = {}) {
  return Layer.effect(CommandCodeAdapter, makeCommandCodeAdapter(dependencies));
}
