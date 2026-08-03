// FILE: remoteEnvironmentSupervisorRuntime.ts
// Purpose: The process-wide supervisor instance, the settings subscription that
//          drives it, and the status stream transports read.
// Layer: Server / remote broker
// Exports: sharedRemoteEnvironmentSupervisor, remoteEnvironmentStatusStream,
//          currentRemoteEnvironmentStatuses, startRemoteEnvironmentSupervision,
//          resetSharedRemoteEnvironmentSupervisor
//
// ONE instance for the process, for the same reason the proxy registry and the
// SSH broker are: the supervised set IS the set of published environments, and
// a second supervisor would race the first for the same install roots, ports
// and proxy entries.

import type { RemoteEnvironmentStatus } from "@synara/contracts";
import { Effect, Queue, Stream } from "effect";

import { resolveSshControlDirectory } from "./remoteHostBroker";
import { resolveSynaraHomeDirectory } from "@synara/shared/synaraHome";
import {
  makeRemoteEnvironmentSupervisor,
  type RemoteEnvironmentSupervisor,
} from "./remoteEnvironmentSupervisor";
import { createLogger } from "./logger";
import { ServerSettingsService } from "./serverSettings";

const logger = createLogger("remote-supervisor");

let shared: RemoteEnvironmentSupervisor | undefined;
let latestStatuses: readonly RemoteEnvironmentStatus[] = [];

/**
 * Subscribers to the status stream.
 *
 * A plain listener set rather than an Effect PubSub because the supervisor is
 * callback-driven and lives outside the Effect runtime; the RPC layer adapts it
 * to a Stream at the edge (see `remoteEnvironmentStatusStream`).
 */
const listeners = new Set<(statuses: readonly RemoteEnvironmentStatus[]) => void>();

export function sharedRemoteEnvironmentSupervisor(): RemoteEnvironmentSupervisor {
  shared ??= makeRemoteEnvironmentSupervisor({
    controlDirectory: resolveSshControlDirectory(resolveSynaraHomeDirectory()),
    onStatusesChanged: (statuses) => {
      latestStatuses = statuses;
      for (const listener of listeners) {
        try {
          listener(statuses);
        } catch {
          // A broken subscriber must not stop the others from being told, and
          // must never propagate into the supervisor's own control flow.
        }
      }
    },
    onError: (message, cause) => {
      logger.warn(message, { cause: cause instanceof Error ? cause.message : String(cause) });
    },
  });
  return shared;
}

/** The latest status for every saved host. Safe to read before any host exists. */
export function currentRemoteEnvironmentStatuses(): readonly RemoteEnvironmentStatus[] {
  return latestStatuses;
}

/**
 * Live status updates.
 *
 * Does NOT replay the current value: callers concatenate the snapshot
 * themselves (the same shape `subscribeServerProviderStatuses` uses), so the
 * snapshot and the stream cannot disagree about which one carries the first
 * value.
 */
export function remoteEnvironmentStatusStream(): Stream.Stream<readonly RemoteEnvironmentStatus[]> {
  return Stream.callback<readonly RemoteEnvironmentStatus[]>((queue) =>
    Effect.gen(function* () {
      const listener = (statuses: readonly RemoteEnvironmentStatus[]) => {
        Effect.runFork(Queue.offer(queue, statuses).pipe(Effect.asVoid));
      };
      listeners.add(listener);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          listeners.delete(listener);
        }),
      );
    }),
  );
}

/**
 * Subscribes the supervisor to saved-host changes, for the life of the scope.
 *
 * Seeds from the CURRENT settings before streaming, because `streamChanges`
 * only carries changes: without the seed, hosts saved in a previous run would
 * sit unsupervised until someone edited settings.
 */
export const startRemoteEnvironmentSupervision = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const supervisor = sharedRemoteEnvironmentSupervisor();

  // SUBSCRIBE BEFORE SEEDING.
  //
  // The reverse order has a real window — not merely a test artifact — in which
  // a host saved during startup is published to a PubSub nobody is listening to
  // yet, and then missed by a seed that already read the older value. That host
  // stays unsupervised until the NEXT settings change, which for a user who adds
  // one host and stops is never.
  yield* settings.streamChanges.pipe(
    Stream.runForEach((next) => Effect.promise(() => supervisor.sync(next.remoteHosts))),
    // Background: the supervisor must not delay or fail server startup, and a
    // stream that ends must not take the runtime with it.
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        logger.warn("Remote host supervision stopped", { cause: String(cause) });
      }),
    ),
    Effect.forkScoped,
  );

  // Lets the forked fiber reach its first pull — where `Stream.fromPubSub`
  // actually takes its subscription — before the seed below reads settings.
  yield* Effect.yieldNow;

  // Hosts saved in a previous run come up from here. `sync` diffs against what
  // is already supervised, so a host seen by both the seed and the stream is
  // started once.
  const current = yield* settings.getSettings;
  yield* Effect.promise(() => supervisor.sync(current.remoteHosts));
});

/**
 * Test seam: drops the process-wide supervisor, optionally installing a
 * replacement.
 *
 * The replacement form is what lets a test drive the REAL settings
 * subscription — the link that did not exist — without opening an SSH tunnel:
 * the subscription and the supervisor stay genuinely wired, and only the
 * bring-up is substituted.
 */
export function resetSharedRemoteEnvironmentSupervisor(
  replacement?: RemoteEnvironmentSupervisor,
): void {
  shared = replacement;
  latestStatuses = [];
  listeners.clear();
}
