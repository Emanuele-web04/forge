/**
 * AcpAdapterLive - configurable stdio Agent Client Protocol provider.
 *
 * This adapter intentionally implements only ACP-standard behavior. Agent
 * extensions stay optional and cannot become a prerequisite for the generic
 * provider path.
 */
import type * as Acp from "@agentclientprotocol/sdk";
import {
  ApprovalRequestId,
  EventId,
  type AcpServerProviderSettings,
  type ProviderApprovalDecision,
  type ProviderComposerCapabilities,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@synara/contracts";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  PubSub,
  Random,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import {
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  clearAcpActiveTurn,
  finalizeAcpActiveTurnCost,
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  resolveRequestedAcpSessionModeId,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  resolveAcpToolCallTurnId,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
} from "../acp/AcpAdapterSessionSupport.ts";
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
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  isFormElicitationRequest,
} from "../acp/AcpElicitationSupport.ts";
import { parsePermissionRequest, type AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { makeGenericAcpRuntime, type GenericAcpRuntimeSettings } from "../acp/GenericAcpSupport.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";
import { AcpAdapter, type AcpAdapterShape } from "../Services/AcpAdapter.ts";

const PROVIDER = "acp" as const;
const RESUME_SCHEMA_VERSION = 1 as const;
const ACP_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const ACP_TURN_SETTLE_DRAIN_POLL_MS = 25;
const ACP_RESUME_REPLAY_QUIET_MS = 250;
const ACP_RESUME_REPLAY_HARD_TIMEOUT_MS = 5_000;
// Keep late tool-call attribution useful across a turn boundary without
// allowing an agent that emits unbounded tool ids to grow this map forever.
const ACP_MAX_TRACKED_TOOL_CALLS = 512;
const MODE_ALIASES = {
  plan: ["plan", "architect"],
  implement: ["act", "agent", "code", "default", "implement"],
  approval: ["ask", "approval"],
} as const;

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface StopSessionOptions {
  readonly exitKind?: "graceful" | "error";
  readonly reason?: string;
  /** The process-exit watcher must not interrupt itself during cleanup. */
  readonly interruptExitWatcher?: boolean;
}

interface AcpSessionContext {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  modeState: AcpSessionModeState | undefined;
  activeTurnId: TurnId | undefined;
  activeInteractionMode: "default" | "plan" | undefined;
  activeTurnHadAssistantContent: boolean;
  activeTurnFailedToolDetail: string | undefined;
  activeAssistantItemsWithContent: Set<string>;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  exitWatcherFiber: Fiber.Fiber<void, never> | undefined;
  // Count of session/update events fully handled by the notification
  // consumer. The runtime exposes the corresponding enqueued count so a
  // prompt's final queued updates retain their originating turn attribution.
  sessionUpdatesProcessed: number;
  // Tool updates can arrive just after session/prompt resolves. Keep their
  // originating turn id long enough to resolve the existing tool row.
  readonly turnToolCallIds: Map<string, TurnId>;
  // session/load may replay historical updates after its response. Keep those
  // updates out of the first live turn until the replay stream is quiet.
  resumeReplayReady: Deferred.Deferred<void> | undefined;
  resumeReplayLastSuppressedAt: number | undefined;
  latestSessionCostUsd: number | undefined;
  stopped: boolean;
}

function parseResumeCursor(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as { schemaVersion?: unknown; sessionId?: unknown };
  return value.schemaVersion === RESUME_SCHEMA_VERSION &&
    typeof value.sessionId === "string" &&
    value.sessionId.trim()
    ? value.sessionId.trim()
    : undefined;
}

export function modelDescriptorsFromConfigOptions(
  options: ReadonlyArray<Acp.SessionConfigOption>,
): ProviderListModelsResult["models"] {
  // ACP agents are expected to label model selectors with category="model",
  // but a few clients only expose the stable option id. Accept both forms so
  // generic discovery does not silently return an empty catalog.
  const modelOption = options.find(
    (option) => option.category === "model" || option.id.trim().toLowerCase() === "model",
  );
  if (!modelOption || modelOption.type !== "select") return [];
  const entries = modelOption.options.flatMap((entry) =>
    "value" in entry ? [entry] : entry.options,
  );
  return entries.flatMap((entry) => {
    const slug = entry.value.trim();
    if (!slug) return [];
    const fallbackName = slug.includes("/")
      ? slug
      : slug.replace(/[-_]+/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
    const name = entry.name.trim() || fallbackName;
    const description = entry.description?.trim() || undefined;
    return [
      {
        slug,
        name,
        ...(description ? { description } : {}),
      },
    ];
  });
}

export function makeAcpAdapter(settings: GenericAcpRuntimeSettings) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const sessions = new Map<ThreadId, AcpSessionContext>();
    const withThreadLock = yield* makeAcpThreadLock();
    const eventBus = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const publish = (
      ctx: Pick<AcpSessionContext, "lifecycleGeneration">,
      event: ProviderRuntimeEvent,
    ) =>
      PubSub.publish(
        eventBus,
        stampAcpRuntimeEventLifecycleGeneration(event, ctx.lifecycleGeneration),
      ).pipe(Effect.asVoid);
    const publishContext = (
      ctx: AcpSessionContext | undefined,
      lifecycleGeneration: string | undefined,
    ): Pick<AcpSessionContext, "lifecycleGeneration"> =>
      ctx ?? (lifecycleGeneration === undefined ? {} : { lifecycleGeneration });

    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const stopSessionInternal = (ctx: AcpSessionContext, options: StopSessionOptions = {}) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.resumeReplayReady) {
          yield* Deferred.succeed(ctx.resumeReplayReady, undefined);
          ctx.resumeReplayReady = undefined;
          ctx.resumeReplayLastSuppressedAt = undefined;
        }
        if (ctx.activePromptFiber) yield* Fiber.interrupt(ctx.activePromptFiber);
        if (ctx.notificationFiber) yield* Fiber.interrupt(ctx.notificationFiber);
        if (options.interruptExitWatcher !== false && ctx.exitWatcherFiber) {
          yield* Fiber.interrupt(ctx.exitWatcherFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        // A delayed cleanup from an exited process must never remove a newer
        // replacement session for the same Synara thread.
        if (sessions.get(ctx.threadId) === ctx) sessions.delete(ctx.threadId);
        yield* publish(ctx, {
          type: "session.exited",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: {
            exitKind: options.exitKind ?? "graceful",
            ...(options.reason ? { reason: options.reason } : {}),
          },
        });
      });

    const installInteractionHandlers = (
      acp: AcpSessionRuntimeShape,
      input: Parameters<AcpAdapterShape["startSession"]>[0],
      getContext: () => AcpSessionContext | undefined,
      pendingApprovals: Map<ApprovalRequestId, PendingApproval>,
      pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>,
    ) =>
      Effect.gen(function* () {
        yield* acp.handleRequestPermission((params) =>
          Effect.gen(function* () {
            const ctx = getContext();
            if (ctx?.stopped) return { outcome: { outcome: "cancelled" as const } };
            const policy = resolveAcpPermissionPolicy({
              runtimeMode: input.runtimeMode,
              interactionMode: ctx?.activeInteractionMode,
              options: params.options,
            });
            if (policy !== undefined) return { outcome: policy };

            const permissionRequest = parsePermissionRequest(params);
            const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            pendingApprovals.set(requestId, { decision });
            yield* publish(
              publishContext(ctx, input.lifecycleGeneration),
              makeAcpRequestOpenedEvent({
                stamp: yield* makeStamp(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: ctx?.activeTurnId,
                requestId: RuntimeRequestId.makeUnsafe(requestId),
                permissionRequest,
                detail: permissionRequest.detail ?? "ACP agent requested permission.",
                args: params,
                source: "acp.jsonrpc",
                method: "session/request_permission",
                rawPayload: params,
              }),
            );
            const resolved = yield* Deferred.await(decision);
            pendingApprovals.delete(requestId);
            if (ctx?.stopped) return { outcome: { outcome: "cancelled" as const } };
            yield* publish(
              publishContext(ctx, input.lifecycleGeneration),
              makeAcpRequestResolvedEvent({
                stamp: yield* makeStamp(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: ctx?.activeTurnId,
                requestId: RuntimeRequestId.makeUnsafe(requestId),
                permissionRequest,
                decision: resolved,
              }),
            );
            const optionId = selectAcpPermissionOptionId(resolved, params.options);
            return {
              outcome:
                resolved === "cancel" || optionId === undefined
                  ? { outcome: "cancelled" as const }
                  : { outcome: "selected" as const, optionId },
            };
          }),
        );

        yield* acp.handleElicitation((params) =>
          Effect.gen(function* () {
            if (!isFormElicitationRequest(params)) return { action: "decline" as const };
            const questions = elicitationQuestionsFromRequest(params);
            if (questions.length === 0) return { action: "decline" as const };
            const ctx = getContext();
            if (ctx?.stopped) return { action: "decline" as const };
            const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
            const answers = yield* Deferred.make<ProviderUserInputAnswers>();
            pendingUserInputs.set(requestId, { answers });
            yield* publish(publishContext(ctx, input.lifecycleGeneration), {
              type: "user-input.requested",
              ...(yield* makeStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: ctx?.activeTurnId,
              requestId: RuntimeRequestId.makeUnsafe(requestId),
              payload: { questions },
              raw: { source: "acp.jsonrpc", method: "session/elicitation", payload: params },
            });
            const resolved = yield* Deferred.await(answers);
            pendingUserInputs.delete(requestId);
            if (ctx?.stopped) return { action: "decline" as const };
            yield* publish(publishContext(ctx, input.lifecycleGeneration), {
              type: "user-input.resolved",
              ...(yield* makeStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: ctx?.activeTurnId,
              requestId: RuntimeRequestId.makeUnsafe(requestId),
              payload: { answers: resolved },
            });
            return elicitationResponseFromAnswers(params, resolved);
          }),
        );
      });

    // Keep the active-turn window open until session/update events already
    // enqueued when session/prompt resolves have been handled by the adapter.
    // A bounded wait prevents a wedged or endlessly chatty agent from
    // stalling turn settlement indefinitely.
    const waitForAcpQueuedTurnEventsDrained = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        const target = yield* ctx.acp.sessionUpdatesEnqueuedCount;
        const startedAt = Date.now();
        while (
          ctx.sessionUpdatesProcessed < target &&
          Date.now() - startedAt < ACP_TURN_SETTLE_DRAIN_MAX_WAIT_MS
        ) {
          yield* Effect.sleep(ACP_TURN_SETTLE_DRAIN_POLL_MS);
        }
      });

    const rememberAcpToolCallTurn = (
      ctx: AcpSessionContext,
      providerToolCallId: string,
      turnId: TurnId,
    ) => {
      // Re-inserting moves an occasionally reused provider id to the newest
      // end of the bounded map. This keeps the common current/previous-turn
      // window while allowing very late updates to retain their old turn id.
      ctx.turnToolCallIds.delete(providerToolCallId);
      ctx.turnToolCallIds.set(providerToolCallId, turnId);
      while (ctx.turnToolCallIds.size > ACP_MAX_TRACKED_TOOL_CALLS) {
        const oldest = ctx.turnToolCallIds.keys().next().value;
        if (oldest === undefined) break;
        ctx.turnToolCallIds.delete(oldest);
      }
    };

    const startSession: AcpAdapterShape["startSession"] = (input) =>
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
          const cwd = resolveAcpSessionCwd({
            inputCwd: input.cwd,
            serverCwd: serverConfig.cwd,
            homeDir: serverConfig.homeDir,
          });
          if (!cwd) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing) yield* stopSessionInternal(existing);
          const scope = yield* Scope.make("sequential");
          let scopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            scopeTransferred ? Effect.void : Scope.close(scope, Exit.void),
          );
          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          let ctx: AcpSessionContext | undefined;
          const configured = input.providerOptions?.acp;
          const resumeSessionId = parseResumeCursor(input.resumeCursor);
          const effectiveSettings: GenericAcpRuntimeSettings = {
            binaryPath: configured?.binaryPath ?? settings.binaryPath,
            args: configured?.args ?? settings.args,
          };
          const acp = yield* makeGenericAcpRuntime({
            settings: effectiveSettings,
            childProcessSpawner,
            cwd,
            options: {
              clientInfo: { name: "Synara", version: "0.0.0" },
              ...(resumeSessionId ? { resumeSessionId } : {}),
            },
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );
          yield* installInteractionHandlers(
            acp,
            input,
            () => ctx,
            pendingApprovals,
            pendingUserInputs,
          );
          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );

          const selectedModel =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
          if (selectedModel && selectedModel !== "default") {
            yield* acp
              .setModel(selectedModel)
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(
                    PROVIDER,
                    input.threadId,
                    "session/set_config_option",
                    error,
                  ),
                ),
              );
          }
          // `session/load` may continue replaying historical updates after
          // responding. `session/resume` is explicitly non-replaying in ACP.
          const resumeReplayReady =
            started.sessionSetupMethod === "load" ? yield* Deferred.make<void>() : undefined;
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            threadId: input.threadId,
            ...(selectedModel ? { model: selectedModel } : {}),
            resumeCursor: {
              schemaVersion: RESUME_SCHEMA_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };
          ctx = {
            threadId: input.threadId,
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            scope,
            acp,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            session,
            modeState: yield* acp.getModeState,
            activeTurnId: undefined,
            activeInteractionMode: undefined,
            activeTurnHadAssistantContent: false,
            activeTurnFailedToolDetail: undefined,
            activeAssistantItemsWithContent: new Set(),
            activePromptFiber: undefined,
            notificationFiber: undefined,
            exitWatcherFiber: undefined,
            sessionUpdatesProcessed: 0,
            turnToolCallIds: new Map(),
            resumeReplayReady,
            resumeReplayLastSuppressedAt: resumeReplayReady ? Date.now() : undefined,
            latestSessionCostUsd: undefined,
            stopped: false,
          };

          ctx.notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (!ctx || ctx.stopped) return;
                if (ctx.resumeReplayReady) {
                  ctx.resumeReplayLastSuppressedAt = Date.now();
                  return;
                }
                if (event._tag === "ModeChanged") {
                  ctx.modeState = ctx.modeState
                    ? { ...ctx.modeState, currentModeId: event.modeId }
                    : undefined;
                  return;
                }
                const activeTurnId = ctx.activeTurnId;
                // A known provider tool id wins over the current active turn:
                // a late update from the previous turn can arrive after the
                // next prompt has already claimed the session. Unknown ids
                // are new updates and therefore belong to the active turn.
                const mappedToolTurnId =
                  event._tag === "ToolCallUpdated"
                    ? ctx.turnToolCallIds.get(event.toolCall.toolCallId)
                    : undefined;
                const eventTurnId = resolveAcpToolCallTurnId(activeTurnId, mappedToolTurnId);
                if (!eventTurnId) return;
                switch (event._tag) {
                  case "AssistantItemStarted":
                    return;
                  case "AssistantItemCompleted": {
                    const itemId = scopeAcpRuntimeItemIdForTurn(
                      PROVIDER,
                      eventTurnId,
                      event.itemId,
                    );
                    if (!ctx.activeAssistantItemsWithContent.delete(itemId)) return;
                    yield* publish(
                      ctx,
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: eventTurnId,
                        itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  }
                  case "PlanUpdated":
                    yield* publish(
                      ctx,
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: eventTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ToolCallUpdated": {
                    if (
                      activeTurnId &&
                      (mappedToolTurnId === undefined || mappedToolTurnId === activeTurnId)
                    ) {
                      rememberAcpToolCallTurn(ctx, event.toolCall.toolCallId, activeTurnId);
                      ctx.activeTurnFailedToolDetail =
                        readAcpFailedToolDetail(event.toolCall) ?? ctx.activeTurnFailedToolDetail;
                    }
                    yield* publish(
                      ctx,
                      makeAcpToolCallEvent({
                        stamp: yield* makeStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: eventTurnId,
                        toolCall: scopeAcpToolCallStateForTurn(
                          PROVIDER,
                          eventTurnId,
                          event.toolCall,
                        ),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ContentDelta": {
                    const itemId = event.itemId
                      ? scopeAcpRuntimeItemIdForTurn(PROVIDER, eventTurnId, event.itemId)
                      : undefined;
                    if (event.streamKind !== "reasoning_text" && event.text.trim()) {
                      ctx.activeTurnHadAssistantContent = true;
                      if (itemId) ctx.activeAssistantItemsWithContent.add(itemId);
                    }
                    yield* publish(
                      ctx,
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: eventTurnId,
                        ...(itemId ? { itemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "UsageUpdated":
                    recordAcpSessionCost(ctx, event.cost);
                    yield* publish(
                      ctx,
                      makeAcpTokenUsageEvent({
                        stamp: yield* makeStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: eventTurnId,
                        usage: event.usage,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (ctx) ctx.sessionUpdatesProcessed += 1;
                  }),
                ),
              ),
            ),
          ).pipe(Effect.forkIn(scope));
          const replayContext = ctx;
          if (replayContext.resumeReplayReady) {
            const ready = replayContext.resumeReplayReady;
            yield* Effect.gen(function* () {
              const startedAt = Date.now();
              while (replayContext.resumeReplayReady === ready) {
                const now = Date.now();
                const quietFor = now - (replayContext.resumeReplayLastSuppressedAt ?? startedAt);
                const elapsed = now - startedAt;
                if (
                  quietFor >= ACP_RESUME_REPLAY_QUIET_MS ||
                  elapsed >= ACP_RESUME_REPLAY_HARD_TIMEOUT_MS
                ) {
                  replayContext.resumeReplayReady = undefined;
                  replayContext.resumeReplayLastSuppressedAt = undefined;
                  yield* Deferred.succeed(ready, undefined);
                  return;
                }
                yield* Effect.sleep(Math.min(ACP_RESUME_REPLAY_QUIET_MS - quietFor, 50));
              }
            }).pipe(Effect.forkIn(scope));
          }
          sessions.set(input.threadId, ctx);
          scopeTransferred = true;

          yield* Effect.gen(function* () {
            yield* publish(ctx, {
              type: "session.started",
              ...(yield* makeStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: started.initializeResult },
            });
            yield* publish(ctx, {
              type: "session.state.changed",
              ...(yield* makeStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "ACP agent session ready" },
            });
            yield* publish(ctx, {
              type: "thread.started",
              ...(yield* makeStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
          }).pipe(
            Effect.onError(() =>
              stopSessionInternal(ctx, {
                exitKind: "error",
                reason: "Failed to publish ACP session startup events.",
              }),
            ),
          );
          // Start watching only after startup events are published, so a child
          // that exits during the handshake cannot race an `exited` event ahead
          // of the session's initial lifecycle events.
          ctx.exitWatcherFiber = yield* acp.awaitExit.pipe(
            Effect.andThen(
              withThreadLock(
                ctx.threadId,
                stopSessionInternal(ctx, {
                  exitKind: "error",
                  reason: "ACP agent process exited unexpectedly.",
                  interruptExitWatcher: false,
                }),
              ).pipe(Effect.forkDetach, Effect.asVoid),
            ),
            Effect.ignoreCause(),
            Effect.forkIn(scope),
          );
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: AcpAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          if (ctx.activeTurnId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "An ACP turn is already active for this thread.",
            });
          }
          if (ctx.resumeReplayReady) {
            yield* Deferred.await(ctx.resumeReplayReady);
          }
          if (ctx.stopped) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          const turnId = TurnId.makeUnsafe(crypto.randomUUID());
          const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
          const requestedMode = resolveRequestedAcpSessionModeId({
            interactionMode,
            runtimeMode: ctx.session.runtimeMode,
            modeState: ctx.modeState,
            aliases: MODE_ALIASES,
          });
          if (requestedMode && requestedMode !== ctx.modeState?.currentModeId) {
            yield* ctx.acp
              .setMode(requestedMode)
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", error),
                ),
              );
            if (ctx.modeState) ctx.modeState = { ...ctx.modeState, currentModeId: requestedMode };
          }
          const turnModel =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
          if (turnModel && turnModel !== "default" && turnModel !== ctx.session.model) {
            yield* ctx.acp
              .setModel(turnModel)
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(
                    PROVIDER,
                    input.threadId,
                    "session/set_config_option",
                    error,
                  ),
                ),
              );
          }
          const prompt: Acp.ContentBlock[] = [];
          const text = appendFileAttachmentsPromptBlock({
            text: input.input?.trim(),
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            include: "all-files",
          });
          if (text) prompt.push({ type: "text", text });
          prompt.push(
            ...(yield* loadProviderPromptImageBlocks({
              attachments: input.attachments,
              attachmentsDir: serverConfig.attachmentsDir,
              provider: PROVIDER,
              method: "session/prompt",
              readFile: fileSystem.readFile,
            })),
          );
          if (prompt.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }
          ctx.activeTurnId = turnId;
          ctx.activeInteractionMode = interactionMode;
          ctx.activeTurnHadAssistantContent = false;
          ctx.activeTurnFailedToolDetail = undefined;
          ctx.activeAssistantItemsWithContent.clear();
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            ...(turnModel ? { model: turnModel } : {}),
            updatedAt: yield* nowIso,
          };
          yield* publish(ctx, {
            type: "turn.started",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { ...(turnModel ? { model: turnModel } : {}) },
          });

          ctx.activePromptFiber = yield* ctx.acp.prompt({ prompt }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.gen(function* () {
                  yield* waitForAcpQueuedTurnEventsDrained(ctx);
                  if (!clearAcpActiveTurn(ctx, turnId)) return;
                  ctx.session = {
                    ...ctx.session,
                    status: "error",
                    updatedAt: yield* nowIso,
                    lastError: error.message,
                  };
                  ctx.turns.push({ id: turnId, items: [{ prompt, error }] });
                  yield* publish(ctx, {
                    type: "turn.completed",
                    ...(yield* makeStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      state: "failed",
                      stopReason: null,
                      errorMessage: error.message,
                      ...finalizeAcpActiveTurnCost(ctx),
                    },
                  });
                }),
              onSuccess: (result) =>
                Effect.gen(function* () {
                  yield* waitForAcpQueuedTurnEventsDrained(ctx);
                  const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                  const failedToolDetail = ctx.activeTurnFailedToolDetail;
                  if (!clearAcpActiveTurn(ctx, turnId)) return;
                  const { lastError: _lastError, ...session } = ctx.session;
                  ctx.session = { ...session, status: "ready", updatedAt: yield* nowIso };
                  ctx.turns.push({ id: turnId, items: [{ prompt, result }] });
                  const completion = classifyAcpPromptTurnCompletion({
                    stopReason: result.stopReason,
                    ...(failedToolDetail ? { failedToolDetail } : {}),
                  });
                  if (!hadAssistantContent && result.stopReason !== "cancelled") {
                    yield* Effect.logWarning("acp.turn_completed_without_content", {
                      threadId: input.threadId,
                      turnId,
                      stopReason: result.stopReason ?? null,
                      hasUsage: result.usage !== undefined,
                    });
                  }
                  yield* publish(ctx, {
                    type: "turn.completed",
                    ...(yield* makeStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      state: completion.state,
                      stopReason: result.stopReason ?? null,
                      ...(completion.errorMessage ? { errorMessage: completion.errorMessage } : {}),
                      ...(result.usage ? { usage: result.usage } : {}),
                      ...finalizeAcpActiveTurnCost(ctx),
                    },
                  });
                }),
            }),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                if (!clearAcpActiveTurn(ctx, turnId)) return;
                ctx.session = { ...ctx.session, status: "ready", updatedAt: yield* nowIso };
                yield* publish(ctx, {
                  type: "turn.completed",
                  ...(yield* makeStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: { state: "cancelled", stopReason: "cancelled" },
                });
              }),
            ),
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(ctx.scope),
          );
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }),
      );

    const interruptTurn: AcpAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (turnId && turnId !== ctx.activeTurnId) return;
          yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
          yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
          yield* Effect.ignore(ctx.acp.cancel);
          if (ctx.activePromptFiber) yield* Fiber.interrupt(ctx.activePromptFiber);
        }),
      );

    const respondToRequest: AcpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
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

    const respondToUserInput: AcpAdapterShape["respondToUserInput"] = (
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

    const readThread: AcpAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns,
          cwd: ctx.session.cwd ?? null,
        } satisfies ProviderThreadSnapshot;
      });
    const rollbackThread: AcpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns, cwd: ctx.session.cwd ?? null };
      });
    const stopSession: AcpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (ctx) yield* stopSessionInternal(ctx);
        }),
      );
    const listSessions: AcpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));
    const hasSession: AcpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.get(threadId)?.stopped === false);
    const stopAll: AcpAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      });

    const getComposerCapabilities: NonNullable<AcpAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    const listModels: NonNullable<AcpAdapterShape["listModels"]> = (input) =>
      Effect.gen(function* () {
        const cwd = resolveAcpSessionCwd({
          inputCwd: input.cwd,
          serverCwd: serverConfig.cwd,
          homeDir: serverConfig.homeDir,
        });
        if (!cwd) {
          return { models: [], source: "acp", cached: false } satisfies ProviderListModelsResult;
        }
        const scope = yield* Scope.make("sequential");
        return yield* Effect.gen(function* () {
          const runtime = yield* makeGenericAcpRuntime({
            settings: {
              binaryPath: input.binaryPath ?? settings.binaryPath,
              args: input.args ?? settings.args,
            },
            childProcessSpawner,
            cwd,
            options: { clientInfo: { name: "Synara model discovery", version: "0.0.0" } },
          }).pipe(Effect.provideService(Scope.Scope, scope));
          const started = yield* runtime.start();
          const models = modelDescriptorsFromConfigOptions(
            started.sessionSetupResult.configOptions ?? [],
          );
          return { models, source: "acp", cached: false } satisfies ProviderListModelsResult;
        }).pipe(Effect.ensuring(Effect.ignore(Scope.close(scope, Exit.void))));
      }).pipe(
        Effect.scoped,
        Effect.mapError((error) =>
          error instanceof ProviderAdapterRequestError
            ? error
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "model/list",
                detail: error instanceof Error ? error.message : String(error),
                cause: error,
              }),
        ),
      );

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(Effect.tap(() => PubSub.shutdown(eventBus))),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(eventBus),
      getComposerCapabilities,
      listModels,
    } satisfies AcpAdapterShape;
  });
}

export const AcpAdapterLive = Layer.effect(
  AcpAdapter,
  makeAcpAdapter({ binaryPath: "cline", args: ["--acp"] }),
);

export function makeAcpAdapterLive(
  settings: Pick<AcpServerProviderSettings, "binaryPath" | "args"> = {
    binaryPath: "cline",
    args: ["--acp"],
  },
) {
  return Layer.effect(AcpAdapter, makeAcpAdapter(settings));
}
