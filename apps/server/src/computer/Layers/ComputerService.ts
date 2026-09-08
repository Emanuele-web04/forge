import { Effect, Layer } from "effect";
import type { ComputerAvailability } from "@synara/contracts";

import { ComputerManager } from "../ComputerManager.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { UnavailableComputerBackend } from "../UnavailableComputerBackend.ts";
import { ComputerService, type ComputerServiceShape } from "../Services/ComputerService.ts";
import type { ComputerBackend } from "../ComputerBackend.ts";

export interface ComputerServiceLiveOptions {
  /** Inject a real or fake backend. */
  readonly backend?: ComputerBackend;
  /** Test/embedding override for the final availability decision. */
  readonly supported?: boolean;
  /** Test override for the host platform; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

export function makeComputerServiceLayer(options: ComputerServiceLiveOptions = {}) {
  return Layer.effect(
    ComputerService,
    Effect.gen(function* () {
      const platform = options.platform ?? process.platform;
      const requestedBackend = process.env.SYNARA_COMPUTER_BACKEND?.trim().toLowerCase();
      const unavailableAvailability: ComputerAvailability =
        platform === "linux"
          ? {
              kind: "backend-unavailable",
              message: "No computer backend is available on this server.",
            }
          : { kind: "unsupported-platform", platform };
      const backend =
        options.backend ??
        (requestedBackend === "fake" ? new FakeComputerBackend() : undefined) ??
        new UnavailableComputerBackend(
          `No computer backend is configured for this server running on ${platform}.`,
          { availability: unavailableAvailability },
        );
      const manager = new ComputerManager({ backend });
      yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()));
      let availability: ComputerAvailability;
      if (options.supported === undefined) {
        // The passive probe, never the establishing read. Boot runs for every
        // user of every build, long before anyone has asked for a desktop.
        availability = yield* Effect.promise(() => backend.probeAvailability());
      } else if (options.supported) {
        availability = { kind: "available", backend: "test-override" };
      } else {
        availability = {
          kind: "backend-unavailable",
          message: "Computer support is disabled by the service configuration.",
        };
      }
      return {
        // A configured fake is supported for tests. Every other default is an
        // unavailable backend whose handlers refuse safely.
        supported: options.supported ?? !(backend instanceof UnavailableComputerBackend),
        availability,
        manager,
      } satisfies ComputerServiceShape;
    }),
  );
}

export const ComputerServiceLive = makeComputerServiceLayer();
