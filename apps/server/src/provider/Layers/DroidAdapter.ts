/**
 * DroidAdapterLive - Factory Droid CLI (`droid exec --output-format acp`) via ACP.
 *
 * @module DroidAdapterLive
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
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as Acp from "@agentclientprotocol/sdk";

import { buildAcpSynaraMcpServers } from "../../agentGateway/mcpInjection.ts";
import {
  type SynaraHarnessPolicyDeliveryState,
  takeSynaraHarnessPolicyTextPartForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { listFactoryPlugins, readFactoryPlugin } from "../FactoryPluginDiscovery.ts";
import { readFactorySessionHistory } from "../FactorySessionHistory.ts";
import { appendProviderReferencesPromptBlock } from "../promptReferenceProjection.ts";
import {
  type ProviderAdapterError,
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
import { forkViaAcpRuntime } from "../acp/acpFork.ts";
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
  applyDroidAcpInteractionMode,
  applyDroidAcpModelSelection,
  discoverDroidAcpModels,
  makeDroidAcpRuntime,
  type DroidAcpRuntimeSettings,
} from "../acp/DroidAcpSupport.ts";
import { makeDroidSessionTeardownGate } from "../acp/DroidSessionTeardownGate.ts";
import { cancelDroidTurnAndWait } from "../acp/DroidTurnCancellation.ts";
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  isFormElicitationRequest,
} from "../acp/AcpElicitationSupport.ts";
import { DroidAdapter, type DroidAdapterShape } from "../Services/DroidAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "droid" as const;

export const takeDroidSynaraHarnessPolicyTextPart = (
  state: SynaraHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeSynaraHarnessPolicyTextPartForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable,
  });
const DROID_RESUME_VERSION = 1 as const;
const DROID_ACP_TRANSPORT_DEBUG_MARKER = "droid-acp-meta-stripper-v2";
const DROID_ACP_LOG_PAYLOAD_LIMIT = 4_000;
const DROID_ACP_DEBUG_ENV = "SYNARA_DROID_ACP_DEBUG";
const LEGACY_DROID_ACP_DEBUG_ENV = "DP_DROID_ACP_DEBUG";
const DROID_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const DROID_TURN_SETTLE_DRAIN_POLL_MS = 25;
// Backstop for an alive-but-silent droid child: if a turn produces no ACP
// activity for this long, force-fail it instead of showing "Working" forever.
// Generous by design so legitimate long, quiet tool runs are not killed;
// override with SYNARA_DROID_TURN_IDLE_TIMEOUT_MS when a workload needs longer.
const DROID_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_DROID_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const DROID_TURN_WATCHDOG_INTERVAL_MS = 15_000;
const DROID_NESTED_TASK_IDLE_TIMEOUT_MS = 60 * 60_000;
const DROID_CANCEL_GRACE_MS = 5_000;
const DROID_PLAN_CAPTURE_CANCEL_FALLBACK_MS = 1_000;
const DROID_ACP_REQUEST_TIMEOUT_MS = 30_000;
const DROID_STARTUP_REPLAY_MAX_WAIT_MS = 3_000;
const DROID_MODEL_DISCOVERY_CACHE_MS = 5 * 60_000;
const DROID_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const DROID_DISCOVERY_CACHE_MAX_ENTRIES = 16;
const DROID_RESOURCE_DISCIPLINE_PROMPT =
  "Keep CPU-intensive validation work serial: never overlap builds, typechecks, linters, tests, package audits, or package-manager commands, including across background agents. Wait for one CPU-intensive command to finish before starting the next. Read-only code inspection may still run in parallel.";
const DROID_PLAN_MODE_PROMPT_PREFIX = [
  "Synara Droid plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

function droidAcpTimeoutError(method: string): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: `Droid ACP did not respond to ${method} within ${DROID_ACP_REQUEST_TIMEOUT_MS / 1000}s.`,
  });
}

function runDroidAcpConfigurationAfterReplay<A, E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "awaitLoadReplayReady">;
  readonly threadId: ThreadId;
  readonly effect: Effect.Effect<A, E>;
}): Effect.Effect<A, E | ProviderAdapterError> {
  // Replay readiness owns its separate hard-cap budget. Only the actual
  // configuration work consumes the ACP request timeout.
  return input.runtime.awaitLoadReplayReady.pipe(
    Effect.mapError((cause) =>
      mapAcpToAdapterError(PROVIDER, input.threadId, "session/load", cause),
    ),
    Effect.andThen(
      input.effect.pipe(
        Effect.timeoutOption(DROID_ACP_REQUEST_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(droidAcpTimeoutError("session/set_config_option")),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
  );
}

function isDroidAcpDebugEnabled(): boolean {
  return (
    process.env[DROID_ACP_DEBUG_ENV] === "1" || process.env[LEGACY_DROID_ACP_DEBUG_ENV] === "1"
  );
}

export interface DroidAdapterLiveOptions {
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

interface DroidSessionContext {
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
  /** Turns cancelled by Synara only because their Plan proposal was captured. */
  readonly planCapturedTurnIds: Set<TurnId>;
  // Epoch-ms of the last inbound ACP activity for the active turn; drives the
  // idle-progress watchdog that force-fails a silently hung turn.
  lastTurnActivityAt: number | undefined;
  // Provider tool-call ids seen during the most recent turn, mapped to that
  // turn. A backlogged consumer can process a queued ToolCallUpdated after the
  // prompt response cleared activeTurnId; this keeps the event attributed to
  // its originating turn instead of dropping it as an orphan. Cleared when the
  // next turn dispatches.
  readonly turnToolCallIds: Map<string, TurnId>;
  // Droid executes `Task` subagents outside the parent ACP event stream. Track
  // their parent tool rows so the watchdog can use a longer, still-finite cap.
  readonly activeNestedTaskToolCallIds: Set<string>;
  readonly nestedTaskLifecycleByToolCallId: Map<string, "active" | "completed">;
  // Pending until startSession has applied the requested model/effort config.
  // The session is registered in `sessions` before the config RPCs run, which
  // means sendTurn can route to it mid-startup;
  // turns await this gate so the first prompt never runs with provider
  // defaults. Resolved by stopSessionInternal too, so a failed startup never
  // strands waiters.
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

export function scopeDroidRuntimeItemIdForTurn(turnId: TurnId, itemId: string): string {
  return scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, itemId);
}

// Droid can close a stale assistant segment before any visible text arrives.
export function isRenderableDroidAssistantDelta(input: {
  readonly streamKind?: string | undefined;
  readonly text: string;
}): boolean {
  return input.streamKind !== "reasoning_text" && input.text.trim().length > 0;
}

export function classifyDroidPromptTurnCompletion(input: {
  readonly planCaptured: boolean;
  readonly stopReason: string | null | undefined;
  readonly failedToolDetail?: string | undefined;
}): { readonly state: "completed" | "cancelled" | "failed"; readonly errorMessage?: string } {
  return input.planCaptured
    ? { state: "completed" }
    : classifyAcpPromptTurnCompletion({
        stopReason: input.stopReason,
        ...(input.failedToolDetail !== undefined
          ? { failedToolDetail: input.failedToolDetail }
          : {}),
      });
}

// Identifies Factory's parent `Task` tool row; child-session progress is not
// forwarded over ACP, so this marker is the only reliable liveness signal.
export function isDroidNestedTaskToolCall(toolCall: AcpToolCallState): boolean {
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
export function shouldIgnoreDroidInterrupt(
  requestedTurnId: TurnId | undefined,
  activeTurnId: TurnId | undefined,
): boolean {
  return requestedTurnId !== undefined && requestedTurnId !== activeTurnId;
}

export function extractDroidApproveSpecPlanMarkdown(
  toolCall: AcpToolCallState,
): string | undefined {
  if (toolCall.title?.trim().toLowerCase() !== "approve spec") {
    return undefined;
  }
  const rawInput = toolCall.data.rawInput;
  if (typeof rawInput !== "object" || rawInput === null || !("plan" in rawInput)) {
    return undefined;
  }
  const plan = rawInput.plan;
  return typeof plan === "string" && plan.trim().length > 0 ? plan.trim() : undefined;
}

export function isExpectedDroidPlanRejection(toolCall: AcpToolCallState): boolean {
  return (
    toolCall.title?.trim().toLowerCase() === "approve spec" &&
    toolCall.status === "failed" &&
    /plan not approved\s*-\s*remaining in spec mode/iu.test(toolCall.detail ?? "")
  );
}

// Droid may reuse ACP item ids across resumed history; DP runtime ids must stay turn-local.
export function scopeDroidToolCallStateForTurn(
  turnId: TurnId,
  toolCall: AcpToolCallState,
): AcpToolCallState {
  return scopeAcpToolCallStateForTurn(PROVIDER, turnId, toolCall);
}

function parseDroidResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== DROID_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

export function resolveDroidSessionCwd(
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

function setDroidDiscoveryCacheEntry<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > DROID_DISCOVERY_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export function makeDroidAdapter(
  droidSettings: DroidAcpRuntimeSettings,
  options?: DroidAdapterLiveOptions,
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

    const sessions = new Map<ThreadId, DroidSessionContext>();
    const sessionTeardownGate = makeDroidSessionTeardownGate();
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
    const makeDroidDiscoveryRuntime = (input: {
      readonly binaryPath?: string;
      readonly cwd: string;
      readonly clientName: string;
    }) =>
      makeDroidAcpRuntime({
        droidSettings: {
          ...(droidSettings.binaryPath ? { binaryPath: droidSettings.binaryPath } : {}),
          ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        },
        childProcessSpawner,
        cwd: input.cwd,
        clientInfo: { name: input.clientName, version: "0.0.0" },
      });

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
      ctx: DroidSessionContext,
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
      ctx: DroidSessionContext,
      toolCall: AcpToolCallState,
      turnId: TurnId,
    ) =>
      Effect.gen(function* () {
        if (!isDroidNestedTaskToolCall(toolCall)) {
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
    ): Effect.Effect<DroidSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (
      ctx: DroidSessionContext,
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
            yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId);
            ctx.gatewaySessionLease?.release();
            sessionTeardownGate.track(ctx.threadId, ctx.teardownComplete);
            if (sessions.get(ctx.threadId) === ctx) {
              sessions.delete(ctx.threadId);
            }
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            if (ctx.sessionConfigReady !== undefined) {
              yield* Deferred.succeed(ctx.sessionConfigReady, undefined);
              ctx.sessionConfigReady = undefined;
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

    const noteSuppressedDroidRuntimeEvent = (ctx: DroidSessionContext, eventTag: string) =>
      Effect.gen(function* () {
        if (!isDroidAcpDebugEnabled()) {
          return;
        }
        yield* Effect.logInfo("droid.acp.runtime_event_suppressed", {
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          eventTag,
          reason: "orphan-turn-event",
        });
      });

    const cancelDroidPromptWithGrace = (
      ctx: DroidSessionContext,
      promptFiber: Fiber.Fiber<void, never> | undefined,
    ) =>
      Effect.gen(function* () {
        const result = yield* cancelDroidTurnAndWait({
          cancel: ctx.acp.cancel,
          promptFiber,
          graceMs: DROID_CANCEL_GRACE_MS,
        });
        if (result.cancelRequest !== "sent" || result.prompt === "timedOut") {
          yield* Effect.logWarning("droid.acp.cancel_escalated", {
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            cancelRequest: result.cancelRequest,
            prompt: result.prompt,
            ...(result.cancelFailure ? { reason: result.cancelFailure } : {}),
          });
        }
        return result;
      });

    const settleCapturedDroidPlanTurn = (
      ctx: DroidSessionContext,
      turnId: TurnId,
      delayMs: number,
    ) =>
      Effect.gen(function* () {
        if (ctx.activeTurnId !== turnId || ctx.stopped) {
          return;
        }
        // Capture ownership immediately. The fallback delay is only for the
        // cancellation attempt; the prompt may settle during that delay and
        // must still complete as a successfully captured Plan turn.
        ctx.planCapturedTurnIds.add(turnId);
        // Only the cancellation work runs in the background. Keeping the marker
        // in this caller fiber closes the scheduler window where the prompt
        // could settle before a forked child executed its first instruction.
        yield* Effect.gen(function* () {
          // The expected rejected-tool update normally starts this immediately.
          // The delayed capture path is a fallback for providers that omit it.
          if (delayMs > 0) {
            yield* Effect.sleep(delayMs);
          }
          if (ctx.activeTurnId !== turnId || ctx.stopped) {
            return;
          }
          const result = yield* cancelDroidPromptWithGrace(ctx, ctx.activePromptFiber);
          if (
            result.prompt === "timedOut" ||
            (result.prompt === "notStarted" && result.cancelRequest !== "sent")
          ) {
            yield* stopSessionInternal(ctx, {
              exitKind: "error",
              reason: "Droid Plan turn did not settle after its proposal was captured.",
              awaitTermination: false,
            });
          }
        }).pipe(Effect.forkIn(ctx.scope));
      });

    const activeTurnIdForDroidRuntimeEvent = (ctx: DroidSessionContext, eventTag: string) =>
      Effect.gen(function* () {
        if (ctx.activeTurnId === undefined) {
          yield* noteSuppressedDroidRuntimeEvent(ctx, eventTag);
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
    const waitForDroidQueuedTurnEventsDrained = (ctx: DroidSessionContext) =>
      Effect.gen(function* () {
        const target = yield* ctx.acp.sessionUpdatesEnqueuedCount;
        const startedAt = Date.now();
        while (
          ctx.sessionUpdatesProcessed < target &&
          Date.now() - startedAt < DROID_TURN_SETTLE_DRAIN_MAX_WAIT_MS
        ) {
          yield* Effect.sleep(DROID_TURN_SETTLE_DRAIN_POLL_MS);
        }
      });

    const startSession: DroidAdapterShape["startSession"] = (input) =>
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
          const cwd = resolveDroidSessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const droidModelSelection =
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
          let ctx!: DroidSessionContext;

          const resumeSessionId = parseDroidResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const acpRuntimeLoggers = makeAcpDebugLoggers({
            base: acpNativeLoggers,
            enabled: isDroidAcpDebugEnabled(),
            provider: PROVIDER,
            marker: DROID_ACP_TRANSPORT_DEBUG_MARKER,
            payloadLimit: DROID_ACP_LOG_PAYLOAD_LIMIT,
            shouldMirrorIncomingRaw: (payload) => payload.includes("droidShell"),
          });
          const providerDroidOptions = input.providerOptions?.droid;
          const effectiveDroidSettings: DroidAcpRuntimeSettings = {
            appendSystemPrompt: DROID_RESOURCE_DISCIPLINE_PROMPT,
            ...(droidSettings.binaryPath !== undefined
              ? { binaryPath: droidSettings.binaryPath }
              : {}),
            ...(providerDroidOptions?.binaryPath !== undefined
              ? { binaryPath: providerDroidOptions.binaryPath }
              : {}),
            ...(droidModelSelection?.model ? { model: droidModelSelection.model } : {}),
            ...(droidModelSelection?.options?.reasoningEffort
              ? { reasoningEffort: droidModelSelection.options.reasoningEffort }
              : {}),
          };

          yield* Effect.logInfo("droid.acp.start", {
            marker: DROID_ACP_TRANSPORT_DEBUG_MARKER,
            debugEnv: DROID_ACP_DEBUG_ENV,
            threadId: input.threadId,
            cwd,
            resume: resumeSessionId !== undefined,
            model: effectiveDroidSettings.model,
            reasoningEffort: effectiveDroidSettings.reasoningEffort,
            binaryPath: effectiveDroidSettings.binaryPath ?? "droid",
          });

          const acp = yield* makeDroidAcpRuntime({
            droidSettings: effectiveDroidSettings,
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
                    if (isDroidAcpDebugEnabled()) {
                      yield* Effect.logInfo("droid.acp.permission_policy_applied", {
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
              .pipe(Effect.timeoutOption(DROID_ACP_REQUEST_TIMEOUT_MS));
            return yield* Option.match(startedOption, {
              onNone: () => Effect.fail(droidAcpTimeoutError("session/start")),
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
                "Droid could not resume the requested native session. Synara refused the fresh fallback to avoid silently losing conversation context.",
            });
          }

          const sessionConfigReady = yield* Deferred.make<void>();
          const teardownComplete = yield* Deferred.make<void>();
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: droidModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: DROID_RESUME_VERSION,
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
            planCapturedTurnIds: new Set(),
            lastTurnActivityAt: undefined,
            turnToolCallIds: new Map(),
            activeNestedTaskToolCallIds: new Set(),
            nestedTaskLifecycleByToolCallId: new Map(),
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
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      // Content deltas open the visible message; empty starts only add noise.
                    }
                    return;
                  case "AssistantItemCompleted":
                    {
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      const scopedItemId = scopeDroidRuntimeItemIdForTurn(
                        activeTurnId,
                        event.itemId,
                      );
                      if (!ctx.activeAssistantItemsWithContent.has(scopedItemId)) {
                        if (isDroidAcpDebugEnabled()) {
                          yield* Effect.logInfo("droid.acp.empty_assistant_item_suppressed", {
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
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
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
                      // place instead of being dropped as an orphan.
                      const lateTurnId =
                        ctx.activeTurnId === undefined
                          ? ctx.turnToolCallIds.get(event.toolCall.toolCallId)
                          : undefined;
                      if (lateTurnId !== undefined) {
                        yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                        if (isExpectedDroidPlanRejection(event.toolCall)) {
                          return;
                        }
                        yield* emitNestedTaskLifecycle(ctx, event.toolCall, lateTurnId);
                        yield* offerRuntimeEvent(
                          input.lifecycleGeneration,
                          makeAcpToolCallEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: lateTurnId,
                            toolCall: scopeDroidToolCallStateForTurn(lateTurnId, event.toolCall),
                            rawPayload: event.rawPayload,
                          }),
                        );
                        return;
                      }
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      ctx.turnToolCallIds.set(event.toolCall.toolCallId, activeTurnId);
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      const approveSpecPlan = extractDroidApproveSpecPlanMarkdown(event.toolCall);
                      if (ctx.activeInteractionMode === "plan" && approveSpecPlan !== undefined) {
                        if (ctx.lastPlanFingerprint !== approveSpecPlan) {
                          ctx.lastPlanFingerprint = approveSpecPlan;
                          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                            type: "turn.proposed.completed",
                            ...(yield* makeEventStamp()),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: activeTurnId,
                            itemId: RuntimeItemId.makeUnsafe(
                              `droid-plan-approval:${event.toolCall.toolCallId}`,
                            ),
                            payload: { planMarkdown: approveSpecPlan },
                            raw: {
                              source: "acp.jsonrpc",
                              method: "session/update",
                              payload: event.rawPayload,
                            },
                          });
                          yield* settleCapturedDroidPlanTurn(
                            ctx,
                            activeTurnId,
                            DROID_PLAN_CAPTURE_CANCEL_FALLBACK_MS,
                          );
                        }
                        if (
                          event.toolCall.status === "pending" ||
                          event.toolCall.status === "inProgress"
                        ) {
                          return;
                        }
                      }
                      if (
                        ctx.activeInteractionMode === "plan" &&
                        isExpectedDroidPlanRejection(event.toolCall)
                      ) {
                        yield* settleCapturedDroidPlanTurn(ctx, activeTurnId, 0);
                        return;
                      }
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
                          toolCall: scopeDroidToolCallStateForTurn(activeTurnId, event.toolCall),
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                  case "ContentDelta":
                    {
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      const scopedItemId = event.itemId
                        ? scopeDroidRuntimeItemIdForTurn(activeTurnId, event.itemId)
                        : undefined;
                      if (isRenderableDroidAssistantDelta(event)) {
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
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
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
                // waitForDroidQueuedTurnEventsDrained cannot observe an event as
                // consumed while its state updates are still being applied.
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.sessionUpdatesProcessed += 1;
                  }),
                ),
              ),
            ),
            // The drain's lifetime is the session's, not the caller's: forking it as
            // a child of the fiber that called startSession kills it as soon as that
            // fiber returns, silently dropping every session/update.
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          // The consumer fork activates the shared replay gate. Configuration
          // remains pending until replay settles, but startup only waits briefly
          // while holding the thread lock so stop/restart stays responsive.
          yield* Effect.gen(function* () {
            const configurationFiber = yield* runDroidAcpConfigurationAfterReplay({
              runtime: acp,
              threadId: input.threadId,
              effect: Effect.gen(function* () {
                if (droidModelSelection?.model) {
                  yield* applyDroidAcpModelSelection({
                    runtime: acp,
                    model: droidModelSelection.model,
                    reasoningEffort: droidModelSelection.options?.reasoningEffort,
                    mapError: ({ cause, method }) =>
                      mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
                  });
                }
                // Turns await this deferred, so none can inherit provider
                // defaults while long replay/configuration work continues.
                yield* Deferred.succeed(sessionConfigReady, undefined);
                ctx.sessionConfigReady = undefined;
              }),
            }).pipe(
              Effect.onError((cause) =>
                stopSessionInternal(ctx, {
                  exitKind: "error",
                  reason: Cause.pretty(cause),
                  awaitTermination: false,
                }),
              ),
              Effect.forkIn(ctx.scope),
            );

            yield* Fiber.join(configurationFiber).pipe(
              Effect.timeoutOption(DROID_STARTUP_REPLAY_MAX_WAIT_MS),
            );

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
              payload: { state: "ready", reason: "Droid ACP session ready" },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : Effect.ignore(stopSessionInternal(ctx, { awaitTermination: false })),
            ),
          );

          return session;
        }).pipe(Effect.scoped),
      );

    // Idle-progress watchdog escape hatch: force-fail a turn whose droid child
    // is alive but has gone completely silent. Mirrors the prompt-fiber
    // onFailure branch and stays idempotent via clearAcpActiveTurn, so it is a
    // no-op if the turn settled normally first (whichever fires first wins).
    const failDroidTurnAsTimedOut = (ctx: DroidSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (ctx.activeTurnId !== turnId) {
          return;
        }
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
        ctx.planCapturedTurnIds.delete(turnId);
        if (!clearAcpActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeAcpActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `Droid stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({ id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning("droid.acp.turn_idle_timeout", {
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
        // Let Droid flush final ACP updates and settle session/prompt before
        // escalating to process teardown for a silent nested worker.
        yield* cancelDroidPromptWithGrace(ctx, promptFiber);
        yield* stopSessionInternal(ctx, {
          exitKind: "error",
          reason: detail,
          awaitTermination: false,
        });
      });

    const sendTurn: DroidAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A second sendTurn entering while another turn is still starting would
        // clear that turn's pendingTurnInterrupted flag (letting a cancelled
        // turn dispatch anyway) and race two ACP prompts; reject it instead.
        if (ctx.turnStarting) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Another Droid turn is still starting for this thread.",
          });
        }
        ctx.turnStarting = true;
        ctx.pendingTurnInterrupted = false;
        return yield* startDroidTurn(ctx, input).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.turnStarting = false;
            }),
          ),
        );
      });

    const startDroidTurn = (
      ctx: DroidSessionContext,
      input: Parameters<DroidAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        // Startup registers the session before its config RPCs settle; a turn
        // routed in during that window must not prompt with provider defaults.
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.await(ctx.sessionConfigReady);
        }
        // The setup gate above is resolved by stopSessionInternal too; a turn
        // unblocked by a failed or stopped startup must fail here instead of
        // emitting lifecycle events for a dead session.
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
        yield* runDroidAcpConfigurationAfterReplay({
          runtime: ctx.acp,
          threadId: input.threadId,
          effect: Effect.gen(function* () {
            if (model !== undefined) {
              yield* applyDroidAcpModelSelection({
                runtime: ctx.acp,
                model,
                reasoningEffort: turnModelSelection?.options?.reasoningEffort,
                mapError: ({ cause, method }) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
              });
            }
            yield* applyDroidAcpInteractionMode({
              runtime: ctx.acp,
              interactionMode,
              runtimeMode,
              mapError: ({ cause, method }) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
            });
          }),
        }).pipe(
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
                  promptPrefix: DROID_PLAN_MODE_PROMPT_PREFIX,
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
        const harnessPolicy = takeDroidSynaraHarnessPolicyTextPart(
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
          // interruptTurn during attachment reads or between turn.started publishing
          // and this fiber being registered sets pendingTurnInterrupted; honor it and
          // a concurrent stop here so a cancelled turn is never prompted. Self-interrupting
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
                yield* waitForDroidQueuedTurnEventsDrained(ctx);
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                ctx.planCapturedTurnIds.delete(turnId);
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
                yield* waitForDroidQueuedTurnEventsDrained(ctx);
                const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                const planCaptured = ctx.planCapturedTurnIds.delete(turnId);
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
                  yield* Effect.logWarning("droid.acp.turn_completed_without_content", {
                    threadId: input.threadId,
                    turnId,
                    stopReason: result.stopReason ?? null,
                    hasUsage: result.usage !== undefined,
                  });
                }
                const completion = classifyDroidPromptTurnCompletion({
                  planCaptured,
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
              const planCaptured = ctx.planCapturedTurnIds.delete(turnId);
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
                  state: planCaptured ? "completed" : "cancelled",
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
          idleTimeoutMs: DROID_TURN_IDLE_TIMEOUT_MS,
          currentIdleTimeoutMs: () =>
            ctx.activeNestedTaskToolCallIds.size > 0
              ? DROID_NESTED_TASK_IDLE_TIMEOUT_MS
              : DROID_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: DROID_TURN_WATCHDOG_INTERVAL_MS,
          scope: ctx.scope,
          isTurnActive: () => ctx.activeTurnId === turnId && !ctx.stopped,
          isAwaitingHuman: () => ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
          lastActivityAt: () => ctx.lastTurnActivityAt ?? Date.now(),
          touchActivity: () => {
            ctx.lastTurnActivityAt = Date.now();
          },
          onIdleTimeout: (idleMs) => failDroidTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          ...(ctx.session.resumeCursor !== undefined
            ? { resumeCursor: ctx.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: DroidAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (shouldIgnoreDroidInterrupt(turnId, ctx.activeTurnId)) {
          yield* Effect.logWarning("droid.acp.stale_interrupt_ignored", {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: ctx.activeTurnId,
          });
          return;
        }
        if (!ctx.turnStarting && ctx.activeTurnId === undefined) {
          return;
        }
        const activeTurnId = turnId ?? ctx.activeTurnId;
        // A turn that is still starting has no prompt fiber to interrupt yet;
        // flag it so startDroidTurn aborts before prompting instead of running
        // the cancelled turn anyway.
        if (ctx.turnStarting && ctx.activePromptFiber === undefined) {
          ctx.pendingTurnInterrupted = true;
        }
        yield* withAgentGatewayTurnCancellation(
          ctx.gatewaySessionLease,
          activeTurnId,
          Effect.gen(function* () {
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            const activePromptFiber = ctx.activePromptFiber;
            yield* cancelDroidPromptWithGrace(ctx, activePromptFiber);
            // Closing the process group is intentional: Factory can acknowledge
            // cancel before nested workers quiesce, so session reuse is unsafe.
            yield* stopSessionInternal(ctx, {
              exitKind: "graceful",
              reason: "Droid turn cancelled; runtime closed to stop nested work.",
            });
          }),
        );
      });

    const respondToRequest: DroidAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
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

    const respondToUserInput: DroidAdapterShape["respondToUserInput"] = (
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

    const readThread: DroidAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const readExternalThread: NonNullable<DroidAdapterShape["readExternalThread"]> = (input) =>
      Effect.tryPromise({
        try: () => readFactorySessionHistory(serverConfig.homeDir, input.externalThreadId),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/read",
            detail: cause instanceof Error ? cause.message : "Failed to read the Droid session.",
            cause,
          }),
      }).pipe(
        Effect.flatMap((history) =>
          history
            ? Effect.succeed({
                threadId: ThreadId.makeUnsafe(history.sessionId),
                ...(history.cwd ? { cwd: history.cwd } : {}),
                turns: history.messages.map((message, index) => ({
                  id: TurnId.makeUnsafe(`factory:${message.id}:${index}`),
                  items: [{ type: "factoryMessage", ...message }],
                })),
              })
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "thread/read",
                  detail: `Droid session '${input.externalThreadId}' was not found locally.`,
                }),
              ),
        ),
      );

    const rollbackThread: DroidAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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
            "Droid does not expose a native rewind cursor; rollback must restart the session with retained transcript context.",
        });
      });

    const forkThread: NonNullable<DroidAdapterShape["forkThread"]> = (input) =>
      Effect.gen(function* () {
        const sourceCwd = resolveDroidSessionCwd(input.sourceCwd ?? input.cwd, serverConfig);
        const targetCwd = resolveDroidSessionCwd(input.cwd ?? input.sourceCwd, serverConfig);
        if (!sourceCwd || !targetCwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue: "A source and target cwd are required to fork a Droid session.",
          });
        }

        const forkRuntime = (runtime: AcpSessionRuntimeShape) =>
          forkViaAcpRuntime({
            provider: PROVIDER,
            runtime,
            targetCwd,
            unsupportedIssue:
              "This Droid ACP version does not advertise session/fork; Synara will rebuild the fork from its retained transcript.",
            requestTimeoutMs: DROID_ACP_REQUEST_TIMEOUT_MS,
            timeoutError: droidAcpTimeoutError,
          });

        const activeSource = sessions.get(input.sourceThreadId);
        // Forking mid-turn would branch from incomplete in-flight state, so
        // let the retained-transcript fallback handle busy sources.
        if (activeSource?.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue:
              "The source Droid session has a turn in flight; Synara will rebuild the fork from its retained transcript.",
          });
        }
        const forked = activeSource
          ? yield* forkRuntime(activeSource.acp)
          : yield* Effect.gen(function* () {
              const sourceSessionId = parseDroidResume(input.sourceResumeCursor)?.sessionId;
              if (!sourceSessionId) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "forkThread",
                  issue: "The source Droid session has no resumable native cursor.",
                });
              }
              const runtime = yield* makeDroidAcpRuntime({
                droidSettings: {
                  ...(droidSettings.binaryPath ? { binaryPath: droidSettings.binaryPath } : {}),
                  ...(input.providerOptions?.droid?.binaryPath
                    ? { binaryPath: input.providerOptions.droid.binaryPath }
                    : {}),
                },
                childProcessSpawner,
                cwd: sourceCwd,
                resumeSessionId: sourceSessionId,
                clientInfo: { name: "Synara Fork", version: "0.0.0" },
              });
              yield* runtime.start().pipe(
                Effect.timeoutOption(DROID_ACP_REQUEST_TIMEOUT_MS),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(droidAcpTimeoutError("session/resume")),
                    onSome: Effect.succeed,
                  }),
                ),
              );
              return yield* forkRuntime(runtime);
            }).pipe(Effect.scoped);

        // Return only the cursor: ProviderService registers the binding under
        // a committed lifecycle lease and the target's first turn resumes it
        // there. Starting the runtime here would capture an undefined
        // lifecycle generation, orphaning the fork's approval requests.
        return {
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: DROID_RESUME_VERSION,
            sessionId: forked.sessionId,
          },
        };
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

    const stopSession: DroidAdapterShape["stopSession"] = (threadId) =>
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

    const listSessions: DroidAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: DroidAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const getComposerCapabilities: NonNullable<DroidAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
        // Droid's TUI has /compact, but ACP currently exposes no compaction RPC
        // and treats that text as an ordinary model prompt.
        supportsThreadCompaction: false,
        supportsThreadImport: true,
      } satisfies ProviderComposerCapabilities);

    const listModels: NonNullable<DroidAdapterShape["listModels"]> = (input) =>
      discoveryLock.withPermits(1)(
        Effect.gen(function* () {
          const cwd = resolveDroidSessionCwd(input.cwd, serverConfig);
          if (!cwd) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "listModels",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }
          const cacheKey = `${input.binaryPath?.trim() || droidSettings.binaryPath?.trim() || "droid"}\u0000${cwd}`;
          const cached = modelDiscoveryCache.get(cacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            return { ...cached.result, cached: true };
          }
          const runtime = yield* makeDroidDiscoveryRuntime({
            ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
            cwd,
            clientName: "Synara Model Discovery",
          });
          yield* runtime.start();
          const result = yield* discoverDroidAcpModels(runtime);
          const commands = yield* runtime.getAvailableCommands;
          setDroidDiscoveryCacheEntry(commandDiscoveryCache, cacheKey, {
            expiresAt: Date.now() + DROID_MODEL_DISCOVERY_CACHE_MS,
            result: {
              commands: commands.map((command) => ({
                name: command.name,
                ...(command.description ? { description: command.description } : {}),
              })),
              source: "droid-acp",
              cached: false,
            },
          });
          setDroidDiscoveryCacheEntry(modelDiscoveryCache, cacheKey, {
            expiresAt: Date.now() + DROID_MODEL_DISCOVERY_CACHE_MS,
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
                  ThreadId.makeUnsafe("droid-model-discovery"),
                  "model/list",
                  cause,
                ),
          ),
          Effect.timeoutOption(DROID_MODEL_DISCOVERY_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "model/list",
                    detail: "Timed out while discovering Droid models over ACP.",
                  }),
                ),
              onSome: (result) => Effect.succeed(result),
            }),
          ),
        ),
      );

    const listPlugins: NonNullable<DroidAdapterShape["listPlugins"]> = (input) => {
      const sessionCwd = input.threadId
        ? sessions.get(ThreadId.makeUnsafe(input.threadId))?.session.cwd
        : undefined;
      const cwd = resolveDroidSessionCwd(input.cwd, serverConfig, sessionCwd);
      return Effect.tryPromise({
        try: () => listFactoryPlugins(serverConfig.homeDir, cwd),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/list",
            detail: cause instanceof Error ? cause.message : "Failed to read Factory plugins.",
            cause,
          }),
      });
    };

    const readPlugin: NonNullable<DroidAdapterShape["readPlugin"]> = (input) => {
      const sessionCwd = input.threadId
        ? sessions.get(ThreadId.makeUnsafe(input.threadId))?.session.cwd
        : undefined;
      const cwd = resolveDroidSessionCwd(input.cwd, serverConfig, sessionCwd);
      return Effect.tryPromise({
        try: () =>
          readFactoryPlugin({
            homeDir: serverConfig.homeDir,
            marketplacePath: input.marketplacePath,
            pluginName: input.pluginName,
            ...(cwd !== undefined ? { cwd } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/read",
            detail: cause instanceof Error ? cause.message : "Failed to read the Factory plugin.",
            cause,
          }),
      }).pipe(
        Effect.flatMap((result) =>
          result
            ? Effect.succeed(result)
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "plugin/read",
                  detail: `Factory plugin '${input.pluginName}' was not found.`,
                }),
              ),
        ),
      );
    };

    const listCommands: NonNullable<DroidAdapterShape["listCommands"]> = (input) =>
      discoveryLock.withPermits(1)(
        Effect.gen(function* () {
          const cwd = resolveDroidSessionCwd(input.cwd, serverConfig);
          if (!cwd) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "listCommands",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }
          const cacheKey = `${input.binaryPath?.trim() || droidSettings.binaryPath?.trim() || "droid"}\u0000${cwd}`;
          const cached = commandDiscoveryCache.get(cacheKey);
          if (input.forceReload !== true && cached && cached.expiresAt > Date.now()) {
            return { ...cached.result, cached: true };
          }
          const runtime = yield* makeDroidDiscoveryRuntime({
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
            source: "droid-acp",
            cached: false,
          } satisfies ProviderListCommandsResult;
          setDroidDiscoveryCacheEntry(commandDiscoveryCache, cacheKey, {
            expiresAt: Date.now() + DROID_MODEL_DISCOVERY_CACHE_MS,
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
                  ThreadId.makeUnsafe("droid-command-discovery"),
                  "command/list",
                  cause,
                ),
          ),
          Effect.timeoutOption(DROID_MODEL_DISCOVERY_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "command/list",
                    detail: "Timed out while discovering Droid commands over ACP.",
                  }),
                ),
              onSome: (result) => Effect.succeed(result),
            }),
          ),
        ),
      );

    const stopAll: DroidAdapterShape["stopAll"] = () =>
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
      readExternalThread,
      rollbackThread,
      forkThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      getComposerCapabilities,
      listCommands,
      listModels,
      listPlugins,
      readPlugin,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies DroidAdapterShape;
  });
}

export const DroidAdapterLive = Layer.effect(DroidAdapter, makeDroidAdapter({}));

export function makeDroidAdapterLive(
  droidSettings: DroidAcpRuntimeSettings = {},
  options?: DroidAdapterLiveOptions,
) {
  return Layer.effect(DroidAdapter, makeDroidAdapter(droidSettings, options));
}
