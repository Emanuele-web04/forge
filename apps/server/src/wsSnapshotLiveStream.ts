import { WsRpcError, type OrchestrationEvent } from "@synara/contracts";
import { Cause, Effect, Queue, Scope, Stream } from "effect";

export const ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT = 4_096;

export type SnapshotLiveStreamItem<Snapshot> =
  | { readonly kind: "snapshot"; readonly snapshot: Snapshot }
  | { readonly kind: "event"; readonly event: OrchestrationEvent };

export interface ResnapshotReport {
  readonly snapshotSequence: number;
  readonly highWaterSequence: number;
  readonly replayCount: number;
  readonly replayLimit: number;
}

/**
 * Detects a resnapshot demand that restarting the stream cannot satisfy.
 *
 * A healthy resnapshot cycle strictly advances the snapshot fence: the client
 * restarts, the server serves a fresh snapshot at (or near) the journal head,
 * and the gap closes. When the snapshot fence is frozen — a stalled or missing
 * projector — every restart re-reads the same fence and re-demands the same
 * resnapshot forever. Track the fence of the last demand per stream key; a
 * repeat demand at a non-advancing fence is escalated to a non-retryable
 * failure so clients stop tearing the transport down and surface the fault.
 *
 * Callers must key the tracker per subscriber (client id + stream name), not
 * per stream name alone: two clients demanding the same stale stream
 * concurrently are two first offenses, not one restart cycle — a shared key
 * would hand the second client a non-retryable verdict before either had
 * actually restarted. The fence itself is shared database state, so each
 * subscriber's chain still converges on the same evidence; per-subscriber
 * keying only ensures the "did not advance" comparison spans one
 * subscription's own retries. State is cleared the moment that subscriber's
 * stream start succeeds.
 */
export function makeResnapshotEscalationTracker(): {
  readonly shouldEscalate: (streamKey: string, report: ResnapshotReport) => boolean;
  readonly recordHealthyStart: (streamKey: string) => void;
} {
  const lastDemandedFenceByStreamKey = new Map<string, number>();
  // Entries for subscribers that disconnect mid-failure are never cleared by a
  // healthy start, so bound the map: evict the oldest insertions once the
  // ceiling is reached. Losing an old entry merely re-grants one retryable
  // demand to that subscriber — safe, since escalation is a loop guard, not a
  // correctness fence.
  const MAX_TRACKED_STREAM_KEYS = 4_096;
  return {
    shouldEscalate: (streamKey, report) => {
      const previousFence = lastDemandedFenceByStreamKey.get(streamKey);
      lastDemandedFenceByStreamKey.delete(streamKey);
      if (lastDemandedFenceByStreamKey.size >= MAX_TRACKED_STREAM_KEYS) {
        const oldestKey = lastDemandedFenceByStreamKey.keys().next().value;
        if (oldestKey !== undefined) {
          lastDemandedFenceByStreamKey.delete(oldestKey);
        }
      }
      lastDemandedFenceByStreamKey.set(streamKey, report.snapshotSequence);
      return previousFence !== undefined && report.snapshotSequence <= previousFence;
    },
    recordHealthyStart: (streamKey) => {
      lastDemandedFenceByStreamKey.delete(streamKey);
    },
  };
}

/**
 * Attach live delivery first, capture a snapshot and durable high-water fence,
 * replay the exact gap, then continue with strictly newer live events.
 *
 * When `resumeFromSequence` is provided and the gap to the durable head is
 * non-negative and within the replay limit, the snapshot is skipped entirely
 * and only the gap is replayed. A negative gap (client cursor ahead of the
 * server head — restored backup or reset database) or an overflowing gap is
 * never trusted: both fall back to the full snapshot path.
 */
export function makeCursorSafeSnapshotLiveStream<Snapshot, E>(input: {
  readonly subscribeLive: Effect.Effect<Stream.Stream<OrchestrationEvent, E>, never, Scope.Scope>;
  readonly snapshot: Effect.Effect<Snapshot, E>;
  readonly snapshotSequence: (snapshot: Snapshot) => number;
  readonly getHighWaterSequence: Effect.Effect<number, E>;
  readonly replay: (
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
  ) => Stream.Stream<OrchestrationEvent, E>;
  readonly resumeFromSequence?: number | undefined;
  /**
   * Guards the resume shortcut against a subject that no longer exists. A hard
   * purge removes a thread's rows while unrelated events keep the journal head
   * above the client's cursor, so the gap check alone would accept the resume
   * and stream an empty replay forever instead of surfacing the deletion.
   */
  readonly resumeSubjectExists?: Effect.Effect<boolean, E>;
  readonly onResnapshotRequired?: (report: ResnapshotReport) => Effect.Effect<void, never>;
  /**
   * Loop guard: pairs a stable stream key with a process-wide tracker so a
   * resnapshot demand whose fence did not advance since the previous demand
   * fails non-retryable instead of prompting another identical restart.
   */
  readonly resnapshotEscalation?: {
    readonly streamKey: string;
    readonly tracker: ReturnType<typeof makeResnapshotEscalationTracker>;
  };
}): Stream.Stream<SnapshotLiveStreamItem<Snapshot>, E | WsRpcError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      // The scoped subscription is registered synchronously before snapshot IO.
      // A one-item handoff queue keeps the bridge bounded; the caller's live
      // stream owns its slow-consumer/drop policy ahead of this queue.
      const live = yield* input.subscribeLive;
      const liveQueue = yield* Queue.bounded<OrchestrationEvent, E | Cause.Done>(1);
      yield* Stream.runIntoQueue(live, liveQueue).pipe(Effect.forkScoped);
      if (input.resumeFromSequence !== undefined) {
        // The head is read after the live attach, so replay through the head
        // plus live-after-fence covers every event exactly once — the same
        // fence discipline as the snapshot path, with the cursor standing in
        // for the snapshot sequence.
        const resumeFromSequence = input.resumeFromSequence;
        const highWaterSequence = yield* input.getHighWaterSequence;
        const resumeGap = highWaterSequence - resumeFromSequence;
        // The `resumeGap >= 0` guard is load-bearing, not defensive: hard
        // deletes remove rows from `orchestration_events` (see the thread purge
        // in profileStatsArchive.ts), which can lower the journal-wide
        // MAX(sequence) below a cursor a client legitimately held. Such a
        // cursor must never be trusted for a gap replay — fall through to the
        // full snapshot instead. Sequences themselves are never reused
        // (`sequence INTEGER PRIMARY KEY AUTOINCREMENT`), so a non-negative
        // gap cannot silently alias deleted history onto new events.
        const subjectExists =
          input.resumeSubjectExists === undefined ? true : yield* input.resumeSubjectExists;
        if (subjectExists && resumeGap >= 0 && resumeGap <= ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT) {
          input.resnapshotEscalation?.tracker.recordHealthyStart(
            input.resnapshotEscalation.streamKey,
          );
          const replay = input.replay(resumeFromSequence, highWaterSequence).pipe(
            Stream.filter(
              (event) => event.sequence > resumeFromSequence && event.sequence <= highWaterSequence,
            ),
            Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
          );
          const liveAfterFence = Stream.fromQueue(liveQueue).pipe(
            Stream.filter((event) => event.sequence > highWaterSequence),
            Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
          );
          return Stream.concat(replay, liveAfterFence);
        }
      }
      const snapshot = yield* input.snapshot;
      const snapshotSequence = input.snapshotSequence(snapshot);
      const highWaterSequence = yield* input.getHighWaterSequence;
      const replayCount = Math.max(0, highWaterSequence - snapshotSequence);
      if (replayCount > ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT) {
        const report: ResnapshotReport = {
          snapshotSequence,
          highWaterSequence,
          replayCount,
          replayLimit: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT,
        };
        if (input.onResnapshotRequired) {
          yield* input.onResnapshotRequired(report);
        }
        const escalate =
          input.resnapshotEscalation?.tracker.shouldEscalate(
            input.resnapshotEscalation.streamKey,
            report,
          ) === true;
        if (escalate) {
          return yield* new WsRpcError({
            message:
              `Orchestration snapshot is still ${replayCount} events behind after a restart; ` +
              "the snapshot fence is not advancing (a projection is stalled or missing). " +
              "Restart the server or run repair local state.",
            code: "ORCHESTRATION_SNAPSHOT_STALLED",
            retryable: false,
          });
        }
        return yield* new WsRpcError({
          message: `Orchestration snapshot is ${replayCount} events behind; restart the stream for a fresh snapshot.`,
          code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
          retryable: true,
        });
      }
      input.resnapshotEscalation?.tracker.recordHealthyStart(input.resnapshotEscalation.streamKey);

      const replay = input.replay(snapshotSequence, highWaterSequence).pipe(
        Stream.filter(
          (event) => event.sequence > snapshotSequence && event.sequence <= highWaterSequence,
        ),
        Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
      );
      const liveAfterFence = Stream.fromQueue(liveQueue).pipe(
        Stream.filter((event) => event.sequence > highWaterSequence),
        Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
      );

      return Stream.concat(
        Stream.succeed<SnapshotLiveStreamItem<Snapshot>>({ kind: "snapshot", snapshot }),
        Stream.concat(replay, liveAfterFence),
      );
    }),
  );
}
