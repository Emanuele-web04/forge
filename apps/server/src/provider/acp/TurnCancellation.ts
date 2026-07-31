// FILE: TurnCancellation.ts
// Purpose: Sends ACP turn cancellation, waits for the prompt response, then escalates if needed.
// Layer: Provider ACP lifecycle coordination

import { Cause, Effect, Exit, Fiber, Option } from "effect";

export interface TurnCancellationResult {
  readonly cancelRequest: "sent" | "failed" | "timedOut";
  readonly cancelFailure?: string;
  readonly prompt: "notStarted" | "settled" | "timedOut";
}

export function cancelTurnAndWait(input: {
  readonly cancel: Effect.Effect<void, unknown>;
  readonly promptFiber: Fiber.Fiber<void, never> | undefined;
  readonly graceMs: number;
}): Effect.Effect<TurnCancellationResult> {
  return Effect.gen(function* () {
    const cancelExit = yield* input.cancel.pipe(Effect.timeoutOption(input.graceMs), Effect.exit);
    const cancelRequest = Exit.isFailure(cancelExit)
      ? "failed"
      : Option.isNone(cancelExit.value)
        ? "timedOut"
        : "sent";
    const cancelFailure = Exit.isFailure(cancelExit) ? Cause.pretty(cancelExit.cause) : undefined;

    if (input.promptFiber === undefined) {
      return {
        cancelRequest,
        ...(cancelFailure ? { cancelFailure } : {}),
        prompt: "notStarted",
      };
    }

    const settled = yield* Fiber.join(input.promptFiber).pipe(Effect.timeoutOption(input.graceMs));
    if (Option.isNone(settled)) {
      yield* Fiber.interrupt(input.promptFiber);
      return {
        cancelRequest,
        ...(cancelFailure ? { cancelFailure } : {}),
        prompt: "timedOut",
      };
    }

    return {
      cancelRequest,
      ...(cancelFailure ? { cancelFailure } : {}),
      prompt: "settled",
    };
  });
}
