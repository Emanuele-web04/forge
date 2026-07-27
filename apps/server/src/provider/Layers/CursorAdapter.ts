/**
 * CursorAdapterLive — Cursor CLI (`cursor-agent acp`) via ACP.
 *
 * @module CursorAdapterLive
 */
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  type CursorModelOptions,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderListModelsResult,
  type ProviderListSkillsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@synara/contracts";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import {
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
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
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
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
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
  makeAcpThreadLock,
  readAcpUsdCost,
  resolveRequestedAcpSessionModeId,
  resolveAcpTurnInteractionMode,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
} from "../acp/AcpAdapterSessionSupport.ts";
import type * as AcpErrors from "../acp/AcpErrors.ts";
import {
  type AcpSessionRuntimeShape,
  type AcpSessionStartupTimeouts,
} from "../acp/AcpSessionRuntime.ts";
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
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  forkAcpTurnIdleWatchdog,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  applyCursorAcpModelSelection,
  buildCursorCliModelListCommand,
  fetchCursorAcpModelDescriptors,
  makeCursorAcpRuntime,
  parseCursorCliModelList,
  resolveCursorAcpBaseModelId,
  type CursorAcpModelSelectionNotice,
  type CursorAcpRuntimeCursorSettings,
} from "../acp/CursorAcpSupport.ts";
import {
  buildCursorAgentHeadlessEnv,
  resolveCursorAgentBinaryPath,
} from "../acp/CursorAcpCommand.ts";
import {
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "../acp/CursorAcpExtension.ts";
import { CursorAdapter, type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { discoverCursorSkills } from "../cursorSkillsDiscovery.ts";

const PROVIDER = "cursor" as const;

export const takeCursorSynaraHarnessPolicyTextPart = (
  state: SynaraHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeSynaraHarnessPolicyTextPartForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable,
  });
const CURSOR_RESUME_VERSION = 1 as const;
const CURSOR_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
// `cursor-agent` authenticates against the macOS Keychain: 1-12s is normal and it
// hangs forever when a Keychain prompt cannot be shown, so authenticate gets the
// widest budget while the aggregate cap keeps a stuck startup from hanging a thread.
const CURSOR_ACP_STARTUP_TIMEOUTS = {
  initializeMs: 20_000,
  authenticateMs: 30_000,
  sessionSetupMs: 20_000,
  totalMs: 60_000,
} as const satisfies AcpSessionStartupTimeouts;
// Backstop for an alive-but-silent cursor-agent child: if a turn produces no
// ACP activity for this long, force-fail it instead of showing "Working"
// forever. Generous by design; override with SYNARA_CURSOR_TURN_IDLE_TIMEOUT_MS.
const CURSOR_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_CURSOR_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const CURSOR_TURN_WATCHDOG_INTERVAL_MS = 15_000;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];
const CURSOR_ACP_SESSION_MODE_ALIASES = {
  plan: ACP_PLAN_MODE_ALIASES,
  implement: ACP_IMPLEMENT_MODE_ALIASES,
  approval: ACP_APPROVAL_MODE_ALIASES,
} as const;
const CURSOR_PLAN_MODE_PROMPT_PREFIX = [
  "Synara Cursor plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

export interface CursorAdapterLiveOptions {
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

interface CursorSessionContext {
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
  readonly assistantItemTurnIds: Map<string, TurnId>;
  lastPlanFingerprint: string | undefined;
  completedPlanFingerprint: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  // Epoch-ms of the last inbound ACP activity for the active turn; drives the
  // idle-progress watchdog that force-fails a silently hung turn.
  lastTurnActivityAt: number | undefined;
  latestSessionCostUsd: number | undefined;
  stopped: boolean;
}

function clearCursorActiveTurn(ctx: CursorSessionContext, turnId: TurnId): boolean {
  if (ctx.activeTurnId !== turnId) {
    return false;
  }

  ctx.activeTurnId = undefined;
  ctx.activeTurnFailedToolDetail = undefined;
  ctx.activePromptFiber = undefined;
  ctx.activeInteractionMode = undefined;
  const { activeTurnId: _activeTurnId, ...session } = ctx.session;
  ctx.session = session;
  return true;
}

function resolveCursorAssistantItemTurnId(
  ctx: CursorSessionContext,
  itemId: string | undefined,
): TurnId | undefined {
  if (itemId === undefined) {
    return ctx.activeTurnId;
  }
  const knownTurnId = ctx.assistantItemTurnIds.get(itemId);
  if (knownTurnId !== undefined) {
    return knownTurnId;
  }
  if (ctx.activeTurnId !== undefined) {
    ctx.assistantItemTurnIds.set(itemId, ctx.activeTurnId);
    return ctx.activeTurnId;
  }
  return ctx.assistantItemTurnIds.get(itemId);
}

function completeCursorAssistantItemTurnId(
  ctx: CursorSessionContext,
  itemId: string,
): TurnId | undefined {
  const turnId = resolveCursorAssistantItemTurnId(ctx, itemId);
  ctx.assistantItemTurnIds.delete(itemId);
  return turnId;
}

function recordCursorSessionCost(
  ctx: CursorSessionContext,
  cost: Acp.Cost | null | undefined,
): void {
  const sessionCostUsd = readAcpUsdCost(cost);
  if (sessionCostUsd === undefined) {
    return;
  }
  ctx.latestSessionCostUsd = sessionCostUsd;
}

// ACP reports session-cumulative cost, so keep it cumulative instead of inventing turn deltas.
function finalizeCursorActiveTurnCost(ctx: CursorSessionContext): {
  readonly cumulativeCostUsd?: number;
} {
  return ctx.latestSessionCostUsd !== undefined
    ? { cumulativeCostUsd: ctx.latestSessionCostUsd }
    : {};
}

function withCursorPlanModePrompt(input: {
  readonly text: string;
  readonly interactionMode?: ProviderInteractionMode;
}): string {
  if (input.interactionMode !== "plan") {
    return input.text;
  }

  const text = input.text.trim();
  return text.length > 0
    ? `${CURSOR_PLAN_MODE_PROMPT_PREFIX}\n\nUser request:\n${text}`
    : CURSOR_PLAN_MODE_PROMPT_PREFIX;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursorResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CURSOR_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function describeCursorErrorCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message.trim();
  }
  if (typeof cause === "string") {
    return cause.trim();
  }
  return "";
}

function describeCursorAcpErrorData(data: unknown): string {
  if (typeof data === "string") {
    return data.trim();
  }
  if (!isRecord(data)) {
    return "";
  }
  const detail = data.detail ?? data.details ?? data.message;
  if (typeof detail === "string" && detail.trim()) {
    return detail.trim();
  }
  return JSON.stringify(data).slice(0, 500);
}

// Startup failures are the only signal the user gets about why Cursor did not
// come up, so keep the agent's own wording (JSON-RPC data included) instead of
// the tagged-error class defaults, which carry no detail for transport errors.
function cursorAcpFailureDetail(error: AcpErrors.AcpError): string {
  if (error._tag === "AcpRequestError") {
    const message = error.errorMessage.trim();
    const data = describeCursorAcpErrorData(error.data);
    const detail = [message, data && data !== message ? data : ""].filter(Boolean).join(" — ");
    return detail
      ? `${detail} (JSON-RPC ${String(error.code)})`
      : `Cursor ACP request failed (JSON-RPC ${String(error.code)}).`;
  }
  const causeDetail = describeCursorErrorCause(error.cause);
  const baseDetail =
    error._tag === "AcpTransportError" ? error.detail.trim() : error.message.trim();
  return [baseDetail, causeDetail && causeDetail !== baseDetail ? causeDetail : ""]
    .filter(Boolean)
    .join(" — ");
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: CursorModelOptions | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: AcpErrors.AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
  readonly onModelSelectionNotice?: (notice: CursorAcpModelSelectionNotice) => Effect.Effect<void>;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyCursorAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        options: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
        ...(input.onModelSelectionNotice ? { onNotice: input.onModelSelectionNotice } : {}),
      });
    }

    const requestedModeId = resolveRequestedAcpSessionModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
      aliases: CURSOR_ACP_SESSION_MODE_ALIASES,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

function resolveCursorSessionCwd(
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
): string | undefined {
  const requestedCwd = inputCwd?.trim();
  if (requestedCwd) {
    return nodePath.resolve(requestedCwd);
  }

  const fallbackCwd = serverConfig.cwd.trim() || serverConfig.homeDir.trim();
  return fallbackCwd ? nodePath.resolve(fallbackCwd) : undefined;
}

export function makeCursorAdapter(
  cursorSettings: CursorAcpRuntimeCursorSettings,
  options?: CursorAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    // Optional so adapter tests can run without the gateway layer; when
    // present, every session gets the synara_* MCP tools.
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, CursorSessionContext>();
    const withThreadLock = yield* makeAcpThreadLock();
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

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | "acp.cursor.extension",
    ) =>
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

    // Degraded model selection is a visible-but-non-fatal condition: the session
    // keeps running on whatever model Cursor actually accepted.
    const emitCursorModelSelectionNotice = (input: {
      readonly threadId: ThreadId;
      readonly lifecycleGeneration: string | undefined;
      readonly turnId: TurnId | undefined;
      readonly notice: CursorAcpModelSelectionNotice;
    }) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("cursor.acp.model_selection_degraded", {
          threadId: input.threadId,
          reason: input.notice.reason,
          requestedModel: input.notice.requestedModel,
          appliedModel: input.notice.appliedModel,
        });
        yield* offerRuntimeEvent(input.lifecycleGeneration, {
          type: "runtime.warning",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          payload: {
            message: input.notice.message,
            detail: {
              reason: input.notice.reason,
              requestedModel: input.notice.requestedModel,
              ...(input.notice.appliedModel !== undefined
                ? { appliedModel: input.notice.appliedModel }
                : {}),
            },
          },
        });
      });

    const completeCursorPlanTurn = (
      ctx: CursorSessionContext,
      turnId: TurnId,
      activePromptFiber: Fiber.Fiber<void, never> | undefined,
    ) =>
      Effect.gen(function* () {
        if (!clearCursorActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeCursorActiveTurnCost(ctx);
        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "ready",
          updatedAt: yield* nowIso,
        };
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: { state: "completed", stopReason: null, ...completedCost },
        });
        yield* Effect.ignore(ctx.acp.cancel);
        if (activePromptFiber) {
          yield* Fiber.interrupt(activePromptFiber);
        }
      });

    // Idle-progress watchdog escape hatch: force-fail a turn whose cursor-agent
    // child is alive but has gone completely silent. Stays idempotent via
    // clearCursorActiveTurn, so it is a no-op if the turn settled normally first.
    const failCursorTurnAsTimedOut = (ctx: CursorSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (!clearCursorActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeCursorActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `Cursor stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({ id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning("cursor.acp.turn_idle_timeout", {
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
        // Best-effort: tell the child to abandon the turn, then unwind the
        // pending prompt fiber (its onInterrupt no-ops, the turn is cleared).
        yield* Effect.ignore(ctx.acp.cancel);
        if (promptFiber) {
          yield* Fiber.interrupt(promptFiber);
        }
      });

    const emitPlanUpdate = (
      ctx: CursorSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | "acp.cursor.extension",
      method: string,
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
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CursorSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: CursorSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        ctx.gatewaySessionLease?.release();
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: CursorAdapterShape["startSession"] = (input) =>
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
          const cwd = resolveCursorSessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const cursorModelSelection =
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
          let ctx!: CursorSessionContext;

          const resumeSessionId = parseCursorResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const providerCursorOptions = input.providerOptions?.cursor;
          const effectiveCursorSettings: CursorAcpRuntimeCursorSettings = {
            ...(cursorSettings.binaryPath !== undefined
              ? { binaryPath: cursorSettings.binaryPath }
              : {}),
            ...(cursorSettings.apiEndpoint !== undefined
              ? { apiEndpoint: cursorSettings.apiEndpoint }
              : {}),
            ...(providerCursorOptions?.binaryPath !== undefined
              ? { binaryPath: providerCursorOptions.binaryPath }
              : {}),
            ...(providerCursorOptions?.apiEndpoint !== undefined
              ? { apiEndpoint: providerCursorOptions.apiEndpoint }
              : {}),
          };

          const acp = yield* makeCursorAcpRuntime({
            cursorSettings: effectiveCursorSettings,
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "Synara", version: "0.0.0" },
            startupTimeouts: CURSOR_ACP_STARTUP_TIMEOUTS,
            ...(agentGatewayCredentials
              ? {
                  buildMcpServers: (initializeResult) =>
                    buildAcpSynaraMcpServers({
                      connection: gatewaySessionLease!.connection,
                      initializeResult,
                      stdioProxy: agentGatewayCredentials.stdioProxy,
                    }),
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cursorAcpFailureDetail(cause),
                  cause,
                }),
            ),
          );
          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);
          const started = yield* Effect.gen(function* () {
            yield* acp.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "cursor/ask_question",
                  params,
                  "acp.cursor.extension",
                );
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
                  payload: { questions: extractAskQuestions(params) },
                  raw: {
                    source: "acp.cursor.extension",
                    method: "cursor/ask_question",
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
                return { answers: resolved };
              }),
            );
            yield* acp.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "cursor/create_plan",
                  params,
                  "acp.cursor.extension",
                );
                const turnId = ctx?.activeTurnId;
                const activePromptFiber = ctx?.activePromptFiber;
                const planMarkdown = extractPlanMarkdown(params);
                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "turn.proposed.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: { planMarkdown },
                  raw: {
                    source: "acp.cursor.extension",
                    method: "cursor/create_plan",
                    payload: params,
                  },
                });
                if (
                  ctx &&
                  turnId !== undefined &&
                  ctx.activeInteractionMode === "plan" &&
                  ctx.completedPlanFingerprint !== planMarkdown
                ) {
                  ctx.completedPlanFingerprint = planMarkdown;
                  yield* completeCursorPlanTurn(ctx, turnId, activePromptFiber);
                }
                return { accepted: true } as const;
              }),
            );
            const handleCursorUpdateTodos = (params: typeof CursorUpdateTodosRequest.Type) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "cursor/update_todos",
                  params,
                  "acp.cursor.extension",
                );
                if (ctx) {
                  yield* emitPlanUpdate(
                    ctx,
                    extractTodosAsPlan(params),
                    params,
                    "acp.cursor.extension",
                    "cursor/update_todos",
                  );
                }
              });
            // Cursor Agent CLI sends cursor/update_todos as a request with an id; keep the
            // notification handler for older or alternate ACP clients.
            yield* acp.handleExtRequest("cursor/update_todos", CursorUpdateTodosRequest, (params) =>
              handleCursorUpdateTodos(params).pipe(Effect.as({ accepted: true } as const)),
            );
            yield* acp.handleExtNotification(
              "cursor/update_todos",
              CursorUpdateTodosRequest,
              handleCursorUpdateTodos,
            );
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "session/request_permission",
                  params,
                  "acp.jsonrpc",
                );
                const policyOutcome = resolveAcpPermissionPolicy({
                  runtimeMode: input.runtimeMode,
                  interactionMode: ctx?.activeInteractionMode,
                  options: params.options,
                });
                if (policyOutcome !== undefined) {
                  return { outcome: policyOutcome };
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, {
                  decision,
                  kind: permissionRequest.kind,
                });
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
            return yield* acp.start();
          }).pipe(
            // Not mapAcpToAdapterError: startup must surface the agent's own
            // failure text (Keychain -32603 data, "Authentication required…",
            // startup timeout step) instead of a generic wrapper message.
            Effect.mapError(
              (error) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/start",
                  detail: `Cursor session startup failed: ${cursorAcpFailureDetail(error)}`,
                  cause: error,
                }),
            ),
          );

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: cursorModelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
            onModelSelectionNotice: (notice) =>
              emitCursorModelSelectionNotice({
                threadId: input.threadId,
                lifecycleGeneration: input.lifecycleGeneration,
                turnId: undefined,
                notice,
              }),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: cursorModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: CURSOR_RESUME_VERSION,
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
            assistantItemTurnIds: new Map(),
            lastPlanFingerprint: undefined,
            completedPlanFingerprint: undefined,
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            lastTurnActivityAt: undefined,
            latestSessionCostUsd: undefined,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
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
                      const turnId = resolveCursorAssistantItemTurnId(ctx, event.itemId);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId,
                          itemId: event.itemId,
                          lifecycle: "item.started",
                        }),
                      );
                    }
                    return;
                  case "AssistantItemCompleted":
                    {
                      const turnId = completeCursorAssistantItemTurnId(ctx, event.itemId);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId,
                          itemId: event.itemId,
                          lifecycle: "item.completed",
                        }),
                      );
                    }
                    return;
                  case "PlanUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                    if (failedToolDetail !== undefined && ctx.activeTurnId !== undefined) {
                      ctx.activeTurnFailedToolDetail = failedToolDetail;
                    }
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveCursorAssistantItemTurnId(ctx, event.itemId),
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "UsageUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    recordCursorSessionCost(ctx, event.cost);
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpTokenUsageEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        usage: event.usage,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(Effect.forkChild);

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

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
            payload: { state: "ready", reason: "Cursor ACP session ready" },
          });
          yield* offerRuntimeEvent(input.lifecycleGeneration, {
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        const resolvedModel = resolveCursorAcpBaseModelId(model);
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
        yield* applyRequestedSessionConfiguration({
          runtime: ctx.acp,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode,
          modelSelection:
            model === undefined
              ? undefined
              : {
                  model,
                  options: turnModelSelection?.options,
                },
          mapError: ({ cause, method }) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          // No turnId: the notice is emitted before turn.started, so it belongs
          // to the session timeline rather than to an unannounced turn.
          onModelSelectionNotice: (notice) =>
            emitCursorModelSelectionNotice({
              threadId: input.threadId,
              lifecycleGeneration: ctx.lifecycleGeneration,
              turnId: undefined,
              notice,
            }),
        });
        const promptParts: Array<Acp.ContentBlock> = [];
        const promptText = appendFileAttachmentsPromptBlock({
          text: input.input?.trim()
            ? withCursorPlanModePrompt({
                text: input.input.trim(),
                interactionMode,
              })
            : undefined,
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
        const harnessPolicy = takeCursorSynaraHarnessPolicyTextPart(
          ctx,
          agentGatewayCredentials !== undefined,
        );
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }

        ctx.activeTurnId = turnId;
        ctx.activeTurnFailedToolDetail = undefined;
        ctx.activeInteractionMode = interactionMode;
        ctx.lastPlanFingerprint = undefined;
        ctx.completedPlanFingerprint = undefined;
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
          payload: { model: resolvedModel },
        });

        const runPrompt = ctx.acp.prompt({ prompt: promptParts }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                if (!clearCursorActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeCursorActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                const detail = error.message;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso,
                  model: resolvedModel,
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
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                if (!clearCursorActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeCursorActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                ctx.session = {
                  ...sessionWithoutLastError,
                  status: "ready",
                  updatedAt: yield* nowIso,
                  model: resolvedModel,
                };
                const completion = classifyAcpPromptTurnCompletion({
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
              if (!clearCursorActiveTurn(ctx, turnId)) {
                return;
              }
              const completedCost = finalizeCursorActiveTurnCost(ctx);
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
              const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
              ctx.session = {
                ...sessionWithoutLastError,
                status: "ready",
                updatedAt: yield* nowIso,
                model: resolvedModel,
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
          idleTimeoutMs: CURSOR_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: CURSOR_TURN_WATCHDOG_INTERVAL_MS,
          scope: ctx.scope,
          isTurnActive: () => ctx.activeTurnId === turnId && !ctx.stopped,
          isAwaitingHuman: () => ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
          lastActivityAt: () => ctx.lastTurnActivityAt ?? Date.now(),
          touchActivity: () => {
            ctx.lastTurnActivityAt = Date.now();
          },
          onIdleTimeout: (idleMs) => failCursorTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        const activePromptFiber = ctx.activePromptFiber;
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
        if (activePromptFiber) {
          yield* Fiber.interrupt(activePromptFiber);
        }
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
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

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
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
            method: "cursor/ask_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const getComposerCapabilities: NonNullable<
      CursorAdapterShape["getComposerCapabilities"]
    > = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: false,
        supportsThreadImport: true,
      } satisfies ProviderComposerCapabilities);

    const listSkills: NonNullable<CursorAdapterShape["listSkills"]> = (input) =>
      Effect.tryPromise({
        try: async () =>
          ({
            skills: await discoverCursorSkills({
              cwd: input.cwd,
              homeDir: serverConfig.homeDir,
            }),
            source: "cursor.filesystem",
            cached: false,
          }) satisfies ProviderListSkillsResult,
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "skill/list",
            detail: "Failed to discover Cursor skills.",
            cause,
          }),
      });

    const listModels: NonNullable<CursorAdapterShape["listModels"]> = (input) => {
      const binaryPath = input.binaryPath?.trim();
      const apiEndpoint = input.apiEndpoint?.trim();
      const effectiveBinaryPath = resolveCursorAgentBinaryPath(
        binaryPath || cursorSettings.binaryPath,
      );
      const effectiveApiEndpoint = apiEndpoint || cursorSettings.apiEndpoint;
      const runCursorModelListCommand = Effect.gen(function* () {
        const command = buildCursorCliModelListCommand({
          binaryPath: effectiveBinaryPath,
          ...(effectiveApiEndpoint ? { apiEndpoint: effectiveApiEndpoint } : {}),
        });
        const env = buildCursorAgentHeadlessEnv();
        const prepared = prepareWindowsSafeProcess(command.command, command.args, {
          env,
        });
        const child = yield* childProcessSpawner.spawn(
          ChildProcess.make(prepared.command, prepared.args, {
            shell: prepared.shell,
            ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            env,
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectStreamAsString(child.stdout),
            collectStreamAsString(child.stderr),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail:
              stderr.trim() ||
              `Cursor model discovery failed because '${[command.command, ...command.args].join(" ")}' exited with code ${exitCode}.`,
          });
        }
        const models = parseCursorCliModelList(stdout);
        if (models.length === 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: "Cursor model discovery returned no CLI models.",
          });
        }
        return models;
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(CURSOR_MODEL_DISCOVERY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "model/list",
                  detail: "Timed out while discovering Cursor models via CLI.",
                }),
              ),
            onSome: (models) => Effect.succeed(models),
          }),
        ),
      );
      // Preferred path: the ACP `cursor/list_available_models` extension exposes
      // each model's full parameter matrix (context window, effort, thinking,
      // fast) — data the flat `cursor-agent models` CLI list cannot provide.
      const effectiveAcpSettings: CursorAcpRuntimeCursorSettings = {
        binaryPath: effectiveBinaryPath,
        ...(effectiveApiEndpoint ? { apiEndpoint: effectiveApiEndpoint } : {}),
      };
      const runCursorAcpModelDiscovery = Effect.gen(function* () {
        const runtime = yield* makeCursorAcpRuntime({
          cursorSettings: effectiveAcpSettings,
          childProcessSpawner,
          cwd: process.cwd(),
          clientInfo: { name: "Synara", version: "0.0.0" },
        });
        const started = yield* runtime.start();
        const models = yield* fetchCursorAcpModelDescriptors(runtime, started.sessionId);
        if (models.length === 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: "Cursor ACP model discovery returned no models.",
          });
        }
        return models;
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(CURSOR_MODEL_DISCOVERY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "model/list",
                  detail: "Timed out while discovering Cursor models via ACP.",
                }),
              ),
            onSome: (models) => Effect.succeed(models),
          }),
        ),
      );

      const discovery = runCursorAcpModelDiscovery.pipe(
        Effect.map((models) => ({
          models,
          source: "cursor.acp",
          cached: false,
        })),
        // The flat CLI list expands transport variants that ACP already represents
        // as per-model controls. Use it only when the richer ACP catalog is unavailable.
        Effect.catch(() =>
          runCursorModelListCommand.pipe(
            Effect.map(
              (cliModels) =>
                ({
                  models: cliModels,
                  source: "cursor.cli",
                  cached: false,
                }) satisfies ProviderListModelsResult,
            ),
          ),
        ),
      );

      return discovery.pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderAdapterRequestError
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "model/list",
                detail: "Failed to discover Cursor models.",
                cause,
              }),
        ),
      );
    };

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsRuntimeModelList: true,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      getComposerCapabilities,
      listSkills,
      listModels,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies CursorAdapterShape;
  });
}

export const CursorAdapterLive = Layer.effect(CursorAdapter, makeCursorAdapter({}));

export function makeCursorAdapterLive(
  cursorSettings: CursorAcpRuntimeCursorSettings = {},
  options?: CursorAdapterLiveOptions,
) {
  return Layer.effect(CursorAdapter, makeCursorAdapter(cursorSettings, options));
}
