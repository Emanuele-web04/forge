import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService";
import { ComputerManager } from "../ComputerManager.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { ComputerLeaseReactor } from "../Services/ComputerLeaseReactor";
import { ComputerService } from "../Services/ComputerService";
import { ComputerLeaseReactorLive, releasesDesktopControl } from "./ComputerLeaseReactor";

const OWNER = "thread-lease-owner";
const OTHER = "thread-lease-other";

const unsupported = () => Effect.die(new Error("Unsupported test call")) as never;

function event(type: ProviderRuntimeEvent["type"], threadId: string): ProviderRuntimeEvent {
  return {
    type,
    eventId: EventId.makeUnsafe(`event-${type}-${threadId}`),
    provider: "codex",
    createdAt: "2026-08-16T00:00:00.000Z",
    threadId: ThreadId.makeUnsafe(threadId),
    turnId: TurnId.makeUnsafe("turn-lease"),
    payload: {},
  } as ProviderRuntimeEvent;
}

/** The reactor consumes the stream on a forked fiber, so assertions poll. */
async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeProviderService(events: readonly ProviderRuntimeEvent[]): ProviderServiceShape {
  return {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    startReview: () => unsupported(),
    interruptTurn: () => unsupported(),
    stopTask: () => unsupported(),
    backgroundTask: () => unsupported(),
    steerSubagent: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => unsupported(),
    rollbackConversation: () => unsupported(),
    compactThread: () => unsupported(),
    closeRuntimeEvents: Effect.void,
    streamEvents: Stream.fromIterable(events),
  };
}

/** Starts the reactor over a fixed event feed for the duration of `body`. */
async function withReactor(
  input: { readonly manager: ComputerManager; readonly events: readonly ProviderRuntimeEvent[] },
  body: () => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make());
  try {
    await Effect.gen(function* () {
      const reactor = yield* ComputerLeaseReactor;
      yield* Scope.provide(reactor.start(), scope);
    }).pipe(
      Effect.provide(
        ComputerLeaseReactorLive.pipe(
          Layer.provide(Layer.succeed(ProviderService, makeProviderService(input.events))),
          Layer.provide(
            Layer.succeed(ComputerService, {
              supported: true,
              availability: { kind: "available" },
              manager: input.manager,
            }),
          ),
        ),
      ),
      Effect.runPromise,
    );
    await body();
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("ComputerLeaseReactor", () => {
  it("treats terminal turns and dead sessions as the end of desktop control", () => {
    for (const type of ["turn.completed", "turn.aborted", "session.exited"] as const) {
      expect(releasesDesktopControl(event(type, OWNER))).toBe(true);
    }
    for (const type of ["turn.started", "item.completed", "content.delta"] as const) {
      expect(releasesDesktopControl(event(type, OWNER))).toBe(false);
    }
  });

  it("frees the desktop when the owning thread's turn ends", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    await manager.click(OWNER, { x: 5, y: 5 });
    await expect(manager.click(OTHER, { x: 6, y: 6 })).rejects.toMatchObject({
      code: "computer_controlled_by_other_thread",
    });

    await withReactor({ manager, events: [event("turn.completed", OWNER)] }, async () => {
      await waitUntil(async () => !(await manager.getThreadState(OTHER)).controlledByOtherThread);
      // The next thread takes it implicitly, and the roles swap.
      await manager.click(OTHER, { x: 6, y: 6 });
      expect((await manager.getThreadState(OWNER)).controlledByOtherThread).toBe(true);
    });
  });

  it("ignores a turn end from a thread that does not hold the desktop", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    await manager.click(OWNER, { x: 5, y: 5 });

    await withReactor({ manager, events: [event("turn.completed", OTHER)] }, async () => {
      // An unrelated thread's turn ending must not be a way to steal the
      // desktop out from under the thread that is actually driving it.
      await waitUntil(async () => (await manager.getThreadState(OTHER)).controlledByOtherThread);
      await manager.click(OWNER, { x: 7, y: 7 });
      await expect(manager.click(OTHER, { x: 6, y: 6 })).rejects.toMatchObject({
        code: "computer_controlled_by_other_thread",
      });
    });
  });
});
