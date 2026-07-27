import { Effect, Queue } from "effect";
import { describe, expect, it } from "vitest";

import {
  takeNextOrchestrationCommand,
  tryAdmitOrchestrationCommand,
} from "./orchestrationAdmission.ts";

describe("orchestration command admission", () => {
  it("keeps reserved lifecycle capacity available under normal-command overload", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const queues = {
          control: yield* Queue.bounded<string>(4),
          normal: yield* Queue.bounded<string>(4),
          wake: yield* Queue.unbounded<void>(),
        };
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
        yield* Queue.shutdown(queues.normal);
        yield* Queue.shutdown(queues.wake);
        expect(admit("after-stop", "thread.turn.interrupt")).toEqual({
          accepted: false,
          reason: "stopped",
        });
      }),
    );
  });

  it("runs control commands before already queued normal work", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const queues = {
          control: yield* Queue.bounded<string>(4),
          normal: yield* Queue.bounded<string>(4),
          wake: yield* Queue.unbounded<void>(),
        };
        const policy = { capacity: 4, reservedCapacity: 1 } as const;

        expect(
          tryAdmitOrchestrationCommand({
            queues,
            envelope: "normal-1",
            commandType: "project.create",
            policy,
          }),
        ).toEqual({ accepted: true });
        expect(
          tryAdmitOrchestrationCommand({
            queues,
            envelope: "normal-2",
            commandType: "thread.meta.update",
            policy,
          }),
        ).toEqual({ accepted: true });
        expect(
          tryAdmitOrchestrationCommand({
            queues,
            envelope: "stop",
            commandType: "thread.turn.interrupt",
            policy,
          }),
        ).toEqual({ accepted: true });

        expect(yield* takeNextOrchestrationCommand(queues)).toBe("stop");
        expect(yield* takeNextOrchestrationCommand(queues)).toBe("normal-1");
        expect(yield* takeNextOrchestrationCommand(queues)).toBe("normal-2");
      }),
    );
  });
});
