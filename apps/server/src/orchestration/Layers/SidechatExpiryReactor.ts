import {
  CommandId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@synara/contracts";
import {
  SIDECHAT_VISIBLE_ACTIVITY_HEARTBEAT_MS,
  createSidechatExpiryTimer,
  type SidechatExpiryTimerClock,
} from "@synara/shared/sidechatExpiry";
import { Cause, Duration, Effect, Layer, Schedule, Stream } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  SidechatExpiryReactor,
  type SidechatExpiryReactorShape,
} from "../Services/SidechatExpiryReactor.ts";

const EXPIRY_RETRY_DELAY_MS = 5_000;
const SESSION_STOP_RETRY_COUNT = 2;

export interface SidechatExpiryReactorRuntime<
  TimerHandle,
> extends SidechatExpiryTimerClock<TimerHandle> {
  readonly runFork: (effect: Effect.Effect<void>) => void;
}

const liveRuntime: SidechatExpiryReactorRuntime<NodeJS.Timeout> = {
  now: Date.now,
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: clearTimeout,
  runFork: (effect) => {
    Effect.runFork(effect);
  },
};

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const parseTimestamp = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const lastActivityAtMs = (thread: OrchestrationThread, fallbackNowMs: number): number =>
  parseTimestamp(thread.sidechatLastActivityAt) ??
  parseTimestamp(thread.updatedAt) ??
  parseTimestamp(thread.createdAt) ??
  fallbackNowMs;

const isThreadRunning = (thread: OrchestrationThread): boolean =>
  thread.latestTurn?.state === "running" ||
  thread.session?.status === "starting" ||
  thread.session?.status === "running" ||
  thread.hasPendingApprovals === true ||
  thread.hasPendingUserInput === true;

export const makeSidechatExpiryReactor = <TimerHandle>(
  runtime: SidechatExpiryReactorRuntime<TimerHandle>,
) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const providerService = yield* ProviderService;
    const knownThreadIds = new Set<ThreadId>();

    let timer: ReturnType<typeof createSidechatExpiryTimer<TimerHandle>>;

    const recordActivity = (threadId: ThreadId, activityAtMs: number) =>
      orchestrationEngine
        .dispatch({
          type: "thread.sidechat.activity.record",
          commandId: serverCommandId("sidechat-activity"),
          threadId,
          activityAt: new Date(activityAtMs).toISOString(),
        })
        .pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to persist side chat activity", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

    const refreshAfterExpiryFailure = (threadId: ThreadId, expectedLastActivityAtMs: number) =>
      Effect.gen(function* () {
        const readModel = yield* orchestrationEngine.getReadModel();
        const thread = readModel.threads.find((candidate) => candidate.id === threadId);
        if (!thread || !thread.sidechatSourceThreadId || thread.deletedAt || thread.archivedAt) {
          timer.remove(threadId);
          return;
        }
        if (thread.sidechatExpiredAt) {
          timer.markExpired(threadId);
          return;
        }
        const persistedActivityAtMs = lastActivityAtMs(thread, runtime.now());
        if (persistedActivityAtMs !== expectedLastActivityAtMs) {
          if (persistedActivityAtMs > expectedLastActivityAtMs) {
            timer.recordActivity(threadId, persistedActivityAtMs);
            return;
          }
          // The in-memory clock can advance before its activity command commits
          // (for example during a transient database failure). Preserve that real
          // activity, retry its durable write, and avoid a zero-delay expiry loop
          // against the older projection timestamp.
          yield* recordActivity(threadId, expectedLastActivityAtMs);
          timer.retryExpiry(threadId, EXPIRY_RETRY_DELAY_MS);
          return;
        }
        if (isThreadRunning(thread)) {
          timer.setRunning(threadId, true, persistedActivityAtMs);
          return;
        }
        timer.retryExpiry(threadId, EXPIRY_RETRY_DELAY_MS);
      });

    const expireSidechat = (threadIdValue: string, expectedLastActivityAtMs: number) => {
      const threadId = ThreadId.makeUnsafe(threadIdValue);
      const expiredAt = new Date(runtime.now()).toISOString();
      return orchestrationEngine
        .dispatch({
          type: "thread.sidechat.expire",
          commandId: serverCommandId("sidechat-expire"),
          threadId,
          expectedLastActivityAt: new Date(expectedLastActivityAtMs).toISOString(),
          expiredAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to expire inactive side chat", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(refreshAfterExpiryFailure(threadId, expectedLastActivityAtMs))),
          ),
        );
    };

    timer = createSidechatExpiryTimer<TimerHandle>({
      now: runtime.now,
      schedule: runtime.schedule,
      cancel: runtime.cancel,
      onExpire: (threadId, expectedLastActivityAtMs) => {
        runtime.runFork(expireSidechat(threadId, expectedLastActivityAtMs));
      },
    });

    const handleEvent = (event: OrchestrationEvent) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "thread.created": {
            knownThreadIds.add(event.payload.threadId);
            if (!event.payload.sidechatSourceThreadId) return;
            timer.restore({
              threadId: event.payload.threadId,
              lastActivityAtMs:
                parseTimestamp(event.payload.sidechatLastActivityAt) ??
                parseTimestamp(event.payload.createdAt) ??
                runtime.now(),
              running: false,
              expired: Boolean(event.payload.sidechatExpiredAt),
            });
            return;
          }
          case "thread.sidechat-activity-recorded":
            timer.recordActivity(
              event.payload.threadId,
              parseTimestamp(event.payload.lastActivityAt) ?? runtime.now(),
            );
            return;
          case "thread.turn-start-requested":
            timer.setRunning(
              event.payload.threadId,
              true,
              parseTimestamp(event.payload.createdAt) ?? runtime.now(),
            );
            return;
          case "thread.session-set":
            timer.setRunning(
              event.payload.threadId,
              event.payload.session.status === "starting" ||
                event.payload.session.status === "running",
              parseTimestamp(event.payload.session.updatedAt) ?? runtime.now(),
            );
            return;
          case "thread.sidechat-expired":
            timer.markExpired(event.payload.threadId);
            yield* providerService.stopSession({ threadId: event.payload.threadId }).pipe(
              Effect.retry(
                Schedule.addDelay(Schedule.recurs(SESSION_STOP_RETRY_COUNT), () =>
                  Effect.succeed(Duration.millis(EXPIRY_RETRY_DELAY_MS)),
                ),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to unload expired side chat provider session", {
                  threadId: event.payload.threadId,
                  cause: Cause.pretty(cause),
                }),
              ),
              Effect.forkScoped,
            );
            return;
          case "thread.deleted":
          case "thread.archived":
            timer.remove(event.payload.threadId);
            return;
          case "thread.unarchived": {
            const readModel = yield* orchestrationEngine.getReadModel();
            const thread = readModel.threads.find(
              (candidate) => candidate.id === event.payload.threadId,
            );
            if (!thread?.sidechatSourceThreadId || thread.deletedAt) return;
            const expired = Boolean(thread.sidechatExpiredAt);
            const restoredActivityAtMs = expired
              ? lastActivityAtMs(thread, runtime.now())
              : runtime.now();
            if (!expired) {
              yield* recordActivity(thread.id, restoredActivityAtMs);
            }
            timer.restore({
              threadId: thread.id,
              lastActivityAtMs: restoredActivityAtMs,
              running: isThreadRunning(thread),
              expired,
            });
            return;
          }
          default:
            return;
        }
      });

    const start: SidechatExpiryReactorShape["start"] = Effect.gen(function* () {
      const liveEvents = yield* orchestrationEngine.subscribeDomainEvents;
      const readModel = yield* orchestrationEngine.getReadModel();
      for (const thread of readModel.threads) {
        knownThreadIds.add(thread.id);
        if (
          !thread.sidechatSourceThreadId ||
          thread.deletedAt !== null ||
          thread.archivedAt !== null
        ) {
          continue;
        }
        timer.restore({
          threadId: thread.id,
          lastActivityAtMs: lastActivityAtMs(thread, runtime.now()),
          running: isThreadRunning(thread),
          expired: Boolean(thread.sidechatExpiredAt),
        });
      }

      yield* Stream.runForEach(liveEvents, handleEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("side chat expiry event stream stopped", {
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.forever(
        Effect.sleep(Duration.millis(SIDECHAT_VISIBLE_ACTIVITY_HEARTBEAT_MS)).pipe(
          Effect.andThen(
            Effect.forEach(timer.getViewedThreadIds(), (threadId) => {
              const now = runtime.now();
              return timer.recordActivity(threadId, now)
                ? recordActivity(ThreadId.makeUnsafe(threadId), now)
                : Effect.void;
            }),
          ),
        ),
      ).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => timer.dispose()));
    });

    const updateView = (threadId: ThreadId, viewed: boolean) =>
      Effect.gen(function* () {
        const now = runtime.now();
        let updated = viewed ? timer.beginView(threadId, now) : timer.endView(threadId, now);
        if (viewed && !updated && !knownThreadIds.has(threadId)) {
          // Shell publication and this reactor consume the same committed event on
          // separate streams. A client can subscribe in that narrow gap, so seed
          // from the authoritative read model instead of losing the view lease.
          const readModel = yield* orchestrationEngine.getReadModel();
          const thread = readModel.threads.find((candidate) => candidate.id === threadId);
          knownThreadIds.add(threadId);
          if (
            thread?.sidechatSourceThreadId &&
            !thread.sidechatExpiredAt &&
            !thread.deletedAt &&
            !thread.archivedAt
          ) {
            timer.restore({
              threadId,
              lastActivityAtMs: lastActivityAtMs(thread, runtime.now()),
              running: isThreadRunning(thread),
              expired: false,
            });
            updated = timer.beginView(threadId, now);
          }
        }
        if (updated) yield* recordActivity(threadId, now);
      });

    return {
      start,
      viewStarted: (threadId) => updateView(threadId, true),
      viewEnded: (threadId) => updateView(threadId, false),
    } satisfies SidechatExpiryReactorShape;
  });

export const SidechatExpiryReactorLive = Layer.effect(
  SidechatExpiryReactor,
  makeSidechatExpiryReactor(liveRuntime),
);
