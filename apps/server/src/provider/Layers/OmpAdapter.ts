/**
 * OmpAdapterLive - Oh My Pi (OMP) CLI (`omp acp`) via ACP.
 *
 * @module OmpAdapterLive
 */
import {
  ApprovalRequestId,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Random,
  Semaphore,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as Acp from "@agentclientprotocol/sdk";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";

import { buildAcpSynaraMcpServers } from "../../agentGateway/mcpInjection.ts";
import {
  type SynaraHarnessPolicyDeliveryState,
  takeSynaraHarnessPolicyTextPartForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import {
  acquireAgentGatewaySessionLease,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { appendProviderReferencesPromptBlock } from "../promptReferenceProjection.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  acceptAcpPlanUpdate,
  clearAcpActiveTurn,
  finalizeAcpActiveTurnCost,
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
  withAcpPlanModePrompt,
} from "../acp/AcpAdapterSessionSupport.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
  stampAcpRuntimeEventLifecycleGeneration,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { type AcpToolCallState, parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpDebugLoggers, makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  forkAcpTurnIdleWatchdog,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  applyOmpAcpInteractionMode,
  applyOmpAcpModelSelection,
  makeOmpAcpRuntime,
  parseOmpCliModelList,
  resolveOmpCliBinaryPath,
  type OmpAcpRuntimeSettings,
} from "../acp/OmpAcpSupport.ts";
import { makeSessionTeardownGate } from "../acp/SessionTeardownGate.ts";
import { cancelTurnAndWait } from "../acp/TurnCancellation.ts";
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  isFormElicitationRequest,
} from "../acp/AcpElicitationSupport.ts";
import { OmpAdapter, type OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { createLogger } from "../../logger.ts";

const PROVIDER = "omp" as const;
const log = createLogger(PROVIDER);

export const takeOmpSynaraHarnessPolicyTextPart = (
  state: SynaraHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeSynaraHarnessPolicyTextPartForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable,
  });
const OMP_RESUME_VERSION = 1 as const;
const OMP_ACP_TRANSPORT_DEBUG_MARKER = "omp-acp-meta-stripper-v2";
const OMP_ACP_LOG_PAYLOAD_LIMIT = 4_000;
const OMP_ACP_DEBUG_ENV = "SYNARA_OMP_ACP_DEBUG";
const OMP_RESUME_REPLAY_QUIET_MS = 350;
// Bounds how long startSession blocks on the replay settling; the background
// settle loop keeps suppression alive past this until the hard timeout.
const OMP_RESUME_REPLAY_MAX_WAIT_MS = 3_000;
const OMP_RESUME_REPLAY_HARD_TIMEOUT_MS = 30_000;
const OMP_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const OMP_TURN_SETTLE_DRAIN_POLL_MS = 25;
// Backstop for an alive-but-silent omp child: if a turn produces no ACP
// activity for this long, force-fail it instead of showing "Working" forever.
// Generous by design so legitimate long, quiet tool runs are not killed;
// override with SYNARA_OMP_TURN_IDLE_TIMEOUT_MS when a workload needs longer.
const OMP_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_OMP_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const OMP_TURN_WATCHDOG_INTERVAL_MS = 15_000;
const OMP_NESTED_TASK_IDLE_TIMEOUT_MS = 60 * 60_000;
const OMP_CANCEL_GRACE_MS = 5_000;
const OMP_ACP_REQUEST_TIMEOUT_MS = 30_000;
const OMP_MODEL_DISCOVERY_CACHE_MS = 5 * 60_000;
const OMP_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const OMP_DISCOVERY_CACHE_MAX_ENTRIES = 16;
const OMP_PLAN_MODE_PROMPT_PREFIX = [
  "Synara OMP plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

function ompAcpTimeoutError(method: string): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: `Omp ACP did not respond to ${method} within ${OMP_ACP_REQUEST_TIMEOUT_MS / 1000}s.`,
  });
}

function isOmpAcpDebugEnabled(): boolean {
  return process.env[OMP_ACP_DEBUG_ENV] === "1";
}

export interface OmpAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface OmpSessionContext {
  harnessPolicyDelivered?: boolean;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  // Epoch-ms of the last inbound ACP activity for the active turn; drives the
  // idle-progress watchdog that force-fails a silently hung turn.
  lastTurnActivityAt: number | undefined;
  // Provider tool-call ids seen during the most recent turn, mapped to that
  // turn. A backlogged consumer can process a queued ToolCallUpdated after the
  // prompt response cleared activeTurnId; this keeps the event attributed to
  // its originating turn instead of dropping it as an orphan. Cleared when the
  // next turn dispatches.
  readonly turnToolCallIds: Map<string, TurnId>;
  // Omp executes `Task` subagents outside the parent ACP event stream. Track
  // their parent tool rows so the watchdog can use a longer, still-finite cap.
  readonly activeNestedTaskToolCallIds: Set<string>;
  readonly nestedTaskLifecycleByToolCallId: Map<string, "active" | "completed">;
  resumeReplayReady: Deferred.Deferred<void> | undefined;
  resumeReplayLastSuppressedAt: number | undefined;
  // Pending until startSession has applied the requested model/effort config.
  // The session is registered in `sessions` before the config RPCs run (so
  // replay keeps draining), which means sendTurn can route to it mid-startup;
  // turns await this gate so the first prompt never runs with provider
  // defaults. Resolved by stopSessionInternal too, like resumeReplayReady, so
  // a failed startup never strands waiters.
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  // Resolves only after the ACP scope and its child process have fully closed.
  // Recovery awaits this gate before starting a replacement session.
  readonly teardownComplete: Deferred.Deferred<void>;
  latestSessionCostUsd: number | undefined;
  // Count of ACP session/update events fully handled by the notification
  // consumer. Compared against acp.sessionUpdatesEnqueuedCount to detect when
  // events received before a prompt response have all been processed —
  // in-flight handlers and stream chunk buffering included.
  sessionUpdatesProcessed: number;
  // True while sendTurn is between its entry check and prompt dispatch; lets
  // interruptTurn flag a turn that has no prompt fiber to interrupt yet.
  turnStarting: boolean;
  // Set by interruptTurn when the turn is still starting; the prompt dispatch
  // guard honors it so a cancelled turn is never prompted.
  pendingTurnInterrupted: boolean;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function scopeOmpRuntimeItemIdForTurn(turnId: TurnId, itemId: string): string {
  return scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, itemId);
}

// Omp can close a stale assistant segment before any visible text arrives.
export function isRenderableOmpAssistantDelta(input: {
  readonly streamKind?: string | undefined;
  readonly text: string;
}): boolean {
  return input.streamKind !== "reasoning_text" && input.text.trim().length > 0;
}

export function classifyOmpPromptTurnCompletion(input: {
  readonly stopReason: string | null | undefined;
  readonly failedToolDetail?: string | undefined;
}): { readonly state: "completed" | "cancelled" | "failed"; readonly errorMessage?: string } {
  return classifyAcpPromptTurnCompletion({
    stopReason: input.stopReason,
    ...(input.failedToolDetail !== undefined ? { failedToolDetail: input.failedToolDetail } : {}),
  });
}

// Identifies OMP's parent `Task` tool row; child-session progress is not
// forwarded over ACP, so this marker is the only reliable liveness signal.
export function isOmpNestedTaskToolCall(toolCall: AcpToolCallState): boolean {
  if (toolCall.title?.trim().toLowerCase() === "task") {
    return true;
  }
  const rawInput = toolCall.data.rawInput;
  return (
    typeof rawInput === "object" &&
    rawInput !== null &&
    "subagent_type" in rawInput &&
    typeof rawInput.subagent_type === "string"
  );
}

// A turn-specific stop is valid only while that exact turn is active. During
// startup no caller can know the new provider turn id yet, so a supplied id is stale.
export function shouldIgnoreOmpInterrupt(
  requestedTurnId: TurnId | undefined,
  activeTurnId: TurnId | undefined,
): boolean {
  return requestedTurnId !== undefined && requestedTurnId !== activeTurnId;
}

// Omp may reuse ACP item ids across resumed history; DP runtime ids must stay turn-local.
export function scopeOmpToolCallStateForTurn(
  turnId: TurnId,
  toolCall: AcpToolCallState,
): AcpToolCallState {
  return scopeAcpToolCallStateForTurn(PROVIDER, turnId, toolCall);
}

function parseOmpResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== OMP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

export function resolveOmpSessionCwd(
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
  sessionCwd?: string,
): string | undefined {
  return resolveAcpSessionCwd({
    inputCwd,
    sessionCwd,
    serverCwd: serverConfig.cwd,
    homeDir: serverConfig.homeDir,
  });
}

function setOmpDiscoveryCacheEntry<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > OMP_DISCOVERY_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export function makeOmpAdapter(
  ompSettings: OmpAcpRuntimeSettings,
  options?: OmpAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, OmpSessionContext>();
    const sessionTeardownGate = makeSessionTeardownGate();
    const modelDiscoveryCache = new Map<
      string,
      { readonly expiresAt: number; readonly result: ProviderListModelsResult }
    >();
    const commandDiscoveryCache = new Map<
      string,
      { readonly expiresAt: number; readonly result: ProviderListCommandsResult }
    >();
    const withThreadLock = yield* makeAcpThreadLock();
    const discoveryLock = yield* Semaphore.make(1);
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (
      lifecycleGeneration: string | undefined,
      event: ProviderRuntimeEvent,
    ) =>
      PubSub.publish(
        runtimeEventPubSub,
        stampAcpRuntimeEventLifecycleGeneration(event, lifecycleGeneration),
      ).pipe(Effect.asVoid);

    // Discovery sessions are disposable and never enter the live session directory.
    const makeOmpDiscoveryRuntime = (input: {
      readonly binaryPath?: string;
      readonly cwd: string;
      readonly clientName: string;
    }) =>
      makeOmpAcpRuntime({
        ompSettings: {
          ...(ompSettings.binaryPath ? { binaryPath: ompSettings.binaryPath } : {}),
          ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        },
        childProcessSpawner,
        cwd: input.cwd,
        clientInfo: { name: input.clientName, version: "0.0.0" },
      });
    const collectDiscoveryStreamAsString = <E>(
      stream: Stream.Stream<Uint8Array, E>,
    ): Effect.Effect<string, E> =>
      Stream.runFold(
        stream,
        () => "",
        (acc, chunk) => acc + new TextDecoder().decode(chunk),
      );

    // OMP publishes its full multi-provider catalog via `omp models --json` in a
    // single subprocess call; each model carries its own `thinking` efforts
    // inline. This is O(1) round-trips and scales to OMP's 300+ model catalogs.
    // The ACP model option exposes only slug/name and would need one
    // session/set_config_option round-trip per model to read per-model thinking.
    const runOmpCliModelList = (binaryPath: string) =>
      Effect.gen(function* () {
        const executable = resolveOmpCliBinaryPath(binaryPath);
        log.info("model/list cli start", { binaryPath, executable });
        const env = buildProviderChildEnvironment({ provider: "omp" });
        const prepared = prepareWindowsSafeProcess(executable, ["models", "--json"], {
          env,
        });
        const command = ChildProcess.make(prepared.command, prepared.args, {
          shell: prepared.shell,
          ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          env,
          stdin: "ignore",
        });
        const child = yield* childProcessSpawner.spawn(command);
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectDiscoveryStreamAsString(child.stdout),
            collectDiscoveryStreamAsString(child.stderr),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        log.info("model/list cli spawned", {
          exitCode,
          stdoutBytes: stdout.length,
          stdoutHead: stdout.slice(0, 240),
          stderr,
        });
        if (exitCode !== 0) {
          log.warn("model/list cli non-zero exit", { exitCode, stderr });
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: stderr.trim() || `'${executable} models --json' exited with code ${exitCode}.`,
          });
        }
        const models = parseOmpCliModelList(stdout);
        log.info("model/list cli parsed", { parsedCount: models.length });
        if (models.length === 0) {
          log.warn("model/list cli returned zero models", {
            stdoutHead: stdout.slice(0, 500),
          });
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail:
              "OMP model discovery returned no models. Run `omp` to authenticate so ~/.omp credentials exist.",
          });
        }
        return { models, source: "omp-cli", cached: false } satisfies ProviderListModelsResult;
      }).pipe(Effect.scoped);

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: OmpSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        if (!acceptAcpPlanUpdate(ctx, payload)) return;
        yield* offerRuntimeEvent(
          ctx.lifecycleGeneration,
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload,
          }),
        );
      });

    const emitNestedTaskLifecycle = (
      ctx: OmpSessionContext,
      toolCall: AcpToolCallState,
      turnId: TurnId,
    ) =>
      Effect.gen(function* () {
        if (!isOmpNestedTaskToolCall(toolCall)) {
          return;
        }
        const previous = ctx.nestedTaskLifecycleByToolCallId.get(toolCall.toolCallId);
        const terminal = toolCall.status === "completed" || toolCall.status === "failed";
        if (terminal) {
          ctx.activeNestedTaskToolCallIds.delete(toolCall.toolCallId);
          if (previous === "completed") {
            return;
          }
          ctx.nestedTaskLifecycleByToolCallId.set(toolCall.toolCallId, "completed");
          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
            type: "task.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(toolCall.toolCallId),
              status: toolCall.status === "failed" ? "failed" : "completed",
              ...(toolCall.detail ? { summary: toolCall.detail } : {}),
            },
          });
          return;
        }

        ctx.activeNestedTaskToolCallIds.add(toolCall.toolCallId);
        if (previous !== undefined) {
          return;
        }
        ctx.nestedTaskLifecycleByToolCallId.set(toolCall.toolCallId, "active");
        const rawInput = toolCall.data.rawInput;
        const description =
          typeof rawInput === "object" &&
          rawInput !== null &&
          "description" in rawInput &&
          typeof rawInput.description === "string"
            ? rawInput.description
            : toolCall.detail;
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "task.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(toolCall.toolCallId),
            taskType: "subagent",
            ...(description ? { description } : {}),
          },
        });
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<OmpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (
      ctx: OmpSessionContext,
      options?: {
        readonly exitKind?: "graceful" | "error";
        readonly reason?: string;
        readonly awaitTermination?: boolean;
      },
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!ctx.stopped) {
            ctx.stopped = true;
            ctx.gatewaySessionLease?.release();
            sessionTeardownGate.track(ctx.threadId, ctx.teardownComplete);
            sessions.delete(ctx.threadId);
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            if (ctx.sessionConfigReady !== undefined) {
              yield* Deferred.succeed(ctx.sessionConfigReady, undefined);
              ctx.sessionConfigReady = undefined;
            }
            if (ctx.resumeReplayReady !== undefined) {
              yield* Deferred.succeed(ctx.resumeReplayReady, undefined);
              ctx.resumeReplayReady = undefined;
              ctx.resumeReplayLastSuppressedAt = undefined;
            }
            if (ctx.notificationFiber) {
              yield* Fiber.interrupt(ctx.notificationFiber);
            }

            const completeTeardown = sessionTeardownGate.complete(
              ctx.threadId,
              ctx.teardownComplete,
            );
            const teardown = Effect.gen(function* () {
              yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                type: "session.exited",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                payload: {
                  exitKind: options?.exitKind ?? "graceful",
                  ...(options?.reason ? { reason: options.reason } : {}),
                },
              });
            }).pipe(Effect.ensuring(completeTeardown));

            // Scope.close interrupts prompt/watchdog fibers owned by this scope.
            // A daemon performs the close so those fibers can initiate teardown
            // without waiting on their own termination.
            yield* teardown.pipe(Effect.forkDetach, Effect.asVoid);
          }

          if (options?.awaitTermination !== false) {
            yield* restore(Deferred.await(ctx.teardownComplete));
          }
        }),
      );

    const noteSuppressedOmpRuntimeEvent = (
      ctx: OmpSessionContext,
      eventTag: string,
      reason: "resume-replay" | "orphan-turn-event",
    ) =>
      Effect.gen(function* () {
        if (reason === "resume-replay") {
          ctx.resumeReplayLastSuppressedAt = Date.now();
        }
        if (!isOmpAcpDebugEnabled()) {
          return;
        }
        yield* Effect.logInfo("omp.acp.runtime_event_suppressed", {
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          eventTag,
          reason,
        });
      });

    const cancelOmpPromptWithGrace = (
      ctx: OmpSessionContext,
      promptFiber: Fiber.Fiber<void, never> | undefined,
    ) =>
      Effect.gen(function* () {
        const result = yield* cancelTurnAndWait({
          cancel: ctx.acp.cancel,
          promptFiber,
          graceMs: OMP_CANCEL_GRACE_MS,
        });
        if (result.cancelRequest !== "sent" || result.prompt === "timedOut") {
          yield* Effect.logWarning("omp.acp.cancel_escalated", {
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            cancelRequest: result.cancelRequest,
            prompt: result.prompt,
            ...(result.cancelFailure ? { reason: result.cancelFailure } : {}),
          });
        }
        return result;
      });

    const activeTurnIdForOmpRuntimeEvent = (ctx: OmpSessionContext, eventTag: string) =>
      Effect.gen(function* () {
        if (ctx.resumeReplayReady !== undefined) {
          yield* noteSuppressedOmpRuntimeEvent(ctx, eventTag, "resume-replay");
          return undefined;
        }
        if (ctx.activeTurnId === undefined) {
          yield* noteSuppressedOmpRuntimeEvent(ctx, eventTag, "orphan-turn-event");
          return undefined;
        }
        return ctx.activeTurnId;
      });

    // Holds the active-turn window open until session/update events that were
    // already enqueued when the prompt response resolved have been fully
    // handled by the notification consumer, so they settle with their turn
    // attribution (and recorded failed-tool detail) intact. Snapshotting the
    // runtime's enqueued count and waiting for the adapter's processed count
    // to catch up is immune to stream chunk buffering and in-flight handlers,
    // unlike a queue-size probe. Returns immediately when the consumer kept
    // up; bounded so a chatty stream cannot stall settlement past the cap.
    const waitForOmpQueuedTurnEventsDrained = (ctx: OmpSessionContext) =>
      Effect.gen(function* () {
        const target = yield* ctx.acp.sessionUpdatesEnqueuedCount;
        const startedAt = Date.now();
        while (
          ctx.sessionUpdatesProcessed < target &&
          Date.now() - startedAt < OMP_TURN_SETTLE_DRAIN_MAX_WAIT_MS
        ) {
          yield* Effect.sleep(OMP_TURN_SETTLE_DRAIN_POLL_MS);
        }
      });

    // On session/load, Omp can replay old ACP updates after the session is "ready".
    // Keep suppression active until that stream actually goes quiet — clearing it
    // on a fixed timeout lets late historical deltas leak into the first turn as
    // its content. The hard cap only guards against a replay that never settles.
    const settleOmpResumeReplayWhenQuiet = (ctx: OmpSessionContext) =>
      Effect.gen(function* () {
        const ready = ctx.resumeReplayReady;
        if (ready === undefined) {
          return;
        }
        const startedAt = Date.now();
        ctx.resumeReplayLastSuppressedAt = startedAt;
        while (ctx.resumeReplayReady !== undefined) {
          const now = Date.now();
          const lastSuppressedAt = ctx.resumeReplayLastSuppressedAt ?? startedAt;
          const quietForMs = now - lastSuppressedAt;
          const elapsedMs = now - startedAt;
          if (
            quietForMs >= OMP_RESUME_REPLAY_QUIET_MS ||
            elapsedMs >= OMP_RESUME_REPLAY_HARD_TIMEOUT_MS
          ) {
            const timedOut = elapsedMs >= OMP_RESUME_REPLAY_HARD_TIMEOUT_MS;
            ctx.resumeReplayReady = undefined;
            ctx.resumeReplayLastSuppressedAt = undefined;
            if (timedOut) {
              yield* Effect.logWarning("omp.acp.resume_replay_quiet_wait_timeout", {
                threadId: ctx.threadId,
                elapsedMs,
              });
            }
            yield* Deferred.succeed(ready, undefined);
            return;
          }
          yield* Effect.sleep(Math.min(OMP_RESUME_REPLAY_QUIET_MS - quietForMs, 50));
        }
        yield* Deferred.succeed(ready, undefined);
      });

    const startSession: OmpAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          yield* sessionTeardownGate.awaitPending(input.threadId);
          const cwd = resolveOmpSessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const ompModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          const gatewaySessionLease = acquireAgentGatewaySessionLease(
            agentGatewayCredentials,
            input.threadId,
            PROVIDER,
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred || !gatewaySessionLease
              ? Effect.void
              : Effect.sync(gatewaySessionLease.release),
          );
          let ctx!: OmpSessionContext;

          const resumeSessionId = parseOmpResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const acpRuntimeLoggers = makeAcpDebugLoggers({
            base: acpNativeLoggers,
            enabled: isOmpAcpDebugEnabled(),
            provider: PROVIDER,
            marker: OMP_ACP_TRANSPORT_DEBUG_MARKER,
            payloadLimit: OMP_ACP_LOG_PAYLOAD_LIMIT,
            shouldMirrorIncomingRaw: () => false,
          });
          const providerOmpOptions = input.providerOptions?.omp;
          const effectiveOmpSettings: OmpAcpRuntimeSettings = {
            ...(ompSettings.binaryPath !== undefined ? { binaryPath: ompSettings.binaryPath } : {}),
            ...(providerOmpOptions?.binaryPath !== undefined
              ? { binaryPath: providerOmpOptions.binaryPath }
              : {}),
          };

          yield* Effect.logInfo("omp.acp.start", {
            marker: OMP_ACP_TRANSPORT_DEBUG_MARKER,
            debugEnv: OMP_ACP_DEBUG_ENV,
            threadId: input.threadId,
            cwd,
            resume: resumeSessionId !== undefined,
            binaryPath: effectiveOmpSettings.binaryPath ?? "omp",
          });

          const acp = yield* makeOmpAcpRuntime({
            ompSettings: effectiveOmpSettings,
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientCapabilities: { elicitation: { form: {} } },
            clientInfo: { name: "Synara", version: "0.0.0" },
            ...(agentGatewayCredentials
              ? {
                  buildMcpServers: (initializeResult: Acp.InitializeResponse) =>
                    buildAcpSynaraMcpServers({
                      connection: gatewaySessionLease!.connection,
                      initializeResult,
                      stdioProxy: agentGatewayCredentials.stdioProxy,
                    }),
                }
              : {}),
            ...acpRuntimeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );
          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                const policyOutcome = resolveAcpPermissionPolicy({
                  runtimeMode: input.runtimeMode,
                  interactionMode: ctx?.activeInteractionMode,
                  options: params.options,
                });
                if (policyOutcome !== undefined) {
                  if (policyOutcome.outcome === "selected") {
                    if (isOmpAcpDebugEnabled()) {
                      yield* Effect.logInfo("omp.acp.permission_policy_applied", {
                        threadId: input.threadId,
                        turnId: ctx?.activeTurnId,
                        interactionMode: ctx?.activeInteractionMode,
                        optionId: policyOutcome.optionId,
                        options: params.options.map((option) => ({
                          kind: option.kind,
                          optionId: option.optionId,
                        })),
                        toolKind: params.toolCall.kind,
                        toolTitle: params.toolCall.title,
                      });
                    }
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: policyOutcome.optionId,
                      },
                    };
                  }
                  return { outcome: { outcome: "cancelled" as const } };
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                return {
                  outcome:
                    resolved === "cancel"
                      ? ({ outcome: "cancelled" } as const)
                      : (() => {
                          const selectedOptionId = selectAcpPermissionOptionId(
                            resolved,
                            params.options,
                          );
                          return selectedOptionId === undefined
                            ? ({ outcome: "cancelled" } as const)
                            : ({
                                outcome: "selected" as const,
                                optionId: selectedOptionId,
                              } as const);
                        })(),
                };
              }),
            );
            yield* acp.handleElicitation((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/elicitation", params);
                if (!isFormElicitationRequest(params)) {
                  return { action: "decline" as const };
                }
                const questions = elicitationQuestionsFromRequest(params);
                if (questions.length === 0) {
                  return { action: "decline" as const };
                }
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                pendingUserInputs.set(requestId, { answers });
                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { questions },
                  raw: {
                    source: "acp.jsonrpc",
                    method: "session/elicitation",
                    payload: params,
                  },
                });
                const resolved = yield* Deferred.await(answers);
                pendingUserInputs.delete(requestId);
                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { answers: resolved },
                });
                return elicitationResponseFromAnswers(params, resolved);
              }),
            );
            const startedOption = yield* acp
              .start()
              .pipe(Effect.timeoutOption(OMP_ACP_REQUEST_TIMEOUT_MS));
            return yield* Option.match(startedOption, {
              onNone: () => Effect.fail(ompAcpTimeoutError("session/start")),
              onSome: Effect.succeed,
            });
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ProviderAdapterRequestError
                ? error
                : mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          if (resumeSessionId !== undefined && started.sessionSetupMethod === "new") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/resume",
              detail:
                "Omp could not resume the requested native session. Synara refused the fresh fallback to avoid silently losing conversation context.",
            });
          }

          // `session/resume` does not replay history; only legacy `session/load`
          // needs the replay-suppression gate below.
          const resumeReplayReady =
            started.sessionSetupMethod === "load" ? yield* Deferred.make<void>() : undefined;
          const sessionConfigReady = yield* Deferred.make<void>();
          const teardownComplete = yield* Deferred.make<void>();
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: ompModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: OMP_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnHadAssistantContent: false,
            activeAssistantItemsWithContent: new Set(),
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            lastTurnActivityAt: undefined,
            turnToolCallIds: new Map(),
            activeNestedTaskToolCallIds: new Set(),
            nestedTaskLifecycleByToolCallId: new Map(),
            resumeReplayReady,
            resumeReplayLastSuppressedAt: resumeReplayReady !== undefined ? Date.now() : undefined,
            sessionConfigReady,
            teardownComplete,
            latestSessionCostUsd: undefined,
            sessionUpdatesProcessed: 0,
            turnStarting: false,
            pendingTurnInterrupted: false,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                // Any inbound ACP event proves the child is alive and making
                // progress; reset the idle-progress watchdog clock.
                ctx.lastTurnActivityAt = Date.now();
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    {
                      const activeTurnId = yield* activeTurnIdForOmpRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      // Content deltas open the visible message; empty starts only add noise.
                    }
                    return;
                  case "AssistantItemCompleted":
                    {
                      const activeTurnId = yield* activeTurnIdForOmpRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      const scopedItemId = scopeOmpRuntimeItemIdForTurn(activeTurnId, event.itemId);
                      if (!ctx.activeAssistantItemsWithContent.has(scopedItemId)) {
                        if (isOmpAcpDebugEnabled()) {
                          yield* Effect.logInfo("omp.acp.empty_assistant_item_suppressed", {
                            threadId: ctx.threadId,
                            turnId: activeTurnId,
                            itemId: scopedItemId,
                          });
                        }
                        return;
                      }
                      ctx.activeAssistantItemsWithContent.delete(scopedItemId);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          itemId: scopedItemId,
                          lifecycle: "item.completed",
                        }),
                      );
                    }
                    return;
                  case "PlanUpdated":
                    {
                      const activeTurnId = yield* activeTurnIdForOmpRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    }
                    return;
                  case "ToolCallUpdated":
                    {
                      // A queued update for a tool call the just-settled turn
                      // already rendered belongs to that turn; emit it with the
                      // originating turn id so the existing tool row resolves in
                      // place instead of being dropped as an orphan. Resume
                      // replay stays suppressed like every other event.
                      const lateTurnId =
                        ctx.resumeReplayReady === undefined && ctx.activeTurnId === undefined
                          ? ctx.turnToolCallIds.get(event.toolCall.toolCallId)
                          : undefined;
                      if (lateTurnId !== undefined) {
                        yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                        yield* emitNestedTaskLifecycle(ctx, event.toolCall, lateTurnId);
                        yield* offerRuntimeEvent(
                          input.lifecycleGeneration,
                          makeAcpToolCallEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: lateTurnId,
                            toolCall: scopeOmpToolCallStateForTurn(lateTurnId, event.toolCall),
                            rawPayload: event.rawPayload,
                          }),
                        );
                        return;
                      }
                      const activeTurnId = yield* activeTurnIdForOmpRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      ctx.turnToolCallIds.set(event.toolCall.toolCallId, activeTurnId);
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      yield* emitNestedTaskLifecycle(ctx, event.toolCall, activeTurnId);
                      const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                      if (failedToolDetail !== undefined) {
                        ctx.activeTurnFailedToolDetail = failedToolDetail;
                      }
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpToolCallEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          toolCall: scopeOmpToolCallStateForTurn(activeTurnId, event.toolCall),
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                  case "ContentDelta":
                    {
                      const activeTurnId = yield* activeTurnIdForOmpRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      const scopedItemId = event.itemId
                        ? scopeOmpRuntimeItemIdForTurn(activeTurnId, event.itemId)
                        : undefined;
                      if (isRenderableOmpAssistantDelta(event)) {
                        ctx.activeTurnHadAssistantContent = true;
                        if (scopedItemId !== undefined) {
                          ctx.activeAssistantItemsWithContent.add(scopedItemId);
                        }
                      }
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpContentDeltaEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          ...(scopedItemId ? { itemId: scopedItemId } : {}),
                          text: event.text,
                          ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                  case "UsageUpdated":
                    {
                      const activeTurnId = yield* activeTurnIdForOmpRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      recordAcpSessionCost(ctx, event.cost);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpTokenUsageEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          usage: event.usage,
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                }
              }).pipe(
                // Bump the processed count only after the handler fully ran, so
                // waitForOmpQueuedTurnEventsDrained cannot observe an event as
                // consumed while its state updates are still being applied.
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.sessionUpdatesProcessed += 1;
                  }),
                ),
              ),
            ),
          ).pipe(Effect.forkChild);

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          // Config RPCs run after the consumer fork so replay emitted while they
          // are in flight keeps draining. The session is already registered and
          // the start-scope finalizer no longer owns the session scope, so any
          // failure OR interruption of the remaining startup steps must tear the
          // session down explicitly instead of leaking a live child.
          yield* Effect.gen(function* () {
            if (ompModelSelection?.model) {
              yield* applyOmpAcpModelSelection({
                runtime: acp,
                model: ompModelSelection.model,
                thinkingLevel: ompModelSelection.options?.thinkingLevel,
                mapError: ({ cause, method }) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
              });
            }
            // The requested model/effort are applied; turns gated on this
            // deferred can now prompt without inheriting provider defaults.
            yield* Deferred.succeed(sessionConfigReady, undefined);
            ctx.sessionConfigReady = undefined;

            if (resumeReplayReady !== undefined) {
              // Settle the replay in the background: suppression stays active until
              // the stream is genuinely quiet, while startup only blocks briefly so
              // a long replay cannot hold session startup hostage. sendTurn awaits
              // the deferred, so the first turn stays gated until the replay has
              // actually finished.
              yield* settleOmpResumeReplayWhenQuiet(ctx).pipe(Effect.forkIn(ctx.scope));
              yield* Deferred.await(resumeReplayReady).pipe(
                Effect.timeoutOption(OMP_RESUME_REPLAY_MAX_WAIT_MS),
              );
            }

            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: started.initializeResult },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "Omp ACP session ready" },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
          }).pipe(
            Effect.timeoutOption(OMP_ACP_REQUEST_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(ompAcpTimeoutError("session/set_config_option")),
                onSome: Effect.succeed,
              }),
            ),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Effect.ignore(stopSessionInternal(ctx)),
            ),
          );

          return session;
        }).pipe(Effect.scoped),
      );

    // Idle-progress watchdog escape hatch: force-fail a turn whose omp child
    // is alive but has gone completely silent. Mirrors the prompt-fiber
    // onFailure branch and stays idempotent via clearAcpActiveTurn, so it is a
    // no-op if the turn settled normally first (whichever fires first wins).
    const failOmpTurnAsTimedOut = (ctx: OmpSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (!clearAcpActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeAcpActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `Omp stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({ id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning("omp.acp.turn_idle_timeout", {
          threadId: ctx.threadId,
          turnId,
          idleMs,
        });
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: "failed",
            stopReason: null,
            errorMessage: detail,
            ...completedCost,
          },
        });
        // Let Omp flush final ACP updates and settle session/prompt before
        // escalating to process teardown for a silent nested worker.
        yield* cancelOmpPromptWithGrace(ctx, promptFiber);
        yield* stopSessionInternal(ctx, {
          exitKind: "error",
          reason: detail,
          awaitTermination: false,
        });
      });

    const sendTurn: OmpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A second sendTurn entering while another turn is still starting would
        // clear that turn's pendingTurnInterrupted flag (letting a cancelled
        // turn dispatch anyway) and race two ACP prompts; reject it instead.
        if (ctx.turnStarting) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Another Omp turn is still starting for this thread.",
          });
        }
        ctx.turnStarting = true;
        ctx.pendingTurnInterrupted = false;
        return yield* startOmpTurn(ctx, input).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.turnStarting = false;
            }),
          ),
        );
      });

    const startOmpTurn = (
      ctx: OmpSessionContext,
      input: Parameters<OmpAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        // Startup registers the session before its config RPCs settle; a turn
        // routed in during that window must not prompt with provider defaults.
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.await(ctx.sessionConfigReady);
        }
        if (ctx.resumeReplayReady !== undefined) {
          yield* Deferred.await(ctx.resumeReplayReady);
        }
        // The gates above are resolved by stopSessionInternal too (a failed or
        // stopped startup must not strand waiters); a turn that was blocked on
        // them must fail here instead of emitting lifecycle events for a dead
        // session.
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
        const runtimeMode = ctx.session.runtimeMode;
        if (runtimeMode === "auto") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Auto runtime mode is available only to Codex and Claude.",
          });
        }
        // Selection changes normally arrive via a session restart, but a turn
        // can still carry an explicit selection; re-assert it over ACP (the
        // shared runtime skips the RPC when the value already matches).
        yield* Effect.gen(function* () {
          if (model !== undefined) {
            yield* applyOmpAcpModelSelection({
              runtime: ctx.acp,
              model,
              thinkingLevel: turnModelSelection?.options?.thinkingLevel,
              mapError: ({ cause, method }) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
            });
          }
          yield* applyOmpAcpInteractionMode({
            runtime: ctx.acp,
            interactionMode,
            runtimeMode,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });
        }).pipe(
          Effect.timeoutOption(OMP_ACP_REQUEST_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(ompAcpTimeoutError("session/set_config_option")),
              onSome: Effect.succeed,
            }),
          ),
          Effect.onError((cause) =>
            stopSessionInternal(ctx, {
              exitKind: "error",
              reason: Cause.pretty(cause),
            }),
          ),
        );
        const promptParts: Array<Acp.ContentBlock> = [];
        const promptText = appendFileAttachmentsPromptBlock({
          text: appendProviderReferencesPromptBlock({
            text: input.input?.trim()
              ? withAcpPlanModePrompt({
                  text: input.input.trim(),
                  interactionMode,
                  promptPrefix: OMP_PLAN_MODE_PROMPT_PREFIX,
                })
              : undefined,
            mentions: input.mentions,
          }),
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        });
        if (promptText) {
          promptParts.push({
            type: "text",
            text: promptText,
          });
        }
        promptParts.push(
          ...(yield* loadProviderPromptImageBlocks({
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            provider: PROVIDER,
            method: "session/prompt",
            readFile: fileSystem.readFile,
          })),
        );

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const harnessPolicy = takeOmpSynaraHarnessPolicyTextPart(
          ctx,
          agentGatewayCredentials !== undefined,
        );
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }

        // A stop can land while the replay gate or attachment reads above were
        // in flight; opening the turn now would publish turn.started (and a
        // phantom cancelled completion) for a session that already exited.
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        ctx.activeTurnId = turnId;
        ctx.activeTurnHadAssistantContent = false;
        ctx.activeAssistantItemsWithContent.clear();
        ctx.activeTurnFailedToolDetail = undefined;
        // Late-event attribution only matters between turns; once a new turn
        // dispatches, stragglers from older turns are stale enough to drop.
        ctx.turnToolCallIds.clear();
        ctx.activeNestedTaskToolCallIds.clear();
        ctx.nestedTaskLifecycleByToolCallId.clear();
        ctx.activeInteractionMode = interactionMode;
        ctx.lastPlanFingerprint = undefined;
        ctx.lastTurnActivityAt = Date.now();
        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { ...(model ? { model } : {}) },
        });

        const runPrompt = Effect.suspend(() =>
          // interruptTurn during the pre-prompt waits (resume replay, attachment
          // reads) or between turn.started publishing and this fiber being
          // registered sets pendingTurnInterrupted; honor it (and a concurrent
          // stop) here so a cancelled turn is never prompted. Self-interrupting
          // routes through the onInterrupt branch below, which completes the
          // turn as cancelled rather than as a provider failure.
          ctx.pendingTurnInterrupted || ctx.stopped
            ? Effect.interrupt
            : ctx.acp.prompt({ prompt: promptParts }),
        ).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                yield* waitForOmpQueuedTurnEventsDrained(ctx);
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                const detail = error.message;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso,
                  ...(model ? { model } : {}),
                  lastError: detail,
                };
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: "failed",
                    stopReason: null,
                    errorMessage: detail,
                    ...completedCost,
                  },
                });
                // Transport/prompt failures make the ACP child unusable. Remove
                // it from routing immediately so ProviderService can recover on
                // the next send instead of reusing a dead session forever.
                yield* stopSessionInternal(ctx, {
                  exitKind: "error",
                  reason: detail,
                  awaitTermination: false,
                });
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                // Drain BEFORE snapshotting turn state: queued events may still
                // set activeTurnFailedToolDetail or assistant-content flags.
                yield* waitForOmpQueuedTurnEventsDrained(ctx);
                const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                ctx.session = {
                  ...sessionWithoutLastError,
                  status: "ready",
                  updatedAt: yield* nowIso,
                  ...(model ? { model } : {}),
                };
                if (!hadAssistantContent && result.stopReason !== "cancelled") {
                  yield* Effect.logWarning("omp.acp.turn_completed_without_content", {
                    threadId: input.threadId,
                    turnId,
                    stopReason: result.stopReason ?? null,
                    hasUsage: result.usage !== undefined,
                  });
                }
                const completion = classifyOmpPromptTurnCompletion({
                  stopReason: result.stopReason,
                  ...(failedToolDetail !== undefined ? { failedToolDetail } : {}),
                });
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: completion.state,
                    stopReason: result.stopReason ?? null,
                    ...(completion.errorMessage !== undefined
                      ? { errorMessage: completion.errorMessage }
                      : {}),
                    ...(result.usage ? { usage: result.usage } : {}),
                    ...completedCost,
                  },
                });
              }),
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (!clearAcpActiveTurn(ctx, turnId)) {
                return;
              }
              const completedCost = finalizeAcpActiveTurnCost(ctx);
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
              const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
              ctx.session = {
                ...sessionWithoutLastError,
                status: "ready",
                updatedAt: yield* nowIso,
                ...(model ? { model } : {}),
              };
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "cancelled",
                  stopReason: "cancelled",
                  ...completedCost,
                },
              });
            }),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(ctx.scope),
        );
        ctx.activePromptFiber = yield* runPrompt;

        // Backstop the forked prompt: if the child goes silent, fail the turn
        // instead of leaving it "Working" forever. Self-terminates when the
        // turn settles; pauses while a human approval is pending.
        yield* forkAcpTurnIdleWatchdog({
          idleTimeoutMs: OMP_TURN_IDLE_TIMEOUT_MS,
          currentIdleTimeoutMs: () =>
            ctx.activeNestedTaskToolCallIds.size > 0
              ? OMP_NESTED_TASK_IDLE_TIMEOUT_MS
              : OMP_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: OMP_TURN_WATCHDOG_INTERVAL_MS,
          scope: ctx.scope,
          isTurnActive: () => ctx.activeTurnId === turnId && !ctx.stopped,
          isAwaitingHuman: () => ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
          lastActivityAt: () => ctx.lastTurnActivityAt ?? Date.now(),
          touchActivity: () => {
            ctx.lastTurnActivityAt = Date.now();
          },
          onIdleTimeout: (idleMs) => failOmpTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          ...(ctx.session.resumeCursor !== undefined
            ? { resumeCursor: ctx.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: OmpAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (shouldIgnoreOmpInterrupt(turnId, ctx.activeTurnId)) {
          yield* Effect.logWarning("omp.acp.stale_interrupt_ignored", {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: ctx.activeTurnId,
          });
          return;
        }
        if (!ctx.turnStarting && ctx.activeTurnId === undefined) {
          return;
        }
        // A turn that is still starting has no prompt fiber to interrupt yet
        // (it may be gated on resume replay); flag it so startOmpTurn aborts
        // before prompting instead of running the cancelled turn anyway.
        if (ctx.turnStarting && ctx.activePromptFiber === undefined) {
          ctx.pendingTurnInterrupted = true;
        }
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        const activePromptFiber = ctx.activePromptFiber;
        yield* cancelOmpPromptWithGrace(ctx, activePromptFiber);
        // Closing the process group is intentional: OMP can acknowledge
        // cancel before nested workers quiesce, so session reuse is unsafe.
        yield* stopSessionInternal(ctx, {
          exitKind: "graceful",
          reason: "Omp turn cancelled; runtime closed to stop nested work.",
        });
      });

    const respondToRequest: OmpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: OmpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: OmpAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: OmpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue:
            "Omp does not expose a native rewind cursor; rollback must restart the session with retained transcript context.",
        });
      });

    const forkThread: NonNullable<OmpAdapterShape["forkThread"]> = (input) =>
      Effect.gen(function* () {
        const sourceCwd = resolveOmpSessionCwd(input.sourceCwd ?? input.cwd, serverConfig);
        const targetCwd = resolveOmpSessionCwd(input.cwd ?? input.sourceCwd, serverConfig);
        if (!sourceCwd || !targetCwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue: "A source and target cwd are required to fork a Omp session.",
          });
        }

        const forkRuntime = (runtime: AcpSessionRuntimeShape) =>
          Effect.gen(function* () {
            if (!(yield* runtime.supportsSessionFork)) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "forkThread",
                issue:
                  "This Omp ACP version does not advertise session/fork; Synara will rebuild the fork from its retained transcript.",
              });
            }
            return yield* runtime.forkSession({ cwd: targetCwd, mcpServers: [] });
          }).pipe(
            Effect.timeoutOption(OMP_ACP_REQUEST_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(ompAcpTimeoutError("session/fork")),
                onSome: Effect.succeed,
              }),
            ),
          );

        const activeSource = sessions.get(input.sourceThreadId);
        const forked = activeSource
          ? yield* forkRuntime(activeSource.acp)
          : yield* Effect.gen(function* () {
              const sourceSessionId = parseOmpResume(input.sourceResumeCursor)?.sessionId;
              if (!sourceSessionId) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "forkThread",
                  issue: "The source Omp session has no resumable native cursor.",
                });
              }
              const runtime = yield* makeOmpAcpRuntime({
                ompSettings: {
                  ...(ompSettings.binaryPath ? { binaryPath: ompSettings.binaryPath } : {}),
                  ...(input.providerOptions?.omp?.binaryPath
                    ? { binaryPath: input.providerOptions.omp.binaryPath }
                    : {}),
                },
                childProcessSpawner,
                cwd: sourceCwd,
                resumeSessionId: sourceSessionId,
                clientInfo: { name: "Synara Fork", version: "0.0.0" },
              });
              yield* runtime.start().pipe(
                Effect.timeoutOption(OMP_ACP_REQUEST_TIMEOUT_MS),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(ompAcpTimeoutError("session/resume")),
                    onSome: Effect.succeed,
                  }),
                ),
              );
              return yield* forkRuntime(runtime);
            }).pipe(Effect.scoped);

        const resumeCursor = {
          schemaVersion: OMP_RESUME_VERSION,
          sessionId: forked.sessionId,
        };
        yield* startSession({
          threadId: input.threadId,
          provider: PROVIDER,
          cwd: targetCwd,
          runtimeMode: input.runtimeMode,
          resumeCursor,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        });
        return { threadId: input.threadId, resumeCursor };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderAdapterRequestError ||
          cause instanceof ProviderAdapterProcessError ||
          cause instanceof ProviderAdapterSessionClosedError ||
          cause instanceof ProviderAdapterSessionNotFoundError ||
          cause instanceof ProviderAdapterValidationError
            ? cause
            : mapAcpToAdapterError(PROVIDER, input.sourceThreadId, "session/fork", cause),
        ),
      );

    const stopSession: OmpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (ctx !== undefined && !ctx.stopped) {
            yield* stopSessionInternal(ctx);
            return;
          }
          if (sessionTeardownGate.isPending(threadId)) {
            yield* sessionTeardownGate.awaitPending(threadId);
            return;
          }
          return;
        }),
      );

    const listSessions: OmpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: OmpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const getComposerCapabilities: NonNullable<OmpAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        // Omp's TUI has /compact, but ACP currently exposes no compaction RPC
        // and treats that text as an ordinary model prompt.
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    const listModels: NonNullable<OmpAdapterShape["listModels"]> = (input) =>
      discoveryLock.withPermits(1)(
        Effect.gen(function* () {
          log.info("model/list enter", {
            inputBinaryPath: input.binaryPath ?? null,
            ompSettingsBinaryPath: ompSettings.binaryPath ?? null,
          });
          const binaryPath = input.binaryPath?.trim() || ompSettings.binaryPath?.trim() || "omp";
          const cacheKey = binaryPath;
          const cached = modelDiscoveryCache.get(cacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            log.info("model/list cache hit", {
              cacheKey,
              modelCount: cached.result.models.length,
            });
            return { ...cached.result, cached: true };
          }
          const result = yield* runOmpCliModelList(binaryPath).pipe(
            Effect.timeoutOption(OMP_MODEL_DISCOVERY_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "model/list",
                      detail: "Timed out while discovering Omp models via CLI.",
                    }),
                  ),
                onSome: (discovered) => Effect.succeed(discovered),
              }),
            ),
            Effect.mapError((cause) =>
              cause instanceof ProviderAdapterRequestError
                ? cause
                : new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "model/list",
                    detail:
                      cause instanceof Error && cause.message
                        ? cause.message
                        : "OMP model discovery failed unexpectedly.",
                  }),
            ),
            Effect.tapError((cause) =>
              Effect.sync(() => {
                if (cause instanceof ProviderAdapterRequestError) {
                  log.warn("model/list failed", {
                    method: cause.method,
                    detail: cause.detail,
                  });
                } else {
                  log.warn("model/list failed", { detail: String(cause) });
                }
              }),
            ),
          );
          log.info("model/list success", {
            modelCount: result.models.length,
            source: result.source,
          });
          setOmpDiscoveryCacheEntry(modelDiscoveryCache, cacheKey, {
            expiresAt: Date.now() + OMP_MODEL_DISCOVERY_CACHE_MS,
            result,
          });
          return result;
        }),
      );

    const listCommands: NonNullable<OmpAdapterShape["listCommands"]> = (input) =>
      discoveryLock.withPermits(1)(
        Effect.gen(function* () {
          const cwd = resolveOmpSessionCwd(input.cwd, serverConfig);
          if (!cwd) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "listCommands",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }
          const cacheKey = `${input.binaryPath?.trim() || ompSettings.binaryPath?.trim() || "omp"}\u0000${cwd}`;
          const cached = commandDiscoveryCache.get(cacheKey);
          if (input.forceReload !== true && cached && cached.expiresAt > Date.now()) {
            return { ...cached.result, cached: true };
          }
          const runtime = yield* makeOmpDiscoveryRuntime({
            ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
            cwd,
            clientName: "Synara Command Discovery",
          });
          yield* runtime.start();
          let commands = yield* runtime.getAvailableCommands;
          const startedAt = Date.now();
          while (commands.length === 0 && Date.now() - startedAt < 500) {
            yield* Effect.sleep(25);
            commands = yield* runtime.getAvailableCommands;
          }
          const result = {
            commands: commands.map((command) => ({
              name: command.name,
              ...(command.description ? { description: command.description } : {}),
            })),
            source: "omp-acp",
            cached: false,
          } satisfies ProviderListCommandsResult;
          setOmpDiscoveryCacheEntry(commandDiscoveryCache, cacheKey, {
            expiresAt: Date.now() + OMP_MODEL_DISCOVERY_CACHE_MS,
            result,
          });
          return result;
        }).pipe(
          Effect.scoped,
          Effect.mapError((cause) =>
            cause instanceof ProviderAdapterValidationError
              ? cause
              : mapAcpToAdapterError(
                  PROVIDER,
                  ThreadId.makeUnsafe("omp-command-discovery"),
                  "command/list",
                  cause,
                ),
          ),
          Effect.timeoutOption(OMP_MODEL_DISCOVERY_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "command/list",
                    detail: "Timed out while discovering Omp commands over ACP.",
                  }),
                ),
              onSome: (result) => Effect.succeed(result),
            }),
          ),
        ),
      );

    const stopAll: OmpAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
        conversationRollback: "restart-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      forkThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      getComposerCapabilities,
      listCommands,
      listModels,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies OmpAdapterShape;
  });
}

export const OmpAdapterLive = Layer.effect(OmpAdapter, makeOmpAdapter({}));

export function makeOmpAdapterLive(
  ompSettings: OmpAcpRuntimeSettings = {},
  options?: OmpAdapterLiveOptions,
) {
  return Layer.effect(OmpAdapter, makeOmpAdapter(ompSettings, options));
}
