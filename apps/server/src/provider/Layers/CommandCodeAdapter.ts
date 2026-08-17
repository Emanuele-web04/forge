import crypto from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import {
  EventId,
  type ProviderComposerCapabilities,
  type ProviderInteractionMode,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderReviewTarget,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, Option, Queue, Schema, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
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
import { resolveCommandCodeBinaryPath } from "../commandCodeCli.ts";
import {
  CommandCodeAdapter,
  type CommandCodeAdapterShape,
} from "../Services/CommandCodeAdapter.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";

const PROVIDER = "commandCode" as const;
const DEFAULT_MODEL = "poolside/laguna-s-2.1-free";
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const HELPER_OUTPUT_MAX_CHARS = 512 * 1024;

const CommandCodeEventLine = Schema.Struct({
  type: Schema.Literal("event"),
  event: Schema.Unknown,
});
const CommandCodeResultLine = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  usage: Schema.optional(Schema.Unknown),
  durationMs: Schema.optional(Schema.Number),
  finalText: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Unknown),
});
const CommandCodeLineJson = Schema.fromJsonString(
  Schema.Union([CommandCodeEventLine, CommandCodeResultLine]),
);
const decodeCommandCodeLine = Schema.decodeUnknownOption(CommandCodeLineJson);

type StoredTurn = { readonly id: TurnId; readonly items: unknown[] };
type ToolItemType = "command_execution" | "file_change" | "dynamic_tool_call" | "web_search";
type PendingTool = {
  readonly itemId: RuntimeItemId;
  readonly itemType: ToolItemType;
  readonly name: string;
  readonly input?: unknown;
  started: boolean;
};
type CommandCodeSessionContext = {
  session: ProviderSession;
  readonly lifecycleGeneration?: string;
  readonly binaryPath: string;
  readonly turns: StoredTurn[];
  activeProcess?: ChildProcess;
  activeTurnId?: TurnId;
  providerSessionId?: string;
  assistantItemId?: RuntimeItemId;
  reasoningItemId?: RuntimeItemId;
  readonly tools: Map<string, PendingTool>;
  lastError?: string;
  interrupted: boolean;
  terminalEmitted: boolean;
};

type CommandCodeChildProcess = ChildProcess & {
  readonly stdin: NonNullable<ChildProcess["stdin"]>;
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
}

function trim(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" ? trim(candidate) : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? Math.round(candidate)
    : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return trim(value);
  return stringField(value, "message") ?? stringField(value, "error");
}

function resumeSessionId(value: unknown): string | undefined {
  if (typeof value === "string") return trim(value);
  return (
    stringField(value, "sessionId") ??
    stringField(value, "providerThreadId") ??
    stringField(value, "id")
  );
}

function toolItemType(name: string): ToolItemType {
  const normalized = name.toLowerCase();
  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized === "bash" ||
    normalized === "exec"
  ) {
    return "command_execution";
  }
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) {
    return "file_change";
  }
  if (
    normalized.includes("web") ||
    normalized.includes("search") ||
    normalized.includes("browser")
  ) {
    return "web_search";
  }
  return "dynamic_tool_call";
}

export function parseCommandCodeModelLines(output: string): ProviderListModelsResult["models"] {
  const models: Array<ProviderListModelsResult["models"][number]> = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^(\S+\/\S+)\s{2,}(.+)$/u.exec(line);
    if (!match) continue;
    const slug = trim(match[1]);
    const description = trim(match[2]);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: slug,
      ...(description ? { description } : {}),
    });
  }
  return models;
}

export function buildCommandCodeTurnArgs(input: {
  readonly model: string;
  readonly resumeSessionId?: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly interactionMode?: ProviderInteractionMode;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    input.model,
    "--skip-onboarding",
    "--no-auto-update",
    "--max-turns",
    "100",
  ];
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  if (input.interactionMode === "plan") args.push("--plan");
  else if (input.runtimeMode === "full-access") args.push("--yolo");
  else if (input.runtimeMode === "auto") args.push("--auto-accept");
  return args;
}

export function commandCodeReviewPrompt(target: ProviderReviewTarget): string {
  return target.type === "uncommittedChanges"
    ? "Review the current uncommitted changes. Focus on correctness, regressions, security, and missing tests. Report findings first with file and line references."
    : `Review the changes on the current branch against base branch ${JSON.stringify(target.branch)}. Focus on correctness, regressions, security, and missing tests. Report findings first with file and line references.`;
}

function makeRuntimeEventBase(input: {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
}) {
  return {
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: new Date().toISOString(),
    ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
  };
}

function helperProcess(
  binaryPath: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs: number },
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd: options.cwd,
      env: buildProviderChildEnvironment({ provider: PROVIDER }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const timeoutError = new Error(`CommandCode helper timed out after ${options.timeoutMs}ms.`);
      void teardownChildProcessTree(child).then(
        () => reject(timeoutError),
        () => reject(timeoutError),
      );
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-HELPER_OUTPUT_MAX_CHARS);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-HELPER_OUTPUT_MAX_CHARS);
    });
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(cause);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
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

    const offer = (event: ProviderRuntimeEvent): void => {
      eventIngress.offer(compactProviderRuntimeEventForIngress(event));
    };
    const base = (
      context: CommandCodeSessionContext,
      options?: { readonly includeTurn?: boolean; readonly itemId?: RuntimeItemId },
    ) => ({
      ...makeRuntimeEventBase({
        threadId: context.session.threadId,
        ...(context.lifecycleGeneration
          ? { lifecycleGeneration: context.lifecycleGeneration }
          : {}),
      }),
      ...(options?.includeTurn !== false && context.activeTurnId
        ? { turnId: context.activeTurnId }
        : {}),
      ...(options?.itemId ? { itemId: options.itemId } : {}),
      ...(context.providerSessionId
        ? { providerRefs: { providerThreadId: context.providerSessionId } }
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
    const snapshot = (context: CommandCodeSessionContext): ProviderThreadSnapshot => ({
      threadId: context.session.threadId,
      ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
      turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    });

    const learnSessionId = (context: CommandCodeSessionContext, sessionId: string): void => {
      if (sessionId === context.providerSessionId) return;
      context.providerSessionId = sessionId;
      context.session = {
        ...context.session,
        resumeCursor: sessionId,
        updatedAt: new Date().toISOString(),
      };
      offer({
        ...base(context, { includeTurn: false }),
        type: "thread.started",
        payload: { providerThreadId: sessionId },
      } satisfies ProviderRuntimeEvent);
    };

    const ensureTextItem = (
      context: CommandCodeSessionContext,
      kind: "assistant" | "reasoning",
    ): RuntimeItemId => {
      const existing = kind === "assistant" ? context.assistantItemId : context.reasoningItemId;
      if (existing) return existing;
      const itemId = RuntimeItemId.makeUnsafe(
        `commandcode-${kind}-${context.activeTurnId ?? crypto.randomUUID()}`,
      );
      if (kind === "assistant") context.assistantItemId = itemId;
      else context.reasoningItemId = itemId;
      offer({
        ...base(context, { itemId }),
        type: "item.started",
        payload: {
          itemType: kind === "assistant" ? "assistant_message" : "reasoning",
          status: "inProgress",
        },
      } satisfies ProviderRuntimeEvent);
      return itemId;
    };

    const completeOpenItems = (context: CommandCodeSessionContext): void => {
      for (const [kind, itemId] of [
        ["assistant", context.assistantItemId],
        ["reasoning", context.reasoningItemId],
      ] as const) {
        if (!itemId) continue;
        offer({
          ...base(context, { itemId }),
          type: "item.completed",
          payload: {
            itemType: kind === "assistant" ? "assistant_message" : "reasoning",
            status: "completed",
          },
        } satisfies ProviderRuntimeEvent);
      }
      for (const tool of context.tools.values()) {
        if (!tool.started) continue;
        offer({
          ...base(context, { itemId: tool.itemId }),
          type: "item.completed",
          payload: {
            itemType: tool.itemType,
            status: "failed",
            title: tool.name,
            detail: "CommandCode ended before the tool reported completion.",
          },
        } satisfies ProviderRuntimeEvent);
      }
      context.tools.clear();
    };

    const settleTurn = (
      context: CommandCodeSessionContext,
      state: "completed" | "failed" | "interrupted",
      details?: { readonly stopReason?: string; readonly usage?: unknown; readonly error?: string },
    ): void => {
      if (context.terminalEmitted || !context.activeTurnId) return;
      completeOpenItems(context);
      const failed = state === "failed";
      offer({
        ...base(context),
        type: "turn.completed",
        payload: {
          state,
          ...(state === "interrupted"
            ? { stopReason: "interrupted" }
            : failed
              ? { stopReason: "error" }
              : details?.stopReason
                ? { stopReason: details.stopReason }
                : {}),
          ...(details?.usage !== undefined ? { usage: details.usage } : {}),
          ...(failed && details?.error ? { errorMessage: details.error } : {}),
        },
      } satisfies ProviderRuntimeEvent);
      context.terminalEmitted = true;
      delete context.activeProcess;
      delete context.activeTurnId;
      delete context.assistantItemId;
      delete context.reasoningItemId;
      context.session = {
        ...context.session,
        status: failed ? "error" : "ready",
        updatedAt: new Date().toISOString(),
        ...(context.providerSessionId ? { resumeCursor: context.providerSessionId } : {}),
        ...(failed && details?.error ? { lastError: details.error } : {}),
      };
    };

    const emitToolEvent = (
      context: CommandCodeSessionContext,
      eventType: string,
      event: Record<string, unknown>,
    ): void => {
      const toolCallId = stringField(event, "toolCallId");
      const toolName = stringField(event, "toolName") ?? "tool";
      if (!toolCallId) return;
      let tool = context.tools.get(toolCallId);
      if (!tool) {
        tool = {
          itemId: RuntimeItemId.makeUnsafe(`commandcode-tool-${toolCallId}`),
          itemType: toolItemType(toolName),
          name: toolName,
          ...(event.input !== undefined ? { input: event.input } : {}),
          started: false,
        };
        context.tools.set(toolCallId, tool);
      }
      if (eventType === "tool_queued") return;
      if (!tool.started) {
        tool.started = true;
        offer({
          ...base(context, { itemId: tool.itemId }),
          type: "item.started",
          payload: {
            itemType: tool.itemType,
            status: "inProgress",
            title: tool.name,
            data: { toolCallId, toolName: tool.name, input: tool.input },
          },
          raw: raw(eventType, event),
        } satisfies ProviderRuntimeEvent);
      }
      if (eventType === "tool_update") {
        offer({
          ...base(context, { itemId: tool.itemId }),
          type: "item.updated",
          payload: {
            itemType: tool.itemType,
            status: "inProgress",
            title: tool.name,
            data: { toolCallId, toolName: tool.name, partial: event.partial },
          },
          raw: raw(eventType, event),
        } satisfies ProviderRuntimeEvent);
        return;
      }
      if (
        !["tool_completed", "tool_errored", "tool_denied", "tool_hook_blocked"].includes(eventType)
      ) {
        return;
      }
      const success = eventType === "tool_completed";
      offer({
        ...base(context, { itemId: tool.itemId }),
        type: "item.completed",
        payload: {
          itemType: tool.itemType,
          status: success ? "completed" : eventType === "tool_denied" ? "declined" : "failed",
          title: tool.name,
          data: {
            toolCallId,
            toolName: tool.name,
            result: event.result,
            error: event.error,
          },
        },
        raw: raw(eventType, event),
      } satisfies ProviderRuntimeEvent);
      context.tools.delete(toolCallId);
    };

    const handleEvent = (context: CommandCodeSessionContext, value: unknown): void => {
      const event = record(value);
      const type = stringField(event, "type");
      if (!event || !type) return;
      if (type === "run_start") {
        const sessionId = stringField(event, "sessionId");
        if (sessionId) learnSessionId(context, sessionId);
        return;
      }
      if (type === "text_delta" || type === "thinking_delta") {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (!delta) return;
        const kind = type === "text_delta" ? "assistant" : "reasoning";
        const itemId = ensureTextItem(context, kind);
        offer({
          ...base(context, { itemId }),
          type: "content.delta",
          payload: {
            streamKind: kind === "assistant" ? "assistant_text" : "reasoning_text",
            delta,
          },
          raw: raw(type, event),
        } satisfies ProviderRuntimeEvent);
        return;
      }
      if (type.startsWith("tool_")) {
        emitToolEvent(context, type, event);
        return;
      }
      if (type === "run_error") {
        context.lastError =
          errorMessage(event.error) ?? errorMessage(event) ?? "CommandCode run failed.";
        offer({
          ...base(context),
          type: "runtime.error",
          payload: { class: "provider_error", message: context.lastError },
          raw: raw(type, event),
        } satisfies ProviderRuntimeEvent);
      }
    };

    const handleResult = (
      context: CommandCodeSessionContext,
      result: typeof CommandCodeResultLine.Type,
    ): void => {
      const sessionId = trim(result.sessionId);
      if (sessionId) learnSessionId(context, sessionId);
      const inputTokens = numberField(result.usage, "inputTokens") ?? 0;
      const cachedInputTokens = numberField(result.usage, "cacheReadTokens") ?? 0;
      const outputTokens = numberField(result.usage, "outputTokens") ?? 0;
      const durationMs =
        typeof result.durationMs === "number" && result.durationMs >= 0
          ? Math.round(result.durationMs)
          : undefined;
      if (
        inputTokens > 0 ||
        cachedInputTokens > 0 ||
        outputTokens > 0 ||
        durationMs !== undefined
      ) {
        offer({
          ...base(context),
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: inputTokens + cachedInputTokens + outputTokens,
              inputTokens,
              cachedInputTokens,
              outputTokens,
              lastUsedTokens: inputTokens + cachedInputTokens + outputTokens,
              lastInputTokens: inputTokens,
              lastCachedInputTokens: cachedInputTokens,
              lastOutputTokens: outputTokens,
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          },
          raw: raw("result.usage", result.usage),
        } satisfies ProviderRuntimeEvent);
      }
      const finalText = trim(result.finalText);
      if (finalText && !context.assistantItemId) {
        const itemId = ensureTextItem(context, "assistant");
        offer({
          ...base(context, { itemId }),
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: finalText },
          raw: raw("result.finalText", result),
        } satisfies ProviderRuntimeEvent);
      }
      const failure = result.subtype === "error" || result.stopReason === "run_error";
      const message = errorMessage(result.error) ?? context.lastError;
      if (failure) {
        settleTurn(context, "failed", {
          ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
          error: message ?? "CommandCode run failed.",
        });
        return;
      }
      settleTurn(context, "completed", {
        stopReason: result.stopReason ?? "model_stop",
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      });
    };

    const handleLine = (context: CommandCodeSessionContext, line: string): void => {
      const decoded = Option.getOrUndefined(decodeCommandCodeLine(line));
      if (!decoded) return;
      if (decoded.type === "event") handleEvent(context, decoded.event);
      else handleResult(context, decoded);
    };

    const startSession: CommandCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const existing = sessions.get(input.threadId);
        if (existing?.activeProcess) {
          existing.interrupted = true;
          yield* Effect.tryPromise({
            try: () => teardownProcessTree(existing.activeProcess!),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/restart",
                detail: errorMessage(cause) ?? "Failed to stop the existing CommandCode process.",
                cause,
              }),
          });
        }
        const now = new Date().toISOString();
        const providerSessionId = resumeSessionId(input.resumeCursor);
        const modelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = modelSelection?.model ?? DEFAULT_MODEL;
        const binaryPath = resolveCommandCodeBinaryPath(
          input.providerOptions?.commandCode?.binaryPath,
        );
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: trim(input.cwd) ?? serverConfig.cwd,
          model,
          threadId: input.threadId,
          ...(providerSessionId ? { resumeCursor: providerSessionId } : {}),
          createdAt: now,
          updatedAt: now,
        };
        const context: CommandCodeSessionContext = {
          session,
          ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
          binaryPath,
          turns: [],
          ...(providerSessionId ? { providerSessionId } : {}),
          tools: new Map(),
          interrupted: false,
          terminalEmitted: false,
        };
        sessions.set(input.threadId, context);
        offer({
          ...base(context, { includeTurn: false }),
          type: "session.started",
          payload: {
            message: "CommandCode CLI session started",
            ...(providerSessionId ? { resume: providerSessionId } : {}),
          },
        } satisfies ProviderRuntimeEvent);
        offer({
          ...base(context, { includeTurn: false }),
          type: "thread.started",
          payload: { ...(providerSessionId ? { providerThreadId: providerSessionId } : {}) },
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
            issue: "A CommandCode turn is already active for this thread.",
          });
        }
        const prompt = trim(
          appendFileAttachmentsPromptBlock({
            text: input.input,
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            include: "all-files",
          }),
        );
        if (!prompt) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "turn/start",
            issue: "A prompt or file attachment is required.",
          });
        }
        const modelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = modelSelection?.model ?? context.session.model ?? DEFAULT_MODEL;
        const args = buildCommandCodeTurnArgs({
          model,
          ...(context.providerSessionId ? { resumeSessionId: context.providerSessionId } : {}),
          runtimeMode: context.session.runtimeMode,
          ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
        });

        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const child = yield* Effect.try({
          try: () =>
            (
              dependencies.spawnProcess ??
              ((command, childArgs, options) =>
                spawn(command, childArgs, options) as CommandCodeChildProcess)
            )(context.binaryPath, args, {
              cwd: context.session.cwd,
              env: buildProviderChildEnvironment({ provider: PROVIDER }),
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: errorMessage(cause) ?? "Failed to start CommandCode.",
              cause,
            }),
        });
        context.activeProcess = child;
        context.activeTurnId = turnId;
        context.interrupted = false;
        context.terminalEmitted = false;
        delete context.lastError;
        const { lastError: _lastError, ...sessionWithoutError } = context.session;
        context.session = {
          ...sessionWithoutError,
          status: "running",
          model,
          activeTurnId: turnId,
          updatedAt: new Date().toISOString(),
        };
        context.turns.push({ id: turnId, items: [] });
        offer({
          ...base(context),
          type: "turn.started",
          payload: {
            model,
          },
        } satisfies ProviderRuntimeEvent);

        let stdoutBuffer = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (context.activeProcess !== child) return;
          stdoutBuffer += chunk;
          for (;;) {
            const newline = stdoutBuffer.indexOf("\n");
            if (newline < 0) break;
            const line = stdoutBuffer.slice(0, newline).trim();
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (line) handleLine(context, line);
          }
        });
        child.stderr.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-64 * 1024);
        });
        child.once("error", (cause) => {
          if (context.activeProcess !== child || context.terminalEmitted) return;
          const message = errorMessage(cause) ?? "CommandCode process failed to start.";
          offer({
            ...base(context),
            type: "runtime.error",
            payload: { class: "transport_error", message },
          } satisfies ProviderRuntimeEvent);
          settleTurn(context, "failed", { error: message });
        });
        child.once("close", (code) => {
          if (context.activeProcess !== child || context.terminalEmitted) return;
          const trailing = stdoutBuffer.trim();
          if (trailing) handleLine(context, trailing);
          if (context.terminalEmitted) return;
          if (context.interrupted) {
            settleTurn(context, "interrupted");
            return;
          }
          const message = context.lastError ?? trim(stderr);
          if (code === 0 && !message)
            settleTurn(context, "completed", { stopReason: "model_stop" });
          else
            settleTurn(context, "failed", {
              error: message ?? `CommandCode exited with code ${code ?? "unknown"}.`,
            });
        });
        child.stdin.once("error", (cause) => {
          if (context.activeProcess !== child || context.terminalEmitted) return;
          const message = errorMessage(cause) ?? "Failed to send the prompt to CommandCode.";
          settleTurn(context, "failed", { error: message });
        });
        child.stdin.end(prompt);
        return {
          threadId: input.threadId,
          turnId,
          ...(context.providerSessionId ? { resumeCursor: context.providerSessionId } : {}),
        };
      });

    const interruptTurn: CommandCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!context.activeProcess) return;
        if (turnId && context.activeTurnId && turnId !== context.activeTurnId) return;
        context.interrupted = true;
        const child = context.activeProcess;
        yield* Effect.tryPromise({
          try: () => teardownProcessTree(child),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/interrupt",
              detail: errorMessage(cause) ?? "Failed to interrupt CommandCode.",
              cause,
            }),
        });
        settleTurn(context, "interrupted");
      });

    const startReview: NonNullable<CommandCodeAdapterShape["startReview"]> = (input) =>
      sendTurn({
        threadId: input.threadId,
        input: commandCodeReviewPrompt(input.target),
        attachments: [],
      });

    const stopSession: CommandCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        if (context.activeProcess) {
          context.interrupted = true;
          yield* Effect.tryPromise({
            try: () => teardownProcessTree(context.activeProcess!),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/stop",
                detail: errorMessage(cause) ?? "Failed to stop CommandCode.",
                cause,
              }),
          });
          settleTurn(context, "interrupted");
        }
        sessions.delete(threadId);
        offer({
          ...base(context, { includeTurn: false }),
          type: "session.exited",
          payload: { reason: "stopped", exitKind: "graceful" },
        } satisfies ProviderRuntimeEvent);
      });

    const rollbackThread: CommandCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      requireSession(threadId).pipe(
        Effect.map((context) => {
          context.turns.splice(Math.max(0, context.turns.length - Math.max(0, numTurns)));
          delete context.providerSessionId;
          const { resumeCursor: _resumeCursor, ...sessionWithoutResume } = context.session;
          context.session = sessionWithoutResume;
          return snapshot(context);
        }),
      );

    const unsupported = (threadId: ThreadId, method: string) =>
      requireSession(threadId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: `CommandCode print mode does not expose interactive requests for ${threadId}.`,
            }),
          ),
        ),
      );

    const listModels: NonNullable<CommandCodeAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const result = await helperProcess(
            resolveCommandCodeBinaryPath(input.binaryPath),
            ["--list-models"],
            {
              ...(input.cwd ? { cwd: input.cwd } : {}),
              timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
            },
          );
          if (result.code !== 0) {
            throw new Error(trim(result.stderr) ?? "CommandCode model discovery failed.");
          }
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
            detail: errorMessage(cause) ?? "Failed to list CommandCode models.",
            cause,
          }),
      });

    const stopAll = () =>
      Effect.forEach([...sessions.keys()], stopSession, {
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
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsRuntimeModelList: true,
        supportsLiveTurnDiffPatch: false,
      },
      startSession,
      sendTurn,
      startReview,
      interruptTurn,
      respondToRequest: (threadId) => unsupported(threadId, "request/respond"),
      respondToUserInput: (threadId) => unsupported(threadId, "user-input/respond"),
      stopSession,
      listSessions: () => Effect.sync(() => [...sessions.values()].map((value) => value.session)),
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
