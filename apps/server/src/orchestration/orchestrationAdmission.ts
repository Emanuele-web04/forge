import type { OrchestrationCommand } from "@synara/contracts";
import { Effect, Option, Queue } from "effect";

export const ORCHESTRATION_COMMAND_QUEUE_CAPACITY = 256;
export const ORCHESTRATION_COMMAND_CONTROL_RESERVE = 32;
export const ORCHESTRATION_EVENT_PUBSUB_CAPACITY = 1_024;

export interface OrchestrationCommandAdmissionPolicy {
  readonly capacity: number;
  readonly reservedCapacity: number;
}

export type OrchestrationCommandAdmissionDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: "overloaded" | "stopped" };

export interface OrchestrationCommandQueues<A> {
  readonly control: Queue.Queue<A>;
  readonly normal: Queue.Queue<A>;
  readonly wake: Queue.Queue<void>;
}

export function usesReservedCommandAdmission(type: OrchestrationCommand["type"]): boolean {
  switch (type) {
    // Direct user actions must not sit behind retention and other background
    // projection traffic. They share the control lane while preserving FIFO
    // ordering within that lane.
    case "thread.create":
    case "thread.turn.start":
    case "thread.turn.interrupt":
    case "thread.checkpoint.revert":
    case "thread.conversation.rollback":
    case "thread.message.edit-and-resend":
    // Task stop/background are user control-plane actions like interrupt:
    // they must stay admissible when the queue is saturated with data traffic.
    case "thread.task.stop":
    case "thread.task.background":
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.session.stop":
    case "thread.turn.dispatch-queued":
    case "thread.session.set":
    case "thread.message.assistant.complete":
    case "thread.turn.diff.complete":
    case "thread.revert.complete":
    case "thread.conversation.rollback.complete":
      return true;
    default:
      return false;
  }
}

export function tryAdmitOrchestrationCommand<A>(input: {
  readonly queues: OrchestrationCommandQueues<A>;
  readonly envelope: A;
  readonly commandType: OrchestrationCommand["type"];
  readonly policy?: OrchestrationCommandAdmissionPolicy;
}): OrchestrationCommandAdmissionDecision {
  const policy = input.policy ?? {
    capacity: ORCHESTRATION_COMMAND_QUEUE_CAPACITY,
    reservedCapacity: ORCHESTRATION_COMMAND_CONTROL_RESERVE,
  };
  if (
    !Number.isSafeInteger(policy.capacity) ||
    policy.capacity <= 0 ||
    !Number.isSafeInteger(policy.reservedCapacity) ||
    policy.reservedCapacity <= 0 ||
    policy.reservedCapacity >= policy.capacity
  ) {
    throw new RangeError(
      "Orchestration command admission requires a positive capacity and a smaller positive reserve.",
    );
  }
  if (
    input.queues.control.state._tag !== "Open" ||
    input.queues.normal.state._tag !== "Open" ||
    input.queues.wake.state._tag !== "Open"
  ) {
    return { accepted: false, reason: "stopped" };
  }

  const admissionLimit = usesReservedCommandAdmission(input.commandType)
    ? policy.capacity
    : policy.capacity - policy.reservedCapacity;
  const queued = Queue.sizeUnsafe(input.queues.control) + Queue.sizeUnsafe(input.queues.normal);
  if (queued >= admissionLimit) {
    return { accepted: false, reason: "overloaded" };
  }
  const target = usesReservedCommandAdmission(input.commandType)
    ? input.queues.control
    : input.queues.normal;
  if (!Queue.offerUnsafe(target, input.envelope)) {
    return {
      accepted: false,
      reason: target.state._tag === "Open" ? "overloaded" : "stopped",
    };
  }
  // One wake token per accepted envelope lets the worker poll the control
  // queue first without racing two destructive Queue.take operations.
  Queue.offerUnsafe(input.queues.wake, undefined);
  return { accepted: true };
}

export function takeNextOrchestrationCommand<A>(
  queues: OrchestrationCommandQueues<A>,
): Effect.Effect<A> {
  return Queue.take(queues.wake).pipe(
    Effect.flatMap(() => Queue.poll(queues.control)),
    Effect.flatMap(
      Option.match({
        onNone: () => Queue.take(queues.normal),
        onSome: Effect.succeed,
      }),
    ),
  );
}
