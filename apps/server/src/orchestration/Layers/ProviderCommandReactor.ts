// FILE: ProviderCommandReactor.ts
// Purpose: Routes orchestration intents into provider sessions and maintains replay-safe context.
// Layer: Orchestration provider reactor

import {
  type ChatAttachment,
  type CheckpointRef,
  CommandId,
  EventId,
  type ModelSelection,
  MessageId,
  type OrchestrationEvent,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProviderMentionReference,
  type ProviderRuntimeEvent,
  ProviderKind,
  type ProviderReviewTarget,
  type ProviderStartOptions,
  type ProviderSkillReference,
  type ProviderTurnStartResult,
  type OrchestrationSession,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  TurnId,
} from "@synara/contracts";
import {
  Cache,
  Cause,
  Duration,
  Effect,
  Equal,
  Exit,
  Layer,
  Option,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import {
  buildPromptThreadTitleFallback,
  isGenericChatThreadTitle,
} from "@synara/shared/chatThreads";
import {
  collectTailTurnIds,
  resolveTailUserMessageEditTarget,
} from "@synara/shared/conversationEdit";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@synara/shared/git";
import { claudeSelectionRequiresRestart } from "@synara/shared/model";
import {
  formatProviderDeliveryBlockDetail,
  PROVIDER_DELIVERY_BLOCK_SUMMARY,
} from "@synara/shared/providerDeliveryBlock";
import { buildStalePendingRequestFailureDetail } from "@synara/shared/threadSummary";
import { resolveThreadWorkspaceState } from "@synara/shared/threadEnvironment";

import {
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderServiceError,
} from "../../provider/Errors.ts";
import { buildInlineSkillInstructions } from "../../provider/skillPromptInjection.ts";
import {
  appendThreadMentionContextBlocks,
  resolveThreadMentionPromptProjection,
  threadMentionContextSuffix,
} from "../../provider/threadMentionContext.ts";
import {
  TextGeneration,
  type BranchNameGenerationInput,
  type ThreadTitleGenerationInput,
} from "../../git/Services/TextGeneration.ts";
import { resolveTextGenerationInputForSelection } from "../../git/textGenerationSelection.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { resolveProviderDispatchAttachments } from "../../provider/providerAttachmentPaths.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "../../persistence/Layers/OrchestrationEventDeliveries.ts";
import { ProjectionPendingInteractionRepositoryLive } from "../../persistence/Layers/ProjectionPendingInteractions.ts";
import { QueuedTurnPromotionRepositoryLive } from "../../persistence/Layers/QueuedTurnPromotions.ts";
import { ProjectionPendingInteractionRepository } from "../../persistence/Services/ProjectionPendingInteractions.ts";
import {
  OrchestrationEventDeliveryRepository,
  PROVIDER_COMMAND_REACTOR_CONSUMER,
} from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { QueuedTurnPromotionRepository } from "../../persistence/Services/QueuedTurnPromotions.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { providerStartOptionsFromServerSettings } from "@synara/shared/serverSettings";
import { clearWorkspaceIndexCache } from "../../workspaceEntries.ts";
import {
  buildPriorTranscriptBootstrapText,
  buildForkBootstrapText,
  buildHandoffBootstrapText,
  hasNativeAssistantMessagesBefore,
  listImportedForkMessages,
  listPriorTranscriptMessages,
} from "../handoff.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { StudioOutputReactor } from "../Services/StudioOutputReactor.ts";
import {
  isClaimedProviderIntent,
  isProviderIntentEvent,
  isProviderSideEffectIntent,
  isQuarantineExemptProviderIntent,
  isReplaySafeClaimedProviderIntent,
  type ProviderIntentEvent,
} from "../providerIntentClassification.ts";
import { deriveTurnStartSession } from "../turnStartSession.ts";
import { TurnCheckpointCoordinator } from "../Services/TurnCheckpointCoordinator.ts";
import { resolveProviderSessionThread as resolveProviderSessionThreadFromProjection } from "../providerSessionThread.ts";

type ProviderQueueDrainEvent = Extract<
  ProviderRuntimeEvent,
  {
    type: "turn.completed" | "turn.aborted";
  }
>;

type QueuedTurnSourceEvent =
  | Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>
  | Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;

type InteractionResponseEvent = Extract<
  ProviderIntentEvent,
  {
    type: "thread.approval-response-requested" | "thread.user-input-response-requested";
  }
>;

type ProviderAttemptOutcome =
  | { readonly _tag: "accepted" }
  | { readonly _tag: "rejected"; readonly detail: string }
  | { readonly _tag: "safe_retry"; readonly detail: string }
  | { readonly _tag: "uncertain"; readonly detail: string };

export function classifyProviderAttemptOutcome(
  exit: Exit.Exit<void, unknown>,
): ProviderAttemptOutcome {
  if (Exit.isSuccess(exit)) return { _tag: "accepted" };
  const detail = Cause.pretty(exit.cause);
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) return { _tag: "uncertain", detail };

  const tag = (failure.value as { readonly _tag?: string })._tag;
  switch (tag) {
    case "ProviderAdapterValidationError":
    case "ProviderAdapterSessionNotFoundError":
    case "ProviderAdapterSessionClosedError":
    case "ProviderValidationError":
    case "ProviderUnsupportedError":
    case "ProviderSessionNotFoundError":
      return { _tag: "rejected", detail };
    case "PersistenceSqlError":
    case "PersistenceDecodeError":
      return { _tag: "safe_retry", detail };
    default:
      return { _tag: "uncertain", detail };
  }
}

type BoundedProviderCallResult<E> =
  | { readonly _tag: "ok" }
  | { readonly _tag: "timeout"; readonly detail: string }
  | {
      readonly _tag: "failed";
      readonly outcome: Exclude<ProviderAttemptOutcome, { readonly _tag: "accepted" }>;
      readonly cause: Cause.Cause<E>;
    };

/**
 * Runs a provider call under a hard deadline and reduces it to a decision.
 * A call that never returns cannot simply be awaited here: the caller holds the
 * reactor's single delivery permit, so waiting forever stalls every thread.
 * Interruption is re-raised untouched so shutdown still cancels cleanly.
 */
const runBoundedProviderCall = <E, R>(input: {
  readonly label: string;
  readonly timeout: Duration.Duration;
  readonly call: Effect.Effect<unknown, E, R>;
}): Effect.Effect<BoundedProviderCallResult<E>, E, R> =>
  Effect.suspend(() => {
    let timedOut = false;
    return input.call.pipe(
      Effect.timeoutOption(input.timeout),
      Effect.flatMap((result) =>
        Effect.sync(() => {
          timedOut = Option.isNone(result);
        }),
      ),
      Effect.exit,
      Effect.flatMap(
        (exit): Effect.Effect<BoundedProviderCallResult<E>, E> =>
          Exit.isSuccess(exit)
            ? Effect.succeed(
                timedOut
                  ? {
                      _tag: "timeout",
                      detail: `${input.label} did not respond within ${Duration.toMillis(input.timeout)}ms.`,
                    }
                  : { _tag: "ok" },
              )
            : Cause.hasInterruptsOnly(exit.cause)
              ? Effect.failCause(exit.cause)
              : Effect.sync((): BoundedProviderCallResult<E> => {
                  const outcome = classifyProviderAttemptOutcome(exit);
                  return {
                    _tag: "failed",
                    // classify only reports "accepted" for success exits, which
                    // cannot reach this branch; normalize to keep the type honest.
                    outcome:
                      outcome._tag === "accepted"
                        ? { _tag: "uncertain", detail: Cause.pretty(exit.cause) }
                        : outcome,
                    cause: exit.cause,
                  };
                }),
      ),
    );
  });

export function isSafeLegacyProviderBlocker(lastError: string | null): boolean {
  const normalized = lastError?.toLowerCase() ?? "";
  return normalized.includes("stdin closed before the frame was written");
}

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

// Codex app-server still expects `$skill` text next to the structured skill item.
export function normalizeSkillMentionTextForProvider(input: {
  readonly provider: ProviderKind;
  readonly messageText: string;
  readonly skills?: ReadonlyArray<ProviderSkillReference>;
}): string {
  if (input.provider !== "codex" || !input.skills || input.skills.length === 0) {
    return input.messageText;
  }

  let nextText = input.messageText;
  for (const skill of input.skills) {
    const escapedName = skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    nextText = nextText.replace(
      new RegExp(`(^|\\s)/${escapedName}(?=\\s|$)`, "gi"),
      `$1$${skill.name}`,
    );
  }
  return nextText;
}

function attachmentTitleSeed(attachment: ChatAttachment | undefined): string {
  if (!attachment) {
    return "";
  }
  if (attachment.type === "image" || attachment.type === "file") {
    return attachment.name;
  }
  return attachment.text.trim();
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const PROVIDER_COMMAND_CLAIM_LEASE_MS = 30_000;
const PROVIDER_COMMAND_SAFE_RETRY_LIMIT = 3;
const PROVIDER_COMMAND_SAFE_RETRY_DELAY = Duration.millis(50);
/**
 * Every provider intent runs under a single process-wide delivery lock, so an
 * unbounded provider call does not stall one thread — it stalls the reactor,
 * which back-pressures the orchestration event PubSub and eventually times out
 * every dispatched command. These deadlines make "hung" degrade into a normal
 * terminal delivery failure instead of a process-wide deadlock.
 */
const PROVIDER_COMMAND_INTERRUPT_TIMEOUT = Duration.seconds(10);
const PROVIDER_COMMAND_STOP_TIMEOUT = Duration.seconds(15);
const PROVIDER_COMMAND_EVENT_TIMEOUT = Duration.seconds(120);
const PROVIDER_INPUT_SAFETY_MARGIN_CHARS = 1_000;
const THREAD_MENTION_CONTEXT_SUFFIX_PREFIX_CHARS = 2;
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const SIDECHAT_BOUNDARY_INSTRUCTION =
  "You are in a sidechat. Treat all prior conversation as reference-only context. Do not continue any prior task automatically. Do not mutate files, git, or the workspace and do not run workspace-changing commands unless the latest user message explicitly asks you to do so after this boundary. Use this sidechat for focused explanation, safety checks, summaries, and alternatives.";

type ProviderContextTag = "handoff_context" | "sidechat_context" | "thread_context";

function wrapProviderContext(input: {
  readonly tag: ProviderContextTag;
  readonly contextText: string;
  readonly messageText: string;
  readonly wrapLatestUserMessage: boolean;
}): string {
  const messageSection = input.wrapLatestUserMessage
    ? `<latest_user_message>\n${input.messageText}\n</latest_user_message>`
    : input.messageText;
  return `<${input.tag}>\n${input.contextText}\n</${input.tag}>\n\n${messageSection}`;
}

function availableProviderContextChars(input: {
  readonly tag: ProviderContextTag;
  readonly messageText: string;
  readonly wrapLatestUserMessage: boolean;
}): number {
  return Math.max(
    0,
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS - wrapProviderContext({ ...input, contextText: "" }).length,
  );
}

function availableThreadMentionContextChars(messageText: string): number {
  return Math.max(
    0,
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS -
      messageText.length -
      PROVIDER_INPUT_SAFETY_MARGIN_CHARS -
      THREAD_MENTION_CONTEXT_SUFFIX_PREFIX_CHARS,
  );
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

function interactionFailureSettlementStatus(
  cause: Cause.Cause<ProviderServiceError>,
  isUnknownPendingRequest: boolean,
): "retryable" | "uncertain" {
  return Option.match(Cause.findErrorOption(cause), {
    onNone: () => "uncertain" as const,
    onSome: (error) =>
      isUnknownPendingRequest ||
      error._tag === "ProviderAdapterRequestError" ||
      error._tag === "ProviderAdapterProcessError"
        ? ("uncertain" as const)
        : ("retryable" as const),
  });
}

function isStaleCodexResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("thread/resume") &&
    (normalized.includes("no rollout found") ||
      normalized.includes("thread not found") ||
      normalized.includes("missing thread") ||
      normalized.includes("unknown thread"))
  );
}

function isStaleClaudeResumeError(error: unknown): boolean {
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return (
      error.provider === "claudeAgent" &&
      error.detail.toLowerCase().includes("no conversation found with session id")
    );
  }
  return String(error).toLowerCase().includes("no conversation found with session id");
}

function isRollbackStillInProgressError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("rollback") &&
    (normalized.includes("turn is in progress") ||
      normalized.includes("turn in progress") ||
      normalized.includes("active turn"))
  );
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.replace(/^synara\//, "");

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const deliveryRepository = yield* OrchestrationEventDeliveryRepository;
  const turnCheckpointCoordinator = yield* TurnCheckpointCoordinator;
  const queuedTurnPromotions = yield* QueuedTurnPromotionRepository;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const pendingInteractions = yield* ProjectionPendingInteractionRepository;
  const checkpointStore = yield* CheckpointStore;
  const studioOutputReactor = yield* StudioOutputReactor;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
  const serverSettings = yield* ServerSettingsService;
  const managedAttachments = yield* ManagedAttachmentRepository;
  const serverConfig = yield* ServerConfig;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });
  const deliverySourceLock = yield* Semaphore.make(1);
  let reconcileDeliveryRuntime: ProviderCommandReactorShape["reconcileDelivery"] | undefined;

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadProviderOptions = new Map<string, ProviderStartOptions>();
  // The selection last applied to each live session. Keep this separate from
  // projected thread metadata so an option changed mid-turn is still compared
  // against the old subprocess configuration before the next turn starts.
  const threadSessionModelSelections = new Map<string, ModelSelection>();
  // Seeded from the engine's in-memory command read model, not a second snapshot query.
  // The engine loads that model once after the projection bootstrap and keeps it current
  // as commands commit, so reading it here is both free and strictly fresher than
  // re-running the eight-query snapshot load on the blocking startup path (~150ms on a
  // large database). It cannot fail, so there is no failure mode left to log.
  const seedThreadModelSelections = orchestrationEngine.getReadModel().pipe(
    Effect.map((snapshot) => {
      for (const thread of snapshot.threads) {
        threadSessionModelSelections.set(thread.id, thread.modelSelection);
      }
    }),
  );

  const resolveThreadWorkspaceProject = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThread, "projectId">,
  ): Effect.fn.Return<OrchestrationProjectShell | undefined> {
    return Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
  });

  const resolveProjectedThreadWorkspaceCwd = Effect.fnUntraced(function* (
    thread: Pick<
      OrchestrationThread,
      "projectId" | "envMode" | "worktreePath" | "workingDirectory"
    >,
  ): Effect.fn.Return<string | undefined> {
    const project = yield* resolveThreadWorkspaceProject(thread);
    if (!project) {
      return undefined;
    }
    return resolveThreadWorkspaceCwd({
      thread,
      projects: [project],
    });
  });
  const editResendTurnStartKeys = new Set<string>();
  const quarantinedThreads = new Set<string>();
  const drainingQueuedTurns = new Set<string>();
  // Provider sessions with a drained queued turn whose promotion is in flight.
  // The reservation survives provider startup and binds to the exact turn that
  // must settle before another queue can drain, preventing late terminal events
  // from promoting overlapping work.
  // Keyed by the session-owning thread id (child subagent threads share the
  // parent session, so per-child keys would allow overlapping promotions on
  // one session); the queued thread + message pair identifies the promoted
  // command, while object identity protects a replacement reservation for a
  // retry of that same command.
  type PendingQueuedDispatch = {
    readonly queuedThreadId: string;
    readonly messageId: string;
    releaseOnTurnId?: TurnId;
    pendingTerminalTurnIds?: Set<TurnId>;
  };
  const pendingQueuedDispatchBySessionThread = new Map<string, PendingQueuedDispatch>();
  const queuedTurnPromotionOwner = `provider-queued-turn:${crypto.randomUUID()}`;
  const sidechatContextBootstrapThreadIds = new Set<string>();
  // Fresh sessions that cannot inherit native conversation state need one
  // transcript bootstrap (fork fallbacks and non-resumable Droid model changes).
  const freshSessionContextBootstrapThreadIds = new Set<string>();
  // Providers without native rewind restart after rollback and receive the
  // retained projection transcript once on their next prompt.
  const rollbackContextBootstrapThreadIds = new Set<string>();
  type PendingContextBootstrapAttempt = {
    turnId?: TurnId;
    terminalEvent?: ProviderQueueDrainEvent;
    readonly clearSidechat: boolean;
    readonly clearPriorTranscript: boolean;
  };
  const pendingContextBootstrapAttempts = new Map<string, PendingContextBootstrapAttempt>();
  // Explicit stop resets context once: the next successful session start must
  // begin clean even if fork metadata would normally register a bootstrap.
  const suppressContextBootstrapOnNextStartThreadIds = new Set<string>();
  const clearPendingContextBootstraps = (threadId: string) => {
    sidechatContextBootstrapThreadIds.delete(threadId);
    freshSessionContextBootstrapThreadIds.delete(threadId);
    rollbackContextBootstrapThreadIds.delete(threadId);
    pendingContextBootstrapAttempts.delete(threadId);
  };

  const completePendingContextBootstrapAttempt = (
    threadId: string,
    attempt: PendingContextBootstrapAttempt,
    event: ProviderQueueDrainEvent,
  ) => {
    // Keep bootstrap flags after cancellation or failure even though Droid may
    // already have received the prompt. A bounded duplicate on retry is safer
    // than dropping the only model-visible copy of the retained transcript.
    if (event.type !== "turn.completed" || event.payload.state !== "completed") {
      return;
    }
    if (attempt.clearSidechat) {
      sidechatContextBootstrapThreadIds.delete(threadId);
    }
    if (attempt.clearPriorTranscript) {
      freshSessionContextBootstrapThreadIds.delete(threadId);
      rollbackContextBootstrapThreadIds.delete(threadId);
      sidechatContextBootstrapThreadIds.delete(threadId);
    }
  };

  const observePendingContextBootstrapTerminalEvent = (event: ProviderQueueDrainEvent) => {
    const attempt = pendingContextBootstrapAttempts.get(event.threadId);
    if (!attempt) {
      return;
    }
    if (attempt.turnId === undefined) {
      attempt.terminalEvent = event;
      return;
    }
    if (attempt.turnId !== event.turnId) {
      return;
    }
    pendingContextBootstrapAttempts.delete(event.threadId);
    completePendingContextBootstrapAttempt(event.threadId, attempt, event);
  };

  const resolveThreadTextGenerationInput = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
    readonly useConfiguredFallback?: boolean;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const modelSelection =
      input.modelSelection ??
      thread?.modelSelection ??
      threadSessionModelSelections.get(input.threadId);
    const providerOptions = input.providerOptions ?? threadProviderOptions.get(input.threadId);
    const threadTextGenerationInput = resolveTextGenerationInputForSelection(
      modelSelection,
      providerOptions,
    );

    if (threadTextGenerationInput || !input.useConfiguredFallback) {
      return threadTextGenerationInput;
    }

    // Non-generating chat providers still get AI titles via the configured git-writing model.
    const settings = yield* serverSettings.getSettings;
    return resolveTextGenerationInputForSelection(
      settings.textGenerationModelSelection,
      providerOptions,
    );
  });

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.task.stop.failed"
      | "provider.task.background.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
    readonly lifecycleGeneration?: string;
    readonly responseCommandId?: CommandId;
    readonly settlementStatus?: "retryable" | "uncertain";
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
          ...(input.responseCommandId ? { responseCommandId: input.responseCommandId } : {}),
          ...(input.settlementStatus ? { settlementStatus: input.settlementStatus } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const setThreadSessionError = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly runtimeMode?: RuntimeMode;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        status: "error",
        providerName: thread.session?.providerName ?? thread.modelSelection.provider,
        runtimeMode: input.runtimeMode ?? thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  /**
   * Finalizes a turn the provider will never settle on its own. `Stop` is only
   * trustworthy if every dead-end branch clears the projected active turn:
   * `settleTurnStateFromSession` finalizes a running turn only when the session
   * reports `activeTurnId: null`, so leaving it set renders as "Thinking"
   * forever with no escape hatch left for the user.
   */
  const settleInterruptedProviderTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!thread || !session) {
      return;
    }
    if (session.activeTurnId === null && thread.latestTurn?.state !== "running") {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...session,
        threadId: input.threadId,
        // Already-terminal statuses stay as they are; anything else becomes
        // `interrupted` so the turn is never reported as a clean completion.
        status:
          session.status === "stopped" || session.status === "error"
            ? session.status
            : "interrupted",
        activeTurnId: null,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return Option.getOrUndefined(yield* projectionSnapshotQuery.getThreadDetailById(threadId));
  });

  const resolveProviderSessionThread = (threadId: ThreadId) =>
    resolveProviderSessionThreadFromProjection(projectionSnapshotQuery, threadId);

  const withProviderSessionLease = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    resolveProviderSessionThread(threadId).pipe(
      Effect.flatMap((providerThread) =>
        turnCheckpointCoordinator.withThreadLease(providerThread?.id ?? threadId, effect),
      ),
    );

  const resolveSubagentProviderThreadId = (
    threadId: ThreadId,
    parentThreadId: ThreadId | null | undefined,
  ): string | undefined => {
    if (!parentThreadId) {
      return undefined;
    }

    const prefix = `subagent:${parentThreadId}:`;
    const rawThreadId = threadId as string;
    return rawThreadId.startsWith(prefix) ? rawThreadId.slice(prefix.length) : undefined;
  };

  const enqueueQueuedTurnStart = (event: QueuedTurnSourceEvent) =>
    queuedTurnPromotions.enqueue({
      queuedEventSequence: event.sequence,
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      dispatchMode: event.payload.dispatchMode,
      createdAt: event.payload.createdAt,
    });

  const hasQueuedTurnStart = (threadId: ThreadId, messageId: string) =>
    queuedTurnPromotions.hasPendingMessage({ threadId, messageId });

  // Live provider state, not the projection: the decider routes turn starts
  // from a projected session snapshot that can lag the runtime in both
  // directions (queueing after the turn already settled, or dispatching while
  // a turn is still live). Adapters clear `activeTurnId` synchronously with
  // emitting `turn.completed`/`turn.aborted`, so this check is authoritative.
  // Child subagent threads share their parent's provider session, so the
  // lookup must resolve to the session-owning thread — a raw child-id lookup
  // would always miss and drain queued child messages into a live turn.
  const resolveLiveProviderTurnId = Effect.fnUntraced(function* (threadId: ThreadId) {
    const providerThread = yield* resolveProviderSessionThread(threadId);
    const sessionThreadId = providerThread?.id ?? threadId;
    const session = yield* providerService
      .listSessions()
      .pipe(Effect.map((sessions) => sessions.find((entry) => entry.threadId === sessionThreadId)));
    return session?.status === "running" ? session.activeTurnId : undefined;
  });
  const hasLiveProviderTurn = (threadId: ThreadId) =>
    resolveLiveProviderTurnId(threadId).pipe(Effect.map((turnId) => turnId !== undefined));

  const editResendTurnStartKey = (threadId: ThreadId, messageId: string) =>
    `${threadId}:${messageId}`;

  const clearEditResendTurnStartKeysForThread = (threadId: ThreadId) =>
    Effect.sync(() => {
      const prefix = `${threadId}:`;
      for (const key of editResendTurnStartKeys) {
        if (key.startsWith(prefix)) {
          editResendTurnStartKeys.delete(key);
        }
      }
    });

  const clearThreadRuntimeCaches = (threadId: ThreadId) =>
    Effect.sync(() => {
      threadProviderOptions.delete(threadId);
      threadSessionModelSelections.delete(threadId);
      const editResendPrefix = `${threadId}:`;
      for (const key of editResendTurnStartKeys) {
        if (key.startsWith(editResendPrefix)) {
          editResendTurnStartKeys.delete(key);
        }
      }
      quarantinedThreads.delete(threadId);
      // NOTE: `drainingQueuedTurns` is intentionally NOT cleared here. It is a
      // turn-scoped in-flight guard that each drain self-clears when it settles;
      // deleting it here would let a concurrent second drain start for the same
      // thread while the first is still running.
      suppressContextBootstrapOnNextStartThreadIds.delete(threadId);
      clearPendingContextBootstraps(threadId);
    });

  const clearStaleProviderResumeState = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly cause: ProviderServiceError;
    readonly preserveActiveRuntime?: boolean;
  }) {
    if (providerService.clearSessionResumeCursor) {
      yield* providerService
        .clearSessionResumeCursor({
          threadId: input.threadId,
          ...(input.preserveActiveRuntime === true ? { preserveActiveRuntime: true } : {}),
        })
        .pipe(Effect.catch(() => Effect.void));
    } else if (input.preserveActiveRuntime !== true) {
      yield* providerService
        .stopSession({ threadId: input.threadId })
        .pipe(Effect.catch(() => Effect.void));
    }
    yield* Effect.logWarning("provider command reactor cleared stale provider resume state", {
      threadId: input.threadId,
      cause: input.cause.message,
    });
  });

  const rollbackProviderConversationForEdit = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) {
    const projectedThread = yield* resolveThread(input.threadId);
    const provider = projectedThread
      ? Schema.is(ProviderKind)(projectedThread.session?.providerName)
        ? projectedThread.session?.providerName
        : projectedThread.modelSelection.provider
      : undefined;
    const rebuildsContext =
      provider !== undefined &&
      (yield* providerService.getCapabilities(provider)).conversationRollback === "restart-session";
    let attempt = 0;
    while (true) {
      let rollbackError: ProviderServiceError | null = null;
      yield* providerService
        .rollbackConversation({
          threadId: input.threadId,
          numTurns: input.numTurns,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              rollbackError = error;
            }),
          ),
        );
      if (rollbackError === null) {
        if (rebuildsContext) {
          rollbackContextBootstrapThreadIds.add(input.threadId);
        }
        return;
      }
      if (isStaleCodexResumeError(rollbackError)) {
        yield* clearStaleProviderResumeState({
          threadId: input.threadId,
          cause: rollbackError,
        });
        return;
      }
      if (isRollbackStillInProgressError(rollbackError) && attempt < 30) {
        attempt += 1;
        yield* Effect.sleep(100);
        continue;
      }
      return yield* Effect.fail(rollbackError);
    }
  });

  interface EditReplayWorkspaceRestorePlan {
    readonly cwd: string;
    readonly checkpointRef: CheckpointRef;
    readonly targetTurnCount: number;
  }

  /**
   * Resolves and validates the workspace restore before the provider
   * conversation rollback runs, so a missing checkpoint refuses the whole edit
   * replay instead of leaving the conversation trimmed with the files intact.
   * Returns `null` when there is legitimately nothing to restore.
   */
  const planWorkspaceRestoreForEditReplay = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly removedTurnIds: ReadonlyArray<TurnId>;
  }) {
    if (input.removedTurnIds.length === 0) {
      return null;
    }

    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return null;
    }

    const removedTurnIdSet = new Set(input.removedTurnIds);
    const removedCheckpoints = thread.checkpoints.filter((checkpoint) =>
      removedTurnIdSet.has(checkpoint.turnId),
    );
    if (removedCheckpoints.length === 0) {
      return null;
    }

    const firstRemovedTurnCount = removedCheckpoints.reduce(
      (minTurnCount, checkpoint) => Math.min(minTurnCount, checkpoint.checkpointTurnCount),
      Number.POSITIVE_INFINITY,
    );
    const targetTurnCount = Math.max(0, firstRemovedTurnCount - 1);
    const cwd = yield* resolveProjectedThreadWorkspaceCwd(thread);
    if (!cwd) {
      return null;
    }

    if (!(yield* checkpointStore.isGitRepository(cwd))) {
      return null;
    }

    const targetCheckpointRef =
      targetTurnCount === 0
        ? checkpointRefForThreadTurn(input.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === targetTurnCount,
          )?.checkpointRef;
    if (!targetCheckpointRef) {
      return yield* Effect.fail(
        new Error(`Checkpoint ref for edit replay turn ${targetTurnCount} is unavailable.`),
      );
    }

    // Turn zero restores with `fallbackToHead`, so a missing baseline ref is
    // tolerated there; every other turn must have its checkpoint on disk.
    if (
      targetTurnCount !== 0 &&
      !(yield* checkpointStore.hasCheckpointRef({ cwd, checkpointRef: targetCheckpointRef }))
    ) {
      return yield* Effect.fail(
        new Error(`Filesystem checkpoint is unavailable for edit replay turn ${targetTurnCount}.`),
      );
    }

    return {
      cwd,
      checkpointRef: targetCheckpointRef,
      targetTurnCount,
    } satisfies EditReplayWorkspaceRestorePlan;
  });

  const executeEditReplayWorkspaceRestore = Effect.fnUntraced(function* (
    plan: EditReplayWorkspaceRestorePlan | null,
  ) {
    if (plan === null) {
      return;
    }
    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd: plan.cwd,
      checkpointRef: plan.checkpointRef,
      fallbackToHead: plan.targetTurnCount === 0,
    });
    if (!restored) {
      return yield* Effect.fail(
        new Error(
          `Filesystem checkpoint for edit replay turn ${plan.targetTurnCount} became unavailable during the rollback.`,
        ),
      );
    }

    clearWorkspaceIndexCache(plan.cwd);
  });

  const ensureSessionForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly providerOptions?: ProviderStartOptions;
      readonly runtimeMode?: RuntimeMode;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${threadId}' was not found in projection state.`),
      );
    }
    const shouldRegisterContextBootstrap =
      thread.session?.status !== "stopped" &&
      !suppressContextBootstrapOnNextStartThreadIds.has(threadId);

    const desiredRuntimeMode = options?.runtimeMode ?? thread.runtimeMode;
    const currentProvider: ProviderKind | undefined = Schema.is(ProviderKind)(
      thread.session?.providerName,
    )
      ? thread.session.providerName
      : undefined;
    const requestedModelSelection = options?.modelSelection;
    const threadProvider: ProviderKind = currentProvider ?? thread.modelSelection.provider;
    if (
      requestedModelSelection !== undefined &&
      requestedModelSelection.provider !== threadProvider
    ) {
      return yield* new ProviderAdapterValidationError({
        provider: threadProvider,
        operation: "thread.turn.start",
        issue: `Thread '${threadId}' is bound to provider '${threadProvider}' and cannot switch to '${requestedModelSelection.provider}'.`,
      });
    }
    const preferredProvider: ProviderKind = currentProvider ?? threadProvider;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const settingsSnapshot = yield* serverSettings.getSnapshot;
    if (!settingsSnapshot.settings.providers[preferredProvider].enabled) {
      return yield* new ProviderAdapterValidationError({
        provider: preferredProvider,
        operation: "thread.turn.start",
        issue: `Provider '${preferredProvider}' is disabled in server settings revision ${settingsSnapshot.revision}.`,
      });
    }
    const resolvedProviderOptions = providerStartOptionsFromServerSettings(
      settingsSnapshot.settings,
    );
    const effectiveCwd = yield* resolveProjectedThreadWorkspaceCwd(thread);
    const workspaceState = resolveThreadWorkspaceState({
      envMode: thread.envMode,
      worktreePath: thread.worktreePath,
    });
    if (workspaceState === "worktree-pending") {
      return yield* new ProviderAdapterValidationError({
        provider: threadProvider,
        operation: "thread.turn.start",
        issue: `Thread '${threadId}' targets a worktree that has not been created yet.`,
      });
    }
    const providerSessionOptions = {
      threadId,
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      modelSelection: desiredModelSelection,
      providerOptions: resolvedProviderOptions,
      runtimeMode: desiredRuntimeMode,
    };

    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const startProviderSession = (resumeCursor?: unknown) =>
      providerService.startSession(threadId, {
        ...providerSessionOptions,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        ...(resumeCursor !== undefined ? { resumeCursor } : {}),
      });

    const bindSessionToThread = (session: ProviderSession) =>
      setThreadSession({
        threadId,
        session: {
          threadId,
          status:
            session.status === "connecting"
              ? "starting"
              : session.status === "closed"
                ? "stopped"
                : session.status,
          providerName: session.provider,
          runtimeMode: desiredRuntimeMode,
          // Provider turn ids are not orchestration turn ids.
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        createdAt,
      });

    // Only reuse projected session state when the runtime still has a live session to attach to.
    const activeSession = yield* resolveActiveSession(threadId);
    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = desiredRuntimeMode !== thread.session?.runtimeMode;
      const providerChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider !== currentProvider;
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "restart-session";
      const previousModelSelection = threadSessionModelSelections.get(threadId);
      // Claude restarts resume via `--resume`, which replays the whole conversation
      // as uncached input tokens. Only spawn-fixed options (currently `max` effort)
      // may force that; model and context-window changes switch in-session via
      // setModel, and effort/fastMode/ultracode/thinking apply via flag settings.
      // When the dispatch cache has no entry (the session was started by a turn
      // without a selection), compare against the projected thread selection the
      // session was actually spawned from so spawn-fixed changes still restart.
      const shouldRestartForModelSelectionChange =
        requestedModelSelection !== undefined &&
        (currentProvider === "claudeAgent"
          ? claudeSelectionRequiresRestart(
              previousModelSelection ?? thread.modelSelection,
              requestedModelSelection,
            )
          : (currentProvider === "droid" || currentProvider === "grok") &&
            !Equal.equals(previousModelSelection, requestedModelSelection));

      if (
        !runtimeModeChanged &&
        !providerChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor =
        providerChanged || shouldRestartForModelChange || runtimeModeChanged
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: desiredModelSelection.provider,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode,
        runtimeModeChanged,
        providerChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(resumeCursor);
      if (
        shouldRegisterContextBootstrap &&
        currentProvider === "droid" &&
        !providerChanged &&
        resumeCursor === undefined
      ) {
        freshSessionContextBootstrapThreadIds.add(threadId);
      }
      threadSessionModelSelections.set(threadId, desiredModelSelection);
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToThread(restartedSession);
      suppressContextBootstrapOnNextStartThreadIds.delete(threadId);
      return restartedSession.threadId;
    }

    if (providerService.forkThread && thread.forkSourceThreadId) {
      const forked = yield* providerService.forkThread({
        ...providerSessionOptions,
        sourceThreadId: thread.forkSourceThreadId,
      });
      if (forked) {
        if (
          shouldRegisterContextBootstrap &&
          preferredProvider === "droid" &&
          thread.sidechatSourceThreadId
        ) {
          // Droid's ACP fork preserves the native session but does not guarantee
          // that the imported sidechat transcript is model-visible on its first prompt.
          sidechatContextBootstrapThreadIds.add(threadId);
        }
        threadSessionModelSelections.set(threadId, desiredModelSelection);
        const forkedSession =
          (yield* resolveActiveSession(threadId)) ??
          ({
            provider: preferredProvider,
            status: "ready",
            runtimeMode: desiredRuntimeMode,
            ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
            model: desiredModelSelection.model,
            threadId,
            ...(forked.resumeCursor !== undefined ? { resumeCursor: forked.resumeCursor } : {}),
            createdAt,
            updatedAt: createdAt,
          } satisfies ProviderSession);
        yield* bindSessionToThread(forkedSession);
        suppressContextBootstrapOnNextStartThreadIds.delete(threadId);
        return threadId;
      }
      if (shouldRegisterContextBootstrap && !thread.sidechatSourceThreadId) {
        freshSessionContextBootstrapThreadIds.add(threadId);
      }
    }

    if (
      shouldRegisterContextBootstrap &&
      thread.sidechatSourceThreadId &&
      thread.forkSourceThreadId
    ) {
      sidechatContextBootstrapThreadIds.add(threadId);
    }

    const startedSession = yield* startProviderSession();
    // Record the exact selection the session was spawned with so later
    // restart-necessity checks compare against the live spawn state even when
    // the spawning dispatch carried no explicit model selection.
    threadSessionModelSelections.set(threadId, desiredModelSelection);
    yield* bindSessionToThread(startedSession);
    suppressContextBootstrapOnNextStartThreadIds.delete(threadId);
    return startedSession.threadId;
  });

  const dispatchTurnForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly skills?: ReadonlyArray<ProviderSkillReference>;
    readonly mentions?: ReadonlyArray<ProviderMentionReference>;
    readonly reviewTarget?: ProviderReviewTarget;
    readonly modelSelection?: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: "default" | "plan";
    readonly dispatchMode?: "queue" | "steer";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const threadMentionProjection = yield* resolveThreadMentionPromptProjection({
      mentions: input.mentions,
      snapshotQuery: projectionSnapshotQuery,
      maxTotalContextChars: availableThreadMentionContextChars(input.messageText),
    });
    const messageText = appendThreadMentionContextBlocks({
      text: input.messageText,
      contextBlocks: threadMentionProjection.contextBlocks,
    });
    const mentionContextSuffix = threadMentionContextSuffix(threadMentionProjection.contextBlocks);
    const providerMentions = threadMentionProjection.providerMentions;
    // Subagent threads have no provider session of their own: their messages
    // steer the running child task through the parent session (mirrors the
    // interrupt seam), never the session-bootstrap path below. Parent metadata
    // may be absent on older/local-only rows, so synthetic ids use the same
    // projection-backed parent inference as interrupt routing.
    const providerThread = yield* resolveProviderSessionThread(input.threadId);
    const subagentProviderThreadId = providerThread
      ? resolveSubagentProviderThreadId(thread.id, providerThread.id)
      : undefined;
    if (providerThread && subagentProviderThreadId) {
      // Parity with the steerTurn path below: inline portable skill
      // instructions, normalize skill/agent mentions, and forward the
      // structured context so the adapter can project attachments into the
      // text-only subagent steering channel.
      const steerProvider = (providerThread.session?.providerName ??
        providerThread.modelSelection.provider) as ProviderKind;
      const steerSkillInlineText =
        input.skills !== undefined && input.skills.length > 0
          ? yield* Effect.tryPromise(() =>
              buildInlineSkillInstructions({
                provider: steerProvider,
                skills: input.skills ?? [],
                maxChars: Math.max(
                  0,
                  PROVIDER_SEND_TURN_MAX_INPUT_CHARS -
                    messageText.length -
                    PROVIDER_INPUT_SAFETY_MARGIN_CHARS,
                ),
              }),
            ).pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to inline portable skill instructions", {
                  threadId: input.threadId,
                  error,
                }).pipe(Effect.as("")),
              ),
            )
          : "";
      const steerMessageWithSkills = steerSkillInlineText
        ? `${messageText}\n\n${steerSkillInlineText}`
        : messageText;
      const normalizedSteerInput = toNonEmptyProviderInput(
        normalizeSkillMentionTextForProvider({
          provider: steerProvider,
          messageText: steerMessageWithSkills,
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
        }),
      );
      const normalizedSteerAttachments = yield* resolveProviderDispatchAttachments({
        attachments: input.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
        repository: managedAttachments,
        threadId: input.threadId,
        messageId: input.messageId,
        provider: steerProvider,
        operation: "thread.turn.start",
      });
      yield* providerService.steerSubagent({
        threadId: providerThread.id,
        providerThreadId: subagentProviderThreadId,
        ...(normalizedSteerInput ? { input: normalizedSteerInput } : {}),
        ...(normalizedSteerAttachments.length > 0
          ? { attachments: normalizedSteerAttachments }
          : {}),
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
        ...(providerMentions !== undefined ? { mentions: providerMentions } : {}),
      });
      return;
    }
    const activeSessionBeforeEnsure = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
      ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
    });
    if (input.providerOptions !== undefined) {
      threadProviderOptions.set(input.threadId, input.providerOptions);
    }
    if (input.modelSelection !== undefined) {
      threadSessionModelSelections.set(input.threadId, input.modelSelection);
    }
    // Bootstrap prompts wrap the user message in `<latest_user_message>` tags;
    // mentioned-thread context is appended after the assembled provider input
    // instead so it never reads as part of the user's own words. The budget
    // text below still counts the suffix, keeping the total under the provider
    // input limit regardless of where the suffix sits.
    const boundaryMessageText = thread.sidechatSourceThreadId
      ? `<sidechat_boundary>\n${SIDECHAT_BOUNDARY_INSTRUCTION}\n</sidechat_boundary>\n\n<latest_user_message>\n${input.messageText}\n</latest_user_message>`
      : input.messageText;
    const bootstrapBudgetMessageText = `${boundaryMessageText}${mentionContextSuffix}`;
    const shouldBootstrapHandoff =
      thread.handoff?.bootstrapStatus === "pending" &&
      !hasNativeAssistantMessagesBefore(thread, input.messageId);
    const handoffBootstrapAvailableChars = availableProviderContextChars({
      tag: "handoff_context",
      messageText: bootstrapBudgetMessageText,
      wrapLatestUserMessage: true,
    });
    const handoffBootstrapText =
      shouldBootstrapHandoff && handoffBootstrapAvailableChars > 0
        ? buildHandoffBootstrapText(thread, handoffBootstrapAvailableChars)
        : null;
    const selectedProvider =
      input.modelSelection?.provider ??
      threadSessionModelSelections.get(input.threadId)?.provider ??
      thread.session?.providerName ??
      thread.modelSelection.provider;
    const hasPendingPriorTranscriptBootstrap =
      freshSessionContextBootstrapThreadIds.has(input.threadId) ||
      rollbackContextBootstrapThreadIds.has(input.threadId);
    const shouldBootstrapSidechatContext =
      thread.sidechatSourceThreadId !== null &&
      sidechatContextBootstrapThreadIds.has(input.threadId) &&
      !hasNativeAssistantMessagesBefore(thread, input.messageId) &&
      !shouldBootstrapHandoff &&
      !hasPendingPriorTranscriptBootstrap;
    const sidechatBootstrapAvailableChars = availableProviderContextChars({
      tag: "sidechat_context",
      messageText: bootstrapBudgetMessageText,
      wrapLatestUserMessage: false,
    });
    const sidechatBootstrapText =
      shouldBootstrapSidechatContext && sidechatBootstrapAvailableChars > 0
        ? buildForkBootstrapText(thread, sidechatBootstrapAvailableChars)
        : null;
    const hasSidechatBootstrapContent =
      shouldBootstrapSidechatContext && listImportedForkMessages(thread).length > 0;
    if (
      input.reviewTarget === undefined &&
      hasSidechatBootstrapContent &&
      sidechatBootstrapAvailableChars === 0
    ) {
      return yield* new ProviderAdapterValidationError({
        provider: selectedProvider as ProviderKind,
        operation: "thread.turn.start",
        issue:
          "The latest message is too long to include the sidechat context required by this provider session. Shorten the message and retry.",
      });
    }
    const shouldBootstrapPriorTranscriptContext =
      (((selectedProvider === "kilo" || selectedProvider === "opencode") &&
        activeSessionBeforeEnsure === undefined) ||
        hasPendingPriorTranscriptBootstrap) &&
      !shouldBootstrapHandoff &&
      !shouldBootstrapSidechatContext;
    const hasPriorTranscriptBootstrapContent =
      shouldBootstrapPriorTranscriptContext &&
      listPriorTranscriptMessages(thread, input.messageId).length > 0;
    const priorTranscriptBootstrapAvailableChars = availableProviderContextChars({
      tag: "thread_context",
      messageText: bootstrapBudgetMessageText,
      wrapLatestUserMessage: true,
    });
    if (
      input.reviewTarget === undefined &&
      hasPendingPriorTranscriptBootstrap &&
      shouldBootstrapPriorTranscriptContext &&
      priorTranscriptBootstrapAvailableChars === 0 &&
      hasPriorTranscriptBootstrapContent
    ) {
      return yield* new ProviderAdapterValidationError({
        provider: selectedProvider as ProviderKind,
        operation: "thread.turn.start",
        issue:
          "The latest message is too long to include the transcript context required by the restarted provider session. Shorten the message and retry.",
      });
    }
    const priorTranscriptBootstrapText =
      shouldBootstrapPriorTranscriptContext && priorTranscriptBootstrapAvailableChars > 0
        ? buildPriorTranscriptBootstrapText(
            thread,
            input.messageId,
            priorTranscriptBootstrapAvailableChars,
          )
        : null;
    const providerInput = handoffBootstrapText
      ? wrapProviderContext({
          tag: "handoff_context",
          contextText: handoffBootstrapText,
          messageText: boundaryMessageText,
          wrapLatestUserMessage: true,
        })
      : sidechatBootstrapText
        ? wrapProviderContext({
            tag: "sidechat_context",
            contextText: sidechatBootstrapText,
            messageText: boundaryMessageText,
            wrapLatestUserMessage: false,
          })
        : priorTranscriptBootstrapText
          ? wrapProviderContext({
              tag: "thread_context",
              contextText: priorTranscriptBootstrapText,
              messageText: boundaryMessageText,
              wrapLatestUserMessage: true,
            })
          : boundaryMessageText;
    const providerInputWithMentionContext = `${providerInput}${mentionContextSuffix}`;
    // Portable skills fallback: providers that cannot load the referenced skill
    // file natively get the skill instructions inlined into the prompt.
    const skillInlineText =
      input.skills !== undefined && input.skills.length > 0
        ? yield* Effect.tryPromise(() =>
            buildInlineSkillInstructions({
              provider: selectedProvider as ProviderKind,
              skills: input.skills ?? [],
              maxChars: Math.max(
                0,
                PROVIDER_SEND_TURN_MAX_INPUT_CHARS -
                  providerInputWithMentionContext.length -
                  PROVIDER_INPUT_SAFETY_MARGIN_CHARS,
              ),
            }),
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to inline portable skill instructions", {
                threadId: input.threadId,
                error,
              }).pipe(Effect.as("")),
            ),
          )
        : "";
    const providerInputWithSkills = skillInlineText
      ? `${providerInputWithMentionContext}\n\n${skillInlineText}`
      : providerInputWithMentionContext;
    const normalizedInput = toNonEmptyProviderInput(
      normalizeSkillMentionTextForProvider({
        provider: selectedProvider as ProviderKind,
        messageText: providerInputWithSkills,
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
      }),
    );
    const normalizedAttachments = yield* resolveProviderDispatchAttachments({
      attachments: input.attachments,
      attachmentsDir: serverConfig.attachmentsDir,
      repository: managedAttachments,
      threadId: input.threadId,
      messageId: input.messageId,
      provider: selectedProvider as ProviderKind,
      operation: "thread.turn.start",
    });
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const requestedModelSelection = input.modelSelection ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : requestedModelSelection;
    const providerTurnInput = {
      threadId: input.threadId,
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(input.skills !== undefined ? { skills: input.skills } : {}),
      ...(providerMentions !== undefined ? { mentions: providerMentions } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
    const sendQueuedProviderTurn = (messageText: string | undefined) =>
      providerService.sendTurn({
        ...providerTurnInput,
        ...(messageText ? { input: messageText } : {}),
      });

    const captureMessageStartCheckpoint = Effect.gen(function* () {
      if ((input.dispatchMode ?? "queue") === "steer") {
        return;
      }

      const currentThread = yield* resolveThread(input.threadId);
      if (!currentThread) {
        return;
      }

      const cwd = yield* resolveProjectedThreadWorkspaceCwd(currentThread);
      if (!cwd || !(yield* checkpointStore.isGitRepository(cwd))) {
        return;
      }

      // Capture before provider dispatch so the later turn diff is bounded by
      // the user's submit moment, not early provider edits. skipIfExists keeps
      // a backup baseline from CheckpointReactor as the first-writer winner.
      yield* checkpointStore.captureCheckpoint({
        cwd,
        checkpointRef: checkpointRefForThreadMessageStart(
          input.threadId,
          MessageId.makeUnsafe(input.messageId),
        ),
        skipIfExists: true,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to capture provider turn start checkpoint", {
          threadId: input.threadId,
          messageId: input.messageId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

    // Both Git and non-Git Studio baselines must finish before provider execution
    // starts. Otherwise a fast command can write a file while the baseline scan is
    // still running and make that output look unchanged at turn completion.
    const capturePreTurnBaselines = Effect.all(
      [
        captureMessageStartCheckpoint,
        studioOutputReactor.captureBaselineBeforeTurn(input.threadId),
      ],
      { concurrency: 2, discard: true },
    );
    const cancelPendingStudioBaseline = studioOutputReactor.cancelPendingTurnBaseline(
      input.threadId,
    );
    let pendingContextBootstrapAttempt: PendingContextBootstrapAttempt | undefined;
    let startedTurn: ProviderTurnStartResult | undefined;

    if (input.reviewTarget !== undefined) {
      yield* capturePreTurnBaselines;
      startedTurn = yield* providerService
        .startReview({
          threadId: input.threadId,
          target: input.reviewTarget,
        })
        .pipe(Effect.onError(() => cancelPendingStudioBaseline));
    } else if (input.dispatchMode === "steer") {
      startedTurn = yield* providerService.steerTurn({
        ...providerTurnInput,
        ...(normalizedInput ? { input: normalizedInput } : {}),
      });
    } else {
      yield* capturePreTurnBaselines;
      pendingContextBootstrapAttempt =
        activeSession?.provider === "droid" &&
        (sidechatBootstrapText !== null || priorTranscriptBootstrapText !== null)
          ? {
              clearSidechat: sidechatBootstrapText !== null,
              clearPriorTranscript: priorTranscriptBootstrapText !== null,
            }
          : undefined;
      if (pendingContextBootstrapAttempt) {
        pendingContextBootstrapAttempts.set(input.threadId, pendingContextBootstrapAttempt);
      }
      const ensureSessionForStaleRetry = ensureSessionForThread(input.threadId, input.createdAt, {
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
      });
      const replayWithTranscriptBootstrap = (
        cause: ProviderServiceError,
        preserveActiveRuntime = false,
      ) =>
        Effect.gen(function* () {
          // Claude cannot continue from a missing native session; clear the
          // dead cursor and replay once with Synara transcript context.
          yield* clearStaleProviderResumeState({
            threadId: input.threadId,
            cause,
            ...(preserveActiveRuntime ? { preserveActiveRuntime: true } : {}),
          });
          yield* ensureSessionForStaleRetry;

          const retryBootstrapText =
            priorTranscriptBootstrapAvailableChars > 0
              ? buildPriorTranscriptBootstrapText(
                  thread,
                  input.messageId,
                  priorTranscriptBootstrapAvailableChars,
                )
              : null;
          const retryProviderInput = retryBootstrapText
            ? wrapProviderContext({
                tag: "thread_context",
                contextText: retryBootstrapText,
                messageText: boundaryMessageText,
                wrapLatestUserMessage: true,
              })
            : boundaryMessageText;
          const retryProviderInputWithMentionContext = `${retryProviderInput}${mentionContextSuffix}`;
          const retryProviderInputWithSkills = skillInlineText
            ? `${retryProviderInputWithMentionContext}\n\n${skillInlineText}`
            : retryProviderInputWithMentionContext;
          const retryNormalizedInput = toNonEmptyProviderInput(
            normalizeSkillMentionTextForProvider({
              provider: selectedProvider as ProviderKind,
              messageText: retryProviderInputWithSkills,
              ...(input.skills !== undefined ? { skills: input.skills } : {}),
            }),
          );

          yield* Effect.logWarning(
            "provider command reactor retrying claude turn after stale resume",
            {
              threadId: input.threadId,
              messageId: input.messageId,
              bootstrappedPriorTranscript: retryBootstrapText !== null,
            },
          );
          return yield* sendQueuedProviderTurn(retryNormalizedInput);
        });
      const sentTurn = yield* sendQueuedProviderTurn(normalizedInput).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (selectedProvider !== "claudeAgent" || !isStaleClaudeResumeError(error)) {
              return yield* Effect.fail(error);
            }

            // Stale-resume errors can be transient CLI/session-file races, so
            // retry the native resume id once before paying the transcript
            // bootstrap. This must preserve the provider binding: startSession
            // recovers the cursor from it when the fresh runtime is spawned.
            if (!providerService.stopRuntimeSession) {
              return yield* replayWithTranscriptBootstrap(error);
            }
            // Background tasks share the runtime subprocess with the parent
            // turn; stopping it for a native-resume retry would silently kill
            // them. Recover on the live runtime via transcript bootstrap.
            const liveBackgroundTasks = providerService.hasLiveRuntimeTasks
              ? yield* providerService.hasLiveRuntimeTasks({ threadId: input.threadId })
              : false;
            if (liveBackgroundTasks) {
              yield* Effect.logWarning(
                "provider command reactor skipping native resume retry: live background tasks",
                {
                  threadId: input.threadId,
                  messageId: input.messageId,
                },
              );
              return yield* replayWithTranscriptBootstrap(error, true);
            }
            yield* providerService
              .stopRuntimeSession({ threadId: input.threadId })
              .pipe(Effect.catch(() => Effect.void));
            yield* ensureSessionForStaleRetry;
            yield* Effect.logWarning(
              "provider command reactor retrying claude turn with native resume",
              {
                threadId: input.threadId,
                messageId: input.messageId,
              },
            );
            return yield* sendQueuedProviderTurn(normalizedInput).pipe(
              Effect.catch((retryError) =>
                isStaleClaudeResumeError(retryError)
                  ? replayWithTranscriptBootstrap(retryError)
                  : Effect.fail(retryError),
              ),
            );
          }),
        ),
        Effect.onError(() =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              if (
                pendingContextBootstrapAttempt &&
                pendingContextBootstrapAttempts.get(input.threadId) ===
                  pendingContextBootstrapAttempt
              ) {
                pendingContextBootstrapAttempts.delete(input.threadId);
              }
            });
            yield* cancelPendingStudioBaseline;
          }),
        ),
      );
      startedTurn = sentTurn;
      if (pendingContextBootstrapAttempt) {
        pendingContextBootstrapAttempt.turnId = sentTurn.turnId;
        const terminalEvent = pendingContextBootstrapAttempt.terminalEvent;
        if (terminalEvent?.turnId === sentTurn.turnId) {
          pendingContextBootstrapAttempts.delete(input.threadId);
          completePendingContextBootstrapAttempt(
            input.threadId,
            pendingContextBootstrapAttempt,
            terminalEvent,
          );
        }
      }
    }
    if (handoffBootstrapText && thread.handoff !== null && input.reviewTarget === undefined) {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("handoff-bootstrap-complete"),
        threadId: input.threadId,
        handoff: {
          ...thread.handoff,
          bootstrapStatus: "completed",
        },
      });
    }
    if (
      shouldBootstrapSidechatContext &&
      input.reviewTarget === undefined &&
      pendingContextBootstrapAttempt === undefined &&
      (sidechatBootstrapText !== null || !hasSidechatBootstrapContent)
    ) {
      sidechatContextBootstrapThreadIds.delete(input.threadId);
    }
    if (
      shouldBootstrapPriorTranscriptContext &&
      input.reviewTarget === undefined &&
      pendingContextBootstrapAttempt === undefined &&
      (priorTranscriptBootstrapText !== null || !hasPriorTranscriptBootstrapContent)
    ) {
      freshSessionContextBootstrapThreadIds.delete(input.threadId);
      rollbackContextBootstrapThreadIds.delete(input.threadId);
      sidechatContextBootstrapThreadIds.delete(input.threadId);
    }
    return startedTurn;
  });

  const renameTemporaryWorktreeBranch = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly oldBranch: string;
    readonly targetBranch: string;
  }) {
    if (input.targetBranch === input.oldBranch) {
      return;
    }

    const renamed = yield* git.withMutation(
      input.cwd,
      Effect.gen(function* () {
        const result = yield* git.renameBranch({
          cwd: input.cwd,
          oldBranch: input.oldBranch,
          newBranch: input.targetBranch,
        });
        yield* git.publishBranch({ cwd: input.cwd, branch: result.branch }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider command reactor failed to publish renamed branch", {
              threadId: input.threadId,
              cwd: input.cwd,
              branch: result.branch,
              cause: Cause.pretty(cause),
            }),
          ),
        );
        return result;
      }),
    );
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: serverCommandId("worktree-branch-rename"),
      threadId: input.threadId,
      branch: renamed.branch,
      worktreePath: input.cwd,
      associatedWorktreePath: input.cwd,
      associatedWorktreeBranch: renamed.branch,
      associatedWorktreeRef: renamed.branch,
    });
  });

  const resolveFirstTurnThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    messageId: string,
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) return null;
    const userMessages = thread.messages.filter(
      (message) => message.role === "user" && message.source === "native",
    );
    return userMessages.length === 1 && userMessages[0]?.id === messageId ? thread : null;
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const thread = yield* resolveFirstTurnThread(input.threadId, input.messageId);
    if (!thread) return;

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    const textGenerationInput = yield* resolveThreadTextGenerationInput({
      threadId: input.threadId,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
    if (!textGenerationInput) {
      const targetBranch = buildGeneratedWorktreeBranchName(
        input.messageText.trim() || attachmentTitleSeed(attachments[0]) || "",
      );
      yield* renameTemporaryWorktreeBranch({
        threadId: input.threadId,
        cwd,
        oldBranch,
        targetBranch,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "provider command reactor failed to apply fallback worktree branch name",
            { threadId: input.threadId, cwd, oldBranch, targetBranch, cause: Cause.pretty(cause) },
          ),
        ),
      );
      return;
    }
    const branchNameGenerationInput: BranchNameGenerationInput = {
      cwd,
      message: input.messageText,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection: textGenerationInput.modelSelection,
      ...(textGenerationInput.providerOptions
        ? { providerOptions: textGenerationInput.providerOptions }
        : {}),
    };
    yield* textGeneration.generateBranchName(branchNameGenerationInput).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "provider command reactor failed to generate worktree branch name; skipping rename",
          { threadId: input.threadId, cwd, oldBranch, reason: error.message },
        ),
      ),
      Effect.flatMap((generated) => {
        if (!generated) return Effect.void;

        const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
        return renameTemporaryWorktreeBranch({
          threadId: input.threadId,
          cwd,
          oldBranch,
          targetBranch,
        });
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  // Only auto-rename placeholder titles that still reflect the first-turn draft state.
  const maybeGenerateAndRenameThreadTitleForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
  }) {
    const thread = yield* resolveFirstTurnThread(input.threadId, input.messageId);
    if (!thread) return;

    const fallbackTitle = buildPromptThreadTitleFallback(
      input.messageText.trim() || attachmentTitleSeed(input.attachments?.[0]) || "",
    );
    const currentTitle = thread.title.trim();
    if (!isGenericChatThreadTitle(currentTitle) && currentTitle !== fallbackTitle) {
      return;
    }
    const cwd = yield* resolveProjectedThreadWorkspaceCwd(thread);
    const textGenerationInput = yield* resolveThreadTextGenerationInput({
      threadId: input.threadId,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      useConfiguredFallback: true,
    });
    if (!textGenerationInput) {
      if (fallbackTitle !== currentTitle) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("thread-title-fallback-rename"),
          threadId: input.threadId,
          title: fallbackTitle,
        });
      }
      return;
    }
    const textGenerationSelection = textGenerationInput.modelSelection;
    const textGenerationLogContext = {
      threadId: input.threadId,
      cwd,
      threadProvider: thread.modelSelection.provider,
      threadModel: thread.modelSelection.model,
      requestedProvider: input.modelSelection?.provider ?? null,
      requestedModel: input.modelSelection?.model ?? null,
      textGenerationProvider: textGenerationSelection.provider,
      textGenerationModel: textGenerationSelection.model,
      textGenerationOptions: textGenerationSelection.options ?? null,
    };
    yield* Effect.logDebug("provider command reactor generating thread title", {
      ...textGenerationLogContext,
      hasProviderOptions: Boolean(textGenerationInput.providerOptions),
    });
    const titleGenerationInput: ThreadTitleGenerationInput = {
      cwd: cwd ?? process.cwd(),
      message: input.messageText,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      modelSelection: textGenerationInput.modelSelection,
      ...(textGenerationInput.providerOptions
        ? { providerOptions: textGenerationInput.providerOptions }
        : {}),
    };
    const nextTitle = yield* textGeneration.generateThreadTitle(titleGenerationInput).pipe(
      Effect.map((generated) => generated.title),
      Effect.catch((error) =>
        Effect.logWarning("provider command reactor failed to generate thread title", {
          ...textGenerationLogContext,
          reason: error.message,
        }).pipe(Effect.as(fallbackTitle)),
      ),
    );

    if (nextTitle === currentTitle) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: serverCommandId("thread-title-rename"),
      threadId: input.threadId,
      title: nextTitle,
    });
  });

  const processTurnStartRequestedWithoutLease = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const sessionThreadId =
      (yield* resolveProviderSessionThread(event.payload.threadId))?.id ?? event.payload.threadId;
    const matchesEvent = (entry: PendingQueuedDispatch | undefined) =>
      entry?.queuedThreadId === (event.payload.threadId as string) &&
      entry.messageId === event.payload.messageId;
    const reservationAtStart = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
    const isPendingQueuedDispatch = matchesEvent(reservationAtStart);
    const ownsReservation = (entry: PendingQueuedDispatch | undefined) =>
      isPendingQueuedDispatch && entry === reservationAtStart;
    const clearPendingQueuedDispatch = Effect.sync(() => {
      if (ownsReservation(pendingQueuedDispatchBySessionThread.get(sessionThreadId))) {
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
      }
    });
    const bindPendingQueuedDispatchToTurn = Effect.fnUntraced(function* (turnId: TurnId) {
      const reservation = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
      if (reservation === undefined || !ownsReservation(reservation)) {
        return;
      }
      reservation.releaseOnTurnId = turnId;
      const completedBeforeBinding = reservation.pendingTerminalTurnIds?.has(turnId);
      delete reservation.pendingTerminalTurnIds;
      if (completedBeforeBinding) {
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
        yield* drainQueuedTurnsForSession(event.payload.threadId);
      }
    });
    try {
      const key = turnStartKeyForEvent(event);
      if (yield* hasHandledTurnStartRecently(key)) {
        return;
      }

      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }

      const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
      if (!message || message.role !== "user") {
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
          turnId: null,
          createdAt: event.payload.createdAt,
        });
        return;
      }

      // The decider routes turn starts from the projected session, which can lag
      // the runtime: a message dispatched right as another turn begins (e.g. the
      // gap between a steer interrupt and the steered turn's start) would race a
      // live provider turn. Codex steers ride the live turn natively; everything
      // else re-queues and is promoted when the live turn settles.
      const providerName = thread.session?.providerName ?? thread.modelSelection.provider;
      const liveTurnId = yield* resolveLiveProviderTurnId(event.payload.threadId);
      const hasLiveTurn = liveTurnId !== undefined;
      // Steering is only meaningful against a live turn. The projection can
      // lag the runtime in the other direction too (turn already settled but
      // still projected as running), so recheck live state and dispatch a
      // settled codex "steer" as a normal queued turn — the native steer path
      // would skip the turn-start checkpoint.
      const isCodexSteer =
        event.payload.dispatchMode === "steer" && providerName === "codex" && hasLiveTurn;
      if (!isCodexSteer && hasLiveTurn) {
        yield* enqueueQueuedTurnStart(event);
        // The promotion raced another live turn and was re-queued. Release
        // only when that exact blocking turn settles, not on any late
        // terminal event for the shared provider session.
        yield* bindPendingQueuedDispatchToTurn(liveTurnId);
        if (event.payload.dispatchMode === "steer") {
          // Preserve steer semantics: jump the queue (enqueue unshifts steers)
          // and ask the live turn to stop so the steer dispatches next.
          yield* interruptProviderTurn({
            threadId: event.payload.threadId,
            createdAt: event.payload.createdAt,
          });
        }
        return;
      }

      // Surface the upcoming work immediately: provider session init can take
      // seconds (e.g. Cursor), and without an early status the thread reads as
      // idle until the runtime's first event. Mirrors the message-edit-resend
      // path. Never touches a live session — a steer turn on a running Codex
      // session must keep its running state and activeTurnId. Keeps the existing
      // session's runtimeMode: ensureSessionForThread detects mode changes by
      // comparing against it, and adopting the requested mode here would mask
      // the restart.
      const turnStartSession = deriveTurnStartSession({
        threadId: event.payload.threadId,
        currentSession: thread.session,
        providerName,
        requestedRuntimeMode: event.payload.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        requestedAt: event.payload.createdAt,
      });
      if (turnStartSession !== null) {
        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: turnStartSession,
          createdAt: event.payload.createdAt,
        });
      }

      const resolvedAttachments = yield* resolveProviderDispatchAttachments({
        attachments: message.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
        repository: managedAttachments,
        threadId: event.payload.threadId,
        messageId: message.id,
        provider: providerName as ProviderKind,
        operation: "thread.turn.start",
      });

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        messageId: message.id,
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: resolvedAttachments } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        ...(event.payload.providerOptions !== undefined
          ? { providerOptions: event.payload.providerOptions }
          : {}),
      }).pipe(Effect.forkScoped);
      yield* maybeGenerateAndRenameThreadTitleForFirstTurn({
        threadId: event.payload.threadId,
        messageId: message.id,
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: resolvedAttachments } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        ...(event.payload.providerOptions !== undefined
          ? { providerOptions: event.payload.providerOptions }
          : {}),
      }).pipe(Effect.forkScoped);
      // Only a codex steer against a genuinely live turn keeps steer
      // semantics; anything else that reaches direct dispatch runs as a
      // normal queued turn (with its turn-start checkpoint).
      const immediateDispatchMode =
        event.payload.dispatchMode === "steer" && !isCodexSteer
          ? "queue"
          : event.payload.dispatchMode;
      const editResendKey = editResendTurnStartKey(event.payload.threadId, event.payload.messageId);

      const startedTurn = yield* dispatchTurnForThread({
        threadId: event.payload.threadId,
        messageId: message.id,
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: resolvedAttachments } : {}),
        ...(message.skills !== undefined ? { skills: message.skills } : {}),
        ...(message.mentions !== undefined ? { mentions: message.mentions } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        ...(event.payload.providerOptions !== undefined
          ? { providerOptions: event.payload.providerOptions }
          : {}),
        ...(event.payload.runtimeMode !== undefined
          ? { runtimeMode: event.payload.runtimeMode }
          : {}),
        ...(event.payload.reviewTarget !== undefined
          ? { reviewTarget: event.payload.reviewTarget }
          : {}),
        interactionMode: event.payload.interactionMode,
        dispatchMode: immediateDispatchMode,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const detail = Cause.pretty(cause);
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              detail,
              turnId: null,
              createdAt: event.payload.createdAt,
            });
            yield* setThreadSessionError({
              threadId: event.payload.threadId,
              runtimeMode: event.payload.runtimeMode,
              detail,
              createdAt: event.payload.createdAt,
            });
            // A direct start has no provider turn and therefore cannot emit a
            // terminal runtime event. Recover every queue sharing this
            // provider session now; otherwise follow-ups queued before the
            // failure remain stranded indefinitely (including child threads
            // multiplexed onto their parent's provider session).
            if (isPendingQueuedDispatch) {
              yield* clearPendingQueuedDispatch;
            }
            yield* drainQueuedTurnsForSession(event.payload.threadId);
            return yield* Effect.failCause(cause);
          }),
        ),
        Effect.ensuring(Effect.sync(() => editResendTurnStartKeys.delete(editResendKey))),
      );
      if (startedTurn && isPendingQueuedDispatch) {
        yield* bindPendingQueuedDispatchToTurn(startedTurn.turnId);
      }
    } finally {
      const reservation = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
      if (
        isPendingQueuedDispatch &&
        reservation !== undefined &&
        ownsReservation(reservation) &&
        reservation.releaseOnTurnId === undefined &&
        !(yield* hasQueuedTurnStart(event.payload.threadId, event.payload.messageId)) &&
        !(yield* hasLiveProviderTurn(event.payload.threadId))
      ) {
        yield* clearPendingQueuedDispatch;
        yield* drainQueuedTurnsForSession(event.payload.threadId);
      }
    }
  });

  const processTurnStartRequested = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) =>
    withProviderSessionLease(event.payload.threadId, processTurnStartRequestedWithoutLease(event));

  const processTurnQueued = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>,
  ) {
    yield* enqueueQueuedTurnStart(event);
    // Recovery drain: if the provider turn settled between the decider's
    // (stale) running check and this enqueue, the terminal
    // `turn.completed`/`turn.aborted` event has already been consumed and will
    // never drain this queue — the message would be stuck forever. Re-check
    // live provider state and promote immediately.
    if (!(yield* hasLiveProviderTurn(event.payload.threadId))) {
      yield* drainQueuedTurnsForThread(event.payload.threadId);
    }
  });

  const readOrchestrationEventAtSequence = (eventSequence: number) =>
    Stream.runCollect(
      orchestrationEngine.readEventsThrough(Math.max(0, eventSequence - 1), eventSequence),
    ).pipe(Effect.map((events) => Array.from(events)[0]));

  // Promote the next queued message only after the active provider turn settles.
  const drainQueuedTurnsForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const sessionThreadId = (yield* resolveProviderSessionThread(threadId))?.id ?? threadId;
    if (
      drainingQueuedTurns.has(threadId) ||
      pendingQueuedDispatchBySessionThread.has(sessionThreadId)
    ) {
      return;
    }
    drainingQueuedTurns.add(threadId);
    try {
      const claimed = yield* queuedTurnPromotions.claimNext({
        threadId,
        claimOwner: queuedTurnPromotionOwner,
        claimedAt: new Date().toISOString(),
        claimExpiresAt: new Date(Date.now() + PROVIDER_COMMAND_CLAIM_LEASE_MS).toISOString(),
      });
      if (Option.isNone(claimed)) {
        return;
      }
      const promotion = claimed.value;
      yield* Effect.gen(function* () {
        const sourceEvent = yield* readOrchestrationEventAtSequence(promotion.queuedEventSequence);
        if (
          sourceEvent === undefined ||
          (sourceEvent.type !== "thread.turn-queued" &&
            sourceEvent.type !== "thread.turn-start-requested")
        ) {
          return yield* Effect.fail(
            new Error(
              `Queued turn promotion ${promotion.queuedEventSequence} has no valid source event.`,
            ),
          );
        }
        const nextQueuedTurn = sourceEvent.payload;
        pendingQueuedDispatchBySessionThread.set(sessionThreadId, {
          queuedThreadId: threadId,
          messageId: nextQueuedTurn.messageId,
        });
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.dispatch-queued",
          commandId: CommandId.makeUnsafe(
            `server:dispatch-queued-turn:${promotion.queuedEventSequence}`,
          ),
          threadId,
          messageId: nextQueuedTurn.messageId,
          ...(nextQueuedTurn.modelSelection !== undefined
            ? { modelSelection: nextQueuedTurn.modelSelection }
            : {}),
          ...(nextQueuedTurn.providerOptions !== undefined
            ? { providerOptions: nextQueuedTurn.providerOptions }
            : {}),
          ...(nextQueuedTurn.reviewTarget !== undefined
            ? { reviewTarget: nextQueuedTurn.reviewTarget }
            : {}),
          ...(nextQueuedTurn.assistantDeliveryMode !== undefined
            ? { assistantDeliveryMode: nextQueuedTurn.assistantDeliveryMode }
            : {}),
          dispatchMode: nextQueuedTurn.dispatchMode,
          ...(nextQueuedTurn.dispatchOrigin !== undefined
            ? { dispatchOrigin: nextQueuedTurn.dispatchOrigin }
            : {}),
          runtimeMode: nextQueuedTurn.runtimeMode,
          interactionMode: nextQueuedTurn.interactionMode,
          ...(nextQueuedTurn.sourceProposedPlan !== undefined
            ? { sourceProposedPlan: nextQueuedTurn.sourceProposedPlan }
            : {}),
          createdAt: nextQueuedTurn.createdAt,
        });
        const promoted = yield* queuedTurnPromotions.markPromoted({
          queuedEventSequence: promotion.queuedEventSequence,
          claimOwner: queuedTurnPromotionOwner,
          promotedAt: new Date().toISOString(),
        });
        if (!promoted) {
          return yield* Effect.fail(
            new Error(
              `Queued turn promotion ${promotion.queuedEventSequence} lost claim ownership.`,
            ),
          );
        }
      }).pipe(
        Effect.onError(() =>
          Effect.all([
            Effect.sync(() => pendingQueuedDispatchBySessionThread.delete(sessionThreadId)),
            queuedTurnPromotions
              .releaseClaim({
                queuedEventSequence: promotion.queuedEventSequence,
                claimOwner: queuedTurnPromotionOwner,
                updatedAt: new Date().toISOString(),
              })
              .pipe(Effect.ignore),
          ]).pipe(Effect.asVoid),
        ),
      );
    } finally {
      drainingQueuedTurns.delete(threadId);
    }
  });

  const drainQueuedTurnsForSession = Effect.fnUntraced(function* (threadId: ThreadId) {
    const sessionThreadId = (yield* resolveProviderSessionThread(threadId))?.id ?? threadId;
    const queuedThreadIds = new Set<ThreadId>([threadId]);
    for (const queuedThreadId of yield* queuedTurnPromotions.listPendingThreadIds) {
      const queuedThread = ThreadId.makeUnsafe(queuedThreadId);
      const providerThread = yield* resolveProviderSessionThread(queuedThread);
      const queuedSessionThreadId = providerThread?.id ?? queuedThread;
      if (queuedSessionThreadId === sessionThreadId) {
        queuedThreadIds.add(queuedThread);
      }
    }
    for (const queuedThreadId of queuedThreadIds) {
      yield* drainQueuedTurnsForThread(queuedThreadId);
    }
  });

  const processQueueDrainEvent = Effect.fnUntraced(function* (event: ProviderQueueDrainEvent) {
    observePendingContextBootstrapTerminalEvent(event);
    const sessionThreadId =
      (yield* resolveProviderSessionThread(event.threadId))?.id ?? event.threadId;
    const reservation = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
    if (reservation) {
      if (event.turnId === undefined) {
        // Some adapters can only report that a stopped turn aborted, not the
        // provider turn id. Their live session state is authoritative and is
        // cleared before the terminal event is emitted. Keep the reservation
        // while a turn is genuinely live; otherwise release it so queued work
        // cannot remain stranded behind an id-less terminal event.
        if (yield* hasLiveProviderTurn(event.threadId)) {
          return;
        }
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
      } else if (reservation.releaseOnTurnId === undefined) {
        const terminalTurnIds = reservation.pendingTerminalTurnIds ?? new Set<TurnId>();
        terminalTurnIds.add(event.turnId);
        reservation.pendingTerminalTurnIds = terminalTurnIds;
        return;
      } else if (reservation.releaseOnTurnId !== event.turnId) {
        return;
      } else {
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
      }
    }
    // Child subagent threads queue under their own id but share the parent's
    // provider session, and terminal runtime events carry the session-owning
    // thread id — drain every queue bound to this session.
    yield* drainQueuedTurnsForSession(event.threadId);
  });

  const recoverQueuedTurnPromotions = Effect.gen(function* () {
    yield* Effect.forEach(yield* queuedTurnPromotions.listPendingThreadIds, (rawThreadId) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe(rawThreadId);
        // Resolve the projected thread first. `resolveThread` filters
        // `deleted_at IS NULL`, so a soft-deleted (or fully missing) thread
        // returns undefined; either way there is nothing to drain into, and the
        // pending promotions must be cancelled rather than promoted (otherwise a
        // deletion that raced startup would leave orphan turns to dispatch).
        const thread = yield* resolveThread(threadId);
        if (!thread || thread.deletedAt !== null) {
          yield* queuedTurnPromotions.cancelThread({
            threadId: rawThreadId,
            updatedAt: new Date().toISOString(),
          });
          return;
        }
        if (yield* hasLiveProviderTurn(threadId)) {
          return;
        }
        yield* drainQueuedTurnsForThread(threadId);
      }),
    );
  });

  const interruptProviderTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const providerThread = yield* resolveProviderSessionThread(input.threadId);
    if (!thread) {
      return;
    }

    const reportInterruptFailure = (detail: string, settlementStatus?: "uncertain") =>
      appendProviderFailureActivity({
        threadId: input.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail,
        turnId: input.turnId ?? null,
        createdAt: input.createdAt,
        ...(settlementStatus ? { settlementStatus } : {}),
      });

    if (!providerThread || !providerThread.session || providerThread.session.status === "stopped") {
      yield* reportInterruptFailure("No active provider session is bound to this thread.");
      // Nothing is left that could ever emit a terminal event for this turn.
      return yield* settleInterruptedProviderTurn({
        threadId: input.threadId,
        createdAt: input.createdAt,
      });
    }

    // Forward the observed turn only as an expectation. ProviderService owns the
    // exact generation-scoped provider turn and rejects a stale mismatch.
    const providerThreadId = resolveSubagentProviderThreadId(thread.id, providerThread.id);
    const turnId = input.turnId ?? thread.session?.activeTurnId ?? undefined;
    const result = yield* runBoundedProviderCall({
      label: "The provider interrupt",
      timeout: PROVIDER_COMMAND_INTERRUPT_TIMEOUT,
      call: providerService.interruptTurn({
        threadId: providerThread.id,
        ...(turnId ? { turnId } : {}),
        ...(providerThreadId ? { providerThreadId } : {}),
      }),
    });
    if (result._tag === "ok") {
      return;
    }

    // An interrupt that timed out or failed uncertainly is escalated to a full
    // session stop rather than propagated: propagating would quarantine the
    // thread, which suppresses every later side effect while still leaving the
    // turn running. The stop path always settles the projection.
    if (result._tag === "timeout" || result.outcome._tag === "uncertain") {
      const detail =
        result._tag === "timeout"
          ? `${result.detail} Stopping the provider session to settle the turn.`
          : `${result.outcome.detail}\nStopping the provider session to settle the turn.`;
      yield* reportInterruptFailure(detail, "uncertain");
      return yield* processThreadSessionStop({
        threadId: input.threadId,
        createdAt: input.createdAt,
      });
    }

    // Terminal rejections (validation and friends) would otherwise vanish
    // silently and leave the stop button looking dead; surface them on the
    // thread and settle locally, since the provider never accepted the request.
    if (result.outcome._tag === "rejected") {
      yield* reportInterruptFailure(result.outcome.detail);
      return yield* settleInterruptedProviderTurn({
        threadId: input.threadId,
        createdAt: input.createdAt,
      });
    }
    // Safe retries (persistence faults) keep propagating so the durable delivery
    // machinery can retry the whole command.
    return yield* Effect.failCause(result.cause);
  });

  const processTurnInterruptRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    yield* interruptProviderTurn({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      createdAt: event.payload.createdAt,
    });
  });

  const processTaskStopRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.task-stop-requested" }>,
  ) {
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    const hasSession = providerThread?.session && providerThread.session.status !== "stopped";
    if (!providerThread || !hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.task.stop.failed",
        summary: "Provider task stop failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
      });
    }

    yield* providerService
      .stopTask({
        threadId: providerThread.id,
        taskId: event.payload.taskId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.task.stop.failed",
            summary: "Provider task stop failed",
            detail: Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
      );
  });

  const processTaskBackgroundRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.task-background-requested" }>,
  ) {
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    const hasSession = providerThread?.session && providerThread.session.status !== "stopped";
    if (!providerThread || !hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.task.background.failed",
        summary: "Provider task background failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
      });
    }

    yield* providerService
      .backgroundTask({
        threadId: providerThread.id,
        toolUseId: event.payload.toolUseId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.task.background.failed",
            summary: "Provider task background failed",
            detail: Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
      );
  });

  const appendInteractionResponseFailure = (
    event: InteractionResponseEvent,
    input: {
      readonly interactionKind: "approval" | "userInput";
      readonly detail: string;
      readonly settlementStatus: "retryable" | "uncertain";
    },
  ) =>
    event.commandId === null
      ? Effect.void
      : appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind:
            input.interactionKind === "approval"
              ? "provider.approval.respond.failed"
              : "provider.user-input.respond.failed",
          summary:
            input.interactionKind === "approval"
              ? "Provider approval response failed"
              : "Provider user input response failed",
          detail: input.detail,
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
          responseCommandId: event.commandId,
          settlementStatus: input.settlementStatus,
          ...(event.payload.lifecycleGeneration === undefined
            ? {}
            : { lifecycleGeneration: event.payload.lifecycleGeneration }),
        });

  const claimInteractionResponse = Effect.fnUntraced(function* (input: {
    readonly event: InteractionResponseEvent;
    readonly interactionKind: "approval" | "userInput";
    readonly decision: Parameters<typeof pendingInteractions.claimResponse>[0]["decision"];
  }) {
    const { event } = input;
    if (event.commandId === null) return null;
    const claimed = yield* pendingInteractions.claimResponse({
      threadId: event.payload.threadId,
      interactionKind: input.interactionKind,
      requestId: event.payload.requestId,
      lifecycleGeneration: event.payload.lifecycleGeneration ?? null,
      responseCommandId: event.commandId,
      decision: input.decision,
      requestedAt: event.payload.createdAt,
    });
    const pending = yield* pendingInteractions.getByIdentity({
      threadId: event.payload.threadId,
      interactionKind: input.interactionKind,
      requestId: event.payload.requestId,
    });
    if (
      !claimed &&
      (Option.isNone(pending) ||
        pending.value.status !== "responding" ||
        pending.value.responseCommandId !== event.commandId)
    ) {
      return null;
    }
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (!providerThread) return null;
    if (providerThread.session?.status !== "stopped") return providerThread.id;
    yield* appendInteractionResponseFailure(event, {
      interactionKind: input.interactionKind,
      detail: "No active provider session is bound to this thread.",
      settlementStatus: "retryable",
    });
    return null;
  });

  const processApprovalResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const providerThreadId = yield* claimInteractionResponse({
      event,
      interactionKind: "approval",
      decision: event.payload.decision,
    });
    if (providerThreadId === null) return;

    yield* providerService
      .respondToRequest({
        threadId: providerThreadId,
        requestId: event.payload.requestId,
        ...(event.payload.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: event.payload.lifecycleGeneration }
          : {}),
        decision: event.payload.decision,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => {
          const unknownPendingRequest = isUnknownPendingApprovalRequestError(cause);
          return appendInteractionResponseFailure(event, {
            interactionKind: "approval",
            detail: unknownPendingRequest
              ? buildStalePendingRequestFailureDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            settlementStatus: interactionFailureSettlementStatus(cause, unknownPendingRequest),
          });
        }),
      );
  });

  const processUserInputResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
  ) {
    const providerThreadId = yield* claimInteractionResponse({
      event,
      interactionKind: "userInput",
      decision: null,
    });
    if (providerThreadId === null) return;

    yield* providerService
      .respondToUserInput({
        threadId: providerThreadId,
        requestId: event.payload.requestId,
        ...(event.payload.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: event.payload.lifecycleGeneration }
          : {}),
        answers: event.payload.answers,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => {
          const unknownPendingRequest = isUnknownPendingUserInputRequestError(cause);
          return appendInteractionResponseFailure(event, {
            interactionKind: "userInput",
            detail: unknownPendingRequest
              ? buildStalePendingRequestFailureDetail("user-input", event.payload.requestId)
              : Cause.pretty(cause),
            settlementStatus: interactionFailureSettlementStatus(cause, unknownPendingRequest),
          });
        }),
      );
  });

  const processConversationRollbackRequestedWithoutLease = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.conversation-rollback-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const removedTurnIds = thread
      ? collectTailTurnIds<TurnId>({
          messages: thread.messages,
          messageId: event.payload.messageId,
        })
      : [];
    if (!thread || removedTurnIds.length !== event.payload.numTurns) {
      return yield* Effect.fail(
        new Error(
          `Conversation rollback target '${event.payload.messageId}' is no longer valid for ${event.payload.numTurns} turn(s).`,
        ),
      );
    }
    if (event.payload.numTurns > 0) {
      const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
      if (
        thread &&
        providerThread?.session?.status === "running" &&
        providerThread.session.activeTurnId !== null
      ) {
        const providerThreadId = resolveSubagentProviderThreadId(thread.id, providerThread.id);
        yield* providerService.interruptTurn({
          threadId: providerThread.id,
          turnId: providerThread.session.activeTurnId,
          ...(providerThreadId ? { providerThreadId } : {}),
        });
      }

      yield* rollbackProviderConversationForEdit({
        threadId: event.payload.threadId,
        numTurns: event.payload.numTurns,
      });
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.conversation.rollback.complete",
      commandId: serverCommandId("conversation-rollback-complete"),
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      numTurns: event.payload.numTurns,
      removedTurnIds,
      createdAt: event.payload.createdAt,
    });
  });

  const processConversationRollbackRequested = (
    event: Extract<ProviderIntentEvent, { type: "thread.conversation-rollback-requested" }>,
  ) =>
    withProviderSessionLease(
      event.payload.threadId,
      processConversationRollbackRequestedWithoutLease(event),
    );

  const processMessageEditResendPayload = Effect.fnUntraced(function* (
    payload: Extract<
      ProviderIntentEvent,
      { type: "thread.message-edit-resend-requested" }
    >["payload"],
    options?: {
      readonly skipProviderRollback?: boolean;
      readonly preserveQueuedTurns?: boolean;
      readonly preserveThreadSession?: boolean;
      readonly activeTurnId?: TurnId | null;
    },
  ) {
    if (options?.preserveQueuedTurns !== true) {
      yield* queuedTurnPromotions.cancelThread({
        threadId: payload.threadId,
        updatedAt: payload.createdAt,
      });
      yield* clearEditResendTurnStartKeysForThread(payload.threadId);
    } else {
      yield* queuedTurnPromotions.cancelMessage({
        threadId: payload.threadId,
        messageId: payload.messageId,
        updatedAt: new Date().toISOString(),
      });
    }
    const originalThread = yield* resolveThread(payload.threadId);
    const originalMessage = originalThread?.messages.find(
      (message) => message.id === payload.messageId,
    );
    if (!originalThread || !originalMessage || originalMessage.role !== "user") {
      return yield* Effect.fail(
        new Error(`Cannot edit missing user message '${payload.messageId}'.`),
      );
    }
    const editTarget =
      payload.removedTurnIds !== undefined && payload.rollbackTurnCount !== undefined
        ? {
            editable: true as const,
            messageId: payload.messageId,
            messageIndex: originalThread.messages.findIndex(
              (message) => message.id === payload.messageId,
            ),
            mode: payload.rollbackTurnCount > 0 ? ("rollback" as const) : ("active" as const),
            rollbackTurnCount: payload.rollbackTurnCount,
            removedTurnIds: payload.removedTurnIds,
          }
        : resolveTailUserMessageEditTarget({
            messages: originalThread.messages,
            messageId: payload.messageId,
            activeTurnId:
              options?.activeTurnId ??
              (originalThread.session?.status === "running"
                ? (originalThread.session.activeTurnId ?? null)
                : null),
          });
    if (!editTarget.editable) {
      return yield* Effect.fail(
        new Error(
          `Cannot edit non-tail user message '${payload.messageId}': ${editTarget.reason}.`,
        ),
      );
    }
    // Validate the workspace restore before the provider conversation rollback:
    // once the provider trims its conversation there is no undo, so a missing
    // checkpoint must refuse the edit replay while nothing has happened yet.
    const workspaceRestorePlan = yield* planWorkspaceRestoreForEditReplay({
      threadId: payload.threadId,
      removedTurnIds: editTarget.removedTurnIds.map((turnId) => TurnId.makeUnsafe(turnId)),
    });
    if (options?.skipProviderRollback !== true && editTarget.rollbackTurnCount > 0) {
      yield* rollbackProviderConversationForEdit({
        threadId: payload.threadId,
        numTurns: editTarget.rollbackTurnCount,
      });
    }
    yield* executeEditReplayWorkspaceRestore(workspaceRestorePlan);
    yield* orchestrationEngine.dispatch({
      type: "thread.conversation.rollback.complete",
      commandId: serverCommandId("message-edit-rollback-complete"),
      threadId: payload.threadId,
      messageId: payload.messageId,
      numTurns: editTarget.rollbackTurnCount,
      removedTurnIds: editTarget.removedTurnIds.map((turnId) => TurnId.makeUnsafe(turnId)),
      skipAttachmentPrune: true,
      createdAt: payload.createdAt,
    });

    const thread = yield* resolveThread(payload.threadId);
    if (thread && options?.preserveThreadSession !== true) {
      yield* setThreadSession({
        threadId: payload.threadId,
        session: {
          threadId: payload.threadId,
          status: "starting",
          providerName: thread.session?.providerName ?? thread.modelSelection.provider,
          runtimeMode: payload.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: payload.createdAt,
        },
        createdAt: payload.createdAt,
      });
    }

    editResendTurnStartKeys.add(editResendTurnStartKey(payload.threadId, payload.messageId));
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("message-edit-resend-turn-start"),
      threadId: payload.threadId,
      message: {
        messageId: payload.messageId,
        role: "user",
        text: payload.text,
        attachments: originalMessage.attachments ?? [],
        ...(originalMessage.skills !== undefined ? { skills: originalMessage.skills } : {}),
        ...(originalMessage.mentions !== undefined ? { mentions: originalMessage.mentions } : {}),
      },
      ...(payload.modelSelection !== undefined ? { modelSelection: payload.modelSelection } : {}),
      ...(payload.providerOptions !== undefined
        ? { providerOptions: payload.providerOptions }
        : {}),
      ...(payload.assistantDeliveryMode !== undefined
        ? { assistantDeliveryMode: payload.assistantDeliveryMode }
        : {}),
      dispatchMode: "queue",
      runtimeMode: payload.runtimeMode,
      interactionMode: payload.interactionMode,
      createdAt: payload.createdAt,
    });
  });

  const stopActiveProviderRuntimeForEdit = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const provider = thread
      ? Schema.is(ProviderKind)(thread.session?.providerName)
        ? thread.session?.providerName
        : thread.modelSelection.provider
      : undefined;
    const rebuildsContext =
      provider !== undefined &&
      (yield* providerService.getCapabilities(provider)).conversationRollback === "restart-session";
    if (rebuildsContext && providerService.clearSessionResumeCursor) {
      yield* providerService.clearSessionResumeCursor({ threadId: input.threadId });
      rollbackContextBootstrapThreadIds.add(input.threadId);
      return;
    }
    if (providerService.stopRuntimeSession) {
      yield* providerService.stopRuntimeSession({ threadId: input.threadId });
      return;
    }
    yield* providerService.stopSession({ threadId: input.threadId });
  });

  const processMessageEditResendRequestedWithoutLease = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.message-edit-resend-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    const activeTurnId =
      providerThread?.session?.status === "running"
        ? (providerThread.session.activeTurnId ?? null)
        : null;
    const isQueuedMessageEdit = yield* queuedTurnPromotions.hasPendingMessage({
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
    });
    if (thread && !isQueuedMessageEdit) {
      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          threadId: event.payload.threadId,
          status: "starting",
          providerName: thread.session?.providerName ?? thread.modelSelection.provider,
          runtimeMode: event.payload.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
    }
    if (
      thread &&
      providerThread?.session?.status === "running" &&
      providerThread.session.activeTurnId !== null &&
      !isQueuedMessageEdit
    ) {
      // Edits should replay from the last stable cursor, not wait for each
      // provider's interrupt lifecycle to settle.
      yield* stopActiveProviderRuntimeForEdit({ threadId: providerThread.id });
      yield* processMessageEditResendPayload(event.payload, {
        skipProviderRollback: true,
        activeTurnId,
      });
      return;
    }

    yield* processMessageEditResendPayload(event.payload, {
      ...(isQueuedMessageEdit ? { skipProviderRollback: true } : {}),
      preserveQueuedTurns: isQueuedMessageEdit,
      preserveThreadSession: isQueuedMessageEdit,
      activeTurnId,
    });
  });

  const processMessageEditResendRequested = (
    event: Extract<ProviderIntentEvent, { type: "thread.message-edit-resend-requested" }>,
  ) =>
    withProviderSessionLease(
      event.payload.threadId,
      processMessageEditResendRequestedWithoutLease(event),
    );

  const processThreadSessionStop = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const providerThread = yield* resolveProviderSessionThread(input.threadId);
    if (!thread) {
      return;
    }

    const stoppedSessionThreadId = providerThread?.id ?? thread.id;
    const stopsProviderSession = providerThread === null || providerThread.id === thread.id;
    const clearedQueuedThreadIds = new Set<ThreadId>([thread.id]);
    if (stopsProviderSession) {
      for (const queuedThreadId of yield* queuedTurnPromotions.listPendingThreadIds) {
        const queuedThread = ThreadId.makeUnsafe(queuedThreadId);
        const queuedProviderThread = yield* resolveProviderSessionThread(queuedThread);
        if ((queuedProviderThread?.id ?? queuedThread) === stoppedSessionThreadId) {
          clearedQueuedThreadIds.add(queuedThread);
        }
      }
    }
    for (const queuedThreadId of clearedQueuedThreadIds) {
      yield* queuedTurnPromotions.cancelThread({
        threadId: queuedThreadId,
        updatedAt: input.createdAt,
      });
      yield* clearEditResendTurnStartKeysForThread(queuedThreadId);
      drainingQueuedTurns.delete(queuedThreadId);
    }
    // Reservations are keyed by session-owning thread but may belong to a
    // stopping child's queued message. A provider-session stop clears every
    // reservation for that session; a child-only interrupt clears its own.
    for (const [sessionThreadId, reservation] of pendingQueuedDispatchBySessionThread) {
      if (
        (stopsProviderSession && sessionThreadId === stoppedSessionThreadId) ||
        clearedQueuedThreadIds.has(ThreadId.makeUnsafe(reservation.queuedThreadId))
      ) {
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
      }
    }
    clearPendingContextBootstraps(thread.id);
    suppressContextBootstrapOnNextStartThreadIds.add(thread.id);

    const providerThreadId =
      providerThread !== null
        ? resolveSubagentProviderThreadId(thread.id, providerThread.id)
        : undefined;
    const isChildProviderRuntime =
      providerThread !== null && providerThread.id !== thread.id && providerThreadId !== undefined;

    // Child subagents share the parent provider session, so stop requests need
    // to interrupt the child turn rather than terminate the whole session.
    if (
      isChildProviderRuntime &&
      thread.session &&
      thread.session.status === "running" &&
      thread.session.activeTurnId !== null &&
      providerThread.session &&
      providerThread.session.status !== "stopped"
    ) {
      const childInterrupt = yield* runBoundedProviderCall({
        label: "The provider interrupt",
        timeout: PROVIDER_COMMAND_INTERRUPT_TIMEOUT,
        call: providerService.interruptTurn({
          threadId: providerThread.id,
          turnId: thread.session.activeTurnId,
          providerThreadId,
        }),
      });
      if (childInterrupt._tag !== "ok") {
        const detail =
          childInterrupt._tag === "timeout" ? childInterrupt.detail : childInterrupt.outcome.detail;
        yield* appendProviderFailureActivity({
          threadId: thread.id,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: thread.session.activeTurnId,
          createdAt: input.createdAt,
          settlementStatus: "uncertain",
        });
        // The parent session was never told to end this child turn, so no
        // terminal child event is coming: settle instead of waiting for one.
        yield* settleInterruptedProviderTurn({
          threadId: thread.id,
          createdAt: input.createdAt,
        });
        return;
      }

      yield* setThreadSession({
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "interrupted",
          providerName: thread.session.providerName ?? null,
          runtimeMode: thread.session.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          // Preserve the active turn until the provider emits the terminal child event.
          activeTurnId: thread.session.activeTurnId,
          lastError: null,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      return;
    }

    const ownsProviderSession = providerThread !== null && providerThread.id === thread.id;
    if (thread.session && thread.session.status !== "stopped" && ownsProviderSession) {
      // A stop that cannot finish must still settle the projection: the session
      // row below is the only thing that releases the turn in the UI.
      const stopped = yield* runBoundedProviderCall({
        label: "The provider session stop",
        timeout: PROVIDER_COMMAND_STOP_TIMEOUT,
        call: providerService.stopSession({ threadId: providerThread.id }),
      });
      if (stopped._tag !== "ok") {
        yield* appendProviderFailureActivity({
          threadId: thread.id,
          kind: "provider.session.stop.failed",
          summary: "Provider session stop failed",
          detail: stopped._tag === "timeout" ? stopped.detail : stopped.outcome.detail,
          turnId: null,
          createdAt: input.createdAt,
          settlementStatus: "uncertain",
        });
      }
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const processSessionStopRequested = (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) =>
    processThreadSessionStop({
      threadId: event.payload.threadId,
      createdAt: event.payload.createdAt,
    });

  const processDomainEvent = (event: ProviderIntentEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.session-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (
            thread &&
            event.payload.session.status !== "stopped" &&
            !threadSessionModelSelections.has(event.payload.threadId)
          ) {
            threadSessionModelSelections.set(event.payload.threadId, thread.modelSelection);
          }
          return;
        }
        case "thread.created":
          threadSessionModelSelections.set(event.payload.threadId, event.payload.modelSelection);
          return;
        case "thread.deleted":
          // Cancel any queued/promoting turns for the deleted thread BEFORE
          // clearing runtime caches so a concurrent drain cannot resurrect them
          // (see cancelThread). Best-effort: the event stays unclaimed either way.
          yield* queuedTurnPromotions.cancelThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.deletedAt,
          });
          yield* clearThreadRuntimeCaches(event.payload.threadId);
          return;
        case "thread.archived":
          // Archive cleanup shares this durable, sequence-ordered provider
          // source with later turn-start intents. An immediate unarchive/send
          // therefore cannot race an older archive stop against the new turn.
          yield* processThreadSessionStop({
            threadId: event.payload.threadId,
            // Legacy thread.archived events may omit archivedAt; fall back like the projector.
            createdAt: event.payload.archivedAt ?? event.payload.updatedAt ?? event.occurredAt,
          });
          return;
        case "thread.meta-updated": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (event.payload.modelSelection === undefined) {
            return;
          }

          if (!thread?.session || thread.session.status === "stopped") {
            threadSessionModelSelections.set(event.payload.threadId, event.payload.modelSelection);
            return;
          }

          if (thread.session.activeTurnId !== null) {
            // The current runtime still owns the previous spawn profile. The
            // projected thread now carries the desired selection; compare them
            // when the next turn ensures the session.
            return;
          }

          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            modelSelection: event.payload.modelSelection,
            ...(cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : {}),
          });
          threadSessionModelSelections.set(event.payload.threadId, event.payload.modelSelection);
          return;
        }
        case "thread.runtime-mode-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            ...(cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : {}),
            modelSelection: thread.modelSelection,
            runtimeMode: event.payload.runtimeMode,
          });
          return;
        }
        case "thread.turn-queued":
          yield* processTurnQueued(event);
          return;
        case "thread.turn-start-requested":
          yield* processTurnStartRequested(event);
          return;
        case "thread.turn-interrupt-requested":
          yield* processTurnInterruptRequested(event);
          return;
        case "thread.task-stop-requested":
          yield* processTaskStopRequested(event);
          return;
        case "thread.task-background-requested":
          yield* processTaskBackgroundRequested(event);
          return;
        case "thread.approval-response-requested":
          yield* processApprovalResponseRequested(event);
          return;
        case "thread.user-input-response-requested":
          yield* processUserInputResponseRequested(event);
          return;
        case "thread.conversation-rollback-requested":
          yield* processConversationRollbackRequested(event);
          return;
        case "thread.message-edit-resend-requested":
          yield* processMessageEditResendRequested(event).pipe(
            Effect.catchCause((cause) =>
              setThreadSessionError({
                threadId: event.payload.threadId,
                runtimeMode: event.payload.runtimeMode,
                detail: Cause.pretty(cause),
                createdAt: event.payload.createdAt,
              }).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          );
          return;
        case "thread.session-stop-requested":
          yield* processSessionStopRequested(event);
          return;
      }
    });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.timeoutOption(PROVIDER_COMMAND_EVENT_TIMEOUT),
      Effect.flatMap((completed) =>
        Option.isSome(completed)
          ? Effect.void
          : Effect.logError("provider command reactor timed out processing event", {
              eventType: event.type,
              eventSequence: event.sequence,
              threadId: event.payload.threadId,
              timeoutMs: Duration.toMillis(PROVIDER_COMMAND_EVENT_TIMEOUT),
            }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const processQueueDrainEventSafely = (event: ProviderQueueDrainEvent) =>
    processQueueDrainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to drain queued turn", {
          eventType: event.type,
          threadId: event.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  // One attach-before-replay source owns every provider intent. The claimed
  // canary classes settle before cursor advancement. Remaining classes execute
  // serially in the same source but do not acquire delivery claims yet.
  const startProviderIntentSource = Effect.gen(function* () {
    const liveEventSource = yield* orchestrationEngine.subscribeDomainEvents;
    // Detach the engine from this reactor's processing latency. The engine
    // publishes committed events into a bounded PubSub from an uninterruptible
    // section of its single command worker, so a subscriber that stalls (a hung
    // provider call, or just slow boot replay below) back-pressures the worker
    // and then fails every dispatched command with a dispatch timeout. Draining
    // into an unbounded queue immediately after subscribing keeps the engine
    // free while boot work runs; ordering is preserved because the queue is FIFO
    // and `processOrderedEvent` skips anything at or below the durable cursor.
    const liveEventQueue = yield* Queue.unbounded<OrchestrationEvent, Cause.Done>();
    yield* Stream.runIntoQueue(liveEventSource, liveEventQueue).pipe(Effect.forkScoped);
    const liveEvents = Stream.fromQueue(liveEventQueue);
    const consumerState = yield* deliveryRepository.getConsumerState(
      PROVIDER_COMMAND_REACTOR_CONSUMER,
    );
    if (Option.isNone(consumerState)) {
      return yield* Effect.die(
        new Error(`Missing durable consumer state for ${PROVIDER_COMMAND_REACTOR_CONSUMER}`),
      );
    }

    const processOwner = `provider-command-reactor:${crypto.randomUUID()}`;
    let cursor = consumerState.value.lastAckedSequence;
    const refreshCursor = Effect.gen(function* () {
      const state = yield* deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER);
      if (Option.isSome(state)) cursor = state.value.lastAckedSequence;
    });

    const advanceCursor = Effect.fnUntraced(function* (event: OrchestrationEvent) {
      const advanced = yield* deliveryRepository.advanceCursor({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: event.sequence,
        updatedAt: new Date().toISOString(),
      });
      if (advanced) cursor = event.sequence;
      return advanced;
    });

    const requireCursorAdvance = Effect.fnUntraced(function* (event: OrchestrationEvent) {
      if (yield* advanceCursor(event)) return;
      yield* refreshCursor;
      if (cursor < event.sequence) {
        return yield* Effect.die(
          new Error(`Provider command cursor could not advance through event ${event.sequence}`),
        );
      }
    });

    const isThreadQuarantined = Effect.fnUntraced(function* (threadId: string) {
      if (quarantinedThreads.has(threadId)) return true;
      const blocker = yield* deliveryRepository.firstBlockingDeliveryForThread({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        threadId,
      });
      if (Option.isNone(blocker)) return false;
      quarantinedThreads.add(threadId);
      return true;
    });

    const settleTerminalFailure = Effect.fnUntraced(function* (input: {
      readonly event: ProviderIntentEvent;
      readonly claimOwner: string;
      readonly state: "dead" | "uncertain";
      readonly detail: string;
    }) {
      yield* Effect.logError("provider command delivery entered terminal failure", {
        eventType: input.event.type,
        eventSequence: input.event.sequence,
        threadId: input.event.payload.threadId,
        state: input.state,
        detail: input.detail,
      });
      const settled = yield* deliveryRepository.markTerminalFailure({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: input.event.sequence,
        expectedClaimOwner: input.claimOwner,
        state: input.state,
        error: input.detail,
        updatedAt: new Date().toISOString(),
      });
      if (!settled) {
        return yield* Effect.die(
          new Error(
            `Provider command delivery ${input.event.sequence} lost terminal settlement ownership`,
          ),
        );
      }
      quarantinedThreads.add(input.event.payload.threadId);
      yield* requireCursorAdvance(input.event);
    });

    const skipQuarantinedSideEffect = Effect.fnUntraced(function* (event: ProviderIntentEvent) {
      if (
        !isProviderSideEffectIntent(event) ||
        // An interrupt is the escape hatch out of a quarantined thread; skipping
        // it leaves the turn running with nothing left that could settle it.
        isQuarantineExemptProviderIntent(event) ||
        !(yield* isThreadQuarantined(event.payload.threadId))
      ) {
        return false;
      }
      yield* Effect.logWarning("provider command skipped for quarantined thread", {
        eventType: event.type,
        eventSequence: event.sequence,
        threadId: event.payload.threadId,
      });
      // A skipped turn start is a user-visible dead end: the projector has
      // already shown the thread as "starting", so silence here reads as an
      // infinite "Thinking". Surface the block and settle the session.
      if (
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.message-edit-resend-requested"
      ) {
        yield* Effect.gen(function* () {
          const blocker = yield* deliveryRepository.firstBlockingDeliveryForThread({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            threadId: event.payload.threadId,
          });
          const blockerDetail =
            Option.isSome(blocker) && blocker.value.lastError !== null
              ? blocker.value.lastError
              : "an earlier provider command failed";
          const createdAt = new Date().toISOString();
          yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: PROVIDER_DELIVERY_BLOCK_SUMMARY,
            detail: `The message was not sent to the provider. Blocking failure: ${blockerDetail}`,
            turnId: null,
            createdAt,
          });
          yield* setThreadSessionError({
            threadId: event.payload.threadId,
            detail: formatProviderDeliveryBlockDetail(blockerDetail),
            createdAt,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to surface quarantined-thread skip", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
      yield* requireCursorAdvance(event);
      return true;
    });

    const processClaimedProviderIntent = Effect.fnUntraced(function* (event: ProviderIntentEvent) {
      const threadId = event.payload.threadId;
      if (yield* skipQuarantinedSideEffect(event)) return;

      const existing = yield* deliveryRepository.getDelivery({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: event.sequence,
      });
      if (Option.isSome(existing)) {
        if (existing.value.state === "succeeded") {
          yield* requireCursorAdvance(event);
          return;
        }
        if (existing.value.state === "dead" || existing.value.state === "uncertain") {
          quarantinedThreads.add(threadId);
          yield* requireCursorAdvance(event);
          return;
        }
        if (existing.value.state === "inflight") {
          const expiresAt = Date.parse(existing.value.claimExpiresAt ?? "");
          const remainingMs = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : 0;
          if (remainingMs > 0) {
            yield* Effect.sleep(Duration.millis(remainingMs));
          }
          const expiredOwner = existing.value.claimOwner ?? "";
          if (!isReplaySafeClaimedProviderIntent(event)) {
            yield* settleTerminalFailure({
              event,
              claimOwner: expiredOwner,
              state: "uncertain",
              detail:
                "External provider command claim expired without a durable acceptance result; execution was not replayed.",
            });
            return;
          }
          const requeued = yield* deliveryRepository.requeueExpired({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: event.sequence,
            expectedClaimOwner: expiredOwner,
            now: new Date().toISOString(),
            error: "Replay-safe provider command claim expired before settlement.",
          });
          if (!requeued) {
            return yield* Effect.die(
              new Error(
                `Replay-safe provider command delivery ${event.sequence} could not be requeued`,
              ),
            );
          }
        }
      }

      while (true) {
        const claimOwner = `${processOwner}:${event.sequence}`;
        const claimed = yield* deliveryRepository.claim({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: event.sequence,
          threadId,
          claimOwner,
          claimedAt: new Date().toISOString(),
          claimExpiresAt: new Date(Date.now() + PROVIDER_COMMAND_CLAIM_LEASE_MS).toISOString(),
        });
        if (Option.isNone(claimed)) {
          return yield* Effect.die(
            new Error(`Provider command delivery ${event.sequence} could not be claimed`),
          );
        }

        const workerResult = yield* runBoundedProviderCall({
          label: `The provider command '${event.type}'`,
          timeout: PROVIDER_COMMAND_EVENT_TIMEOUT,
          call: processDomainEvent(event),
        });
        if (workerResult._tag === "timeout") {
          // The delivery lock is single-permit and process-wide, so an attempt
          // that never returns is a total outage. Settle it as uncertain and
          // let the thread quarantine rather than block every other thread.
          yield* settleTerminalFailure({
            event,
            claimOwner,
            state: "uncertain",
            detail: workerResult.detail,
          });
          return;
        }
        const outcome: ProviderAttemptOutcome =
          workerResult._tag === "ok" ? { _tag: "accepted" } : workerResult.outcome;

        switch (outcome._tag) {
          case "accepted":
          case "rejected": {
            if (outcome._tag === "rejected") {
              yield* Effect.logWarning("provider command was rejected before acceptance", {
                eventType: event.type,
                eventSequence: event.sequence,
                threadId,
                detail: outcome.detail,
              });
            }
            const completed = yield* deliveryRepository.complete({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: event.sequence,
              claimOwner,
              completedAt: new Date().toISOString(),
            });
            if (!completed) {
              return yield* Effect.die(
                new Error(`Provider command delivery ${event.sequence} lost settlement ownership`),
              );
            }
            yield* refreshCursor;
            return;
          }
          case "safe_retry": {
            if (claimed.value.attemptCount >= PROVIDER_COMMAND_SAFE_RETRY_LIMIT) {
              yield* settleTerminalFailure({
                event,
                claimOwner,
                state: "dead",
                detail: `Safe retry budget exhausted. ${outcome.detail}`,
              });
              return;
            }
            const retryable = yield* deliveryRepository.markRetryable({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: event.sequence,
              expectedClaimOwner: claimOwner,
              error: outcome.detail,
              updatedAt: new Date().toISOString(),
            });
            if (!retryable) {
              return yield* Effect.die(
                new Error(`Provider command delivery ${event.sequence} lost retry ownership`),
              );
            }
            yield* Effect.sleep(PROVIDER_COMMAND_SAFE_RETRY_DELAY);
            break;
          }
          case "uncertain":
            yield* settleTerminalFailure({
              event,
              claimOwner,
              state: "uncertain",
              detail: outcome.detail,
            });
            return;
        }
      }
    });

    const processUnclaimedProviderIntent = Effect.fnUntraced(function* (
      event: ProviderIntentEvent,
    ) {
      if (yield* skipQuarantinedSideEffect(event)) return;
      yield* processDomainEventSafely(event);
      yield* requireCursorAdvance(event);
    });

    const processOrderedEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
      if (event.sequence <= cursor) return;
      if (!isProviderIntentEvent(event)) {
        yield* requireCursorAdvance(event);
        return;
      }
      if (isClaimedProviderIntent(event)) {
        yield* processClaimedProviderIntent(event);
        return;
      }
      yield* processUnclaimedProviderIntent(event);
    });

    const readProviderIntentEvent = Effect.fnUntraced(function* (eventSequence: number) {
      const event = yield* readOrchestrationEventAtSequence(eventSequence);
      if (
        event === undefined ||
        event.sequence !== eventSequence ||
        !isProviderIntentEvent(event)
      ) {
        return yield* Effect.die(
          new Error(
            `Provider delivery ${eventSequence} has no matching provider-intent source event`,
          ),
        );
      }
      return event;
    });

    const replayQuarantinedThreadSideEffects = Effect.fnUntraced(function* (input: {
      readonly threadId: string;
      readonly afterSequence: number;
    }) {
      const replayThrough = cursor;
      if (replayThrough <= input.afterSequence) return;
      yield* Stream.runForEach(
        orchestrationEngine.readEventsThrough(input.afterSequence, replayThrough),
        (event) => {
          if (
            !isProviderIntentEvent(event) ||
            event.payload.threadId !== input.threadId ||
            !isProviderSideEffectIntent(event)
          ) {
            return Effect.void;
          }
          return isClaimedProviderIntent(event)
            ? processClaimedProviderIntent(event)
            : processUnclaimedProviderIntent(event);
        },
      );
    });

    const resumeRetryableDelivery = Effect.fnUntraced(function* (input: {
      readonly eventSequence: number;
      readonly threadId: string;
    }) {
      quarantinedThreads.delete(input.threadId);
      const event = yield* readProviderIntentEvent(input.eventSequence);
      if (!isClaimedProviderIntent(event)) {
        return yield* Effect.die(
          new Error(
            `Provider delivery ${input.eventSequence} does not own a claimed provider intent`,
          ),
        );
      }
      yield* processClaimedProviderIntent(event);
      const delivery = yield* deliveryRepository.getDelivery({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: input.eventSequence,
      });
      if (Option.isSome(delivery) && delivery.value.state === "succeeded") {
        quarantinedThreads.delete(input.threadId);
        yield* replayQuarantinedThreadSideEffects({
          threadId: input.threadId,
          afterSequence: input.eventSequence,
        });
      }
    });

    reconcileDeliveryRuntime = (input) =>
      Effect.scoped(
        deliverySourceLock.withPermits(1)(
          Effect.gen(function* () {
            const reconciledAt = new Date().toISOString();
            const reconciled = yield* deliveryRepository.reconcile({
              reconciliationId: crypto.randomUUID(),
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: input.eventSequence,
              threadId: input.threadId,
              expectedState: input.expectedState,
              outcome: input.outcome,
              reconciledBy: input.reconciledBy,
              ...(input.note === undefined ? {} : { note: input.note }),
              reconciledAt,
            });
            if (Option.isNone(reconciled)) return null;

            if (input.outcome === "safe_retry") {
              yield* resumeRetryableDelivery(input);
            } else {
              quarantinedThreads.delete(input.threadId);
              yield* replayQuarantinedThreadSideEffects({
                threadId: input.threadId,
                afterSequence: input.eventSequence,
              });
            }

            const finalDelivery = yield* deliveryRepository.getDelivery({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: input.eventSequence,
            });
            if (Option.isNone(finalDelivery) || finalDelivery.value.state === "inflight") {
              return yield* Effect.die(
                new Error(
                  `Provider delivery ${input.eventSequence} did not reach a reconciled state`,
                ),
              );
            }
            return {
              eventSequence: input.eventSequence,
              threadId: input.threadId,
              outcome: input.outcome,
              state: finalDelivery.value.state,
              reconciledAt,
            };
          }),
        ),
      ) as ReturnType<ProviderCommandReactorShape["reconcileDelivery"]>;

    const countSkippedPrompts = (input: {
      readonly threadId: ThreadId;
      readonly afterSequence: number;
    }) => {
      if (cursor <= input.afterSequence) return Effect.succeed(0);
      return orchestrationEngine.readEventsThrough(input.afterSequence, cursor).pipe(
        Stream.runFold(
          () => 0,
          (count: number, event) =>
            isProviderIntentEvent(event) &&
            event.payload.threadId === input.threadId &&
            (event.type === "thread.turn-start-requested" ||
              event.type === "thread.message-edit-resend-requested")
              ? count + 1
              : count,
        ),
      );
    };

    // Self-heal only legacy quarantines whose recorded details prove the
    // command frame was never written. Exit-unproven process failures remain
    // quarantined because the old provider may still be running.
    // Skipped prompts are not replayed at startup; instead, surface a durable
    // activity asking the user to resend them.
    const startupRecoveryNotifiedThreads = new Set<ThreadId>();
    yield* Effect.gen(function* () {
      const pageSize = 100;
      let afterEventSequence: number | undefined;
      while (true) {
        const startupBlockers = yield* deliveryRepository.listBlockingDeliveries({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          ...(afterEventSequence === undefined ? {} : { afterEventSequence }),
          limit: pageSize,
        });
        for (const blocker of startupBlockers) {
          if (!isSafeLegacyProviderBlocker(blocker.lastError)) continue;
          const reconciled = yield* deliveryRepository.reconcile({
            reconciliationId: crypto.randomUUID(),
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: blocker.eventSequence,
            threadId: blocker.threadId,
            expectedState: blocker.state,
            outcome: "abandon",
            reconciledBy: "system:provider-command-reactor",
            note: "Recorded failure proves the provider never executed this command; settled at startup.",
            reconciledAt: new Date().toISOString(),
          });
          if (Option.isNone(reconciled)) continue;

          quarantinedThreads.delete(blocker.threadId);
          if (!startupRecoveryNotifiedThreads.has(blocker.threadId)) {
            const skippedPromptCount = yield* countSkippedPrompts({
              threadId: blocker.threadId,
              afterSequence: blocker.eventSequence,
            });
            if (skippedPromptCount > 0) {
              const noun = skippedPromptCount === 1 ? "message was" : "messages were";
              const createdAt = new Date().toISOString();
              yield* appendProviderFailureActivity({
                threadId: blocker.threadId,
                kind: "provider.turn.start.failed",
                summary: "Previous messages were not sent",
                detail: `Synara recovered an earlier provider failure, but ${skippedPromptCount} ${noun} skipped while the thread was blocked. Resend ${skippedPromptCount === 1 ? "it" : "them"} to continue.`,
                turnId: null,
                createdAt,
              });
              startupRecoveryNotifiedThreads.add(blocker.threadId);
            }
          }
          yield* Effect.logInfo("provider delivery blocker auto-healed at startup", {
            eventSequence: blocker.eventSequence,
            threadId: blocker.threadId,
            lastError: blocker.lastError,
          });
        }
        if (startupBlockers.length < pageSize) break;
        afterEventSequence = startupBlockers[startupBlockers.length - 1]?.eventSequence;
        if (afterEventSequence === undefined) break;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider delivery blocker auto-heal failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    const retryableDeliveries = yield* deliveryRepository.listRetryableDeliveries(
      PROVIDER_COMMAND_REACTOR_CONSUMER,
    );
    yield* deliverySourceLock.withPermits(1)(
      Effect.forEach(retryableDeliveries, resumeRetryableDelivery, { discard: true }),
    );

    const processOrderedEventSerially = (event: OrchestrationEvent) =>
      deliverySourceLock.withPermits(1)(processOrderedEvent(event));

    const replayThrough = yield* orchestrationEngine.getEventHighWaterSequence;
    yield* Stream.runForEach(
      orchestrationEngine.readEventsThrough(cursor, replayThrough),
      processOrderedEventSerially,
    );
    yield* Stream.runForEach(liveEvents, processOrderedEventSerially).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("provider command durable source stopped", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
      Effect.forkScoped,
    );
  });

  const start = seedThreadModelSelections.pipe(
    Effect.andThen(
      Effect.all([
        startProviderIntentSource.pipe(Effect.andThen(recoverQueuedTurnPromotions)),
        Stream.runForEach(providerService.streamEvents, (event) => {
          if (event.type !== "turn.completed" && event.type !== "turn.aborted") {
            return Effect.void;
          }
          return processQueueDrainEventSafely(event);
        }).pipe(Effect.forkScoped),
      ]).pipe(Effect.asVoid),
    ),
    Effect.orDie,
  ) as ProviderCommandReactorShape["start"];

  const drain: ProviderCommandReactorShape["drain"] = Effect.gen(function* () {
    const targetSequence = yield* orchestrationEngine.getEventHighWaterSequence;
    while (true) {
      const consumerState = yield* deliveryRepository.getConsumerState(
        PROVIDER_COMMAND_REACTOR_CONSUMER,
      );
      if (Option.isSome(consumerState) && consumerState.value.lastAckedSequence >= targetSequence) {
        return;
      }
      yield* Effect.sleep(Duration.millis(5));
    }
  }).pipe(Effect.orDie);

  const listBlockingDeliveries: ProviderCommandReactorShape["listBlockingDeliveries"] = (input) =>
    deliveryRepository.listBlockingDeliveries({
      consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      limit: Math.max(1, Math.min(100, input.limit)),
    });

  const reconcileDelivery: ProviderCommandReactorShape["reconcileDelivery"] = (input) =>
    Effect.suspend(() =>
      reconcileDeliveryRuntime === undefined
        ? Effect.fail(new Error("Provider delivery reconciliation is not ready"))
        : reconcileDeliveryRuntime(input),
    );

  return {
    start,
    drain,
    listBlockingDeliveries,
    reconcileDelivery,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make).pipe(
  Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
  Layer.provideMerge(QueuedTurnPromotionRepositoryLive),
  Layer.provideMerge(ProjectionPendingInteractionRepositoryLive),
);
