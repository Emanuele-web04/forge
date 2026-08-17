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
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildInlineSkillInstructions } from "../skillPromptInjection.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import { DeepSeekAdapter, type DeepSeekAdapterShape } from "../Services/DeepSeekAdapter.ts";
import {
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import { withAcpPlanModePrompt } from "../acp/AcpAdapterSessionSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
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
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";

const PROVIDER = "deepseek" as const;
const MAX_INLINE_SKILL_CHARS = 48_000;
// session/prompt can resolve before its already-enqueued session/update events
// finish running through the adapter's notification consumer. Keep the turn
// attribution alive briefly so committed assistant text cannot be dropped.
const DEEPSEEK_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const DEEPSEEK_TURN_SETTLE_DRAIN_POLL_MS = 25;
const DEEPSEEK_PLAN_MODE_PROMPT_PREFIX = [
  "Synara DeepSeek Harness plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

export function buildDeepSeekTurnPromptText(input: {
  readonly text: string;
  readonly interactionMode: "default" | "plan" | "debug";
}): string {
  return withAcpPlanModePrompt({
    text: input.text,
    interactionMode: input.interactionMode,
    promptPrefix: DEEPSEEK_PLAN_MODE_PROMPT_PREFIX,
  });
}

type PendingApproval = {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
};

type DeepSeekSessionContext = {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  promptFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnId: TurnId | undefined;
  activeInteractionMode: "default" | "plan" | "debug" | undefined;
  sessionUpdatesProcessed: number;
  turnStarting: boolean;
  pendingTurnInterrupted: boolean;
  stopped: boolean;
};

export interface DeepSeekAdapterLiveOptions {
  readonly settings?: DeepSeekAcpRuntimeSettings;
}

export function makeDeepSeekAdapter(options: DeepSeekAdapterLiveOptions = {}) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const sessions = new Map<ThreadId, DeepSeekSessionContext>();
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
      return !ctx || ctx.stopped
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(ctx);
    };

    const settlePendingApprovals = (ctx: DeepSeekSessionContext) =>
      Effect.forEach(
        Array.from(ctx.pendingApprovals.values()),
        (pending) => Deferred.succeed(pending.decision, "cancel"),
        { discard: true },
      ).pipe(
        Effect.tap(() => Effect.sync(() => ctx.pendingApprovals.clear())),
        Effect.asVoid,
      );

    const stopSessionInternal = (ctx: DeepSeekSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovals(ctx);
        yield* Effect.ignore(ctx.acp.cancel);
        if (ctx.promptFiber) yield* Fiber.interrupt(ctx.promptFiber);
        if (ctx.notificationFiber) yield* Fiber.interrupt(ctx.notificationFiber);
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

    const waitForDeepSeekQueuedTurnEventsDrained = (ctx: DeepSeekSessionContext) =>
      Effect.gen(function* () {
        const target = yield* ctx.acp.sessionUpdatesEnqueuedCount;
        const startedAt = Date.now();
        while (
          ctx.sessionUpdatesProcessed < target &&
          Date.now() - startedAt < DEEPSEEK_TURN_SETTLE_DRAIN_MAX_WAIT_MS
        ) {
          yield* Effect.sleep(DEEPSEEK_TURN_SETTLE_DRAIN_POLL_MS);
        }
      });

    const startSession: DeepSeekAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopSessionInternal(existing);

        if (input.resumeCursor !== undefined) {
          yield* Effect.logWarning(
            "DeepSeek Harness ACP does not support session resume; starting a fresh ACP session.",
            { threadId: input.threadId },
          );
        }

        const cwd = input.cwd?.trim() || serverConfig.cwd;
        if (!cwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "A working directory is required for DeepSeek Harness ACP.",
          });
        }

        const modelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const providerOptions = input.providerOptions?.deepseek;
        const settings: DeepSeekAcpRuntimeSettings = {
          ...(options.settings?.binaryPath ? { binaryPath: options.settings.binaryPath } : {}),
          ...(options.settings?.configPath ? { configPath: options.settings.configPath } : {}),
          ...(providerOptions?.binaryPath ? { binaryPath: providerOptions.binaryPath } : {}),
          ...(providerOptions?.configPath ? { configPath: providerOptions.configPath } : {}),
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        };

        const scope = yield* Scope.make("sequential");
        let scopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          scopeTransferred ? Effect.void : Scope.close(scope, Exit.void),
        );

        const acp = yield* makeDeepSeekAcpRuntime({
          settings,
          childProcessSpawner,
          cwd,
          runtimeMode: input.runtimeMode,
          clientInfo: { name: "Synara", version: "0.0.0" },
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
          ),
        );

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        let ctx!: DeepSeekSessionContext;

        yield* acp.handleRequestPermission((params) =>
          Effect.gen(function* () {
            const policyOutcome = resolveAcpPermissionPolicy({
              runtimeMode: input.runtimeMode,
              interactionMode: ctx?.activeInteractionMode,
              options: params.options,
            });
            if (policyOutcome !== undefined) return { outcome: policyOutcome };

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
                resolved === "cancel" || optionId === undefined
                  ? ({ outcome: "cancelled" } as const)
                  : ({ outcome: "selected", optionId } as const),
            };
          }),
        );

        const started = yield* acp
          .start()
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );
        const now = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
        };
        ctx = {
          threadId: input.threadId,
          ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
          scope,
          acp,
          pendingApprovals,
          turns: [],
          session,
          notificationFiber: undefined,
          promptFiber: undefined,
          activeTurnId: undefined,
          activeInteractionMode: undefined,
          sessionUpdatesProcessed: 0,
          turnStarting: false,
          pendingTurnInterrupted: false,
          stopped: false,
        };
        sessions.set(input.threadId, ctx);
        scopeTransferred = true;

        ctx.notificationFiber = yield* Stream.runDrain(
          Stream.mapEffect(acp.getEvents(), (event) =>
            Effect.gen(function* () {
              const turnId = ctx.activeTurnId;
              switch (event._tag) {
                case "AssistantItemStarted":
                  if (turnId !== undefined) {
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
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
                  if (turnId !== undefined) {
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
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
                case "ContentDelta":
                  if (turnId !== undefined && event.text.length > 0) {
                    ctx.turns.at(-1)?.items.push({
                      type: "content.delta",
                      text: event.text,
                      streamKind: event.streamKind ?? "assistant_text",
                    });
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                  }
                  return;
                case "ToolCallUpdated":
                  if (turnId !== undefined) {
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                  }
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
                case "ModeChanged":
                case "PlanUpdated":
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
        ).pipe(Effect.forkIn(scope));

        yield* offerRuntimeEvent(input.lifecycleGeneration, {
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          providerRefs: { providerThreadId: started.sessionId },
          payload: {},
        });
        return session;
      }).pipe(Effect.scoped);

    const sendTurn: DeepSeekAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.activeTurnId !== undefined || ctx.turnStarting) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "A DeepSeek Harness turn is already running.",
          });
        }
        if ((input.attachments?.length ?? 0) > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue:
              "DeepSeek Harness ACP developer preview currently accepts text prompts only; attachments are not supported.",
          });
        }
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "The requested model selection belongs to a different provider.",
          });
        }
        if (
          input.modelSelection?.model &&
          ctx.session.model &&
          input.modelSelection.model !== ctx.session.model
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Changing DeepSeek Harness models requires restarting the session.",
          });
        }

        ctx.turnStarting = true;
        const interactionMode = input.interactionMode ?? "default";
        const { text, turnId } = yield* Effect.gen(function* () {
          const inlineSkills = input.skills?.length
            ? yield* Effect.tryPromise(() =>
                buildInlineSkillInstructions({
                  provider: PROVIDER,
                  skills: input.skills ?? [],
                  maxChars: MAX_INLINE_SKILL_CHARS,
                }),
              ).pipe(Effect.orElseSucceed(() => ""))
            : "";
          const rawText = [input.input?.trim(), inlineSkills].filter(Boolean).join("\n\n");
          if (!rawText) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "A text prompt is required.",
            });
          }

          const turnId = TurnId.makeUnsafe(crypto.randomUUID());
          ctx.activeTurnId = turnId;
          ctx.activeInteractionMode = interactionMode;
          ctx.pendingTurnInterrupted = false;
          ctx.turns.push({ id: turnId, items: [] });
          return {
            text: buildDeepSeekTurnPromptText({ text: rawText, interactionMode }),
            turnId,
          };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.turnStarting = false;
            }),
          ),
        );
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
          threadId: ctx.threadId,
          turnId,
          payload: {},
        });

        const promptFiber = yield* Effect.gen(function* () {
          const response = yield* Effect.suspend(() =>
            ctx.pendingTurnInterrupted || ctx.stopped
              ? Effect.succeed({ stopReason: "cancelled" as const })
              : ctx.acp.prompt({ prompt: [{ type: "text", text }] }),
          ).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/prompt", error),
            ),
          );
          yield* waitForDeepSeekQueuedTurnEventsDrained(ctx);
          if (ctx.activeTurnId !== turnId) return;
          const completion = classifyAcpPromptTurnCompletion({ stopReason: response.stopReason });
          ctx.activeTurnId = undefined;
          ctx.activeInteractionMode = undefined;
          ctx.pendingTurnInterrupted = false;
          ctx.session = {
            ...ctx.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: yield* nowIso,
          };
          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              state: completion.state,
              stopReason: response.stopReason ?? null,
              ...(completion.errorMessage ? { errorMessage: completion.errorMessage } : {}),
            },
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* waitForDeepSeekQueuedTurnEventsDrained(ctx);
              if (ctx.activeTurnId === turnId) {
                ctx.activeTurnId = undefined;
                ctx.activeInteractionMode = undefined;
                ctx.pendingTurnInterrupted = false;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  activeTurnId: undefined,
                  updatedAt: yield* nowIso,
                  lastError: error.message,
                };
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId,
                  payload: { state: "failed", errorMessage: error.message },
                });
              }
            }),
          ),
          Effect.forkIn(ctx.scope),
        );
        ctx.promptFiber = promptFiber;
        return { threadId: ctx.threadId, turnId };
      });

    const interruptTurn: DeepSeekAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && ctx.activeTurnId !== turnId) return;
        if (ctx.activeTurnId === undefined && !ctx.turnStarting) return;
        ctx.pendingTurnInterrupted = true;
        if (ctx.activeTurnId === undefined) return;
        yield* ctx.acp.cancel.pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
          ),
        );
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

    const respondToUserInput: DeepSeekAdapterShape["respondToUserInput"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: "DeepSeek Harness ACP does not expose elicitation/user-input requests.",
        });
      });

    const readThread: DeepSeekAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns, cwd: ctx.session.cwd ?? null };
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
        return { threadId, turns: ctx.turns, cwd: ctx.session.cwd ?? null };
      });

    const stopSession: DeepSeekAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (ctx) yield* stopSessionInternal(ctx);
      });
    const listSessions: DeepSeekAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));
    const hasSession: DeepSeekAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped));
    const stopAll: DeepSeekAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    const getComposerCapabilities: NonNullable<
      DeepSeekAdapterShape["getComposerCapabilities"]
    > = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: true,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: false,
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
        conversationRollback: "restart-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: false,
        supportsTurnSteering: false,
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
      getComposerCapabilities,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies DeepSeekAdapterShape;
  });
}

export const DeepSeekAdapterLive = Layer.effect(DeepSeekAdapter, makeDeepSeekAdapter());

export function makeDeepSeekAdapterLive(options: DeepSeekAdapterLiveOptions = {}) {
  return Layer.effect(DeepSeekAdapter, makeDeepSeekAdapter(options));
}
