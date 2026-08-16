/**
 * DeepSeekAdapterLive - DeepSeek Harness (`dsh-acp-demo`) via ACP.
 *
 * DeepSeek Harness' public ACP bridge is deliberately automation-oriented: it
 * supports fresh sessions, prompt/cancel, committed assistant messages and
 * permission requests, but not transcript recovery, session fork, modes,
 * config pickers, or live reasoning/tool presentation. This adapter keeps that
 * boundary explicit instead of emulating unsupported protocol features.
 *
 * @module DeepSeekAdapterLive
 */
import type * as Acp from "@agentclientprotocol/sdk";
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderComposerCapabilities,
  type ProviderRuntimeEvent,
  type ProviderSession,
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
import {
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  clearAcpActiveTurn,
  makeAcpThreadLock,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  settleAcpPendingApprovalsAsCancelled,
  withAcpPlanModePrompt,
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
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import {
  makeDeepSeekAcpRuntime,
  type DeepSeekAcpRuntimeSettings,
} from "../acp/DeepSeekAcpSupport.ts";
import { DeepSeekAdapter, type DeepSeekAdapterShape } from "../Services/DeepSeekAdapter.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";

const PROVIDER = "deepseek" as const;
const DEEPSEEK_TURN_EVENT_DRAIN_MAX_WAIT_MS = 1_000;
const DEEPSEEK_TURN_EVENT_DRAIN_POLL_MS = 10;
const DEEPSEEK_PLAN_MODE_PROMPT_PREFIX = [
  "Synara Plan mode is active.",
  "Do not mutate files, run commands that change state, or implement the request in this turn.",
  "Inspect and reason as needed, then return a concrete implementation plan.",
].join("\n");

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface DeepSeekSessionContext {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  session: ProviderSession;
  readonly scope: Scope.Scope;
  readonly acp: Awaited<ReturnType<typeof makeDeepSeekAcpRuntime>>;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: ReadonlyArray<unknown> }>;
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  activeInteractionMode: "default" | "plan" | "debug" | undefined;
  sessionUpdatesProcessed: number;
  stopped: boolean;
}

function resolveDeepSeekSessionCwd(
  inputCwd: string | undefined,
  serverConfig: { readonly cwd: string; readonly homeDir: string },
): string | undefined {
  return resolveAcpSessionCwd({
    inputCwd,
    serverCwd: serverConfig.cwd,
    homeDir: serverConfig.homeDir,
  });
}

export function makeDeepSeekAdapter(deepSeekSettings: DeepSeekAcpRuntimeSettings) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const sessions = new Map<ThreadId, DeepSeekSessionContext>();
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

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<DeepSeekSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const waitForQueuedTurnEventsDrained = (ctx: DeepSeekSessionContext) =>
      Effect.gen(function* () {
        const target = yield* ctx.acp.sessionUpdatesEnqueuedCount;
        const startedAt = Date.now();
        while (
          ctx.sessionUpdatesProcessed < target &&
          Date.now() - startedAt < DEEPSEEK_TURN_EVENT_DRAIN_MAX_WAIT_MS
        ) {
          yield* Effect.sleep(DEEPSEEK_TURN_EVENT_DRAIN_POLL_MS);
        }
      });

    const stopSessionInternal = (ctx: DeepSeekSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
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

    const startSession: DeepSeekAdapterShape["startSession"] = (input) =>
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
          if (input.resumeCursor !== undefined || input.forkSourceResumeCursor !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "DeepSeek Harness' public ACP bridge only supports fresh sessions; resume and fork cursors are unavailable.",
            });
          }

          const cwd = resolveDeepSeekSessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          let ctx!: DeepSeekSessionContext;
          const providerOptions = input.providerOptions?.deepseek;
          const effectiveSettings: DeepSeekAcpRuntimeSettings = {
            ...(deepSeekSettings.binaryPath ? { binaryPath: deepSeekSettings.binaryPath } : {}),
            ...(deepSeekSettings.configPath ? { configPath: deepSeekSettings.configPath } : {}),
            ...(providerOptions?.binaryPath ? { binaryPath: providerOptions.binaryPath } : {}),
            ...(providerOptions?.configPath ? { configPath: providerOptions.configPath } : {}),
          };

          const acp = yield* makeDeepSeekAcpRuntime({
            childProcessSpawner,
            cwd,
            runtimeMode: input.runtimeMode,
            deepSeekSettings: effectiveSettings,
            clientInfo: { name: "Synara", version: "0.0.0" },
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
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
                pendingApprovals.set(requestId, { decision });
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2_000),
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
                const optionId = selectAcpPermissionOptionId(resolved, params.options);
                return {
                  outcome:
                    optionId === undefined
                      ? ({ outcome: "cancelled" } as const)
                      : ({ outcome: "selected", optionId } as const),
                };
              }),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const now = yield* nowIso;
          const selectedModel =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(selectedModel ? { model: selectedModel } : {}),
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            activeTurnId: undefined,
            activeTurnHadAssistantContent: false,
            activeAssistantItemsWithContent: new Set(),
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            activeInteractionMode: undefined,
            sessionUpdatesProcessed: 0,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                const turnId = ctx.activeTurnId;
                if (turnId === undefined) return;
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted": {
                    const itemId = scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, event.itemId);
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  }
                  case "AssistantItemCompleted": {
                    const itemId = scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, event.itemId);
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  }
                  case "ContentDelta": {
                    const itemId = event.itemId
                      ? scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, event.itemId)
                      : undefined;
                    if ((event.streamKind ?? "assistant_text") === "assistant_text" && event.text.trim()) {
                      ctx.activeTurnHadAssistantContent = true;
                      if (itemId) ctx.activeAssistantItemsWithContent.add(itemId);
                    }
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        ...(itemId ? { itemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ToolCallUpdated": {
                    const failedDetail = readAcpFailedToolDetail(event.toolCall);
                    if (failedDetail) ctx.activeTurnFailedToolDetail = failedDetail;
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        toolCall: scopeAcpToolCallStateForTurn(PROVIDER, turnId, event.toolCall),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "PlanUpdated":
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "UsageUpdated":
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpTokenUsageEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        usage: event.usage,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.sessionUpdatesProcessed += 1;
                  }),
                ),
              ),
            ),
          ).pipe(Effect.forkIn(sessionScope));
          ctx.notificationFiber = notificationFiber;
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
            payload: { state: "ready", reason: "DeepSeek Harness ACP session ready" },
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

    const sendTurn: DeepSeekAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Another DeepSeek Harness turn is already running for this thread.",
          });
        }

        const inputText = appendFileAttachmentsPromptBlock({
          text: input.input?.trim(),
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        });
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
        const promptText = withAcpPlanModePrompt({
          text: inputText ?? "",
          interactionMode,
          promptPrefix: DEEPSEEK_PLAN_MODE_PROMPT_PREFIX,
        }).trim();
        if (!promptText) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or file attachments.",
          });
        }

        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        ctx.activeTurnId = turnId;
        ctx.activeInteractionMode = interactionMode;
        ctx.activeTurnHadAssistantContent = false;
        ctx.activeTurnFailedToolDetail = undefined;
        ctx.session = {
          ...ctx.session,
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
          payload: {},
        });

        const prompt: Array<Acp.ContentBlock> = [{ type: "text", text: promptText }];
        const promptFiber = yield* ctx.acp
          .prompt({ prompt })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.gen(function* () {
                  yield* waitForQueuedTurnEventsDrained(ctx);
                  if (!clearAcpActiveTurn(ctx, turnId)) return;
                  ctx.turns.push({ id: turnId, items: [{ prompt, error }] });
                  ctx.session = {
                    ...ctx.session,
                    status: "error",
                    updatedAt: yield* nowIso,
                    lastError: error.message,
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
                      errorMessage: error.message,
                    },
                  });
                }),
              onSuccess: (result) =>
                Effect.gen(function* () {
                  yield* waitForQueuedTurnEventsDrained(ctx);
                  if (ctx.activeTurnId !== turnId) return;
                  const failedToolDetail = ctx.activeTurnFailedToolDetail;
                  if (!clearAcpActiveTurn(ctx, turnId)) return;
                  ctx.turns.push({ id: turnId, items: [{ prompt, result }] });
                  const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                  ctx.session = {
                    ...sessionWithoutLastError,
                    status: "ready",
                    updatedAt: yield* nowIso,
                  };
                  const completion = classifyAcpPromptTurnCompletion({
                    stopReason: result.stopReason,
                    ...(failedToolDetail ? { failedToolDetail } : {}),
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
                      ...(completion.errorMessage
                        ? { errorMessage: completion.errorMessage }
                        : {}),
                      ...(result.usage ? { usage: result.usage } : {}),
                    },
                  });
                }),
            }),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                if (!clearAcpActiveTurn(ctx, turnId)) return;
                ctx.turns.push({ id: turnId, items: [{ prompt, interrupted: true }] });
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
                  threadId: input.threadId,
                  turnId,
                  payload: { state: "cancelled", stopReason: "cancelled" },
                });
              }),
            ),
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(ctx.scope),
          );
        ctx.activePromptFiber = promptFiber;

        return { threadId: input.threadId, turnId };
      });

    const interruptTurn: DeepSeekAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== ctx.activeTurnId) return;
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
        if (ctx.activePromptFiber) {
          yield* Fiber.interrupt(ctx.activePromptFiber);
        }
      });

    const respondToRequest: DeepSeekAdapterShape["respondToRequest"] = (
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

    const respondToUserInput: DeepSeekAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "elicitation/create",
          detail: `DeepSeek Harness ACP does not expose interactive elicitation requests (${requestId}).`,
        });
      });

    const readThread: DeepSeekAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns, cwd: ctx.session.cwd };
      });

    const rollbackThread: DeepSeekAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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
        return { threadId, turns: ctx.turns, cwd: ctx.session.cwd };
      });

    const stopSession: DeepSeekAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (ctx) yield* stopSessionInternal(ctx);
        }),
      );

    const stopAll: DeepSeekAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    const listSessions: DeepSeekAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: DeepSeekAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const getComposerCapabilities: NonNullable<
      DeepSeekAdapterShape["getComposerCapabilities"]
    > = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: false,
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "unsupported",
        conversationRollback: "restart-session",
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: false,
        supportsTurnSteering: false,
        supportsLiveTurnDiffPatch: false,
      },
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
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
      getComposerCapabilities,
    } satisfies DeepSeekAdapterShape;
  });
}

export const makeDeepSeekAdapterLive = (settings: DeepSeekAcpRuntimeSettings = {}) =>
  Layer.effect(DeepSeekAdapter, makeDeepSeekAdapter(settings));
