// FILE: wsThreadDetailStream.test.ts
// Purpose: Verifies cursor resume skips the detail snapshot loader entirely.
// Layer: Server WebSocket RPC test

import { ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  makeThreadDetailStream,
  makeThreadDetailStreamQueries,
  type ThreadDetailStreamDependencies,
} from "./wsThreadDetailStream";
import { WsRpcError } from "@synara/contracts";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

const event = (sequence: number) =>
  ({ sequence, aggregateKind: "thread", aggregateId: THREAD_ID }) as unknown as OrchestrationEvent;

function makeDependencies(overrides?: Partial<ThreadDetailStreamDependencies>) {
  // The snapshot loader is the expensive path: it materialises the message
  // window, plans, activities, pending interactions, checkpoints, turn and
  // session state. Cursor resume must never reach it.
  const loadSnapshot = vi.fn(() =>
    Effect.succeed({
      detail: Option.some({ snapshotSequence: 5 } as never),
      snapshotSequence: 5,
    }),
  );
  const threadExists = vi.fn(() => Effect.succeed(true));
  const dependencies: ThreadDetailStreamDependencies = {
    threadExists,
    loadSnapshot,
    subscribeLive: () => Effect.succeed(Stream.never),
    getHighWaterSequence: Effect.succeed(7),
    replay: (_threadId, fromSequenceExclusive, throughSequenceInclusive) =>
      Stream.fromIterable(
        [6, 7].filter(
          (sequence) => sequence > fromSequenceExclusive && sequence <= throughSequenceInclusive,
        ),
      ).pipe(Stream.map(event)),
    onResnapshotRequired: () => Effect.void,
    ...overrides,
  };
  return { dependencies, loadSnapshot, threadExists };
}

describe("makeThreadDetailStream", () => {
  it("resumes from a valid cursor without materialising the thread detail snapshot", async () => {
    const { dependencies, loadSnapshot, threadExists } = makeDependencies();

    const items = await Effect.runPromise(
      Effect.scoped(
        makeThreadDetailStream(dependencies, { threadId: THREAD_ID, afterSequence: 5 }).pipe(
          Stream.take(2),
          Stream.runCollect,
        ),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "event", event: event(6) },
      { kind: "event", event: event(7) },
    ]);
    // The load-bearing assertion: the cheap existence check answered the
    // resume fence, and the snapshot loader was never touched.
    expect(threadExists).toHaveBeenCalledTimes(1);
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("loads the snapshot exactly once when the cursor subject no longer exists", async () => {
    const { dependencies, loadSnapshot } = makeDependencies({
      threadExists: () => Effect.succeed(false),
    });

    const items = await Effect.runPromise(
      Effect.scoped(
        makeThreadDetailStream(dependencies, { threadId: THREAD_ID, afterSequence: 5 }).pipe(
          Stream.take(1),
          Stream.runCollect,
        ),
      ),
    );

    expect(Array.from(items)).toEqual([{ kind: "snapshot", snapshot: { snapshotSequence: 5 } }]);
    // A rejected cursor pays the snapshot cost once, on the fallback — not
    // twice, once to answer the existence check and again to build the stream.
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  // The tests above inject their dependencies, so they pin this module but not
  // the wiring. These pin the wiring itself: reverting the production resume
  // fence back to `getThreadDetailSnapshotById` must fail here.
  describe("projection query wiring", () => {
    function makeQuerySpies() {
      const threadExistsById = vi.fn(() => Effect.succeed(true));
      const getThreadDetailSnapshotById = vi.fn(() =>
        Effect.succeed(Option.some({ snapshotSequence: 5 } as never)),
      );
      const getSnapshotSequence = vi.fn(() => Effect.succeed({ snapshotSequence: 5 }));
      const queries = makeThreadDetailStreamQueries(
        { threadExistsById, getThreadDetailSnapshotById, getSnapshotSequence },
        (cause, message) => new WsRpcError({ message, cause }),
      );
      return { queries, threadExistsById, getThreadDetailSnapshotById, getSnapshotSequence };
    }

    it("answers the resume fence from the cheap existence query, never the detail snapshot", async () => {
      const { queries, threadExistsById, getThreadDetailSnapshotById } = makeQuerySpies();

      await expect(Effect.runPromise(queries.threadExists(THREAD_ID))).resolves.toBe(true);

      expect(threadExistsById).toHaveBeenCalledWith(THREAD_ID);
      // The mutation this pins: routing the fence through the snapshot loader
      // makes the resume path pay nearly the whole snapshot it exists to avoid.
      expect(getThreadDetailSnapshotById).not.toHaveBeenCalled();
    });

    it("still uses the detail snapshot query for the actual snapshot payload", async () => {
      const { queries, threadExistsById, getThreadDetailSnapshotById } = makeQuerySpies();

      await Effect.runPromise(queries.loadSnapshot(THREAD_ID));

      expect(getThreadDetailSnapshotById).toHaveBeenCalledWith(THREAD_ID);
      expect(threadExistsById).not.toHaveBeenCalled();
    });
  });
});
