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

/**
 * Priority lanes, drained strictly highest-first.
 *
 * - `control`: settle or abort work that already exists (stop, interrupt,
 *   completion commands). Never blocked behind anything.
 * - `user`: direct user actions that create new work. Ahead of background
 *   traffic, but behind control so a stop can never queue behind a burst of
 *   turn starts.
 * - `normal`: retention, projections and every other background command.
 */
export type OrchestrationCommandLane = "control" | "user" | "normal";

export interface OrchestrationCommandQueues<A> {
  readonly control: Queue.Queue<A>;
  readonly user: Queue.Queue<A>;
  readonly normal: Queue.Queue<A>;
  readonly wake: Queue.Queue<void>;
}

/**
 * Commands that may use the reserved capacity and stay admissible while the
 * engine is quiescing.
 *
 * Membership means "this command settles work that is already in flight", so
 * admitting it can only bring the engine closer to idle. A command that starts
 * new work must never be listed here: during quiesce it would spawn a provider
 * turn the shutdown is about to fence, orphaning it. Lane priority for user
 * actions is expressed by {@link orchestrationCommandLane} instead.
 */
export function usesReservedCommandAdmission(type: OrchestrationCommand["type"]): boolean {
  switch (type) {
    case "thread.turn.interrupt":
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

export function orchestrationCommandLane(
  type: OrchestrationCommand["type"],
): OrchestrationCommandLane {
  if (usesReservedCommandAdmission(type)) {
    return "control";
  }
  switch (type) {
    // Direct user actions must not sit behind retention and other background
    // projection traffic. They get their own lane rather than the control lane,
    // so a burst of turn starts cannot delay a stop.
    case "thread.create":
    case "thread.turn.start":
    case "thread.checkpoint.revert":
    case "thread.conversation.rollback":
    case "thread.message.edit-and-resend":
      return "user";
    default:
      return "normal";
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
    input.queues.user.state._tag !== "Open" ||
    input.queues.normal.state._tag !== "Open" ||
    input.queues.wake.state._tag !== "Open"
  ) {
    return { accepted: false, reason: "stopped" };
  }

  const lane = orchestrationCommandLane(input.commandType);
  // The reserve is measured against everything already queued, so only control
  // commands can consume the last `reservedCapacity` slots.
  const admissionLimit =
    lane === "control" ? policy.capacity : policy.capacity - policy.reservedCapacity;
  const queued =
    Queue.sizeUnsafe(input.queues.control) +
    Queue.sizeUnsafe(input.queues.user) +
    Queue.sizeUnsafe(input.queues.normal);
  if (queued >= admissionLimit) {
    return { accepted: false, reason: "overloaded" };
  }
  const target = input.queues[lane];
  if (!Queue.offerUnsafe(target, input.envelope)) {
    return {
      accepted: false,
      reason: target.state._tag === "Open" ? "overloaded" : "stopped",
    };
  }
  // One wake token per accepted envelope lets the worker drain the lanes in
  // priority order without racing several destructive Queue.take operations.
  Queue.offerUnsafe(input.queues.wake, undefined);
  return { accepted: true };
}

export function takeNextOrchestrationCommand<A>(
  queues: OrchestrationCommandQueues<A>,
): Effect.Effect<A> {
  // The token is offered after the envelope, so by the time one is taken its
  // envelope is already queued: polling the higher lanes can only miss it if a
  // lower lane holds it.
  return Queue.take(queues.wake).pipe(
    Effect.flatMap(() => Queue.poll(queues.control)),
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Queue.poll(queues.user).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () => Queue.take(queues.normal),
              }),
            ),
          ),
      }),
    ),
  );
}
