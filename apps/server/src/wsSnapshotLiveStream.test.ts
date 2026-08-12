import type { OrchestrationEvent } from "@synara/contracts";
import { Duration, Effect, PubSub, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeCursorSafeSnapshotLiveStream,
  makeResnapshotEscalationTracker,
  ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT,
} from "./wsSnapshotLiveStream";

const event = (sequence: number) => ({ sequence }) as OrchestrationEvent;

describe("makeCursorSafeSnapshotLiveStream", () => {
  it("attaches before snapshot IO and deduplicates events covered by durable replay", async () => {
    const steps: string[] = [];
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const replayed = event(2);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.tap(() => Effect.sync(() => steps.push("attached"))),
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: PubSub.publish(live, replayed).pipe(
              Effect.tap(() => Effect.sync(() => steps.push("snapshot"))),
              Effect.as({ snapshotSequence: 1 }),
            ),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(2),
            replay: () => Stream.succeed(replayed),
          }).pipe(Stream.take(2), Stream.runCollect);
        }),
      ),
    );

    expect(steps).toEqual(["attached", "snapshot"]);
    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
    ]);
  });

  it("emits the snapshot first, the fenced replay next, and newer live events last", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const replayed = event(2);
          const newerLive = event(3);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: PubSub.publish(live, replayed).pipe(Effect.as({ snapshotSequence: 1 })),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(2),
            replay: () =>
              Stream.concat(
                Stream.fromEffect(PubSub.publish(live, newerLive)).pipe(Stream.drain),
                Stream.succeed(replayed),
              ),
          }).pipe(Stream.take(3), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
      { kind: "event", event: event(3) },
    ]);
  });

  it("emits the snapshot before an event published during snapshot IO, losing nothing", async () => {
    // Regression: the live subscription must attach before snapshot IO starts,
    // so an event published while the (delayed) snapshot loads is delivered
    // after the snapshot instead of being dropped or duplicated.
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const publishedDuringSnapshot = event(2);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.sleep(Duration.millis(20)).pipe(
              Effect.andThen(PubSub.publish(live, publishedDuringSnapshot)),
              Effect.as({ snapshotSequence: 1 }),
            ),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(1),
            replay: () => Stream.empty,
          }).pipe(Stream.take(2), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
    ]);
    // A short deadline: when the attach ordering regresses, this test fails by
    // losing the mid-snapshot event and would otherwise stall for the suite's
    // full 90s default before reporting.
  }, 15_000);

  it("resumes from a cursor by replaying exactly the gap without a snapshot", async () => {
    let snapshotLoaded = false;
    let replayRange: readonly [number, number] | null = null;
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const newerLive = event(6);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.sync(() => {
              snapshotLoaded = true;
              return { snapshotSequence: 1 };
            }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(5),
            resumeFromSequence: 3,
            replay: (fromSequenceExclusive, throughSequenceInclusive) => {
              replayRange = [fromSequenceExclusive, throughSequenceInclusive];
              return Stream.concat(
                Stream.fromEffect(PubSub.publish(live, newerLive)).pipe(Stream.drain),
                Stream.make(event(4), event(5)),
              );
            },
          }).pipe(Stream.take(3), Stream.runCollect);
        }),
      ),
    );

    expect(snapshotLoaded).toBe(false);
    expect(replayRange).toEqual([3, 5]);
    expect(Array.from(items)).toEqual([
      { kind: "event", event: event(4) },
      { kind: "event", event: event(5) },
      { kind: "event", event: event(6) },
    ]);
  });

  it("does not lose an event published while the resume path reads the durable head", async () => {
    // The resume branch must share the snapshot path's attach-before-IO
    // discipline: the live subscription attaches before the durable head is
    // read, so an event published during that read lands in the live queue and
    // is delivered after the gap replay instead of being lost. Moving the
    // attach after the head read passes every other test in this file — only
    // this probe catches it.
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const publishedDuringHeadRead = event(6);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.die(new Error("cursor resume must not load the snapshot")),
            snapshotSequence: () => 0,
            getHighWaterSequence: Effect.sleep(Duration.millis(20)).pipe(
              Effect.andThen(PubSub.publish(live, publishedDuringHeadRead)),
              Effect.as(5),
            ),
            resumeFromSequence: 3,
            replay: () => Stream.make(event(4), event(5)),
          }).pipe(Stream.take(3), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "event", event: event(4) },
      { kind: "event", event: event(5) },
      { kind: "event", event: event(6) },
    ]);
  }, 15_000);

  it("falls back to the snapshot when the cursor gap exceeds the replay limit", async () => {
    const replayRanges: Array<readonly [number, number]> = [];
    const highWaterSequence = ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 10;
    const items = await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.succeed({ snapshotSequence: highWaterSequence }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(highWaterSequence),
          resumeFromSequence: 1,
          replay: (fromSequenceExclusive, throughSequenceInclusive) => {
            replayRanges.push([fromSequenceExclusive, throughSequenceInclusive]);
            return Stream.empty;
          },
        }).pipe(Stream.take(1), Stream.runCollect),
      ),
    );

    // Only the snapshot-fence replay ran; the overflowing cursor gap was never replayed.
    expect(replayRanges).toEqual([[highWaterSequence, highWaterSequence]]);
    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: highWaterSequence } },
    ]);
  });

  it("falls back to the snapshot when the cursor is ahead of the durable head", async () => {
    // A negative gap means the client cursor comes from a different event
    // journal (restored backup / reset DB); resuming from it would silently
    // skip history, so it must reset with a full snapshot.
    const replayRanges: Array<readonly [number, number]> = [];
    const items = await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.succeed({ snapshotSequence: 2 }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(2),
          resumeFromSequence: 100,
          replay: (fromSequenceExclusive, throughSequenceInclusive) => {
            replayRanges.push([fromSequenceExclusive, throughSequenceInclusive]);
            return Stream.empty;
          },
        }).pipe(Stream.take(1), Stream.runCollect),
      ),
    );

    // Only the snapshot-fence replay ran; the untrusted cursor was never replayed from.
    expect(replayRanges).toEqual([[2, 2]]);
    expect(Array.from(items)).toEqual([{ kind: "snapshot", snapshot: { snapshotSequence: 2 } }]);
  });

  it("falls back to the snapshot when the resume subject no longer exists", async () => {
    // A hard-purged thread leaves an in-range gap (unrelated events keep the
    // journal head above the cursor) but nothing to replay, so the resume
    // shortcut would stream silence forever instead of surfacing the deletion.
    const replayRanges: Array<readonly [number, number]> = [];
    const items = await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.succeed({ snapshotSequence: 40 }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(40),
          resumeFromSequence: 30,
          resumeSubjectExists: Effect.succeed(false),
          replay: (fromSequenceExclusive, throughSequenceInclusive) => {
            replayRanges.push([fromSequenceExclusive, throughSequenceInclusive]);
            return Stream.empty;
          },
        }).pipe(Stream.take(1), Stream.runCollect),
      ),
    );

    // The snapshot fence replayed, not the cursor gap.
    expect(replayRanges).toEqual([[40, 40]]);
    expect(Array.from(items)).toEqual([{ kind: "snapshot", snapshot: { snapshotSequence: 40 } }]);
  });

  it("resumes from the cursor when the subject still exists", async () => {
    const replayRanges: Array<readonly [number, number]> = [];
    const items = await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.die("snapshot must not load on a valid resume"),
          snapshotSequence: (snapshot: { snapshotSequence: number }) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(40),
          resumeFromSequence: 30,
          resumeSubjectExists: Effect.succeed(true),
          replay: (fromSequenceExclusive, throughSequenceInclusive) => {
            replayRanges.push([fromSequenceExclusive, throughSequenceInclusive]);
            return Stream.empty;
          },
        }).pipe(Stream.runCollect),
      ),
    );

    expect(replayRanges).toEqual([[30, 40]]);
    expect(Array.from(items)).toEqual([]);
  });

  it("requires a fresh snapshot instead of replaying an unbounded attach gap", async () => {
    let replayStarted = false;
    const reports: Array<{
      readonly snapshotSequence: number;
      readonly highWaterSequence: number;
      readonly replayCount: number;
      readonly replayLimit: number;
    }> = [];
    const program = Effect.scoped(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.empty),
        snapshot: Effect.succeed({ snapshotSequence: 1 }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2),
        onResnapshotRequired: (report) => Effect.sync(() => reports.push(report)),
        replay: () => {
          replayStarted = true;
          return Stream.empty;
        },
      }).pipe(Stream.runDrain),
    );

    await expect(Effect.runPromise(program)).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    expect(replayStarted).toBe(false);
    expect(reports).toEqual([
      {
        snapshotSequence: 1,
        highWaterSequence: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2,
        replayCount: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 1,
        replayLimit: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT,
      },
    ]);
  });

  it("escalates to a non-retryable failure when a restart re-demands the same fence", async () => {
    // Regression for the permanent resnapshot loop: a stalled or missing
    // projector froze the snapshot fence, so every stream restart demanded the
    // same unsatisfiable resnapshot forever. The second demand at a
    // non-advancing fence must be a distinguishable, non-retryable failure.
    const tracker = makeResnapshotEscalationTracker();
    const start = () =>
      Effect.runPromise(
        Effect.scoped(
          makeCursorSafeSnapshotLiveStream({
            resnapshotEscalation: { streamKey: "orchestration.shell", tracker },
            subscribeLive: Effect.succeed(Stream.empty),
            snapshot: Effect.succeed({ snapshotSequence: 1 }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2),
            replay: () => Stream.empty,
          }).pipe(Stream.runDrain),
        ),
      );

    await expect(start()).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    await expect(start()).rejects.toMatchObject({
      code: "ORCHESTRATION_SNAPSHOT_STALLED",
      retryable: false,
    });
  });

  it("tracks escalation per stream key so concurrent subscribers get independent chains", async () => {
    // Two clients demanding the same stale stream concurrently are two first
    // offenses: the caller keys the tracker per subscriber, and the tracker
    // must not bleed one subscriber's demand into another's restart chain.
    const tracker = makeResnapshotEscalationTracker();
    const start = (streamKey: string) =>
      Effect.runPromise(
        Effect.scoped(
          makeCursorSafeSnapshotLiveStream({
            resnapshotEscalation: { streamKey, tracker },
            subscribeLive: Effect.succeed(Stream.empty),
            snapshot: Effect.succeed({ snapshotSequence: 1 }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2),
            replay: () => Stream.empty,
          }).pipe(Stream.runDrain),
        ),
      );

    await expect(start("client-1:orchestration.shell")).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    // A different subscriber's first demand stays retryable.
    await expect(start("client-2:orchestration.shell")).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    // Each chain escalates independently on its own repeat.
    await expect(start("client-1:orchestration.shell")).rejects.toMatchObject({
      code: "ORCHESTRATION_SNAPSHOT_STALLED",
      retryable: false,
    });
  });

  it("keeps the retryable resnapshot demand while the fence advances between restarts", async () => {
    // An advancing fence means the projector is catching up: each restart is
    // making progress, so the demand must stay retryable.
    const tracker = makeResnapshotEscalationTracker();
    const start = (snapshotSequence: number) =>
      Effect.runPromise(
        Effect.scoped(
          makeCursorSafeSnapshotLiveStream({
            resnapshotEscalation: { streamKey: "orchestration.shell", tracker },
            subscribeLive: Effect.succeed(Stream.empty),
            snapshot: Effect.succeed({ snapshotSequence }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT * 3),
            replay: () => Stream.empty,
          }).pipe(Stream.runDrain),
        ),
      );

    await expect(start(1)).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    await expect(start(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT)).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
  });

  it("clears escalation state after a healthy stream start", async () => {
    const tracker = makeResnapshotEscalationTracker();
    const failingStart = () =>
      Effect.runPromise(
        Effect.scoped(
          makeCursorSafeSnapshotLiveStream({
            resnapshotEscalation: { streamKey: "orchestration.shell", tracker },
            subscribeLive: Effect.succeed(Stream.empty),
            snapshot: Effect.succeed({ snapshotSequence: 1 }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2),
            replay: () => Stream.empty,
          }).pipe(Stream.runDrain),
        ),
      );

    await expect(failingStart()).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
    });

    // A healthy start (fence caught up) resets the loop detection.
    await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          resnapshotEscalation: { streamKey: "orchestration.shell", tracker },
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.succeed({ snapshotSequence: 5 }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(5),
          replay: () => Stream.empty,
        }).pipe(Stream.take(1), Stream.runDrain),
      ),
    );

    // The next stale demand is a fresh first offense, retryable again.
    await expect(failingStart()).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
  });
});
