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
  DEFAULT_PROVIDER_PROFILE_ID,
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
  type ProviderSession,
  type ProviderTarget,
} from "@synara/contracts";
import {
  providerSupportsAutoRuntimeMode,
  unsupportedAutoRuntimeModeMessage,
} from "@synara/shared/runtimeMode";
import { createHash, randomUUID } from "node:crypto";
import {
  Array as EffectArray,
  Cause,
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
import {
  providerTargetFromModelSelection,
  providerTargetFromSource,
  providerTargetsEqual,
} from "@synara/shared/providerTarget";

import { ProviderValidationError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
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
import {
  makeProviderRuntimeEventPumpHealthRegistry,
  runProviderRuntimeEventPump,
} from "../providerRuntimeEventPump.ts";
import {
  AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED,
  AGENT_GATEWAY_TURN_AUTHORITY_RETIRED,
} from "../../agentGateway/sessionLease.ts";
import {
  resolveDefaultProviderProfile,
  type ResolveProviderProfile,
} from "../providerProfileResolver.ts";

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
  /** Test/embedding override. Production accepts only the server-owned default profile. */
  readonly resolveProviderProfile?: ResolveProviderProfile;
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

function providerTargetLabel(target: ProviderTarget): string {
  return `${target.provider}/${target.profileId}`;
}

function sessionStartTarget(
  input: ProviderSessionStartInput,
): Effect.Effect<ProviderTarget, ProviderValidationError> {
  const selectionTarget = input.modelSelection
    ? providerTargetFromModelSelection(input.modelSelection)
    : undefined;
  const target = providerTargetFromSource({
    provider: input.provider ?? selectionTarget?.provider ?? "codex",
    profileId: input.profileId ?? selectionTarget?.profileId,
  });

  return selectionTarget && !providerTargetsEqual(target, selectionTarget)
    ? Effect.fail(
        toValidationError(
          "ProviderService.startSession",
          `Session target '${providerTargetLabel(target)}' does not match model selection target '${providerTargetLabel(selectionTarget)}'.`,
        ),
      )
    : Effect.succeed(target);
}

function forkTarget(
  input: ProviderForkThreadInput,
  sourceTarget: ProviderTarget,
): Effect.Effect<ProviderTarget, ProviderValidationError> {
  const selectionTarget = input.modelSelection
    ? providerTargetFromModelSelection(input.modelSelection)
    : undefined;
  const target =
    selectionTarget ??
    providerTargetFromSource({
      provider: sourceTarget.provider,
      profileId: input.profileId ?? sourceTarget.profileId,
    });

  return input.profileId !== undefined && input.profileId !== target.profileId
    ? Effect.fail(
        toValidationError(
          "ProviderService.forkThread",
          `Fork profile '${input.profileId}' does not match model selection target '${providerTargetLabel(target)}'.`,
        ),
      )
    : Effect.succeed(target);
}

function modelSelectionForTarget(input: {
  readonly operation: string;
  readonly modelSelection: ModelSelection | undefined;
  readonly target: ProviderTarget;
}): Effect.Effect<ModelSelection | undefined, ProviderValidationError> {
  if (
    input.modelSelection &&
    !providerTargetsEqual(providerTargetFromModelSelection(input.modelSelection), input.target)
  ) {
    return Effect.fail(
      toValidationError(
        input.operation,
        `Model selection target does not match '${providerTargetLabel(input.target)}'.`,
      ),
    );
  }
  return Effect.succeed(input.modelSelection);
}

function sessionWithExpectedTarget(input: {
  readonly operation: string;
  readonly session: ProviderSession;
  readonly target: ProviderTarget;
}): Effect.Effect<ProviderSession, ProviderValidationError> {
  const actualTarget = providerTargetFromSource(input.session);
  if (!providerTargetsEqual(actualTarget, input.target)) {
    return Effect.fail(
      toValidationError(
        input.operation,
        `Adapter target mismatch: expected '${providerTargetLabel(input.target)}', received '${providerTargetLabel(actualTarget)}'.`,
      ),
    );
  }
  return Effect.succeed({ ...input.session, profileId: input.target.profileId });
}

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  if (session.status === "connecting") return "starting";
  if (session.status === "closed") return "stopped";
  return session.status === "error" ? "error" : "running";
}

interface SessionBindingExtra {
  readonly modelSelection?: unknown;
  readonly providerOptions?: unknown;
  readonly lastRuntimeEvent?: string;
  readonly lastRuntimeEventAt?: string;
  readonly lifecycleGeneration?: string;
  readonly agentGatewayCredentialRotationRequired?: boolean;
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: SessionBindingExtra,
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
    ...(extra?.agentGatewayCredentialRotationRequired !== undefined
      ? {
          [AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED]:
            extra.agentGatewayCredentialRotationRequired,
        }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  const raw = runtimePayloadRecord(runtimePayload).modelSelection;
  return Option.getOrUndefined(Schema.decodeUnknownOption(ModelSelection)(raw));
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

function runtimeEventOwnsBinding(
  event: ProviderRuntimeEvent,
  binding: ProviderRuntimeBinding,
): boolean {
  if (binding.provider !== event.provider) return false;
  if (event.profileId !== undefined && binding.profileId !== event.profileId) return false;
  if (
    event.lifecycleGeneration === undefined &&
    binding.profileId !== DEFAULT_PROVIDER_PROFILE_ID
  ) {
    return false;
  }
  return (
    event.lifecycleGeneration === undefined ||
    binding.lifecycleGeneration === event.lifecycleGeneration
  );
}

function runtimeEventOwnsAdmission(
  event: ProviderRuntimeEvent,
  binding: ProviderRuntimeBinding,
  currentGeneration: string | undefined,
): boolean {
  if (event.lifecycleGeneration === undefined) {
    return runtimeEventOwnsBinding(event, binding);
  }
  if (event.lifecycleGeneration !== currentGeneration) {
    return false;
  }
  // A lifecycle run publishes its new generation before the replacement
  // adapter can emit startup events and before the new binding is durable.
  // During that narrow transition the generation is the ownership proof.
  if (binding.lifecycleGeneration !== currentGeneration) {
    return true;
  }
  return providerTargetsEqual(
    providerTargetFromSource(event),
    providerTargetFromSource(binding),
  );
}

function runtimeEventOwnsUnboundAdmission(event: ProviderRuntimeEvent): boolean {
  if (event.lifecycleGeneration !== undefined) {
    return true;
  }
  return (
    event.profileId === undefined || event.profileId === DEFAULT_PROVIDER_PROFILE_ID
  );
}

function runtimeActiveTurnId(value: unknown): string | undefined {
  const activeTurnId = runtimePayloadRecord(value).activeTurnId;
  return typeof activeTurnId === "string" ? activeTurnId : undefined;
}

function hasResumeCursor(value: unknown): boolean {
  return value !== null && value !== undefined;
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
    const resolveProviderProfile =
      options?.resolveProviderProfile ?? resolveDefaultProviderProfile;
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
    const failedUncommittedSessionRetirements = new Map<
      ThreadId,
      { readonly target: ProviderTarget; readonly failure: string }
    >();
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

    const ensureUncommittedSessionRetirementSettled = (
      threadId: ThreadId,
      operation: string,
    ): Effect.Effect<void, ProviderValidationError> => {
      const failedRetirement = failedUncommittedSessionRetirements.get(threadId);
      return failedRetirement === undefined
        ? Effect.void
        : Effect.fail(
            toValidationError(
              operation,
              `Cannot continue thread '${threadId}' because uncommitted provider target ` +
                `'${providerTargetLabel(failedRetirement.target)}' could not be retired safely: ` +
                `${failedRetirement.failure}. Stop the provider session before retrying.`,
            ),
          );
    };

    const retireUncommittedSession = (input: {
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
      readonly target: ProviderTarget;
      readonly threadId: ThreadId;
      readonly operation: string;
    }): Effect.Effect<boolean> =>
      input.adapter.stopSession(input.threadId).pipe(
        Effect.timeoutOption(PROVIDER_STOP_SESSION_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () => {
              const failure = `cleanup exceeded ${Duration.toMillis(
                PROVIDER_STOP_SESSION_TIMEOUT,
              )}ms`;
              return Effect.sync(() => {
                failedUncommittedSessionRetirements.set(input.threadId, {
                  target: input.target,
                  failure,
                });
              }).pipe(
                Effect.andThen(
                  Effect.logWarning(
                    "provider session cleanup exceeded its deadline after an uncommitted start",
                    {
                      threadId: input.threadId,
                      provider: input.target.provider,
                      profileId: input.target.profileId,
                      operation: input.operation,
                      timeoutMs: Duration.toMillis(PROVIDER_STOP_SESSION_TIMEOUT),
                    },
                  ),
                ),
                Effect.as(false),
              );
            },
            onSome: () =>
              Effect.sync(() => {
                failedUncommittedSessionRetirements.delete(input.threadId);
                return true;
              }),
          }),
        ),
        Effect.catchCause((cause) => {
          const failure = Cause.pretty(cause);
          return Effect.sync(() => {
            failedUncommittedSessionRetirements.set(input.threadId, {
              target: input.target,
              failure,
            });
          }).pipe(
            Effect.andThen(
              Effect.logWarning("failed to retire an uncommitted provider session", {
                threadId: input.threadId,
                provider: input.target.provider,
                profileId: input.target.profileId,
                operation: input.operation,
                cause: failure,
              }),
            ),
            Effect.as(false),
          );
        }),
      );

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
        const waitForUncommittedSessionRetirement =
          ensureUncommittedSessionRetirementSettled(
            threadId,
            "ProviderService.turnDispatch",
          );
        const existingIdleStop = runtimeIdleStopsInFlight.get(threadId);
        const displacedIdleStop = existingIdleStop !== undefined || runtimeIdleTimers.has(threadId);
        const waitForExistingIdleStop =
          existingIdleStop !== undefined ? Effect.promise(() => existingIdleStop) : Effect.void;
        return waitForInterruptionFence.pipe(
          Effect.andThen(waitForUncommittedSessionRetirement),
          Effect.andThen(waitForExistingIdleStop),
          Effect.tap(() => Effect.sync(() => clearRuntimeIdleTimer(threadId))),
          Effect.flatMap(() => waitForRuntimeIdleStop(threadId)),
          Effect.flatMap(() =>
            lifecycle.runCurrent(threadId, () =>
              ensureUncommittedSessionRetirementSettled(
                threadId,
                "ProviderService.turnDispatch",
              ),
            ),
          ),
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
      extra?: SessionBindingExtra,
    ) =>
      directory.upsert({
        threadId,
        provider: session.provider,
        profileId: providerTargetFromSource(session).profileId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(extra?.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: extra.lifecycleGeneration }
          : {}),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
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
            profileId: providerTargetFromSource(session).profileId,
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
        : directory.getTarget(threadId).pipe(
            Effect.flatMap((target) =>
              directory.upsert({
                threadId,
                ...target,
                status: "stopped",
                runtimePayload: {
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.stopAll",
                  lastRuntimeEventAt: stoppedAt,
                },
              }),
            ),
          );

    // Runtime events are where adapters surface provider-native ids; refresh
    // from the live session before idle stop/recovery freezes an old cursor.
    const refreshResumeCursorFromActiveSession = (
      event: ProviderRuntimeEvent,
      binding: ProviderRuntimeBinding,
    ): Effect.Effect<unknown | null | undefined> => {
      if (!shouldRefreshResumeCursorForEvent(event)) {
        return Effect.succeed(binding.resumeCursor);
      }

      return Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(binding.provider);
        const sessions = yield* adapter.listSessions();
        const activeSession = sessions.find((session) => session.threadId === event.threadId);
        const compatibleActiveSession =
          activeSession !== undefined &&
          providerTargetsEqual(
            providerTargetFromSource(activeSession),
            providerTargetFromSource(binding),
          )
            ? activeSession
            : undefined;
        return compatibleActiveSession?.resumeCursor ?? binding.resumeCursor;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.resume_cursor_refresh_failed", {
            threadId: event.threadId,
            provider: binding.provider,
            eventType: event.type,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(binding.resumeCursor)),
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
    // mutex adds no meaningful contention. Creation is synchronous
    // (Semaphore.makeUnsafe), so concurrent callers cannot mint two locks.
    const withBindingWriteLock = makeKeyedLock<ThreadId>().withLock;

    interface StartedTurnPersistenceInput {
      readonly threadId: ThreadId;
      readonly target: ProviderTarget;
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
              ...input.target,
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
            ...input.target,
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
      currentGeneration: string | undefined,
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
        const binding = Option.getOrUndefined(yield* directory.getBinding(event.threadId));
        if (
          binding !== undefined &&
          !runtimeEventOwnsAdmission(event, binding, currentGeneration)
        ) {
          return;
        }
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
        if (binding === undefined) {
          reconcileRuntimeIdleTimer(event);
          return;
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
        const resumeCursor = yield* refreshResumeCursorFromActiveSession(event, binding);

        yield* directory.upsert({
          threadId: event.threadId,
          provider: binding.provider,
          profileId: binding.profileId,
          ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
          ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
          status: runtimeStatusForEvent(event, activeTurnId),
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
          runtimePayload: {
            activeTurnId,
            lastRuntimeEvent: event.type,
            lastRuntimeEventAt: event.createdAt,
            ...(lastError !== undefined ? { lastError } : {}),
            ...(runtimeEventRetiredGatewayTurnAuthority(event)
              ? { [AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED]: true }
              : {}),
          },
        });
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
    const processAdmittedRuntimeEvent = (
      event: ProviderRuntimeEvent,
      currentGeneration: string | undefined,
    ): Effect.Effect<void, unknown> =>
      // Journal before mutating lifecycle/task state. If durable persistence
      // fails, the supervised pump retries while ownership is still current.
      persistCanonicalRuntimeEvent(event).pipe(
        Effect.flatMap((persisted) =>
          Effect.sync(() => {
            if (event.type === "turn.started") {
              reconcileRuntimeIdleTimer(event);
            }
          }).pipe(
            Effect.andThen(updateSessionBindingFromRuntimeEvent(event, currentGeneration)),
            Effect.andThen(publishRuntimeEvent(event, persisted)),
            Effect.andThen(scheduleRetiredGatewaySessionRecovery(event)),
          ),
        ),
      );
    const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void, unknown> =>
      Effect.uninterruptible(
        lifecycle.runStable(event.threadId, (currentGeneration) => {
          if (
            event.lifecycleGeneration !== undefined &&
            currentGeneration !== event.lifecycleGeneration
          ) {
            return Effect.logWarning("provider.session.stale_generation_event_ignored", {
              threadId: event.threadId,
              provider: event.provider,
              eventType: event.type,
              eventLifecycleGeneration: event.lifecycleGeneration,
              currentLifecycleGeneration: currentGeneration,
            });
          }
          return withBindingWriteLock(
            event.threadId,
            directory.getBinding(event.threadId).pipe(
              Effect.flatMap(
                Option.match({
                  // Startup and live-session fallback events can arrive before the
                  // first binding write. Preserve that established admission path.
                  onNone: () =>
                    runtimeEventOwnsUnboundAdmission(event)
                      ? processAdmittedRuntimeEvent(event, currentGeneration)
                      : Effect.logWarning("provider.session.stale_target_event_ignored", {
                          threadId: event.threadId,
                          eventType: event.type,
                          eventProvider: event.provider,
                          eventProfileId: event.profileId,
                          eventLifecycleGeneration: event.lifecycleGeneration,
                        }),
                  // The binding lock and stable generation jointly keep target
                  // replacement outside admission, journal, and publication.
                  onSome: (binding) =>
                    runtimeEventOwnsAdmission(event, binding, currentGeneration)
                      ? processAdmittedRuntimeEvent(event, currentGeneration)
                      : Effect.logWarning("provider.session.stale_target_event_ignored", {
                          threadId: event.threadId,
                          eventType: event.type,
                          eventProvider: event.provider,
                          eventProfileId: event.profileId,
                          eventLifecycleGeneration: event.lifecycleGeneration,
                          bindingProvider: binding.provider,
                          bindingProfileId: binding.profileId,
                          bindingLifecycleGeneration: binding.lifecycleGeneration,
                        }),
                }),
              ),
            ),
          );
        }),
      );

    const recoverSessionForThread = (input: {
      readonly binding: ProviderRuntimeBinding;
      readonly operation: string;
    }) =>
      Effect.gen(function* () {
        const threadId = input.binding.threadId;
        yield* ensureUncommittedSessionRetirementSettled(threadId, input.operation);
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
            yield* ensureUncommittedSessionRetirementSettled(threadId, input.operation);
            let binding = yield* getCurrentBinding();
            let target = yield* resolveProviderProfile({
              operation: input.operation,
              target: providerTargetFromSource(binding),
            });
            const requiresCredentialRotation =
              runtimePayloadRecord(binding.runtimePayload)[
                AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED
              ] === true;
            if (!requiresCredentialRotation) {
              return;
            }

            let adapter = yield* registry.getByProvider(target.provider);
            if (!(yield* adapter.hasSession(threadId))) {
              return;
            }

            yield* waitForLiveRuntimeTasksToSettle(threadId);

            // The drain may have waited for a while. Re-read all durable
            // routing state before stopping anything.
            binding = yield* getCurrentBinding();
            target = yield* resolveProviderProfile({
              operation: input.operation,
              target: providerTargetFromSource(binding),
            });
            if (
              runtimePayloadRecord(binding.runtimePayload)[
                AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED
              ] !== true
            ) {
              return;
            }
            adapter = yield* registry.getByProvider(target.provider);
            if (!(yield* adapter.hasSession(threadId))) {
              return;
            }

            const activeSession = (yield* adapter.listSessions()).find(
              (session) => session.threadId === threadId,
            );
            if (
              !activeSession ||
              !providerTargetsEqual(providerTargetFromSource(activeSession), target)
            ) {
              return yield* toValidationError(
                input.operation,
                `Cannot recover thread '${threadId}' because its active provider target does not match '${providerTargetLabel(target)}'.`,
              );
            }
            if (activeSession?.resumeCursor !== undefined) {
              yield* withBindingWriteLock(
                threadId,
                directory.upsert({
                  threadId,
                  provider: binding.provider,
                  profileId: binding.profileId,
                  resumeCursor: activeSession.resumeCursor,
                }),
              );
            }
            yield* adapter.stopSession(threadId);
          }),
        );

        return yield* lifecycle.run(threadId, (lease) =>
          Effect.gen(function* () {
            yield* ensureUncommittedSessionRetirementSettled(threadId, input.operation);
            const binding = yield* getCurrentBinding();
            const target = yield* resolveProviderProfile({
              operation: input.operation,
              target: providerTargetFromSource(binding),
            });
            const adapter = yield* registry.getByProvider(target.provider);
            const hasPersistedResumeCursor = hasResumeCursor(binding.resumeCursor);
            const requiresCredentialRotation =
              runtimePayloadRecord(binding.runtimePayload)[
                AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED
              ] === true;
            const hasActiveSession = yield* adapter.hasSession(threadId);
            const activeSession = hasActiveSession
              ? (yield* adapter.listSessions()).find((session) => session.threadId === threadId)
              : undefined;
            const activeSessionMatchesTarget =
              activeSession !== undefined &&
              providerTargetsEqual(providerTargetFromSource(activeSession), target);

            // A concurrent recovery may have won between the drain and restart
            // phases. Adopt its fresh runtime instead of replacing it again.
            if (activeSessionMatchesTarget && !requiresCredentialRotation) {
              yield* lease.adopt(binding.lifecycleGeneration ?? "legacy");
              return adapter;
            }

            if (hasActiveSession && !activeSessionMatchesTarget) {
              return yield* toValidationError(
                input.operation,
                `Cannot recover thread '${threadId}' because its active provider target does not match '${providerTargetLabel(target)}'.`,
              );
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
            const persistedModelSelection = yield* modelSelectionForTarget({
              operation: input.operation,
              modelSelection: readPersistedModelSelection(binding.runtimePayload),
              target,
            });
            const persistedProviderOptions = readPersistedProviderOptions(binding.runtimePayload);
            yield* validateAutoRuntimeMode(
              input.operation,
              target.provider,
              binding.runtimeMode ?? "full-access",
            );

            let recoveryStartAttempted = false;
            const resumeAndCommit = Effect.gen(function* () {
              recoveryStartAttempted = true;
              const started = yield* adapter
                .startSession({
                  threadId,
                  provider: target.provider,
                  profileId: target.profileId,
                  lifecycleGeneration: lease.generation,
                  ...(persistedCwd ? { cwd: persistedCwd } : {}),
                  ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
                  ...(persistedProviderOptions
                    ? { providerOptions: persistedProviderOptions }
                    : {}),
                  ...(hasPersistedResumeCursor ? { resumeCursor: binding.resumeCursor } : {}),
                  runtimeMode: binding.runtimeMode ?? "full-access",
                })
                .pipe(Effect.timeoutOption(PROVIDER_START_SESSION_TIMEOUT));
              if (Option.isNone(started)) {
                yield* Effect.logError("provider session recovery exceeded its deadline", {
                  threadId,
                  provider: target.provider,
                  profileId: target.profileId,
                  operation: input.operation,
                  timeoutMs: Duration.toMillis(PROVIDER_START_SESSION_TIMEOUT),
                });
                return yield* toValidationError(
                  input.operation,
                  `Provider '${target.provider}' did not finish recovering within ${Duration.toMillis(
                    PROVIDER_START_SESSION_TIMEOUT,
                  )}ms for thread '${threadId}'.`,
                );
              }
              const resumed = started.value;
              const resumedSession = yield* sessionWithExpectedTarget({
                operation: input.operation,
                session: resumed,
                target,
              });

              yield* withBindingWriteLock(
                threadId,
                upsertSessionBinding(resumedSession, threadId, {
                  lifecycleGeneration: lease.generation,
                  ...(requiresCredentialRotation
                    ? { agentGatewayCredentialRotationRequired: false }
                    : {}),
                }),
              );
              lease.commit();
              return adapter;
            });

            return yield* resumeAndCommit.pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) && recoveryStartAttempted
                  ? retireUncommittedSession({
                      adapter,
                      target,
                      threadId,
                      operation: input.operation,
                    }).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            );
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
            const liveSession = (yield* liveAdapter.listSessions()).find(
              (session) => session.threadId === input.threadId,
            );
            const target = yield* resolveProviderProfile({
              operation: input.operation,
              target: liveSession
                ? providerTargetFromSource(liveSession)
                : providerTargetFromSource({ provider: liveAdapter.provider }),
            });
            return {
              adapter: liveAdapter,
              target,
              isActive: true,
              lifecycleGeneration: lifecycle.currentGeneration(input.threadId),
            } as const;
          }
          return yield* toValidationError(
            input.operation,
            `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
          );
        }
        const target = yield* resolveProviderProfile({
          operation: input.operation,
          target: providerTargetFromSource(binding),
        });
        const adapter = yield* registry.getByProvider(target.provider);

        const hasActiveSession = yield* adapter.hasSession(input.threadId);
        const activeSession = hasActiveSession
          ? (yield* adapter.listSessions()).find((session) => session.threadId === input.threadId)
          : undefined;
        const activeSessionMatchesTarget =
          activeSession !== undefined &&
          providerTargetsEqual(providerTargetFromSource(activeSession), target);
        const requiresCredentialRotation =
          runtimePayloadRecord(binding.runtimePayload)[
            AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED
          ] === true;
        if (
          hasActiveSession &&
          activeSessionMatchesTarget &&
          (!input.allowRecovery || !requiresCredentialRotation)
        ) {
          return {
            adapter,
            target,
            isActive: true,
            lifecycleGeneration: binding.lifecycleGeneration,
          } as const;
        }

        if (hasActiveSession && !activeSessionMatchesTarget && !input.allowRecovery) {
          return yield* toValidationError(
            input.operation,
            `Cannot route thread '${input.threadId}' because its active provider target does not match '${providerTargetLabel(target)}'.`,
          );
        }

        if (!input.allowRecovery) {
          return {
            adapter,
            target,
            isActive: false,
            lifecycleGeneration: binding.lifecycleGeneration,
          } as const;
        }

        return {
          adapter: yield* recoverSessionForThread({ binding, operation: input.operation }),
          target,
          isActive: true,
          lifecycleGeneration: lifecycle.currentGeneration(input.threadId),
        } as const;
      });

    const startSession: ProviderServiceShape["startSession"] = (threadId, rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.startSession",
          schema: ProviderSessionStartInput,
          payload: rawInput,
        });

        const target = yield* sessionStartTarget(parsed).pipe(
          Effect.flatMap((requestedTarget) =>
            resolveProviderProfile({
              operation: "ProviderService.startSession",
              target: requestedTarget,
            }),
          ),
        );
        const input = {
          ...parsed,
          threadId,
          provider: target.provider,
          profileId: target.profileId,
        };
        yield* validateAutoRuntimeMode(
          "ProviderService.startSession",
          input.provider,
          input.runtimeMode,
        );
        yield* ensureUncommittedSessionRetirementSettled(
          threadId,
          "ProviderService.startSession",
        );
        // An explicit start is the recovery authority for a settled interruption
        // fence, but it must never interleave with one still in progress. Capture the
        // exact settled fence so this replacement cannot delete a newer fence
        // that was published while provider startup was running.
        const replacementFence = yield* waitForCurrentInterruptionFence(threadId);
        clearRuntimeIdleTimer(threadId);
        yield* waitForRuntimeIdleStop(threadId);
        return yield* lifecycle.run(threadId, (lease) =>
          Effect.gen(function* () {
            yield* ensureUncommittedSessionRetirementSettled(
              threadId,
              "ProviderService.startSession",
            );
            const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
            const persistedTarget = persistedBinding
              ? providerTargetFromSource(persistedBinding)
              : undefined;
            const compatiblePersistedBinding =
              persistedBinding &&
              persistedTarget &&
              providerTargetsEqual(target, persistedTarget)
                ? persistedBinding
                : undefined;
            const effectiveResumeCursor =
              input.forkSourceResumeCursor !== undefined
                ? undefined
                : (input.resumeCursor ??
                  compatiblePersistedBinding?.resumeCursor);
            const adapterStartInput = { ...input };
            delete adapterStartInput.resumeCursor;
            const effectiveProviderOptions =
              input.providerOptions ??
              (compatiblePersistedBinding
                ? readPersistedProviderOptions(compatiblePersistedBinding.runtimePayload)
                : undefined);
            const adapter = yield* registry.getByProvider(target.provider);
            let replacementStartAttempted = false;
            let replacementCleanupRequired = false;
            let replacementCleanupSucceeded = false;
            const startAndPersistReplacement = Effect.gen(function* () {
              replacementStartAttempted = true;
              // A provider start that never returns holds this thread's
              // lifecycle lock and the caller's command slot forever. Bound it,
              // retire whatever the adapter may have half-spawned, and fail
              // with text the caller can surface as a session error.
              const started = yield* adapter
                .startSession({
                  ...adapterStartInput,
                  lifecycleGeneration: lease.generation,
                  ...(effectiveProviderOptions !== undefined
                    ? { providerOptions: effectiveProviderOptions }
                    : {}),
                  ...(effectiveResumeCursor !== undefined
                    ? { resumeCursor: effectiveResumeCursor }
                    : {}),
                })
                .pipe(Effect.timeoutOption(PROVIDER_START_SESSION_TIMEOUT));
              if (Option.isNone(started)) {
                yield* Effect.logError("provider session start exceeded its deadline", {
                  threadId,
                  provider: input.provider,
                  timeoutMs: Duration.toMillis(PROVIDER_START_SESSION_TIMEOUT),
                });
                return yield* toValidationError(
                  "ProviderService.startSession",
                  `Provider '${input.provider}' did not finish starting within ${Duration.toMillis(
                    PROVIDER_START_SESSION_TIMEOUT,
                  )}ms for thread '${threadId}'.`,
                );
              }
              const startedSession = started.value;
              const session = yield* sessionWithExpectedTarget({
                operation: "ProviderService.startSession",
                session: startedSession,
                target,
              });

              yield* withBindingWriteLock(
                threadId,
                upsertSessionBinding(session, threadId, {
                  modelSelection: input.modelSelection,
                  providerOptions: effectiveProviderOptions,
                  lifecycleGeneration: lease.generation,
                  agentGatewayCredentialRotationRequired: false,
                }),
              );
              lease.commit();
              if (
                replacementFence !== undefined &&
                providerInterruptionFences.get(threadId) === replacementFence
              ) {
                providerInterruptionFences.delete(threadId);
              }

              return session;
            }).pipe(
              Effect.onExit((exit) => {
                replacementCleanupRequired =
                  Exit.isFailure(exit) && replacementStartAttempted;
                return replacementCleanupRequired
                  ? retireUncommittedSession({
                      adapter,
                      target,
                      threadId,
                      operation: "ProviderService.startSession",
                    }).pipe(
                      Effect.tap((cleanupSucceeded) =>
                        Effect.sync(() => {
                          replacementCleanupSucceeded = cleanupSucceeded;
                        }),
                      ),
                      Effect.asVoid,
                    )
                  : Effect.void;
              }),
            );

            if (!persistedBinding || compatiblePersistedBinding) {
              return yield* startAndPersistReplacement;
            }

            const previousTarget = providerTargetFromSource(persistedBinding);
            const previousAdapter = yield* registry.getByProvider(previousTarget.provider);
            if (!(yield* previousAdapter.hasSession(threadId))) {
              return yield* startAndPersistReplacement;
            }

            const previousGeneration = persistedBinding.lifecycleGeneration ?? "legacy";
            const previousModelSelection = yield* modelSelectionForTarget({
              operation: "ProviderService.startSession",
              modelSelection: readPersistedModelSelection(persistedBinding.runtimePayload),
              target: previousTarget,
            });
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
                      // The replacement effect retires any runtime it created
                      // before this rollback restores the exact previous generation.
                      if (replacementCleanupRequired && !replacementCleanupSucceeded) {
                        yield* Effect.logError(
                          "skipping previous provider restoration because replacement cleanup failed",
                          {
                            threadId,
                            previousProvider: previousTarget.provider,
                            replacementProvider: target.provider,
                          },
                        );
                        return;
                      }
                      // Publish the restored generation before starting the
                      // previous runtime: adapters can emit startup events
                      // before startSession returns and before binding upsert.
                      yield* lease.adopt(previousGeneration);
                      let restorationStartAttempted = false;
                      const restorePreviousSession = Effect.gen(function* () {
                        restorationStartAttempted = true;
                        const started = yield* previousAdapter
                          .startSession({
                            threadId,
                            provider: previousTarget.provider,
                            profileId: previousTarget.profileId,
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
                          })
                          .pipe(Effect.timeoutOption(PROVIDER_START_SESSION_TIMEOUT));
                        if (Option.isNone(started)) {
                          return yield* toValidationError(
                            "ProviderService.startSession",
                            `Provider '${previousTarget.provider}' did not finish restoring within ${Duration.toMillis(
                              PROVIDER_START_SESSION_TIMEOUT,
                            )}ms for thread '${threadId}'.`,
                          );
                        }
                        const restoredSession = yield* sessionWithExpectedTarget({
                          operation: "ProviderService.startSession",
                          session: started.value,
                          target: previousTarget,
                        });
                        yield* withBindingWriteLock(
                          threadId,
                          upsertSessionBinding(restoredSession, threadId, {
                            lifecycleGeneration: previousGeneration,
                            modelSelection: previousModelSelection,
                            providerOptions: previousProviderOptions,
                          }),
                        );
                      }).pipe(
                        Effect.onExit((restoreExit) =>
                          Exit.isFailure(restoreExit) && restorationStartAttempted
                            ? retireUncommittedSession({
                                adapter: previousAdapter,
                                target: previousTarget,
                                threadId,
                                operation: "ProviderService.startSession:restorePrevious",
                              }).pipe(Effect.asVoid)
                            : Effect.void,
                        ),
                      );
                      const restoration = yield* Effect.exit(restorePreviousSession);
                      if (Exit.isFailure(restoration)) {
                        yield* Effect.logError(
                          "failed to restore the previous provider after replacement failure",
                          {
                            threadId,
                            previousProvider: previousTarget.provider,
                            previousProfileId: previousTarget.profileId,
                            replacementProvider: target.provider,
                            replacementProfileId: target.profileId,
                            cause: Cause.pretty(restoration.cause),
                          },
                        );
                      }
                    }),
              ),
            );
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

        const sourceBinding = Option.getOrUndefined(
          yield* directory.getBinding(input.sourceThreadId),
        );
        if (!sourceBinding) {
          return null;
        }

        if (Option.isSome(yield* directory.getBinding(input.threadId))) {
          return null;
        }

        const sourceTarget = yield* resolveProviderProfile({
          operation: "ProviderService.forkThread",
          target: providerTargetFromSource(sourceBinding),
        });
        const target = yield* forkTarget(input, sourceTarget);
        if (!providerTargetsEqual(sourceTarget, target)) {
          return null;
        }

        const effectiveProviderOptions =
          input.providerOptions ?? readPersistedProviderOptions(sourceBinding.runtimePayload);
        const sourceCwd = readPersistedCwd(sourceBinding.runtimePayload);
        yield* validateAutoRuntimeMode(
          "ProviderService.forkThread",
          sourceTarget.provider,
          input.runtimeMode,
        );

        const adapter = yield* registry.getByProvider(sourceTarget.provider);
        if (!adapter.forkThread) {
          return null;
        }

        const forked = yield* adapter
          .forkThread({
            ...input,
            threadId: input.threadId,
            sourceThreadId: input.sourceThreadId,
            profileId: target.profileId,
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
        const targetSession = forkedSession
          ? yield* sessionWithExpectedTarget({
              operation: "ProviderService.forkThread",
              session: forkedSession,
              target,
            }).pipe(
              Effect.tapError(() => adapter.stopSession(input.threadId).pipe(Effect.ignore)),
            )
          : undefined;
        // Register the fork under a committed lifecycle generation. Writing the
        // binding outside the coordinator lands it on the directory's "legacy"
        // default while the coordinator has no entry for the thread at all, and
        // any later generation adoption from that row (session recovery, the
        // startup broadcast) diverges from what the live runtime stamps —
        // silently discarding the thread's runtime events.
        yield* lifecycle.run(input.threadId, (lease) =>
          Effect.gen(function* () {
            if (targetSession) {
              yield* upsertSessionBinding(targetSession, input.threadId, {
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
                ...target,
                runtimeMode: input.runtimeMode,
                status: "stopped",
                lifecycleGeneration: lease.generation,
                ...(forked.resumeCursor !== undefined ? { resumeCursor: forked.resumeCursor } : {}),
                runtimePayload: {
                  cwd: input.cwd ?? null,
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
            yield* modelSelectionForTarget({
              operation: "ProviderService.sendTurn",
              modelSelection: input.modelSelection,
              target: routed.target,
            });
            const turn = yield* routed.adapter.sendTurn(input);
            const persistenceInput: StartedTurnPersistenceInput = {
              threadId: input.threadId,
              target: routed.target,
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
            yield* modelSelectionForTarget({
              operation: "ProviderService.steerTurn",
              modelSelection: input.modelSelection,
              target: routed.target,
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
              target: routed.target,
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
              target: routed.target,
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
            const failedSessionRetirement = failedUncommittedSessionRetirements.get(
              input.threadId,
            );
            let retiredUncommittedAdapter:
              | ProviderAdapterShape<ProviderAdapterError>
              | undefined;
            if (failedSessionRetirement !== undefined) {
              retiredUncommittedAdapter = yield* registry.getByProvider(
                failedSessionRetirement.target.provider,
              );
              yield* retiredUncommittedAdapter.stopSession(input.threadId);
            }
            const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
            const adapter = binding
              ? yield* registry.getByProvider(binding.provider)
              : yield* findLiveSessionAdapter(input.threadId);
            if (adapter === null) {
              clearLiveRuntimeTasks(input.threadId);
              failedUncommittedSessionRetirements.delete(input.threadId);
              lease.retire();
              retireRuntimeIdleGeneration(input.threadId);
              return;
            }
            // Adapter stop is an idempotent cleanup barrier. Even when the
            // routable session is inactive, the adapter may retain ownership
            // from a teardown whose exit proof previously failed.
            if (adapter !== retiredUncommittedAdapter) {
              yield* adapter.stopSession(input.threadId);
            }
            clearLiveRuntimeTasks(input.threadId);
            yield* waitForRuntimeIdleStop(input.threadId);
            yield* withBindingWriteLock(input.threadId, directory.remove(input.threadId));
            providerInterruptionFences.delete(input.threadId);
            failedUncommittedSessionRetirements.delete(input.threadId);
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
              const activeSessionMatchesBinding =
                activeSession !== undefined &&
                providerTargetsEqual(
                  providerTargetFromSource(activeSession),
                  providerTargetFromSource(binding),
                );
              if (activeSessionMatchesBinding && activeSession.resumeCursor !== undefined) {
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
                profileId: binding.profileId,
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
          lease.withStableGeneration((adoptGeneration) =>
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
                  profileId: binding.profileId,
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
                adoptGeneration(effectiveGeneration);
                return binding.provider;
              }),
            ),
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
            profileId?: ProviderSession["profileId"];
          } = {};
          if (
            session.profileId === undefined &&
            binding.profileId === DEFAULT_PROVIDER_PROFILE_ID
          ) {
            overrides.profileId = binding.profileId;
          }
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
        const bindings = yield* directory.listBindings();
        const bindingByThreadId = new Map(
          bindings.map((binding) => [binding.threadId, binding] as const),
        );
        const activeSessionByThreadId = new Map(
          (yield* Effect.forEach(adapters, (adapter) => adapter.listSessions()))
            .flatMap((sessions) => sessions)
            .map((session) => [session.threadId, session] as const),
        );
        yield* Effect.forEach(
          new Set([...bindingByThreadId.keys(), ...activeSessionByThreadId.keys()]),
          (threadId) => {
            const binding = bindingByThreadId.get(threadId);
            const activeSession = activeSessionByThreadId.get(threadId);
            const compatibleSession =
              binding && activeSession
                ? providerTargetsEqual(
                    providerTargetFromSource(binding),
                    providerTargetFromSource(activeSession),
                  )
                  ? activeSession
                  : undefined
                : activeSession;
            return markThreadStopped(threadId, stoppedAt, compatibleSession);
          },
        );
        yield* Effect.forEach(adapters, (adapter) => adapter.stopAll());
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
