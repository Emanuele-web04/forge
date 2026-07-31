// FILE: wsThreadDetailStream.ts
// Purpose: Build the thread-detail subscription stream (cursor resume or full snapshot).
// Layer: Server WebSocket RPC
// Exports: makeThreadDetailStream plus the dependency shape its callers provide.

import {
  WsRpcError,
  type OrchestrationEvent,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId,
} from "@synara/contracts";
import { Effect, Option, Scope, Stream } from "effect";

import { makeCursorSafeSnapshotLiveStream } from "./wsSnapshotLiveStream";

interface ThreadDetailSnapshotEnvelope {
  readonly detail: Option.Option<OrchestrationThreadDetailSnapshot>;
  readonly snapshotSequence: number;
}

export interface ThreadDetailStreamDependencies {
  /**
   * Existence check for the resume path. Deliberately not the snapshot loader:
   * an accepted cursor resume never reads the detail, so materialising it here
   * would cost the resume nearly the whole snapshot it exists to avoid, and a
   * rejected cursor would pay that cost twice.
   */
  readonly threadExists: (threadId: ThreadId) => Effect.Effect<boolean, WsRpcError>;
  readonly loadSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadDetailSnapshotEnvelope, WsRpcError>;
  readonly subscribeLive: (
    threadId: ThreadId,
  ) => Effect.Effect<Stream.Stream<OrchestrationEvent, WsRpcError>, never, Scope.Scope>;
  readonly getHighWaterSequence: Effect.Effect<number, WsRpcError>;
  readonly replay: (
    threadId: ThreadId,
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
  ) => Stream.Stream<OrchestrationEvent, WsRpcError>;
  readonly onResnapshotRequired: (
    threadId: ThreadId,
    report: {
      readonly snapshotSequence: number;
      readonly highWaterSequence: number;
      readonly replayCount: number;
      readonly replayLimit: number;
    },
  ) => Effect.Effect<void, never>;
}

/** The projection queries this stream reads, as the read model exposes them. */
export interface ThreadDetailProjectionQueries<E = unknown> {
  readonly threadExistsById: (threadId: ThreadId) => Effect.Effect<boolean, E>;
  readonly getThreadDetailSnapshotById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, E>;
  readonly getSnapshotSequence: () => Effect.Effect<{ readonly snapshotSequence: number }, E>;
}

/**
 * The projection-query half of the dependencies, built from the read model.
 *
 * Takes the query service itself rather than per-role callbacks: that leaves no
 * seam where a caller could hand the resume fence a different query, so which
 * query answers which role is decided here and pinned by this module's tests.
 * `makeThreadDetailStream` takes its dependencies injected, so a test that stubs
 * those proves the stream's behaviour but not the production wiring — this is
 * where the wiring lives.
 */
export function makeThreadDetailStreamQueries<E>(
  query: ThreadDetailProjectionQueries<E>,
  toWsRpcError: (cause: unknown, fallbackMessage: string) => WsRpcError,
): Pick<ThreadDetailStreamDependencies, "threadExists" | "loadSnapshot"> {
  return {
    // Existence only — never the detail snapshot. See `threadExists` above.
    threadExists: (threadId) =>
      query
        .threadExistsById(threadId)
        .pipe(
          Effect.mapError((cause) =>
            toWsRpcError(cause, "Failed to verify thread before cursor resume"),
          ),
        ),
    loadSnapshot: (threadId) =>
      query.getThreadDetailSnapshotById(threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              query.getSnapshotSequence().pipe(
                Effect.map(({ snapshotSequence }) => ({
                  detail: Option.none<OrchestrationThreadDetailSnapshot>(),
                  snapshotSequence,
                })),
              ),
            onSome: (detail) =>
              Effect.succeed({
                detail: Option.some(detail),
                snapshotSequence: detail.snapshotSequence,
              }),
          }),
        ),
        Effect.mapError((cause) => toWsRpcError(cause, "Failed to load thread snapshot")),
      ),
  };
}

export function makeThreadDetailStream(
  dependencies: ThreadDetailStreamDependencies,
  input: { readonly threadId: ThreadId; readonly afterSequence?: number | undefined },
): Stream.Stream<OrchestrationThreadStreamItem, WsRpcError> {
  const threadId = input.threadId;
  return makeCursorSafeSnapshotLiveStream({
    // Cursor resume: a client holding cached detail replays only the gap.
    // Out-of-range cursors (negative or overflowing gap) fall back to the
    // snapshot inside the stream factory.
    resumeFromSequence: input.afterSequence,
    // A hard-purged thread leaves no rows to replay while the journal head
    // stays above the cursor, so the gap check alone would accept the resume
    // and stream nothing. Falling through to the snapshot path surfaces
    // THREAD_SNAPSHOT_NOT_FOUND instead.
    resumeSubjectExists: Effect.suspend(() => dependencies.threadExists(threadId)),
    onResnapshotRequired: (report) => dependencies.onResnapshotRequired(threadId, report),
    subscribeLive: dependencies.subscribeLive(threadId),
    // Suspended so an accepted cursor resume never even builds the snapshot
    // query, let alone runs it. This is the invariant the resume path exists
    // for; see `threadExists`.
    snapshot: Effect.suspend(() => dependencies.loadSnapshot(threadId)),
    snapshotSequence: (snapshot) => snapshot.snapshotSequence,
    getHighWaterSequence: dependencies.getHighWaterSequence,
    replay: (fromSequenceExclusive, throughSequenceInclusive) =>
      dependencies.replay(threadId, fromSequenceExclusive, throughSequenceInclusive),
  }).pipe(
    Stream.flatMap((item) => {
      if (item.kind === "event") {
        return Stream.succeed<OrchestrationThreadStreamItem>({
          kind: "event",
          event: item.event,
        });
      }
      // A silently empty snapshot would leave the client waiting forever for
      // thread history; fail identifiably so it can surface the state.
      return Option.isSome(item.snapshot.detail)
        ? Stream.succeed<OrchestrationThreadStreamItem>({
            kind: "snapshot",
            snapshot: item.snapshot.detail.value,
          })
        : Stream.fail(
            new WsRpcError({
              message: `Thread detail snapshot not found for thread ${threadId}.`,
              code: "THREAD_SNAPSHOT_NOT_FOUND",
              retryable: false,
            }),
          );
    }),
  );
}
