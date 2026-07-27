import { Effect, Queue } from "effect";
import { describe, expect, it } from "vitest";

import {
  takeNextOrchestrationCommand,
  tryAdmitOrchestrationCommand,
} from "./orchestrationAdmission.ts";

const makeQueues = Effect.gen(function* () {
  return {
    control: yield* Queue.bounded<string>(4),
    user: yield* Queue.bounded<string>(4),
    normal: yield* Queue.bounded<string>(4),
    wake: yield* Queue.unbounded<void>(),
  };
});

describe("orchestration command admission", () => {
  it("keeps reserved lifecycle capacity available under normal-command overload", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const queues = yield* makeQueues;
        const policy = { capacity: 4, reservedCapacity: 1 } as const;
        const admit = (
          envelope: string,
          commandType: Parameters<typeof tryAdmitOrchestrationCommand<string>>[0]["commandType"],
        ) => tryAdmitOrchestrationCommand({ queues, envelope, commandType, policy });

        expect(admit("normal-1", "project.create")).toEqual({ accepted: true });
        expect(admit("normal-2", "project.create")).toEqual({ accepted: true });
        expect(admit("normal-3", "project.create")).toEqual({ accepted: true });
        expect(admit("normal-overload", "project.create")).toEqual({
          accepted: false,
          reason: "overloaded",
        });

        expect(admit("control", "thread.turn.interrupt")).toEqual({ accepted: true });
        expect(admit("control-overload", "thread.session.stop")).toEqual({
          accepted: false,
          reason: "overloaded",
        });

        // Task stop/background share the interrupt reserve: draining one slot
        // shows they are admitted past the normal-command limit.
        yield* takeNextOrchestrationCommand(queues);
        expect(admit("task-stop", "thread.task.stop")).toEqual({ accepted: true });
        yield* takeNextOrchestrationCommand(queues);
        expect(admit("task-background", "thread.task.background")).toEqual({ accepted: true });

        yield* Queue.shutdown(queues.control);
        yield* Queue.shutdown(queues.user);
        yield* Queue.shutdown(queues.normal);
        yield* Queue.shutdown(queues.wake);
        expect(admit("after-stop", "thread.turn.interrupt")).toEqual({
          accepted: false,
          reason: "stopped",
        });
      }),
    );
  });

  it("does not let user actions consume the control reserve", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const queues = yield* makeQueues;
        const policy = { capacity: 4, reservedCapacity: 1 } as const;
        const admit = (
          envelope: string,
          commandType: Parameters<typeof tryAdmitOrchestrationCommand<string>>[0]["commandType"],
        ) => tryAdmitOrchestrationCommand({ queues, envelope, commandType, policy });

        // Turn starts get lane priority but not the reserve, so a burst of them
        // can never crowd out the stop that cancels them.
        expect(admit("start-1", "thread.turn.start")).toEqual({ accepted: true });
        expect(admit("start-2", "thread.turn.start")).toEqual({ accepted: true });
        expect(admit("start-3", "thread.create")).toEqual({ accepted: true });
        expect(admit("start-overload", "thread.turn.start")).toEqual({
          accepted: false,
          reason: "overloaded",
        });

        expect(admit("stop", "thread.session.stop")).toEqual({ accepted: true });
      }),
    );
  });

  it("drains control ahead of user actions, and user actions ahead of background work", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const queues = yield* makeQueues;
        const policy = { capacity: 8, reservedCapacity: 2 } as const;
        const admit = (
          envelope: string,
          commandType: Parameters<typeof tryAdmitOrchestrationCommand<string>>[0]["commandType"],
        ) => tryAdmitOrchestrationCommand({ queues, envelope, commandType, policy });

        expect(admit("normal-1", "project.create")).toEqual({ accepted: true });
        expect(admit("normal-2", "thread.meta.update")).toEqual({ accepted: true });
        expect(admit("start-1", "thread.turn.start")).toEqual({ accepted: true });
        expect(admit("revert", "thread.checkpoint.revert")).toEqual({ accepted: true });
        expect(admit("stop", "thread.turn.interrupt")).toEqual({ accepted: true });

        expect(yield* takeNextOrchestrationCommand(queues)).toBe("stop");
        // FIFO is preserved within each lane.
        expect(yield* takeNextOrchestrationCommand(queues)).toBe("start-1");
        expect(yield* takeNextOrchestrationCommand(queues)).toBe("revert");
        expect(yield* takeNextOrchestrationCommand(queues)).toBe("normal-1");
        expect(yield* takeNextOrchestrationCommand(queues)).toBe("normal-2");
      }),
    );
  });
});
