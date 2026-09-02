/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  EventId,
  ProviderCompactThreadInput,
  ProviderForkThreadInput,
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderStopTaskInput,
  ProviderBackgroundTaskInput,
  ProviderSteerSubagentInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderStartReviewInput,
  ProviderSteerTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderStartOptions,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderKind,
  type ProviderSession,
} from "@synara/contracts";
import {
  providerSupportsAutoRuntimeMode,
  unsupportedAutoRuntimeModeMessage,
} from "@synara/shared/runtimeMode";
import { createHash, randomUUID } from "node:crypto";
import {
  Array as EffectArray,
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Schema,
  SchemaIssue,
  Scope,
  Stream,
} from "effect";
import { nonEmptyTrimmed } from "@synara/shared/text";

import { type ProviderAdapterError, ProviderValidationError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryWriteError,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { PersistenceDecodeError } from "../../persistence/Errors.ts";
import {
  ProviderRuntimeEventRepository,
  type PersistedProviderRuntimeEvent,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import {
  classifyTerminalTurnApplicability,
  isStartedTurnApplicable,
} from "../terminalTurnApplicability.ts";
import { makeProviderLifecycleCoordinator } from "../providerLifecycleCoordinator.ts";
import { makeKeyedLock } from "../keyedLock.ts";
import { carryProviderAttachmentPaths } from "../providerAttachmentPaths.ts";
import { observeProviderStartup, ProviderStartupLifecycle } from "../providerStartupLifecycle.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import {
  makeProviderRuntimeEventPumpHealthRegistry,
  runProviderRuntimeEventPump,
} from "../providerRuntimeEventPump.ts";
import {
  AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED,
  AGENT_GATEWAY_TURN_AUTHORITY_RETIRED,
} from "../../agentGateway/sessionLease.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
  readonly runtimeIdleStopMs?: number;
  /** Test/embedding override for the lossless runtime-event fan-out budget. */
  readonly runtimeEventBufferCapacity?: number;
  /** Production journal hook. The event must be durable before this effect returns. */
  readonly persistRuntimeEvent?: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<PersistedProviderRuntimeEvent, unknown>;
  /** Durable fallback for events that can never be accepted by the canonical journal. */
  readonly quarantineRuntimeEvent?: (
    event: ProviderRuntimeEvent,
    cause: string,
  ) => Effect.Effect<void, unknown>;
  /** Test override for supervised event retry timing. */
  readonly runtimeEventRetryBaseDelayMs?: number;
  readonly runtimeEventRetryMaxDelayMs?: number;
  /** Server-authoritative start gate. Omit only in isolated tests and embedded callers. */
  readonly providerIsEnabled?: (
    provider: ProviderKind,
  ) => Effect.Effect<boolean, ProviderValidationError>;
}

const DEFAULT_PROVIDER_RUNTIME_IDLE_STOP_MS = 10 * 60 * 1000;
export const PROVIDER_RUNTIME_EVENT_BUFFER_CAPACITY = 2_048;
export const PROVIDER_RUNTIME_QUARANTINE_CAUSE_MAX_BYTES = 16 * 1024;
const configuredProviderRuntimeIdleStopMs = process.env.SYNARA_PROVIDER_RUNTIME_IDLE_STOP_MS;
const PROVIDER_RUNTIME_IDLE_STOP_MS = Number.isFinite(Number(configuredProviderRuntimeIdleStopMs))
  ? Math.max(0, Number(configuredProviderRuntimeIdleStopMs))
  : DEFAULT_PROVIDER_RUNTIME_IDLE_STOP_MS;
const MAX_TARGETED_CHILD_INTERRUPT_TOMBSTONES = 16_384;

function validateAutoRuntimeMode(
  operation: string,
  provider: ProviderSession["provider"],
  runtimeMode: ProviderSession["runtimeMode"],
) {
  return runtimeMode !== "auto" || providerSupportsAutoRuntimeMode(provider)
    ? Effect.void
    : Effect.fail(
        new ProviderValidationError({
          operation,
          issue: unsupportedAutoRuntimeModeMessage(provider),
        }),
      );
}

export function summarizeProviderRuntimeQuarantineCause(cause: string): {
  readonly cause: string;
  readonly causeTruncated?: true;
  readonly causeOriginalBytes?: number;
  readonly causeSha256?: string;
} {
  const encoded = Buffer.from(cause, "utf8");
  if (encoded.byteLength <= PROVIDER_RUNTIME_QUARANTINE_CAUSE_MAX_BYTES) {
    return { cause };
  }
  let prefixEnd = PROVIDER_RUNTIME_QUARANTINE_CAUSE_MAX_BYTES;
  while (prefixEnd > 0 && ((encoded[prefixEnd] ?? 0) & 0xc0) === 0x80) {
    prefixEnd -= 1;
  }
  return {
    cause: encoded.subarray(0, prefixEnd).toString("utf8"),
    causeTruncated: true,
    causeOriginalBytes: encoded.byteLength,
    causeSha256: createHash("sha256").update(encoded).digest("hex"),
  };
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

const ClearSessionResumeCursorInput = Schema.Struct({
  threadId: ThreadId,
  preserveActiveRuntime: Schema.optional(Schema.Boolean),
});

const CompletePriorTranscriptBootstrapInput = Schema.Struct({
  threadId: ThreadId,
});

type StopRuntimeSession = NonNullable<ProviderServiceShape["stopRuntimeSession"]>;
type StopRuntimeSessionInput = Parameters<StopRuntimeSession>[0];
type StopRuntimeSessionEffect = ReturnType<StopRuntimeSession>;
type ProviderInterruptionFence = {
  readonly settled: Promise<void>;
  readonly resolve: () => void;
  failure: string | null;
};
type TargetedChildInterruptTombstone = {
  readonly lifecycleGeneration: string | undefined;
  readonly state: "uncertain" | "confirmed";
};
type InteractionResponse =
  | { readonly kind: "approval"; readonly input: ProviderRespondToRequestInput }
  | { readonly kind: "userInput"; readonly input: ProviderRespondToUserInputInput };

/**
 * Hard deadlines for provider lifecycle calls. Every caller of these paths
 * holds a serialized resource (the per-thread lifecycle lock, an orchestration
 * command slot, or the provider command reactor's delivery lock), so an
 * unbounded adapter call is a process-wide stall, not a local one.
 */
const PROVIDER_START_SESSION_TIMEOUT = Duration.seconds(60);
const PROVIDER_STOP_SESSION_TIMEOUT = Duration.seconds(10);
const PRIOR_TRANSCRIPT_BOOTSTRAP_PENDING = "priorTranscriptBootstrapPending";

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  if (session.status === "connecting") return "starting";
  if (session.status === "closed") return "stopped";
  return session.status === "error" ? "error" : "running";
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly providerOptions?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
    readonly lifecycleGeneration?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: nonEmptyTrimmed(session.activeTurnId) ?? null,
    // `thread.session.set` types both as trimmed-non-empty-or-null, so a blank
    // provider string has to become an explicit "absent" rather than reaching
    // the schema as "".
    lastError: nonEmptyTrimmed(session.lastError) ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.providerOptions !== undefined ? { providerOptions: extra.providerOptions } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...(extra?.lifecycleGeneration !== undefined
      ? { lifecycleGeneration: extra.lifecycleGeneration }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  const raw = runtimePayloadRecord(runtimePayload).modelSelection;
  return Schema.is(ModelSelection)(raw) ? raw : undefined;
}

function readPersistedProviderOptions(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ProviderStartOptions | undefined {
  const raw = runtimePayloadRecord(runtimePayload).providerOptions;
  return Option.getOrUndefined(Schema.decodeUnknownOption(ProviderStartOptions)(raw));
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  const rawCwd = runtimePayloadRecord(runtimePayload).cwd;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function runtimePayloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function runtimeEventRetiredGatewayTurnAuthority(event: ProviderRuntimeEvent): boolean {
  return runtimePayloadRecord(event.raw?.payload)[AGENT_GATEWAY_TURN_AUTHORITY_RETIRED] === true;
}

function runtimeActiveTurnId(value: unknown): string | undefined {
  const activeTurnId = runtimePayloadRecord(value).activeTurnId;
  return typeof activeTurnId === "string" ? activeTurnId : undefined;
}

function hasResumeCursor(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * True for events that settle a turn/session lifecycle (as opposed to stream
 * or item-level events). Terminal events are the only stale-generation events
 * that may still be processed: they are the sole signal that can settle a
 * thread whose runtime died after its lifecycle generation was rotated away.
 */
function isTerminalRuntimeEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.exited" ||
    event.type === "runtime.error"
  );
}

function runtimeStatusForEvent(
  event: ProviderRuntimeEvent,
  activeTurnId?: unknown,
): "running" | "stopped" | "error" {
  switch (event.type) {
    case "session.state.changed":
      if (event.payload.state === "stopped") return "stopped";
      return event.payload.state === "error" ? "error" : "running";
    case "thread.state.changed":
      if (event.payload.state === "error") return "error";
      if (event.payload.state === "archived" || event.payload.state === "closed") return "stopped";
      return event.payload.state === "compacted" &&
        event.turnId === undefined &&
        activeTurnId == null
        ? "stopped"
        : "running";
    case "session.exited":
    case "turn.completed":
    case "turn.aborted":
      // A completed turn can still carry a resume cursor, but it must not keep
      // the desktop app treating the provider process as active after restart.
      return "stopped";
    case "runtime.error":
      return "error";
    default:
      return "running";
  }
}

function shouldRefreshResumeCursorForEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "thread.started" ||
    event.type === "model.rerouted" ||
    (event.type === "thread.state.changed" &&
      event.payload.state === "compacted" &&
      event.turnId === undefined) ||
    event.type === "turn.tasks.updated" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted"
  );
}

function runtimeLastErrorForEvent(event: ProviderRuntimeEvent): string | null | undefined {
  // A blank message must not degrade to `null`: null means "clear the error",
  // which would erase the very failure being reported. Fall back to an honest
  // constant instead.
  if (event.type === "runtime.error")
    return nonEmptyTrimmed(event.payload.message) ?? "Provider runtime reported an error.";
  if (event.type === "session.state.changed")
    return event.payload.state === "error"
      ? (nonEmptyTrimmed(event.payload.reason) ?? "Session error")
      : null;
  if (event.type === "thread.state.changed")
    return event.payload.state === "error" ? "Thread error" : null;
  return event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.exited"
    ? null
    : undefined;
}

const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    const canonicalEventLogger =
      options?.canonicalEventLogger ??
      (options?.canonicalEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
            stream: "canonical",
          })
        : undefined);

    const registry = yield* ProviderAdapterRegistry;
    const directory = yield* ProviderSessionDirectory;
    const ensureProviderEnabled = (provider: ProviderKind, operation: string) =>
      options?.providerIsEnabled
        ? options.providerIsEnabled(provider).pipe(
            Effect.flatMap((enabled) =>
              enabled
                ? Effect.void
                : Effect.fail(
                    new ProviderValidationError({
                      operation,
                      issue: `${provider} is disabled in Settings > Providers.`,
                    }),
                  ),
            ),
          )
        : Effect.void;
    const lifecycle = makeProviderLifecycleCoordinator();
    for (const binding of yield* directory.listBindings()) {
      if (binding.lifecycleGeneration !== undefined) {
        lifecycle.adoptCurrent(binding.threadId, binding.lifecycleGeneration);
      }
    }
    const runtimeEventBufferCapacity = Math.max(
      1,
      Math.floor(options?.runtimeEventBufferCapacity ?? PROVIDER_RUNTIME_EVENT_BUFFER_CAPACITY),
    );
    type PublishedRuntimeEvent = {
      readonly event: ProviderRuntimeEvent;
      readonly persisted?: PersistedProviderRuntimeEvent;
    };
    const runtimeEventPubSub = yield* PubSub.bounded<PublishedRuntimeEvent>(
      runtimeEventBufferCapacity,
    );
    const runtimeEventProducerScope = yield* Scope.make("sequential");
    const runtimeIdleTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
    const liveRuntimeTaskIds = new Map<ThreadId, Set<string>>();
    const runtimeTaskSettlementWaiters = new Map<ThreadId, Set<() => void>>();
    // Fired idle callbacks outlive their timer map entry, so use generations to
    // invalidate async stop work when new user work starts in that gap.
    const runtimeIdleGenerations = new Map<ThreadId, symbol>();
    const runtimeIdleStopsInFlight = new Map<ThreadId, Promise<void>>();
    const providerInterruptionFences = new Map<ThreadId, ProviderInterruptionFence>();
    const targetedChildInterruptTombstones = new Map<string, TargetedChildInterruptTombstone>();
    const runtimeIdleStopMs = Math.max(
      0,
      options?.runtimeIdleStopMs ?? PROVIDER_RUNTIME_IDLE_STOP_MS,
    );
    let stopIdleRuntimeSession: ((threadId: ThreadId, generation: symbol) => void) | null = null;

    const invalidateRuntimeIdleGeneration = (threadId: ThreadId): symbol => {
      const generation = Symbol(String(threadId));
      runtimeIdleGenerations.set(threadId, generation);
      return generation;
    };

    const isRuntimeIdleGenerationCurrent = (threadId: ThreadId, generation: symbol): boolean =>
      runtimeIdleGenerations.get(threadId) === generation;

    const retireRuntimeIdleGeneration = (threadId: ThreadId, generation?: symbol): void => {
      if (generation === undefined || isRuntimeIdleGenerationCurrent(threadId, generation)) {
        runtimeIdleGenerations.delete(threadId);
      }
    };

    const clearRuntimeIdleTimer = (threadId: ThreadId) => {
      invalidateRuntimeIdleGeneration(threadId);
      const timer = runtimeIdleTimers.get(threadId);
      if (!timer) {
        return;
      }
      clearTimeout(timer);
      runtimeIdleTimers.delete(threadId);
    };

    const scheduleRuntimeIdleStop = (threadId: ThreadId) => {
      clearRuntimeIdleTimer(threadId);
      // A parent turn can finish while provider-native tasks keep running in
      // the same subprocess. Those tasks own the runtime until the last one
      // settles, even though the adapter session otherwise looks idle-ready.
      if ((liveRuntimeTaskIds.get(threadId)?.size ?? 0) > 0) {
        return;
      }
      if (runtimeIdleStopMs <= 0) {
        retireRuntimeIdleGeneration(threadId);
        return;
      }

      const generation = invalidateRuntimeIdleGeneration(threadId);
      const timer = setTimeout(() => {
        runtimeIdleTimers.delete(threadId);
        stopIdleRuntimeSession?.(threadId, generation);
      }, runtimeIdleStopMs);
      timer.unref();
      runtimeIdleTimers.set(threadId, timer);
    };

    const markRuntimeTaskLive = (threadId: ThreadId, taskId: string): void => {
      const taskIds = liveRuntimeTaskIds.get(threadId) ?? new Set<string>();
      taskIds.add(taskId);
      liveRuntimeTaskIds.set(threadId, taskIds);
      clearRuntimeIdleTimer(threadId);
    };

    const resolveRuntimeTaskSettlementWaiters = (threadId: ThreadId): void => {
      const waiters = runtimeTaskSettlementWaiters.get(threadId);
      runtimeTaskSettlementWaiters.delete(threadId);
      for (const resolve of waiters ?? []) resolve();
    };

    const clearLiveRuntimeTasks = (threadId: ThreadId): void => {
      liveRuntimeTaskIds.delete(threadId);
      resolveRuntimeTaskSettlementWaiters(threadId);
    };

    const waitForLiveRuntimeTasksToSettle = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.suspend(() => {
        if ((liveRuntimeTaskIds.get(threadId)?.size ?? 0) === 0) return Effect.void;
        let resolveWaiter!: () => void;
        const settled = new Promise<void>((resolve) => {
          resolveWaiter = resolve;
        });
        const waiters = runtimeTaskSettlementWaiters.get(threadId) ?? new Set<() => void>();
        waiters.add(resolveWaiter);
        runtimeTaskSettlementWaiters.set(threadId, waiters);
        return Effect.promise(() => settled).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const current = runtimeTaskSettlementWaiters.get(threadId);
              current?.delete(resolveWaiter);
              if (current?.size === 0) runtimeTaskSettlementWaiters.delete(threadId);
            }),
          ),
          // A new task can become visible while the previous last task settles.
          // Recheck before allowing credential rotation to stop the runtime.
          Effect.andThen(waitForLiveRuntimeTasksToSettle(threadId)),
        );
      });

    const markRuntimeTaskSettled = (threadId: ThreadId, taskId: string): void => {
      const taskIds = liveRuntimeTaskIds.get(threadId);
      taskIds?.delete(taskId);
      if (taskIds && taskIds.size > 0) {
        return;
      }
      clearLiveRuntimeTasks(threadId);
      scheduleRuntimeIdleStop(threadId);
    };

    const waitForRuntimeIdleStop = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.promise(() => runtimeIdleStopsInFlight.get(threadId) ?? Promise.resolve());

    const targetedChildInterruptKey = (
      threadId: ThreadId,
      turnId: TurnId,
      providerThreadId: string,
    ): string => JSON.stringify([threadId, turnId, providerThreadId]);

    const rememberTargetedChildInterrupt = (
      key: string,
      tombstone: TargetedChildInterruptTombstone,
    ): void => {
      const existing = targetedChildInterruptTombstones.get(key);
      if (existing?.state === "confirmed" && tombstone.state === "uncertain") return;
      targetedChildInterruptTombstones.delete(key);
      targetedChildInterruptTombstones.set(key, tombstone);
      while (targetedChildInterruptTombstones.size > MAX_TARGETED_CHILD_INTERRUPT_TOMBSTONES) {
        const oldest = targetedChildInterruptTombstones.keys().next().value;
        if (oldest === undefined) break;
        targetedChildInterruptTombstones.delete(oldest);
      }
    };

    const waitForCurrentInterruptionFence = (
      threadId: ThreadId,
    ): Effect.Effect<ProviderInterruptionFence | undefined> =>
      Effect.suspend(() => {
        const fence = providerInterruptionFences.get(threadId);
        if (!fence) return Effect.succeed(undefined);
        return Effect.promise(() => fence.settled).pipe(
          Effect.flatMap(() =>
            providerInterruptionFences.get(threadId) === fence
              ? Effect.succeed(fence)
              : waitForCurrentInterruptionFence(threadId),
          ),
        );
      });

    const acquireProviderInterruptionFence = (
      threadId: ThreadId,
    ): Effect.Effect<ProviderInterruptionFence, ProviderValidationError> =>
      Effect.suspend(() => {
        const existing = providerInterruptionFences.get(threadId);
        if (!existing) {
          let resolveFence!: () => void;
          const fence: ProviderInterruptionFence = {
            settled: new Promise<void>((resolve) => {
              resolveFence = resolve;
            }),
            resolve: () => resolveFence(),
            failure: null,
          };
          providerInterruptionFences.set(threadId, fence);
          return Effect.succeed(fence);
        }
        return Effect.promise(() => existing.settled).pipe(
          Effect.flatMap(() => {
            if (providerInterruptionFences.get(threadId) !== existing) {
              return acquireProviderInterruptionFence(threadId);
            }
            return Effect.fail(
              toValidationError(
                "ProviderService.interruptTurn",
                existing.failure
                  ? `Cannot interrupt thread '${threadId}' because its previous runtime could not be retired safely: ${existing.failure}`
                  : `Cannot interrupt thread '${threadId}' because its previous interruption did not reconcile safely.`,
              ),
            );
          }),
        );
      });

    const runIdleSensitiveProviderWork = <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
      options?: { readonly scheduleIdleStopOnSuccess?: boolean },
    ): Effect.Effect<A, E | ProviderValidationError, R> =>
      Effect.suspend(() => {
        const waitForInterruptionFence = waitForCurrentInterruptionFence(threadId).pipe(
          Effect.flatMap((interruptionFence) =>
            interruptionFence?.failure
              ? Effect.fail(
                  toValidationError(
                    "ProviderService.turnDispatch",
                    `Cannot start a new provider turn because the interrupted runtime could not be retired safely: ${interruptionFence.failure}`,
                  ),
                )
              : Effect.void,
          ),
        );
        const existingIdleStop = runtimeIdleStopsInFlight.get(threadId);
        const displacedIdleStop = existingIdleStop !== undefined || runtimeIdleTimers.has(threadId);
        const waitForExistingIdleStop =
          existingIdleStop !== undefined ? Effect.promise(() => existingIdleStop) : Effect.void;
        return waitForInterruptionFence.pipe(
          Effect.andThen(waitForExistingIdleStop),
          Effect.tap(() => Effect.sync(() => clearRuntimeIdleTimer(threadId))),
          Effect.flatMap(() => waitForRuntimeIdleStop(threadId)),
          Effect.flatMap(() => effect),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? options?.scheduleIdleStopOnSuccess === true
                ? Effect.sync(() => scheduleRuntimeIdleStop(threadId))
                : Effect.void
              : displacedIdleStop
                ? Effect.sync(() => scheduleRuntimeIdleStop(threadId))
                : Effect.sync(() => retireRuntimeIdleGeneration(threadId)),
          ),
        );
      });

    const reconcileRuntimeIdleTimer = (event: ProviderRuntimeEvent) => {
      switch (event.type) {
        case "turn.started":
          clearRuntimeIdleTimer(event.threadId);
          return;
        case "task.started":
        case "task.progress":
          markRuntimeTaskLive(event.threadId, event.payload.taskId);
          return;
        case "task.updated":
          if (
            event.payload.status === "completed" ||
            event.payload.status === "failed" ||
            event.payload.status === "killed" ||
            event.payload.status === "paused"
          ) {
            markRuntimeTaskSettled(event.threadId, event.payload.taskId);
          } else {
            markRuntimeTaskLive(event.threadId, event.payload.taskId);
          }
          return;
        case "task.completed":
          markRuntimeTaskSettled(event.threadId, event.payload.taskId);
          return;
        case "session.started":
        case "thread.started":
        case "turn.completed":
        case "turn.aborted":
          scheduleRuntimeIdleStop(event.threadId);
          return;
        case "thread.state.changed":
          if (
            event.payload.state === "compacted" ||
            event.payload.state === "archived" ||
            event.payload.state === "closed"
          ) {
            if (event.payload.state === "archived" || event.payload.state === "closed") {
              clearLiveRuntimeTasks(event.threadId);
            }
            scheduleRuntimeIdleStop(event.threadId);
          }
          return;
        case "session.exited":
          clearLiveRuntimeTasks(event.threadId);
          clearRuntimeIdleTimer(event.threadId);
          retireRuntimeIdleGeneration(event.threadId);
          return;
      }
    };

    const persistCanonicalRuntimeEvent = (
      event: ProviderRuntimeEvent,
    ): Effect.Effect<PersistedProviderRuntimeEvent | undefined, unknown> => {
      const persistence: Effect.Effect<PersistedProviderRuntimeEvent | undefined, unknown> =
        options?.persistRuntimeEvent
          ? options.persistRuntimeEvent(event)
          : Effect.succeed(undefined);

      return Effect.uninterruptible(
        persistence.pipe(
          Effect.tap(() =>
            canonicalEventLogger ? canonicalEventLogger.write(event, null) : Effect.void,
          ),
        ),
      );
    };

    const publishRuntimeEvent = (
      event: ProviderRuntimeEvent,
      persisted: PersistedProviderRuntimeEvent | undefined,
    ): Effect.Effect<void> =>
      PubSub.publish(runtimeEventPubSub, {
        event,
        ...(persisted === undefined ? {} : { persisted }),
      }).pipe(Effect.asVoid);

    const upsertSessionBinding = (
      session: ProviderSession,
      threadId: ThreadId,
      extra?: {
        readonly lifecycleGeneration?: string;
        readonly modelSelection?: unknown;
        readonly providerOptions?: unknown;
        readonly lastRuntimeEvent?: string;
        readonly lastRuntimeEventAt?: string;
        readonly runtimePayload?: Record<string, unknown>;
      },
    ) =>
      directory.upsert({
        threadId,
        provider: session.provider,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(extra?.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: extra.lifecycleGeneration }
          : {}),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: {
          ...toRuntimePayloadFromSession(session, extra),
          ...extra?.runtimePayload,
        },
      });

    const markThreadStopped = (
      threadId: ThreadId,
      stoppedAt: string,
      session?: ProviderSession,
    ): Effect.Effect<void, ProviderSessionDirectoryWriteError> =>
      session
        ? directory.upsert({
            threadId,
            provider: session.provider,
            runtimeMode: session.runtimeMode,
            status: "stopped",
            ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
            runtimePayload: {
              ...toRuntimePayloadFromSession(session, {
                lastRuntimeEvent: "provider.stopAll",
                lastRuntimeEventAt: stoppedAt,
              }),
              activeTurnId: null,
            },
          })
        : directory.getProvider(threadId).pipe(
            Effect.flatMap((provider) =>
              directory.upsert({
                threadId,
                provider,
                status: "stopped",
                runtimePayload: {
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.stopAll",
                  lastRuntimeEventAt: stoppedAt,
                },
              }),
            ),
          );

    let runtimeCursorWriteVersion = 0;
    let shutdownStartedAt: string | undefined;
    const latestRuntimeCursorWriteByThread = new Map<
      ThreadId,
      { readonly version: number; readonly resumeCursor: unknown }
    >();

    // Runtime events are where adapters surface provider-native ids. Capture
    // the live cursor before queueing the durable write so shutdown cannot
    // delete the adapter session while an earlier event is waiting on SQLite.
    const captureResumeCursorFromActiveSession = (
      event: ProviderRuntimeEvent,
    ): Effect.Effect<unknown | null | undefined> => {
      if (!shouldRefreshResumeCursorForEvent(event)) {
        return Effect.succeed(undefined);
      }

      return Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(event.provider);
        const sessions = yield* adapter.listSessions();
        const activeSession = sessions.find((session) => session.threadId === event.threadId);
        return activeSession?.resumeCursor;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.resume_cursor_refresh_failed", {
            threadId: event.threadId,
            provider: event.provider,
            eventType: event.type,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(undefined)),
        ),
      );
    };

    // Turn ids whose terminal runtime event has already been observed, keyed by
    // thread. sendTurn consults this immediately before its post-dispatch
    // "running" upsert: a turn that settles before that write lands (e.g. a
    // pre-start cancellation) must not be re-marked as running afterwards.
    // A single slot per thread is not enough — sendTurn is not serialized per
    // thread, so overlapping sends can both settle pre-write and the second
    // completion would evict the first turn's marker before its send checked
    // it. Markers are retained only while dispatches are in flight, and each
    // sendTurn consumes its own marker.
    const recentlyCompletedTurnsByThread = new Map<ThreadId, Set<string>>();
    const recordRecentlyCompletedTurn = (threadId: ThreadId, turnId: string): void => {
      let turns = recentlyCompletedTurnsByThread.get(threadId);
      if (turns === undefined) {
        turns = new Set();
        recentlyCompletedTurnsByThread.set(threadId, turns);
      }
      turns.delete(turnId);
      turns.add(turnId);
    };
    const consumeRecentlyCompletedTurn = (threadId: ThreadId, turnId: string): boolean => {
      const turns = recentlyCompletedTurnsByThread.get(threadId);
      if (turns === undefined || !turns.has(turnId)) {
        return false;
      }
      turns.delete(turnId);
      if (turns.size === 0) {
        recentlyCompletedTurnsByThread.delete(threadId);
      }
      return true;
    };

    // Serializes binding writes for a thread between the runtime-event handler
    // and sendTurn's post-dispatch write. Without it a terminal event could
    // land between sendTurn's settled-turn check and its "running" upsert and
    // still be overwritten. Lifecycle events are low-frequency, so a per-thread
    // mutex adds no meaningful contention. Queue registration is synchronous,
    // so concurrent callers cannot mint two locks or overtake an earlier write.
    const bindingWriteLock = makeKeyedLock<ThreadId>();
    const withBindingWriteLock = bindingWriteLock.withLock;

    interface StartedTurnPersistenceInput {
      readonly threadId: ThreadId;
      readonly provider: ProviderRuntimeBinding["provider"];
      readonly turnId: string;
      readonly generation: number;
      readonly resumeCursor?: unknown;
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent: string;
    }
    interface ThreadDispatchState {
      nextGeneration: number;
      latestGeneration: number;
      ownerGeneration: number;
      readonly inFlightGenerations: Set<number>;
      readonly outstandingTurnIds: Set<string>;
      readonly successfulResults: Map<number, StartedTurnPersistenceInput>;
    }
    const dispatchStateByThread = new Map<ThreadId, ThreadDispatchState>();
    const getDispatchState = (threadId: ThreadId): ThreadDispatchState => {
      let state = dispatchStateByThread.get(threadId);
      if (!state) {
        state = {
          nextGeneration: 0,
          latestGeneration: 0,
          ownerGeneration: 0,
          inFlightGenerations: new Set(),
          outstandingTurnIds: new Set(),
          successfulResults: new Map(),
        };
        dispatchStateByThread.set(threadId, state);
      }
      return state;
    };
    const beginTurnDispatch = (threadId: ThreadId): number => {
      const state = getDispatchState(threadId);
      const generation = state.nextGeneration + 1;
      state.nextGeneration = generation;
      state.latestGeneration = generation;
      state.inFlightGenerations.add(generation);
      return generation;
    };
    const cleanupDispatchState = (threadId: ThreadId): void => {
      const state = dispatchStateByThread.get(threadId);
      if (
        state &&
        state.inFlightGenerations.size === 0 &&
        state.outstandingTurnIds.size === 0 &&
        state.successfulResults.size === 0
      ) {
        dispatchStateByThread.delete(threadId);
      }
    };
    const rememberSuccessfulTurnDispatch = (input: StartedTurnPersistenceInput): void => {
      const state = getDispatchState(input.threadId);
      state.outstandingTurnIds.add(input.turnId);
      state.successfulResults.set(input.generation, input);
    };
    const hasAmbiguousTerminalTurn = (threadId: ThreadId): boolean => {
      const state = dispatchStateByThread.get(threadId);
      return (
        state !== undefined &&
        (state.outstandingTurnIds.size > 1 ||
          state.inFlightGenerations.size > 1 ||
          (state.outstandingTurnIds.size > 0 && state.inFlightGenerations.size > 0))
      );
    };

    const persistStartedTurn = (input: StartedTurnPersistenceInput) => {
      let persistenceAttempted = false;
      const rollbackFailedPersistence = Effect.sync(() => {
        if (!persistenceAttempted) return;
        const state = dispatchStateByThread.get(input.threadId);
        state?.successfulResults.delete(input.generation);
        state?.outstandingTurnIds.delete(input.turnId);
        cleanupDispatchState(input.threadId);
      });
      const markPersistenceSucceeded = (ownsLifecycle: boolean): void => {
        const state = getDispatchState(input.threadId);
        if (ownsLifecycle) state.ownerGeneration = input.generation;
        for (const generation of state.successfulResults.keys()) {
          if (generation <= input.generation) state.successfulResults.delete(generation);
        }
      };

      return withBindingWriteLock(
        input.threadId,
        Effect.gen(function* () {
          // Older successful results stay retained while newer invocations are
          // unresolved. If every newer generation fails, settlement promotes
          // the newest retained result through this same persistence path.
          if (getDispatchState(input.threadId).latestGeneration !== input.generation) {
            return;
          }
          const completedBeforePersistence = consumeRecentlyCompletedTurn(
            input.threadId,
            input.turnId,
          );
          if (completedBeforePersistence) {
            getDispatchState(input.threadId).outstandingTurnIds.delete(input.turnId);
          }
          persistenceAttempted = true;
          if (completedBeforePersistence) {
            // An existing row may already belong to a newer overlapping turn;
            // the delayed result must not overwrite any of its metadata. With
            // no row, preserve the live-fallback behavior by creating an
            // explicitly stopped binding from the settled dispatch result.
            if (Option.isSome(yield* directory.getBinding(input.threadId))) {
              markPersistenceSucceeded(false);
              return;
            }
            yield* directory.upsert({
              threadId: input.threadId,
              provider: input.provider,
              status: "stopped",
              ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
              ...(input.modelSelection !== undefined
                ? { runtimePayload: { modelSelection: input.modelSelection } }
                : {}),
            });
            markPersistenceSucceeded(false);
            return;
          }

          // Clear again under the binding lock. This orders active-turn writes
          // against terminal-event scheduling even if dispatch took long
          // enough for an older terminal event to arrive in the meantime.
          clearRuntimeIdleTimer(input.threadId);
          yield* directory.upsert({
            threadId: input.threadId,
            provider: input.provider,
            status: "running",
            ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
            runtimePayload: {
              ...(input.modelSelection !== undefined
                ? { modelSelection: input.modelSelection }
                : {}),
              activeTurnId: input.turnId,
              lastRuntimeEvent: input.lastRuntimeEvent,
              lastRuntimeEventAt: new Date().toISOString(),
            },
          });
          markPersistenceSucceeded(true);
        }),
      ).pipe(Effect.onError(() => rollbackFailedPersistence));
    };

    const finishTurnDispatch = (
      threadId: ThreadId,
      generation: number,
    ): Effect.Effect<void, ProviderSessionDirectoryWriteError> =>
      Effect.gen(function* () {
        const candidate = yield* Effect.sync(() => {
          const state = getDispatchState(threadId);
          state.inFlightGenerations.delete(generation);
          if (state.latestGeneration === generation && !state.successfulResults.has(generation)) {
            state.latestGeneration = Math.max(
              state.ownerGeneration,
              ...state.inFlightGenerations,
              ...state.successfulResults.keys(),
            );
          }
          return state.successfulResults.get(state.latestGeneration);
        });
        if (candidate !== undefined) {
          yield* persistStartedTurn(candidate);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const state = dispatchStateByThread.get(threadId);
            if (state?.inFlightGenerations.size === 0) {
              recentlyCompletedTurnsByThread.delete(threadId);
            }
            cleanupDispatchState(threadId);
          }),
        ),
      );

    const runTurnDispatch = <A, E, R>(
      threadId: ThreadId,
      dispatch: (generation: number) => Effect.Effect<A, E, R>,
    ) =>
      runIdleSensitiveProviderWork(
        threadId,
        Effect.suspend(() => {
          const generation = beginTurnDispatch(threadId);
          return dispatch(generation).pipe(
            Effect.ensuring(finishTurnDispatch(threadId, generation).pipe(Effect.ignore)),
          );
        }),
      );

    const updateSessionBindingFromRuntimeEvent = (
      event: ProviderRuntimeEvent,
    ): Effect.Effect<void> => {
      // Subagent-scoped events carry the parent thread id with the child
      // identity in providerRefs. Their turn/session lifecycle belongs to the
      // child thread and must not touch the parent binding — a stopped
      // subagent would otherwise clear the parent's active turn and break
      // main-thread interrupts for the rest of the turn.
      if (event.providerRefs?.providerParentThreadId !== undefined) {
        return Effect.void;
      }
      switch (event.type) {
        case "session.started":
        case "session.state.changed":
        case "thread.started":
        case "thread.state.changed":
        case "turn.started":
        case "turn.tasks.updated":
        case "model.rerouted":
        case "turn.completed":
        case "turn.aborted":
        case "session.exited":
        case "runtime.error":
          break;
        default:
          return Effect.sync(() => reconcileRuntimeIdleTimer(event));
      }

      return Effect.gen(function* () {
        const liveResumeCursor = yield* captureResumeCursorFromActiveSession(event);
        yield* withBindingWriteLock(
          event.threadId,
          Effect.gen(function* () {
            if (event.type === "turn.started" && event.turnId !== undefined) {
              getDispatchState(event.threadId).outstandingTurnIds.add(String(event.turnId));
            }
            if (
              (event.type === "turn.completed" || event.type === "turn.aborted") &&
              event.turnId !== undefined &&
              (dispatchStateByThread.get(event.threadId)?.inFlightGenerations.size ?? 0) > 0
            ) {
              recordRecentlyCompletedTurn(event.threadId, String(event.turnId));
            }
            const binding = Option.getOrUndefined(yield* directory.getBinding(event.threadId));
            if (!binding) {
              reconcileRuntimeIdleTimer(event);
              return;
            }
            if (binding.provider !== event.provider) {
              return;
            }
            if (
              event.lifecycleGeneration !== undefined &&
              binding.lifecycleGeneration !== event.lifecycleGeneration
            ) {
              // The pump gate lets a stale terminal event through only when it
              // can safely settle the thread: no current generation exists, or
              // the event still names the turn the binding has active. Mirror
              // that acceptance here, otherwise the accepted event is journaled
              // and published but the durable binding keeps the dead turn active
              // forever and the thread stays a reconciliation candidate.
              const staleTerminalSettlesThread =
                isTerminalRuntimeEvent(event) &&
                (lifecycle.currentGeneration(event.threadId) === undefined ||
                  (event.turnId !== undefined &&
                    runtimeActiveTurnId(binding.runtimePayload) === String(event.turnId)));
              if (!staleTerminalSettlesThread) {
                return;
              }
            }

            const currentActiveTurnId = runtimeActiveTurnId(binding.runtimePayload);
            if (
              event.type === "turn.started" &&
              !isStartedTurnApplicable({
                activeTurnId: currentActiveTurnId,
                eventTurnId: event.turnId === undefined ? undefined : String(event.turnId),
              })
            ) {
              return;
            }
            if (event.type === "turn.completed" || event.type === "turn.aborted") {
              const applicability = classifyTerminalTurnApplicability({
                activeTurnId: currentActiveTurnId,
                eventTurnId: event.turnId === undefined ? undefined : String(event.turnId),
                hasAmbiguousTurns: hasAmbiguousTerminalTurn(event.threadId),
              });
              if (!applicability.applicable) {
                if (event.turnId !== undefined) {
                  dispatchStateByThread
                    .get(event.threadId)
                    ?.outstandingTurnIds.delete(String(event.turnId));
                  cleanupDispatchState(event.threadId);
                }
                if (applicability.reason === "ambiguous-missing-turn-id") {
                  yield* Effect.logWarning("provider.session.ambiguous_terminal_event_ignored", {
                    threadId: event.threadId,
                    eventType: event.type,
                  });
                }
                return;
              }
              if (event.turnId === undefined && applicability.resolvedTurnId !== undefined) {
                recordRecentlyCompletedTurn(event.threadId, applicability.resolvedTurnId);
              }
              if (applicability.resolvedTurnId !== undefined) {
                dispatchStateByThread
                  .get(event.threadId)
                  ?.outstandingTurnIds.delete(applicability.resolvedTurnId);
                cleanupDispatchState(event.threadId);
              }
            }
            const activeTurnId =
              event.type === "turn.started"
                ? (event.turnId ?? null)
                : event.type === "thread.state.changed" && event.payload.state === "compacted"
                  ? (event.turnId ?? currentActiveTurnId)
                  : event.type === "turn.completed" ||
                      event.type === "turn.aborted" ||
                      (event.type === "thread.state.changed" &&
                        (event.payload.state === "archived" ||
                          event.payload.state === "closed" ||
                          event.payload.state === "error")) ||
                      event.type === "session.exited" ||
                      event.type === "runtime.error" ||
                      (event.type === "session.state.changed" &&
                        (event.payload.state === "ready" ||
                          event.payload.state === "stopped" ||
                          event.payload.state === "error"))
                    ? null
                    : currentActiveTurnId;
            const lastError = runtimeLastErrorForEvent(event);
            const resumeCursor = liveResumeCursor ?? binding.resumeCursor;
            const eventStatus = runtimeStatusForEvent(event, activeTurnId);
            // Cursor capture happens before the write lock. An event that began
            // before shutdown can therefore queue behind the stopped snapshot;
            // retain its cursor without reviving the durable runtime state.
            const preserveShutdownStop =
              shutdownStartedAt !== undefined && eventStatus === "running";

            yield* directory.upsert({
              threadId: event.threadId,
              provider: binding.provider,
              ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
              ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
              status: preserveShutdownStop ? "stopped" : eventStatus,
              ...(resumeCursor !== undefined ? { resumeCursor } : {}),
              runtimePayload: {
                activeTurnId: preserveShutdownStop ? null : activeTurnId,
                lastRuntimeEvent: preserveShutdownStop ? "provider.stopAll" : event.type,
                lastRuntimeEventAt: preserveShutdownStop ? shutdownStartedAt : event.createdAt,
                ...(lastError !== undefined ? { lastError } : {}),
                ...(runtimeEventRetiredGatewayTurnAuthority(event)
                  ? { [AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED]: true }
                  : {}),
              },
            });
            if (liveResumeCursor !== undefined && liveResumeCursor !== null) {
              runtimeCursorWriteVersion += 1;
              latestRuntimeCursorWriteByThread.set(event.threadId, {
                version: runtimeCursorWriteVersion,
                resumeCursor: liveResumeCursor,
              });
            }
            if (event.type === "session.exited") {
              const dispatchState = dispatchStateByThread.get(event.threadId);
              if (dispatchState) {
                // Invalidate adapter calls that were already in flight when the
                // session exited, then retain only the generations needed for
                // their eventual settlement/cleanup.
                dispatchState.latestGeneration = dispatchState.nextGeneration + 1;
                dispatchState.nextGeneration = dispatchState.latestGeneration;
                dispatchState.outstandingTurnIds.clear();
                dispatchState.successfulResults.clear();
              }
              recentlyCompletedTurnsByThread.delete(event.threadId);
              cleanupDispatchState(event.threadId);
            }
            reconcileRuntimeIdleTimer(event);
          }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.runtime_binding_update_failed", {
            threadId: event.threadId,
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    };

    const providers = yield* registry.listProviders();
    const adapters = yield* Effect.forEach(providers, (provider) =>
      registry.getByProvider(provider),
    );
    const runtimeEventPumpHealth = makeProviderRuntimeEventPumpHealthRegistry(providers);
    let scheduleRetiredGatewaySessionRecovery = (
      _event: ProviderRuntimeEvent,
    ): Effect.Effect<void> => Effect.void;
    const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void, unknown> =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          const journalAndPublish = (acceptedEvent: ProviderRuntimeEvent) =>
            persistCanonicalRuntimeEvent(acceptedEvent).pipe(
              Effect.flatMap((persisted) =>
                Effect.sync(() => {
                  if (acceptedEvent.type === "turn.started") {
                    reconcileRuntimeIdleTimer(acceptedEvent);
                  }
                }).pipe(
                  Effect.andThen(updateSessionBindingFromRuntimeEvent(acceptedEvent)),
                  Effect.andThen(publishRuntimeEvent(acceptedEvent, persisted)),
                  Effect.andThen(scheduleRetiredGatewaySessionRecovery(acceptedEvent)),
                ),
              ),
            );
          const canonicalEvent = event;
          if (
            event.lifecycleGeneration !== undefined &&
            lifecycle.currentGeneration(event.threadId) !== event.lifecycleGeneration
          ) {
            const currentGeneration = lifecycle.currentGeneration(event.threadId);
            // A stale-generation event is normally noise from a superseded
            // session, but terminal events are the exception: they are the
            // only signal that can settle a turn whose runtime died after its
            // generation was rotated or retired (a stop, a recovery, or an
            // idle retire). Dropping them strands the thread "working" with a
            // dead runtime until the reconciler or an app restart intervenes,
            // and silently discards the very error that explains the death.
            //
            // A stale terminal event is safe to let through when either:
            //  - no current generation exists (nothing newer can be corrupted
            //    by settling the old session's state), or
            //  - the event still names the turn the binding considers active
            //    (a newer epoch has not started a different turn, so settling
            //    this turn cannot clobber newer state).
            const staleTerminalIsSettling =
              isTerminalRuntimeEvent(event) &&
              (currentGeneration === undefined || event.turnId !== undefined);
            if (!staleTerminalIsSettling) {
              // Warn, not debug: a persistent mismatch silently discards every
              // runtime event for the thread — the provider runs, the UI shows
              // nothing, and the runtime reconciler later settles the turn as
              // interrupted. This log line is the only way to see it happening.
              return Effect.logWarning("provider.session.stale_generation_event_ignored", {
                threadId: event.threadId,
                provider: event.provider,
                eventType: event.type,
                eventLifecycleGeneration: event.lifecycleGeneration,
                currentLifecycleGeneration: currentGeneration,
              });
            }
            if (currentGeneration !== undefined) {
              // A newer generation exists: only accept the stale terminal event
              // when it still names the turn the binding has active. If the
              // binding already moved on (or is gone), keep dropping it.
              return directory.getBinding(event.threadId).pipe(
                Effect.flatMap((maybeBinding) => {
                  const binding = Option.getOrUndefined(maybeBinding);
                  const boundActiveTurnId = binding
                    ? runtimeActiveTurnId(binding.runtimePayload)
                    : undefined;
                  if (binding === undefined || boundActiveTurnId !== String(event.turnId)) {
                    return Effect.logWarning("provider.session.stale_generation_event_ignored", {
                      threadId: event.threadId,
                      provider: event.provider,
                      eventType: event.type,
                      eventLifecycleGeneration: event.lifecycleGeneration,
                      currentLifecycleGeneration: currentGeneration,
                    });
                  }
                  return Effect.logInfo(
                    "provider.session.stale_generation_terminal_event_accepted",
                    {
                      threadId: event.threadId,
                      provider: event.provider,
                      eventType: event.type,
                      eventLifecycleGeneration: event.lifecycleGeneration,
                      currentLifecycleGeneration: currentGeneration,
                    },
                  ).pipe(Effect.andThen(() => journalAndPublish(canonicalEvent)));
                }),
              );
            }
            // No current generation and the event is terminal: fall through so
            // the stale session's exit/error settles the binding and projection.
          }
          return journalAndPublish(canonicalEvent);
        }),
      );

    const recoverSessionForThread = (input: {
      readonly binding: ProviderRuntimeBinding;
      readonly operation: string;
    }) =>
      Effect.gen(function* () {
        const threadId = input.binding.threadId;
        const getCurrentBinding = () =>
          directory.getBinding(threadId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    toValidationError(
                      input.operation,
                      `Cannot recover thread '${threadId}' because its provider binding was removed.`,
                    ),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );

        // Keep the retiring runtime's generation current until all of its
        // background work has settled and the process is stopped. Otherwise
        // its terminal task event would be rejected as stale and this drain
        // could wait forever.
        yield* lifecycle.runCurrent(threadId, () =>
          Effect.gen(function* () {
            let binding = yield* getCurrentBinding();
            const requiresCredentialRotation =
              runtimePayloadRecord(binding.runtimePayload)[
                AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED
              ] === true;
            if (!requiresCredentialRotation) {
              return;
            }

            let adapter = yield* registry.getByProvider(binding.provider);
            if (!(yield* adapter.hasSession(threadId))) {
              return;
            }

            yield* waitForLiveRuntimeTasksToSettle(threadId);

            // The drain may have waited for a while. Re-read all durable
            // routing state before stopping anything.
            binding = yield* getCurrentBinding();
            if (
              runtimePayloadRecord(binding.runtimePayload)[
                AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED
              ] !== true
            ) {
              return;
            }
            adapter = yield* registry.getByProvider(binding.provider);
            if (!(yield* adapter.hasSession(threadId))) {
              return;
            }

            const activeSession = (yield* adapter.listSessions()).find(
              (session) => session.threadId === threadId,
            );
            if (activeSession?.resumeCursor !== undefined) {
              yield* withBindingWriteLock(
                threadId,
                directory.upsert({
                  threadId,
                  provider: binding.provider,
                  resumeCursor: activeSession.resumeCursor,
                }),
              );
            }
            yield* adapter.stopSession(threadId);
          }),
        );

        return yield* lifecycle.run(threadId, (lease) =>
          Effect.gen(function* () {
            const binding = yield* getCurrentBinding();
            const adapter = yield* registry.getByProvider(binding.provider);
            const hasPersistedResumeCursor = hasResumeCursor(binding.resumeCursor);
            const requiresCredentialRotation =
              runtimePayloadRecord(binding.runtimePayload)[
                AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED
              ] === true;
            const hasActiveSession = yield* adapter.hasSession(threadId);

            // A concurrent recovery may have won between the drain and restart
            // phases. Adopt its fresh runtime instead of replacing it again.
            if (hasActiveSession && !requiresCredentialRotation) {
              const existing = (yield* adapter.listSessions()).find(
                (session) => session.threadId === threadId,
              );
              if (existing) {
                lease.adopt(binding.lifecycleGeneration ?? "legacy");
                return adapter;
              }
            }

            if (hasActiveSession && requiresCredentialRotation) {
              return yield* toValidationError(
                input.operation,
                `Cannot recover thread '${threadId}' because its retired provider runtime is still active.`,
              );
            }

            if (!hasPersistedResumeCursor && !requiresCredentialRotation) {
              return yield* toValidationError(
                input.operation,
                `Cannot recover thread '${threadId}' because no provider resume state is persisted.`,
              );
            }

            const persistedCwd = readPersistedCwd(binding.runtimePayload);
            const persistedModelSelection = readPersistedModelSelection(binding.runtimePayload);
            const persistedProviderOptions = readPersistedProviderOptions(binding.runtimePayload);
            yield* validateAutoRuntimeMode(
              input.operation,
              binding.provider,
              binding.runtimeMode ?? "full-access",
            );
            yield* ensureProviderEnabled(binding.provider, input.operation);

            const resumed = yield* adapter.startSession({
              threadId,
              provider: binding.provider,
              lifecycleGeneration: lease.generation,
              ...(persistedCwd ? { cwd: persistedCwd } : {}),
              ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
              ...(persistedProviderOptions ? { providerOptions: persistedProviderOptions } : {}),
              ...(hasPersistedResumeCursor ? { resumeCursor: binding.resumeCursor } : {}),
              runtimeMode: binding.runtimeMode ?? "full-access",
            });
            if (resumed.provider !== adapter.provider) {
              return yield* toValidationError(
                input.operation,
                `Adapter/provider mismatch while recovering thread '${threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
              );
            }

            yield* withBindingWriteLock(
              threadId,
              upsertSessionBinding(resumed, threadId, {
                lifecycleGeneration: lease.generation,
              }).pipe(
                Effect.andThen(
                  requiresCredentialRotation
                    ? directory.upsert({
                        threadId,
                        provider: binding.provider,
                        runtimePayload: {
                          [AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED]: false,
                        },
                      })
                    : Effect.void,
                ),
              ),
            );
            lease.commit();
            return adapter;
          }),
        );
      });

    const retiredGatewaySessionRecoveries = new Set<ThreadId>();
    scheduleRetiredGatewaySessionRecovery = (event) => {
      if (
        (event.type !== "turn.completed" && event.type !== "turn.aborted") ||
        !runtimeEventRetiredGatewayTurnAuthority(event)
      ) {
        return Effect.void;
      }

      return Effect.suspend(() => {
        if (retiredGatewaySessionRecoveries.has(event.threadId)) {
          return Effect.void;
        }
        retiredGatewaySessionRecoveries.add(event.threadId);

        return Effect.gen(function* () {
          // The terminal event is already durable and published. Rotate the
          // retired bearer now, while the user is reading the response, so the
          // next turn does not pay for process teardown and thread/resume.
          yield* Effect.yieldNow;
          const binding = Option.getOrUndefined(yield* directory.getBinding(event.threadId));
          if (!binding) return;
          yield* recoverSessionForThread({
            binding,
            operation: "ProviderService.proactiveGatewayCredentialRotation",
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.proactive_gateway_rotation_failed", {
              threadId: event.threadId,
              provider: event.provider,
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              retiredGatewaySessionRecoveries.delete(event.threadId);
            }),
          ),
          Effect.forkIn(runtimeEventProducerScope),
          Effect.asVoid,
        );
      });
    };

    // Each Adapter has one supervised journal-first pump. Per-event retry holds
    // the current queue item until durable acceptance succeeds; stream restart
    // covers unexpected completion/defects without provider-specific fallbacks.
    // Start the pumps only after proactive recovery is installed so even an
    // immediately queued terminal event can schedule credential rotation.
    yield* Effect.forEach(adapters, (adapter) =>
      runProviderRuntimeEventPump({
        provider: adapter.provider,
        stream: adapter.streamEvents,
        processEvent: processRuntimeEvent,
        updateHealth: runtimeEventPumpHealth.update,
        isPermanentFailure: (cause) =>
          Option.match(Cause.findErrorOption(cause), {
            onNone: () => false,
            onSome: (error) => error instanceof PersistenceDecodeError,
          }),
        ...(options?.quarantineRuntimeEvent !== undefined
          ? { quarantineEvent: options.quarantineRuntimeEvent }
          : {}),
        ...(options?.runtimeEventRetryBaseDelayMs !== undefined
          ? { retryBaseDelayMs: options.runtimeEventRetryBaseDelayMs }
          : {}),
        ...(options?.runtimeEventRetryMaxDelayMs !== undefined
          ? { retryMaxDelayMs: options.runtimeEventRetryMaxDelayMs }
          : {}),
      }).pipe(Effect.forkIn(runtimeEventProducerScope)),
    ).pipe(Effect.asVoid);

    const findLiveSessionAdapter = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const matches = yield* Effect.forEach(
          adapters,
          (adapter) =>
            adapter.hasSession(threadId).pipe(
              Effect.map((hasSession) => (hasSession ? adapter : null)),
              Effect.orElseSucceed(() => null),
            ),
          { concurrency: "unbounded" },
        );
        return matches.find((adapter) => adapter !== null) ?? null;
      });

    const resolveRoutableSession = (input: {
      readonly threadId: ThreadId;
      readonly operation: string;
      readonly allowRecovery: boolean;
    }) =>
      Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        if (!binding) {
          // Startup extension prompts can fire before startSession has persisted
          // the provider binding, but the adapter already owns a live session.
          const liveAdapter = yield* findLiveSessionAdapter(input.threadId);
          if (liveAdapter) {
            if (input.allowRecovery) {
              yield* ensureProviderEnabled(liveAdapter.provider, input.operation);
            }
            return {
              adapter: liveAdapter,
              isActive: true,
              lifecycleGeneration: lifecycle.currentGeneration(input.threadId),
            } as const;
          }
          return yield* toValidationError(
            input.operation,
            `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
          );
        }
        const adapter = yield* registry.getByProvider(binding.provider);
        if (input.allowRecovery) {
          yield* ensureProviderEnabled(binding.provider, input.operation);
        }

        const hasActiveSession = yield* adapter.hasSession(input.threadId);
        const requiresCredentialRotation =
          runtimePayloadRecord(binding.runtimePayload)[
            AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED
          ] === true;
        // A live adapter session whose persisted generation no longer matches
        // the thread's current generation is a zombie: its runtime events are
        // rejected by the stale-generation gate, so a turn routed into it can
        // produce no visible output and the thread appears wedged. Recovery-
        // capable callers (turn sends) must replace it instead of fast-pathing
        // into it. Control-plane callers (interrupts, responses) keep routing
        // to the live session — stopping a wedged runtime is the user's escape
        // hatch and must keep working.
        const bindingMatchesCurrentGeneration =
          binding.lifecycleGeneration === undefined ||
          binding.lifecycleGeneration === lifecycle.currentGeneration(input.threadId);
        if (
          hasActiveSession &&
          (!input.allowRecovery || (bindingMatchesCurrentGeneration && !requiresCredentialRotation))
        ) {
          return {
            adapter,
            isActive: true,
            lifecycleGeneration: binding.lifecycleGeneration,
          } as const;
        }

        if (!input.allowRecovery) {
          return {
            adapter,
            isActive: false,
            lifecycleGeneration: binding.lifecycleGeneration,
          } as const;
        }

        return {
          adapter: yield* recoverSessionForThread({ binding, operation: input.operation }),
          isActive: true,
          lifecycleGeneration: lifecycle.currentGeneration(input.threadId),
        } as const;
      });

    const startSessionWithOutcome: NonNullable<ProviderServiceShape["startSessionWithOutcome"]> = (
      threadId,
      rawInput,
      outcomeOptions,
    ) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.startSession",
          schema: ProviderSessionStartInput,
          payload: rawInput,
        });

        const resolvedProvider = parsed.provider ?? parsed.modelSelection?.provider;
        if (resolvedProvider === undefined) {
          return yield* toValidationError(
            "provider.session.start",
            "startSession requires an explicit provider or modelSelection with a provider",
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        yield* ensureProviderEnabled(input.provider, "ProviderService.startSession");
        yield* validateAutoRuntimeMode(
          "ProviderService.startSession",
          input.provider,
          input.runtimeMode,
        );
        // An explicit start is the recovery authority for a failed retirement,
        // but it must never interleave with one still in progress. Capture the
        // exact settled fence so this replacement cannot delete a newer fence
        // that was published while provider startup was running.
        const replacementFence = yield* waitForCurrentInterruptionFence(threadId);
        clearRuntimeIdleTimer(threadId);
        yield* waitForRuntimeIdleStop(threadId);
        return yield* lifecycle.run(threadId, (lease) =>
          Effect.gen(function* () {
            const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
            const effectiveResumeCursor =
              input.forkSourceResumeCursor !== undefined
                ? undefined
                : (input.resumeCursor ??
                  (persistedBinding?.provider === input.provider
                    ? persistedBinding.resumeCursor
                    : undefined));
            const persistedPriorTranscriptBootstrapPending =
              persistedBinding?.provider === input.provider &&
              runtimePayloadRecord(persistedBinding.runtimePayload)[
                PRIOR_TRANSCRIPT_BOOTSTRAP_PENDING
              ] === true;
            const adapterStartInput = { ...input };
            delete adapterStartInput.resumeCursor;
            const effectiveProviderOptions =
              input.providerOptions ??
              (persistedBinding?.provider === input.provider
                ? readPersistedProviderOptions(persistedBinding.runtimePayload)
                : undefined);
            const adapter = yield* registry.getByProvider(input.provider);
            let replacementStarted = false;
            const startupLifecycle = new ProviderStartupLifecycle();
            const startAndPersistReplacement = Effect.gen(function* () {
              yield* ensureProviderEnabled(input.provider, "ProviderService.startSession");
              const resolvedAdapterStartInput = {
                ...adapterStartInput,
                lifecycleGeneration: lease.generation,
                ...(effectiveProviderOptions !== undefined
                  ? { providerOptions: effectiveProviderOptions }
                  : {}),
                ...(hasResumeCursor(effectiveResumeCursor)
                  ? { resumeCursor: effectiveResumeCursor }
                  : {}),
              };
              // A provider start that never returns holds this thread's
              // lifecycle lock and the caller's command slot forever. Bound it,
              // retire whatever the adapter may have half-spawned, and fail
              // with text the caller can surface as a session error.
              startupLifecycle.transition("starting");
              startupLifecycle.transition("handshaking");
              // The lifecycle is updated inside observeProviderStartup; these taps
              // only log the already-recorded outcome.
              const started = yield* observeProviderStartup(
                adapter.startSession(resolvedAdapterStartInput),
                { lifecycle: startupLifecycle, timeout: PROVIDER_START_SESSION_TIMEOUT },
              ).pipe(
                Effect.tapError((cause) =>
                  Effect.logError("provider.session.start_failed", {
                    threadId,
                    provider: input.provider,
                    startup: startupLifecycle.snapshot(),
                    cause: cause instanceof Error ? cause.message : String(cause),
                  }),
                ),
                Effect.onInterrupt(() =>
                  Effect.logInfo("provider.session.start_cancelled", {
                    threadId,
                    provider: input.provider,
                    startup: startupLifecycle.snapshot(),
                  }),
                ),
              );
              if (Option.isNone(started)) {
                yield* Effect.logError("provider session start exceeded its deadline", {
                  threadId,
                  provider: input.provider,
                  timeoutMs: Duration.toMillis(PROVIDER_START_SESSION_TIMEOUT),
                  startup: startupLifecycle.snapshot(),
                });
                yield* adapter.stopSession(threadId).pipe(
                  Effect.timeoutOption(PROVIDER_STOP_SESSION_TIMEOUT),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to retire a timed-out provider session start", {
                      threadId,
                      provider: input.provider,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                );
                return yield* toValidationError(
                  "ProviderService.startSession",
                  `Provider '${input.provider}' did not finish starting within ${Duration.toMillis(
                    PROVIDER_START_SESSION_TIMEOUT,
                  )}ms for thread '${threadId}'.`,
                );
              }
              const session = started.value;
              startupLifecycle.transition("ready");
              replacementStarted = true;
              const nativeResumeAttempted = hasResumeCursor(effectiveResumeCursor);
              const nativeResumeSucceeded = nativeResumeAttempted
                ? (adapter.didResumeSession?.(resolvedAdapterStartInput, session) ?? true)
                : false;
              const priorTranscriptBootstrapPending =
                persistedPriorTranscriptBootstrapPending ||
                (outcomeOptions?.registerPriorTranscriptBootstrapOnFreshStart === true &&
                  !nativeResumeSucceeded);

              if (session.provider !== adapter.provider) {
                return yield* toValidationError(
                  "ProviderService.startSession",
                  `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
                );
              }

              yield* withBindingWriteLock(
                threadId,
                upsertSessionBinding(session, threadId, {
                  modelSelection: input.modelSelection,
                  providerOptions: effectiveProviderOptions,
                  lifecycleGeneration: lease.generation,
                  runtimePayload: {
                    [AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED]: false,
                    [PRIOR_TRANSCRIPT_BOOTSTRAP_PENDING]: priorTranscriptBootstrapPending,
                  },
                }),
              );
              lease.commit();
              startupLifecycle.transition("running");
              yield* Effect.logDebug("provider.session.started", {
                threadId,
                provider: input.provider,
                startup: startupLifecycle.snapshot(),
              });
              if (
                replacementFence !== undefined &&
                providerInterruptionFences.get(threadId) === replacementFence
              ) {
                providerInterruptionFences.delete(threadId);
              }

              return {
                session,
                nativeResumeAttempted,
                nativeResumeSucceeded,
                priorTranscriptBootstrapPending,
              };
            });

            if (!persistedBinding || persistedBinding.provider === input.provider) {
              return yield* startAndPersistReplacement;
            }

            const previousAdapter = yield* registry.getByProvider(persistedBinding.provider);
            if (!(yield* previousAdapter.hasSession(threadId))) {
              return yield* startAndPersistReplacement;
            }

            const previousGeneration = persistedBinding.lifecycleGeneration ?? "legacy";
            const previousModelSelection = readPersistedModelSelection(
              persistedBinding.runtimePayload,
            );
            const previousProviderOptions = readPersistedProviderOptions(
              persistedBinding.runtimePayload,
            );
            const previousCwd = readPersistedCwd(persistedBinding.runtimePayload);
            yield* previousAdapter.stopSession(threadId);

            return yield* startAndPersistReplacement.pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : Effect.gen(function* () {
                      // A provider switch is stop-first so one thread is never dual-owned.
                      // If anything after the stop fails, retire a partially started
                      // replacement before restoring the exact previous generation.
                      if (replacementStarted) {
                        yield* adapter.stopSession(threadId);
                      }
                      const restored = yield* previousAdapter.startSession({
                        threadId,
                        provider: persistedBinding.provider,
                        lifecycleGeneration: previousGeneration,
                        runtimeMode: persistedBinding.runtimeMode ?? "full-access",
                        ...(previousCwd !== undefined ? { cwd: previousCwd } : {}),
                        ...(previousModelSelection !== undefined
                          ? { modelSelection: previousModelSelection }
                          : {}),
                        ...(previousProviderOptions !== undefined
                          ? { providerOptions: previousProviderOptions }
                          : {}),
                        ...(persistedBinding.resumeCursor !== undefined
                          ? { resumeCursor: persistedBinding.resumeCursor }
                          : {}),
                      });
                      if (restored.provider !== previousAdapter.provider) {
                        return yield* toValidationError(
                          "ProviderService.startSession",
                          `Adapter/provider mismatch while restoring '${previousAdapter.provider}': received '${restored.provider}'.`,
                        );
                      }
                      yield* withBindingWriteLock(
                        threadId,
                        upsertSessionBinding(restored, threadId, {
                          lifecycleGeneration: previousGeneration,
                          modelSelection: previousModelSelection,
                          providerOptions: previousProviderOptions,
                        }),
                      );
                      // The restored runtime stamps its events with the exact
                      // generation persisted above, so the coordinator must end
                      // the run owning that generation and not the abandoned
                      // replacement's.
                      lease.adopt(previousGeneration);
                    }),
              ),
            );
          }),
        );
      });

    const startSession: ProviderServiceShape["startSession"] = (threadId, input) =>
      startSessionWithOutcome(threadId, input).pipe(Effect.map(({ session }) => session));

    const completePriorTranscriptBootstrap: NonNullable<
      ProviderServiceShape["completePriorTranscriptBootstrap"]
    > = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.completePriorTranscriptBootstrap",
          schema: CompletePriorTranscriptBootstrapInput,
          payload: rawInput,
        });
        yield* withBindingWriteLock(
          input.threadId,
          Effect.gen(function* () {
            const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
            if (!binding) {
              return;
            }
            yield* directory.upsert({
              threadId: input.threadId,
              provider: binding.provider,
              runtimePayload: {
                [PRIOR_TRANSCRIPT_BOOTSTRAP_PENDING]: false,
              },
            });
          }),
        );
      });

    const forkThread: NonNullable<ProviderServiceShape["forkThread"]> = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.forkThread",
          schema: ProviderForkThreadInput,
          payload: rawInput,
        });

        const existingTargetBinding = Option.getOrUndefined(
          yield* directory.getBinding(input.threadId),
        );
        if (existingTargetBinding) {
          const existingTargetPayload = runtimePayloadRecord(existingTargetBinding.runtimePayload);
          if (
            existingTargetPayload.lastRuntimeEvent === "provider.thread.forked" &&
            hasResumeCursor(existingTargetBinding.resumeCursor)
          ) {
            return {
              threadId: input.threadId,
              resumeCursor: existingTargetBinding.resumeCursor,
            };
          }
          return null;
        }

        const sourceBinding = Option.getOrUndefined(
          yield* directory.getBinding(input.sourceThreadId),
        );
        if (!sourceBinding) {
          return null;
        }

        const effectiveProviderOptions =
          input.providerOptions ?? readPersistedProviderOptions(sourceBinding.runtimePayload);
        const sourceCwd = readPersistedCwd(sourceBinding.runtimePayload);
        const targetCwd = input.cwd ?? sourceCwd;
        yield* validateAutoRuntimeMode(
          "ProviderService.forkThread",
          sourceBinding.provider,
          input.runtimeMode,
        );

        const adapter = yield* registry.getByProvider(sourceBinding.provider);
        if (!adapter.forkThread) {
          return null;
        }

        if (
          input.modelSelection !== undefined &&
          input.modelSelection.provider !== adapter.provider
        ) {
          return null;
        }

        const forked = yield* adapter
          .forkThread({
            ...input,
            threadId: input.threadId,
            sourceThreadId: input.sourceThreadId,
            ...(effectiveProviderOptions !== undefined
              ? { providerOptions: effectiveProviderOptions }
              : {}),
            ...(sourceBinding.resumeCursor !== null && sourceBinding.resumeCursor !== undefined
              ? { sourceResumeCursor: sourceBinding.resumeCursor }
              : {}),
            ...(sourceCwd ? { sourceCwd } : {}),
            runtimeMode: input.runtimeMode,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("provider native fork failed; falling back", {
                sourceThreadId: input.sourceThreadId,
                targetThreadId: input.threadId,
                cause: error instanceof Error ? error.message : String(error),
              }).pipe(Effect.as(null)),
            ),
          );
        if (!forked) {
          return null;
        }

        const forkedSession = (yield* adapter.listSessions()).find(
          (session) => session.threadId === input.threadId,
        );
        // Register the fork under a committed lifecycle generation. Writing the
        // binding outside the coordinator lands it on the directory's "legacy"
        // default while the coordinator has no entry for the thread at all, and
        // any later generation adoption from that row (session recovery, the
        // startup broadcast) diverges from what the live runtime stamps —
        // silently discarding the thread's runtime events.
        yield* lifecycle.run(input.threadId, (lease) =>
          Effect.gen(function* () {
            if (forkedSession) {
              yield* upsertSessionBinding(forkedSession, input.threadId, {
                lifecycleGeneration: lease.generation,
                ...(input.modelSelection !== undefined
                  ? { modelSelection: input.modelSelection }
                  : {}),
                ...(effectiveProviderOptions !== undefined
                  ? { providerOptions: effectiveProviderOptions }
                  : {}),
                lastRuntimeEvent: "provider.thread.forked",
                lastRuntimeEventAt: new Date().toISOString(),
              });
            } else {
              yield* directory.upsert({
                threadId: input.threadId,
                provider: adapter.provider,
                runtimeMode: input.runtimeMode,
                status: "stopped",
                lifecycleGeneration: lease.generation,
                ...(forked.resumeCursor !== undefined ? { resumeCursor: forked.resumeCursor } : {}),
                runtimePayload: {
                  cwd: targetCwd ?? null,
                  model: input.modelSelection?.model ?? null,
                  activeTurnId: null,
                  lastError: null,
                  ...(input.modelSelection !== undefined
                    ? { modelSelection: input.modelSelection }
                    : {}),
                  ...(effectiveProviderOptions !== undefined
                    ? { providerOptions: effectiveProviderOptions }
                    : {}),
                  lastRuntimeEvent: "provider.thread.forked",
                  lastRuntimeEventAt: new Date().toISOString(),
                },
              });
            }
            lease.commit();
          }),
        );
        return forked;
      });

    const sendTurn: ProviderServiceShape["sendTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.sendTurn",
          schema: ProviderSendTurnInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          attachments: carryProviderAttachmentPaths(rawInput, parsed.attachments ?? []),
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            "Either input text or at least one attachment is required",
          );
        }
        return yield* runTurnDispatch(input.threadId, (generation) =>
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.sendTurn",
              allowRecovery: true,
            });
            const turn = yield* routed.adapter.sendTurn(input);
            const persistenceInput: StartedTurnPersistenceInput = {
              threadId: input.threadId,
              provider: routed.adapter.provider,
              turnId: String(turn.turnId),
              generation,
              ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
              ...(input.modelSelection !== undefined
                ? { modelSelection: input.modelSelection }
                : {}),
              lastRuntimeEvent: "provider.sendTurn",
            };
            rememberSuccessfulTurnDispatch(persistenceInput);
            // A turn can settle before this write lands (e.g. a pre-start
            // cancellation completes inside the adapter fork); re-marking the
            // thread as running then would strand it with a stale active turn.
            // Durable metadata (model selection, resume cursor) is still
            // persisted — status stays untouched (upsert keeps the existing
            // value when omitted) and runtimePayload merges per key. The
            // binding-write lock makes the check and the write atomic with the
            // runtime-event handler, so a terminal event cannot slip between
            // them and then be overwritten.
            yield* persistStartedTurn(persistenceInput);
            return turn;
          }),
        );
      });

    const steerTurn: ProviderServiceShape["steerTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.steerTurn",
          schema: ProviderSteerTurnInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          attachments: carryProviderAttachmentPaths(rawInput, parsed.attachments ?? []),
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.steerTurn",
            "Either input text or at least one attachment is required",
          );
        }
        return yield* runTurnDispatch(input.threadId, (generation) =>
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.steerTurn",
              allowRecovery: true,
            });
            if (
              !routed.adapter.steerTurn ||
              routed.adapter.capabilities.supportsTurnSteering !== true
            ) {
              return yield* toValidationError(
                "ProviderService.steerTurn",
                `Provider '${routed.adapter.provider}' does not support steering an active turn.`,
              );
            }
            const turn = yield* routed.adapter.steerTurn(input);
            const persistenceInput: StartedTurnPersistenceInput = {
              threadId: input.threadId,
              provider: routed.adapter.provider,
              turnId: String(turn.turnId),
              generation,
              ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
              ...(input.modelSelection !== undefined
                ? { modelSelection: input.modelSelection }
                : {}),
              lastRuntimeEvent: "provider.steerTurn",
            };
            rememberSuccessfulTurnDispatch(persistenceInput);
            yield* persistStartedTurn(persistenceInput);
            return turn;
          }),
        );
      });

    const startReview: ProviderServiceShape["startReview"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.startReview",
          schema: ProviderStartReviewInput,
          payload: rawInput,
        });

        return yield* runTurnDispatch(input.threadId, (generation) =>
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.startReview",
              allowRecovery: true,
            });
            if (!routed.adapter.startReview) {
              return yield* toValidationError(
                "ProviderService.startReview",
                `Provider '${routed.adapter.provider}' does not support native review.`,
              );
            }

            const turn = yield* routed.adapter.startReview(input);
            const persistenceInput: StartedTurnPersistenceInput = {
              threadId: input.threadId,
              provider: routed.adapter.provider,
              turnId: String(turn.turnId),
              generation,
              ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
              lastRuntimeEvent: "provider.startReview",
            };
            rememberSuccessfulTurnDispatch(persistenceInput);
            yield* persistStartedTurn(persistenceInput);
            return turn;
          }),
        );
      });

    const interruptTurn: ProviderServiceShape["interruptTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.interruptTurn",
          schema: ProviderInterruptTurnInput,
          payload: rawInput,
        });
        let rotationStarted = false;
        // Urgent: an interrupt is the user's only escape hatch from a wedged
        // turn, so it must not queue behind a lifecycle mutation that hangs.
        const runInterrupt =
          input.providerThreadId === undefined ? lifecycle.runCurrentUrgent : lifecycle.runCurrent;
        const interruptActiveTurn = runInterrupt(input.threadId, (currentGeneration) =>
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.interruptTurn",
              allowRecovery: false,
            });
            if (!routed.isActive) {
              return yield* toValidationError(
                "ProviderService.interruptTurn",
                `Cannot interrupt thread '${input.threadId}' because its provider runtime is not active.`,
              );
            }

            const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
            if (!binding) {
              return yield* toValidationError(
                "ProviderService.interruptTurn",
                `Cannot interrupt thread '${input.threadId}' without a persisted provider binding.`,
              );
            }
            const bindingGeneration = binding.lifecycleGeneration ?? currentGeneration;
            if (
              currentGeneration !== undefined &&
              bindingGeneration !== undefined &&
              bindingGeneration !== currentGeneration
            ) {
              return yield* toValidationError(
                "ProviderService.interruptTurn",
                `Cannot interrupt stale provider generation '${bindingGeneration}' for thread '${input.threadId}'.`,
              );
            }

            const boundActiveTurnId = runtimeActiveTurnId(binding.runtimePayload);
            const providerTurnId =
              input.providerThreadId !== undefined ? input.turnId : boundActiveTurnId;
            if (providerTurnId === undefined) {
              return yield* toValidationError(
                "ProviderService.interruptTurn",
                `Cannot interrupt thread '${input.threadId}' because no exact active provider turn is bound.`,
              );
            }
            if (
              input.providerThreadId === undefined &&
              input.turnId !== undefined &&
              input.turnId !== providerTurnId
            ) {
              yield* Effect.logWarning(
                "provider interrupt received stale projection turn; using authoritative active turn",
                {
                  threadId: input.threadId,
                  requestedTurnId: input.turnId,
                  activeTurnId: providerTurnId,
                  provider: routed.adapter.provider,
                },
              );
            }

            const targetedInterruptKey =
              input.providerThreadId === undefined
                ? undefined
                : targetedChildInterruptKey(
                    input.threadId,
                    TurnId.makeUnsafe(providerTurnId),
                    input.providerThreadId,
                  );
            if (targetedInterruptKey !== undefined) {
              const previousTargetedInterrupt =
                targetedChildInterruptTombstones.get(targetedInterruptKey);
              if (
                previousTargetedInterrupt?.state === "confirmed" ||
                (previousTargetedInterrupt?.state === "uncertain" &&
                  previousTargetedInterrupt.lifecycleGeneration !== bindingGeneration)
              ) {
                return;
              }
            }

            if (input.providerThreadId !== undefined) {
              // Child and parent share one provider MCP transport. The adapter
              // revokes that lease while stopping the child; persist the need
              // to replace the still-running parent runtime before its next
              // turn receives browser authority.
              yield* withBindingWriteLock(
                input.threadId,
                directory.upsert({
                  threadId: input.threadId,
                  provider: binding.provider,
                  runtimePayload: {
                    [AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED]: true,
                    lastRuntimeEvent: "provider.subagentInterruptedCredentialRotationRequired",
                    lastRuntimeEventAt: new Date().toISOString(),
                  },
                }),
              );
              if (targetedInterruptKey !== undefined) {
                // The adapter revokes the shared bearer before attempting its
                // provider-native child stop. Tombstone at the same admission
                // boundary: even an uncertain native failure must not let a
                // duplicate stale Stop revoke the replacement runtime's lease.
                rememberTargetedChildInterrupt(targetedInterruptKey, {
                  lifecycleGeneration: bindingGeneration,
                  state: "uncertain",
                });
              }
            }

            rotationStarted = input.providerThreadId === undefined;
            yield* routed.adapter.interruptTurn(
              input.threadId,
              TurnId.makeUnsafe(providerTurnId),
              input.providerThreadId,
            );
            if (targetedInterruptKey !== undefined) {
              rememberTargetedChildInterrupt(targetedInterruptKey, {
                lifecycleGeneration: bindingGeneration,
                state: "confirmed",
              });
            }
          }),
        );
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            // Publish and settle the fence inside the same masked region. If
            // this interrupt fiber is itself cancelled while runtime teardown
            // is blocked, deferred interruption must not skip resolve/delete.
            const fence = yield* acquireProviderInterruptionFence(input.threadId);
            const rotationExit = yield* Effect.exit(
              input.providerThreadId === undefined
                ? interruptActiveTurn.pipe(
                    Effect.andThen(
                      stopRuntimeSessionInternal({ threadId: input.threadId }, undefined, {
                        requireAgentGatewayCredentialRotation: true,
                      }),
                    ),
                  )
                : interruptActiveTurn,
            );
            if (Exit.isFailure(rotationExit)) {
              if (rotationStarted) {
                fence.failure = Cause.pretty(rotationExit.cause);
              } else if (providerInterruptionFences.get(input.threadId) === fence) {
                providerInterruptionFences.delete(input.threadId);
              }
              fence.resolve();
              return yield* Effect.failCause(rotationExit.cause);
            }
            if (providerInterruptionFences.get(input.threadId) === fence) {
              providerInterruptionFences.delete(input.threadId);
            }
            fence.resolve();
          }),
        );
      });

    const stopTask: ProviderServiceShape["stopTask"] = (rawInput) =>
      decodeInputOrValidationError({
        operation: "ProviderService.stopTask",
        schema: ProviderStopTaskInput,
        payload: rawInput,
      }).pipe(
        Effect.flatMap((input) =>
          lifecycle.runCurrent(input.threadId, () =>
            Effect.gen(function* () {
              const routed = yield* resolveRoutableSession({
                threadId: input.threadId,
                operation: "ProviderService.stopTask",
                allowRecovery: false,
              });
              if (!routed.isActive) {
                return yield* toValidationError(
                  "ProviderService.stopTask",
                  `Cannot stop provider task '${input.taskId}' because the provider runtime is not active.`,
                );
              }
              if (!routed.adapter.stopTask) {
                return yield* toValidationError(
                  "ProviderService.stopTask",
                  `Provider '${routed.adapter.provider}' does not support stopping a provider task.`,
                );
              }
              yield* routed.adapter.stopTask(input.threadId, input.taskId);
            }),
          ),
        ),
      );

    const backgroundTask: ProviderServiceShape["backgroundTask"] = (rawInput) =>
      decodeInputOrValidationError({
        operation: "ProviderService.backgroundTask",
        schema: ProviderBackgroundTaskInput,
        payload: rawInput,
      }).pipe(
        Effect.flatMap((input) =>
          lifecycle.runCurrent(input.threadId, () =>
            Effect.gen(function* () {
              const routed = yield* resolveRoutableSession({
                threadId: input.threadId,
                operation: "ProviderService.backgroundTask",
                allowRecovery: false,
              });
              if (!routed.isActive) {
                return yield* toValidationError(
                  "ProviderService.backgroundTask",
                  `Cannot background provider task '${input.toolUseId}' because the provider runtime is not active.`,
                );
              }
              if (!routed.adapter.backgroundTask) {
                return yield* toValidationError(
                  "ProviderService.backgroundTask",
                  `Provider '${routed.adapter.provider}' does not support backgrounding a provider task.`,
                );
              }
              yield* routed.adapter.backgroundTask(input.threadId, input.toolUseId);
            }),
          ),
        ),
      );

    const steerSubagent: ProviderServiceShape["steerSubagent"] = (rawInput) =>
      decodeInputOrValidationError({
        operation: "ProviderService.steerSubagent",
        schema: ProviderSteerSubagentInput,
        payload: rawInput,
      }).pipe(
        Effect.flatMap((input) =>
          lifecycle.runCurrent(input.threadId, () =>
            Effect.gen(function* () {
              const routed = yield* resolveRoutableSession({
                threadId: input.threadId,
                operation: "ProviderService.steerSubagent",
                allowRecovery: false,
              });
              if (!routed.isActive) {
                return yield* toValidationError(
                  "ProviderService.steerSubagent",
                  `Cannot message subagent '${input.providerThreadId}' because the provider runtime is not active.`,
                );
              }
              if (!routed.adapter.steerSubagent) {
                return yield* toValidationError(
                  "ProviderService.steerSubagent",
                  `Provider '${routed.adapter.provider}' does not support messaging a running subagent.`,
                );
              }
              const attachments = carryProviderAttachmentPaths(rawInput, input.attachments ?? []);
              yield* routed.adapter.steerSubagent(input.threadId, input.providerThreadId, {
                input: input.input ?? "",
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(input.skills !== undefined ? { skills: input.skills } : {}),
                ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
              });
            }),
          ),
        ),
      );

    const respondToInteraction = (response: InteractionResponse) => {
      const { input } = response;
      const operation =
        response.kind === "approval"
          ? "ProviderService.respondToRequest"
          : "ProviderService.respondToUserInput";
      return lifecycle.runCurrent(input.threadId, (currentGeneration) =>
        Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation,
            allowRecovery: false,
          });
          if (!routed.isActive) {
            return yield* toValidationError(
              operation,
              `Cannot respond to request '${input.requestId}' because the provider runtime is not active.`,
            );
          }
          const routedGeneration = routed.lifecycleGeneration ?? currentGeneration;
          if (
            routedGeneration !== undefined &&
            routedGeneration !== "legacy" &&
            input.lifecycleGeneration === undefined
          ) {
            return yield* toValidationError(
              operation,
              `Cannot respond to request '${input.requestId}' without its provider lifecycle generation.`,
            );
          }
          if (
            input.lifecycleGeneration !== undefined &&
            input.lifecycleGeneration !== routedGeneration
          ) {
            return yield* toValidationError(
              operation,
              `Cannot respond to stale request '${input.requestId}' from provider generation '${input.lifecycleGeneration}'.`,
            );
          }
          if (response.kind === "approval") {
            yield* routed.adapter.respondToRequest(
              input.threadId,
              input.requestId,
              response.input.decision,
            );
            return;
          }
          yield* routed.adapter.respondToUserInput(
            input.threadId,
            input.requestId,
            response.input.answers,
          );
        }),
      );
    };

    const respondToRequest: ProviderServiceShape["respondToRequest"] = (rawInput) =>
      decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      }).pipe(Effect.flatMap((input) => respondToInteraction({ kind: "approval", input })));

    const respondToUserInput: ProviderServiceShape["respondToUserInput"] = (rawInput) =>
      decodeInputOrValidationError({
        operation: "ProviderService.respondToUserInput",
        schema: ProviderRespondToUserInputInput,
        payload: rawInput,
      }).pipe(Effect.flatMap((input) => respondToInteraction({ kind: "userInput", input })));

    const stopSession: ProviderServiceShape["stopSession"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stopSession",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        yield* waitForRuntimeIdleStop(input.threadId);
        clearRuntimeIdleTimer(input.threadId);
        return yield* lifecycle.run(input.threadId, (lease) =>
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.stopSession",
              allowRecovery: false,
            }).pipe(
              Effect.catchTag("ProviderValidationError", (error) =>
                error.issue.includes("no persisted provider binding exists")
                  ? Effect.succeed(null)
                  : Effect.fail(error),
              ),
            );
            if (routed === null) {
              clearLiveRuntimeTasks(input.threadId);
              lease.retire();
              retireRuntimeIdleGeneration(input.threadId);
              return;
            }
            // Adapter stop is an idempotent cleanup barrier. Even when the
            // routable session is inactive, the adapter may retain ownership
            // from a teardown whose exit proof previously failed.
            yield* routed.adapter.stopSession(input.threadId);
            clearLiveRuntimeTasks(input.threadId);
            yield* waitForRuntimeIdleStop(input.threadId);
            yield* withBindingWriteLock(input.threadId, directory.remove(input.threadId));
            providerInterruptionFences.delete(input.threadId);
            lease.retire();
            retireRuntimeIdleGeneration(input.threadId);
          }),
        );
      });

    const stopRuntimeSessionInternal = (
      rawInput: StopRuntimeSessionInput,
      expectedIdleGeneration?: symbol,
      options?: { readonly requireAgentGatewayCredentialRotation?: boolean },
    ): StopRuntimeSessionEffect =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stopRuntimeSession",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        const isExpectedIdleStopCurrent = () =>
          expectedIdleGeneration === undefined ||
          isRuntimeIdleGenerationCurrent(input.threadId, expectedIdleGeneration);
        if (expectedIdleGeneration === undefined) {
          yield* waitForRuntimeIdleStop(input.threadId);
          clearRuntimeIdleTimer(input.threadId);
        } else if (!isExpectedIdleStopCurrent()) {
          return;
        }
        return yield* lifecycle.run(input.threadId, (lease) =>
          Effect.gen(function* () {
            if (!isExpectedIdleStopCurrent()) {
              return;
            }
            const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
            if (!binding || !isExpectedIdleStopCurrent()) {
              return;
            }
            const adapter = yield* registry.getByProvider(binding.provider);
            const hasActiveSession = yield* adapter.hasSession(input.threadId);
            let resumeCursor = binding.resumeCursor;
            if (!isExpectedIdleStopCurrent()) {
              return;
            }
            if (hasActiveSession) {
              const activeSessions = yield* adapter.listSessions();
              const activeSession = activeSessions.find(
                (session) => session.threadId === input.threadId,
              );
              if (activeSession?.resumeCursor !== undefined) {
                resumeCursor = activeSession.resumeCursor;
              }
              yield* adapter.stopSession(input.threadId);
            }
            if (!isExpectedIdleStopCurrent()) {
              return;
            }
            clearLiveRuntimeTasks(input.threadId);
            yield* withBindingWriteLock(
              input.threadId,
              directory.upsert({
                threadId: input.threadId,
                provider: binding.provider,
                ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
                ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
                status: "stopped",
                lifecycleGeneration: lease.generation,
                resumeCursor,
                runtimePayload: {
                  ...runtimePayloadRecord(binding.runtimePayload),
                  activeTurnId: null,
                  lastRuntimeEvent:
                    options?.requireAgentGatewayCredentialRotation === true
                      ? "provider.interruptRuntimeFenced"
                      : "provider.stopRuntimeSession",
                  lastRuntimeEventAt: new Date().toISOString(),
                  lifecycleGeneration: lease.generation,
                  ...(options?.requireAgentGatewayCredentialRotation === true
                    ? { [AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED]: true }
                    : {}),
                },
              }),
            );
            lease.commit();
            retireRuntimeIdleGeneration(input.threadId, expectedIdleGeneration);
          }),
        );
      });

    const stopRuntimeSession: StopRuntimeSession = (rawInput) =>
      stopRuntimeSessionInternal(rawInput);

    const hasLiveRuntimeTasks: NonNullable<ProviderServiceShape["hasLiveRuntimeTasks"]> = (input) =>
      Effect.sync(() => (liveRuntimeTaskIds.get(input.threadId)?.size ?? 0) > 0);

    stopIdleRuntimeSession = (threadId, generation) => {
      const stopEffect = Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        if (!binding) {
          retireRuntimeIdleGeneration(threadId, generation);
          return;
        }

        const adapter = yield* registry.getByProvider(binding.provider);
        const sessions = yield* adapter.listSessions();
        const session = sessions.find((entry) => entry.threadId === threadId);
        const bindingRuntimePayload = runtimePayloadRecord(binding.runtimePayload);
        if (
          bindingRuntimePayload.activeTurnId !== null &&
          bindingRuntimePayload.activeTurnId !== undefined
        ) {
          retireRuntimeIdleGeneration(threadId, generation);
          return;
        }
        const isIdleReadySession =
          session?.status === "ready" ||
          (session?.status === "running" &&
            binding.status === "stopped" &&
            (bindingRuntimePayload.lastRuntimeEvent === "thread.state.changed" ||
              bindingRuntimePayload.lastRuntimeEvent === "provider.compactThread"));
        if (
          !session ||
          !isIdleReadySession ||
          session.activeTurnId !== undefined ||
          (liveRuntimeTaskIds.get(threadId)?.size ?? 0) > 0
        ) {
          retireRuntimeIdleGeneration(threadId, generation);
          return;
        }
        // Live adapter snapshots can temporarily omit cursors even though the
        // directory already persisted one from an earlier runtime event.
        if (!hasResumeCursor(session.resumeCursor) && !hasResumeCursor(binding.resumeCursor)) {
          retireRuntimeIdleGeneration(threadId, generation);
          return;
        }
        if (!isRuntimeIdleGenerationCurrent(threadId, generation)) {
          return;
        }

        yield* stopRuntimeSessionInternal({ threadId }, generation);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.idle_stop_failed", {
            threadId,
            cause,
          }),
        ),
      );
      const stopPromise = Effect.runPromise(stopEffect).finally(() => {
        if (runtimeIdleStopsInFlight.get(threadId) === stopPromise) {
          runtimeIdleStopsInFlight.delete(threadId);
        }
      });
      runtimeIdleStopsInFlight.set(threadId, stopPromise);
    };

    const clearSessionResumeCursor: NonNullable<
      ProviderServiceShape["clearSessionResumeCursor"]
    > = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.clearSessionResumeCursor",
          schema: ClearSessionResumeCursorInput,
          payload: rawInput,
        });
        yield* waitForRuntimeIdleStop(input.threadId);
        clearRuntimeIdleTimer(input.threadId);
        // Share the runtime-event binding lock so a delayed session.exited
        // update cannot restore the stale cursor after this explicit clear.
        yield* lifecycle.run(input.threadId, (lease) =>
          withBindingWriteLock(
            input.threadId,
            Effect.gen(function* () {
              const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
              if (!binding) {
                return undefined;
              }
              const adapter = yield* registry.getByProvider(binding.provider);
              const hasActiveSession = yield* adapter.hasSession(input.threadId);
              const preserveActive = hasActiveSession && input.preserveActiveRuntime === true;
              if (hasActiveSession && !preserveActive) {
                yield* adapter.stopSession(input.threadId);
              }
              if (!preserveActive) {
                clearLiveRuntimeTasks(input.threadId);
              }
              // A preserved runtime keeps stamping its events with the
              // generation it was started under, so clearing the cursor must
              // not re-label the thread with a generation that runtime will
              // never emit.
              const effectiveGeneration = preserveActive
                ? (binding.lifecycleGeneration ?? lease.generation)
                : lease.generation;
              yield* directory.upsert({
                threadId: input.threadId,
                provider: binding.provider,
                ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
                ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
                status: preserveActive ? (binding.status ?? "running") : "stopped",
                lifecycleGeneration: effectiveGeneration,
                resumeCursor: null,
                runtimePayload: {
                  ...runtimePayloadRecord(binding.runtimePayload),
                  ...(preserveActive ? {} : { activeTurnId: null }),
                  lifecycleGeneration: effectiveGeneration,
                },
              });
              lease.adopt(effectiveGeneration);
              return binding.provider;
            }),
          ),
        );
        yield* waitForRuntimeIdleStop(input.threadId);
        retireRuntimeIdleGeneration(input.threadId);
      });

    const listSessions: ProviderServiceShape["listSessions"] = () =>
      Effect.gen(function* () {
        const activeSessions = (yield* Effect.forEach(adapters, (adapter) =>
          adapter.listSessions(),
        )).flatMap((sessions) => sessions);
        const persistedBindings = yield* directory.listThreadIds().pipe(
          Effect.flatMap((threadIds) =>
            Effect.forEach(
              threadIds,
              (threadId) =>
                directory
                  .getBinding(threadId)
                  .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
        );
        const bindingsByThreadId = new Map(
          EffectArray.getSomes(persistedBindings).map(
            (binding) => [binding.threadId, binding] as const,
          ),
        );

        return activeSessions.map((session) => {
          const binding = bindingsByThreadId.get(session.threadId);
          if (!binding) {
            return session;
          }

          const overrides: {
            resumeCursor?: ProviderSession["resumeCursor"];
            runtimeMode?: ProviderSession["runtimeMode"];
          } = {};
          if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
            overrides.resumeCursor = binding.resumeCursor;
          }
          if (binding.runtimeMode !== undefined) {
            overrides.runtimeMode = binding.runtimeMode;
          }
          return Object.assign({}, session, overrides);
        });
      });

    const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider) =>
      registry.getByProvider(provider).pipe(Effect.map((adapter) => adapter.capabilities));

    const rollbackConversation: ProviderServiceShape["rollbackConversation"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.rollbackConversation",
          schema: ProviderRollbackConversationInput,
          payload: rawInput,
        });
        if (input.numTurns === 0) {
          return;
        }
        yield* runIdleSensitiveProviderWork(
          input.threadId,
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.rollbackConversation",
              // Restart-based rollback only needs the persisted binding and must
              // not replay the stale native cursor merely to close it again.
              allowRecovery: false,
            });
            if (routed.adapter.capabilities.conversationRollback === "restart-session") {
              // Some provider protocols can resume but cannot rewind. Clear their
              // native cursor so edit-and-resend cannot continue from stale history;
              // ProviderCommandReactor bootstraps the retained transcript next turn.
              yield* clearSessionResumeCursor({ threadId: input.threadId });
            } else {
              const active = routed.isActive
                ? routed
                : yield* resolveRoutableSession({
                    threadId: input.threadId,
                    operation: "ProviderService.rollbackConversation",
                    allowRecovery: true,
                  });
              yield* active.adapter.rollbackThread(input.threadId, input.numTurns);
            }
          }),
          { scheduleIdleStopOnSuccess: true },
        );
      });

    const compactThread: ProviderServiceShape["compactThread"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.compactThread",
          schema: ProviderCompactThreadInput,
          payload: rawInput,
        });
        yield* runIdleSensitiveProviderWork(
          input.threadId,
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.compactThread",
              allowRecovery: true,
            });
            if (!routed.adapter.compactThread) {
              return yield* toValidationError(
                "ProviderService.compactThread",
                `Context compaction is unavailable for provider '${routed.adapter.provider}'.`,
              );
            }
            yield* routed.adapter.compactThread(input.threadId);
            const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
            if (binding) {
              yield* directory.upsert({
                threadId: input.threadId,
                provider: binding.provider,
                ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
                ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
                status: "stopped",
                resumeCursor: binding.resumeCursor,
                runtimePayload: {
                  ...runtimePayloadRecord(binding.runtimePayload),
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.compactThread",
                  lastRuntimeEventAt: new Date().toISOString(),
                },
              });
            }
          }),
          { scheduleIdleStopOnSuccess: true },
        );
      });

    const runStopAll = () =>
      Effect.gen(function* () {
        const stoppedAt = new Date().toISOString();
        shutdownStartedAt = stoppedAt;
        const runtimeCursorWriteBaseline = runtimeCursorWriteVersion;
        const activeSessionByThreadId = new Map(
          (yield* Effect.forEach(adapters, (adapter) =>
            adapter
              .listSessions()
              .pipe(Effect.map((sessions) => sessions.map((session) => ({ adapter, session })))),
          ))
            .flatMap((sessions) => sessions)
            .map(({ adapter, session }) => [session.threadId, { adapter, session }] as const),
        );
        const activeSessionWrites = yield* Effect.forEach(
          activeSessionByThreadId.values(),
          ({ adapter, session }) =>
            Deferred.make<void>().pipe(Effect.map((started) => ({ adapter, session, started }))),
        );
        const persistActiveSessions = settleConcurrentTeardowns(
          activeSessionWrites,
          ({ adapter, session, started }) =>
            bindingWriteLock.withLockQueued(
              session.threadId,
              Effect.gen(function* () {
                const latestSession = (yield* adapter.listSessions()).find(
                  (candidate) => candidate.threadId === session.threadId,
                );
                const queuedCursorWrite = latestRuntimeCursorWriteByThread.get(session.threadId);
                const queuedResumeCursor =
                  queuedCursorWrite !== undefined &&
                  queuedCursorWrite.version > runtimeCursorWriteBaseline
                    ? queuedCursorWrite.resumeCursor
                    : undefined;
                const stoppedSession = latestSession ?? session;
                const resumeCursor =
                  latestSession?.resumeCursor ?? queuedResumeCursor ?? session.resumeCursor;
                yield* markThreadStopped(
                  session.threadId,
                  stoppedAt,
                  resumeCursor !== undefined && resumeCursor !== stoppedSession.resumeCursor
                    ? { ...stoppedSession, resumeCursor }
                    : stoppedSession,
                );
              }),
              started,
            ),
        );
        const persistInactiveSessions = Effect.gen(function* () {
          const threadIds = yield* directory.listThreadIds();
          yield* Effect.forEach(
            threadIds.filter((threadId) => !activeSessionByThreadId.has(threadId)),
            (threadId) => withBindingWriteLock(threadId, markThreadStopped(threadId, stoppedAt)),
          );
        });
        const stopAdapters = Effect.forEach(
          activeSessionWrites,
          ({ started }) => Deferred.await(started),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.andThen(settleConcurrentTeardowns(adapters, (adapter) => adapter.stopAll())));

        // Each active-session write signals after it is queued on its per-thread
        // lock. Provider teardown can therefore begin without waiting for an
        // earlier slow write, while terminal events still queue behind the stop
        // snapshot and become the final writer.
        const shutdownWork: ReadonlyArray<
          Effect.Effect<void, ProviderAdapterError | ProviderSessionDirectoryWriteError, never>
        > = [persistActiveSessions, persistInactiveSessions, stopAdapters];
        yield* settleConcurrentTeardowns(shutdownWork, (teardown) => teardown);
      });

    const awaitRuntimeEventFanoutDrained: Effect.Effect<void> = Effect.suspend(() =>
      PubSub.isEmpty(runtimeEventPubSub).pipe(
        Effect.flatMap((empty) =>
          empty
            ? Effect.void
            : Effect.yieldNow.pipe(Effect.andThen(awaitRuntimeEventFanoutDrained)),
        ),
      ),
    );

    const closeRuntimeEvents = yield* Effect.cached(
      Effect.uninterruptible(
        Effect.sync(() => {
          for (const timer of runtimeIdleTimers.values()) {
            clearTimeout(timer);
          }
          runtimeIdleTimers.clear();
          for (const threadId of new Set([
            ...liveRuntimeTaskIds.keys(),
            ...runtimeTaskSettlementWaiters.keys(),
          ])) {
            clearLiveRuntimeTasks(threadId);
          }
          runtimeIdleGenerations.clear();
          runtimeIdleStopsInFlight.clear();
          stopIdleRuntimeSession = null;
        }).pipe(
          Effect.andThen(
            runStopAll().pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to stop provider sessions", {
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          ),
          // Keep subscriptions alive until adapters have emitted terminal
          // events. Closing waits for an in-flight canonical event because its
          // persistence and publication section is uninterruptible.
          Effect.andThen(Scope.close(runtimeEventProducerScope, Exit.void)),
          // Downstream subscribers transfer every published event into their
          // own drainable workers before the publication owner is shut down.
          Effect.andThen(awaitRuntimeEventFanoutDrained),
          Effect.andThen(PubSub.shutdown(runtimeEventPubSub)),
        ),
      ),
    );

    yield* Effect.addFinalizer(() => closeRuntimeEvents);

    return {
      startSession,
      startSessionWithOutcome,
      completePriorTranscriptBootstrap,
      forkThread,
      sendTurn,
      steerTurn,
      startReview,
      interruptTurn,
      stopTask,
      backgroundTask,
      steerSubagent,
      respondToRequest,
      respondToUserInput,
      stopSession,
      stopRuntimeSession,
      hasLiveRuntimeTasks,
      clearSessionResumeCursor,
      listSessions,
      getCapabilities,
      rollbackConversation,
      compactThread,
      closeRuntimeEvents,
      getRuntimeEventPumpHealth: () => Effect.sync(runtimeEventPumpHealth.snapshot),
      // Each access creates a fresh PubSub subscription so that multiple
      // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
      // independently receive all runtime events.
      get streamEvents(): ProviderServiceShape["streamEvents"] {
        return Stream.fromPubSub(runtimeEventPubSub).pipe(Stream.map(({ event }) => event));
      },
      ...(options?.persistRuntimeEvent === undefined
        ? {}
        : {
            get streamPersistedEvents(): NonNullable<
              ProviderServiceShape["streamPersistedEvents"]
            > {
              return Stream.fromPubSub(runtimeEventPubSub).pipe(
                Stream.filter(
                  (
                    published,
                  ): published is PublishedRuntimeEvent & {
                    readonly persisted: PersistedProviderRuntimeEvent;
                  } => published.persisted !== undefined,
                ),
                Stream.map(({ persisted }) => persisted),
              );
            },
          }),
    } satisfies ProviderServiceShape;
  });

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}

/** Production provider service: journal each canonical event before live fan-out. */
export function makeDurableProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(
    ProviderService,
    Effect.gen(function* () {
      const runtimeEvents = yield* ProviderRuntimeEventRepository;
      return yield* makeProviderService({
        ...options,
        persistRuntimeEvent: (event) => runtimeEvents.append(event),
        quarantineRuntimeEvent: (event, cause) =>
          runtimeEvents
            .append({
              type: "runtime.warning",
              eventId: EventId.makeUnsafe(randomUUID()),
              provider: event.provider,
              threadId: event.threadId,
              createdAt: new Date().toISOString(),
              ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
              ...(event.lifecycleGeneration !== undefined
                ? { lifecycleGeneration: event.lifecycleGeneration }
                : {}),
              payload: {
                message: `Quarantined provider runtime event '${event.type}' after a permanent journal failure.`,
                detail: {
                  originalEventId: event.eventId,
                  originalEventType: event.type,
                  ...summarizeProviderRuntimeQuarantineCause(cause),
                },
              },
            })
            .pipe(Effect.asVoid),
      });
    }),
  );
}
