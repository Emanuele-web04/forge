import { Effect, Layer } from "effect";
import type { ComputerAvailability } from "@synara/contracts";

import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { ComputerManager } from "../ComputerManager.ts";
import { KWinComputerBackend } from "../KWinComputerBackend.ts";
import { UnavailableComputerBackend } from "../UnavailableComputerBackend.ts";
import {
  nestedModeForChoice,
  selectLinuxBackend,
  type LinuxBackendSelection,
} from "../linuxBackendSelection.ts";
import { sessionBusNameHasOwner } from "../sessionBusNames.ts";
import { NestedComputerBackend } from "../nestedComputerBackend.ts";
import { nestedAtspiMode, parseNestedSizeEnv } from "../nestedKWinSession.ts";
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

interface LinuxBackend {
  readonly backend: ComputerBackend;
}

export function makeComputerServiceLayer(options: ComputerServiceLiveOptions = {}) {
  return Layer.effect(
    ComputerService,
    Effect.gen(function* () {
      const platform = options.platform ?? process.platform;
      const configuredBackend =
        options.backend ??
        (process.env.SYNARA_COMPUTER_BACKEND === "fake" ? new FakeComputerBackend() : undefined);
      const linux =
        configuredBackend === undefined && platform === "linux"
          ? yield* Effect.promise(() => makeLinuxBackend())
          : undefined;
      // Off Linux there is no backend to fall back to — and the fake would be
      // worse than none: it answers "available" and every tool call succeeds
      // against a phantom desktop, so an agent could report success at clicks
      // that never happened. The unavailable backend refuses instead, with the
      // verdict kind the pane's blocked state is keyed off.
      const backend =
        configuredBackend ??
        linux?.backend ??
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

/**
 * Builds whichever backend `selectLinuxBackend` resolved, with no fallback in
 * any direction: a backend that fails stays failed and carries the reason. See `linuxBackendSelection.ts` for the order and why it probes the
 * session bus rather than reading `XDG_CURRENT_DESKTOP`.
 *
 * On a KDE host with none of these environment variables set, this is still a
 * bare `new KWinComputerBackend()` — the same object, with the same defaults,
 * as before any other backend existed.
 */
async function makeLinuxBackend(): Promise<LinuxBackend> {
  let selection: LinuxBackendSelection;
  try {
    selection = await selectLinuxBackend({ busNameHasOwner: sessionBusNameHasOwner });
  } catch (error) {
    // Only a malformed SYNARA_COMPUTER_BACKEND reaches here, and it must not
    // take the server down: an operator typo becomes an availability card that
    // lists the backends that do exist.
    return { backend: new UnavailableComputerBackend(describeError(error)) };
  }
  switch (selection.choice) {
    case "kwin":
      return { backend: new KWinComputerBackend() };
    case "nested":
    case "nested-window": {
      // Constructed, not booted: the nested compositor is expensive and — in
      // window mode — visible, so nothing may appear because a server started.
      // The backend boots its session on first real use, and its `provision()`
      // is the settings panel's one-click setup. The geometry comes from
      // `SYNARA_COMPUTER_NESTED_SIZE=WxH`. A session that fails to boot stays
      // failed: falling back to the real desktop would hand an agent the
      // human's screen right after an operator asked for an isolated one.
      const size = parseNestedSizeEnv(process.env.SYNARA_COMPUTER_NESTED_SIZE);
      return {
        backend: new NestedComputerBackend({
          mode: nestedModeForChoice(selection.choice) ?? "virtual",
          ...(size ? { size } : {}),
          atspiMode: nestedAtspiMode(),
        }),
      };
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ComputerServiceLive = makeComputerServiceLayer();
