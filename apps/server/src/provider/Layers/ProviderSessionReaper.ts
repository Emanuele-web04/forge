import { Cause, Duration, Effect, Layer, Option, Schedule } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper";
import { ProviderService } from "../Services/ProviderService";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.gen(function* () {
      if (!providerService.stopRuntimeSession) {
        yield* Effect.logWarning(
          "provider session reaper skipped sweep: stopRuntimeSession is unavailable",
        );
        return;
      }
      const stopRuntimeSession = providerService.stopRuntimeSession;
      const bindings = yield* directory.listBindings();
      const now = Date.now();

      for (const binding of bindings) {
        if (binding.status === "stopped") continue;
        if (!binding.lastSeenAt) continue;

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider session reaper skipped invalid timestamp", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) continue;

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) continue;

        yield* stopRuntimeSession({ threadId: binding.threadId }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider session reaper failed to stop stale session", {
              threadId: binding.threadId,
              provider: binding.provider,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
    });

    const runSweepSafely = sweep.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider session reaper sweep failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.forkScoped(
        runSweepSafely.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
      ).pipe(Effect.asVoid);

    return { start } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
