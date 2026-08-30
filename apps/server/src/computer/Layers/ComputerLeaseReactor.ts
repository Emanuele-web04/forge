/**
 * Releases the exclusive desktop lease when its owner can no longer drive the
 * desktop.
 *
 * The desktop is held by one thread at a time (see `ComputerManager`), and the
 * hold must end as soon as the owning turn does — otherwise the next
 * conversation waits out the idle backstop for no reason. Nothing in the
 * orchestration domain event vocabulary says "a turn ended", so this listens to
 * the provider runtime stream, which is where terminal turns and dead sessions
 * are actually reported.
 *
 * It lives outside `ComputerServiceLive` on purpose: that layer is
 * dependency-free and is constructed inside the runtime graph, while
 * `ProviderService` only exists once the provider graph is composed alongside
 * it. This is the same split `ProviderSessionReaper` makes for the same reason.
 *
 * @module computer/Layers/ComputerLeaseReactor
 */
import type { ProviderRuntimeEvent } from "@synara/contracts";
import { Cause, Effect, Layer, Stream } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService";
import {
  ComputerLeaseReactor,
  type ComputerLeaseReactorShape,
} from "../Services/ComputerLeaseReactor";
import { ComputerService } from "../Services/ComputerService";

/**
 * A terminal turn ends the thread's authority to act: the gateway refuses every
 * computer tool call outside an active turn, so the lease has no one left to
 * protect. `session.exited` covers the runtime dying mid-turn, which reaches
 * the same state without a terminal turn event.
 */
export function releasesDesktopControl(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.exited"
  );
}

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const computerService = yield* ComputerService;

  const releaseDesktopControl = (event: ProviderRuntimeEvent) =>
    Effect.promise(() => computerService.manager.releaseDesktopControl(event.threadId)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : // A lease that fails to release is not worth failing a fiber over:
            // the idle backstop still frees the desktop.
            Effect.logDebug("computer lease release skipped", {
              threadId: event.threadId,
              eventType: event.type,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const start: ComputerLeaseReactorShape["start"] = () =>
    Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        releasesDesktopControl(event) ? releaseDesktopControl(event) : Effect.void,
      ),
    ).pipe(Effect.asVoid);

  return { start } satisfies ComputerLeaseReactorShape;
});

export const ComputerLeaseReactorLive = Layer.effect(ComputerLeaseReactor, make);
