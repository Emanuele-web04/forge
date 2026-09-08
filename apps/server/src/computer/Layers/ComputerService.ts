import { Effect, Layer } from "effect";
import type { ComputerAvailability } from "@synara/contracts";

import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { ComputerManager } from "../ComputerManager.ts";
import { KWinComputerBackend } from "../KWinComputerBackend.ts";
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
      const configuredBackend =
        options.backend ??
        (process.env.SYNARA_COMPUTER_BACKEND === "fake" ? new FakeComputerBackend() : undefined);
      // Off Linux there is no backend to fall back to — and the fake would be
      // worse than none: it answers "available" and every tool call succeeds
      // against a phantom desktop, so an agent could report success at clicks
      // that never happened. The unavailable backend refuses instead, with the
      // verdict kind the pane's blocked state is keyed off.
      const backend =
        configuredBackend ??
        (platform === "linux" ? new KWinComputerBackend() : undefined) ??
        new UnavailableComputerBackend(
          `Computer control requires a Linux host; this server runs on ${platform}.`,
          { availability: { kind: "unsupported-platform", platform } },
        );
      const manager = new ComputerManager({ backend });
      yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()));
      let availability: ComputerAvailability;
      if (options.supported === undefined) {
        // The passive probe, never the establishing read. Boot runs for every
        // user of every build, and `availability()` on KWin connects, installs
        // the plugin — compiling it from source on a cold machine — and loads
        // it into the live compositor. Nobody has asked for a desktop yet at
        // this point, so nothing may be done to theirs; the first real use is
        // what provisions, and it reports its own failure if it cannot.
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
        // Supported means "this host could ever drive a desktop", not "the
        // desktop works right now". A real backend keeps every handler and the
        // agent gateway routed through the manager, whose availability reads
        // let a helper installed or a plugin loaded after boot appear without
        // a server restart; freezing the boot probe's verdict here would cache
        // `unsupported` for the process's lifetime — the exact restart the
        // backend's re-probe exists to avoid. Only a host that can never
        // qualify — off Linux, or a configuration the backend selection
        // refused — stays unsupported, and the boot `availability` beside it
        // is the frozen answer those handlers serve.
        supported: options.supported ?? !(backend instanceof UnavailableComputerBackend),
        availability,
        manager,
      } satisfies ComputerServiceShape;
    }),
  );
}

export const ComputerServiceLive = makeComputerServiceLayer();
