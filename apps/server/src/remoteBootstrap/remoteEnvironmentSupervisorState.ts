// FILE: remoteEnvironmentSupervisorState.ts
// Purpose: The supervisor's decisions as pure functions — what a saved-host set
//          change implies (start / stop / leave alone), and how one host's
//          status advances through the pipeline.
// Layer: Server / remote broker (no I/O, so every branch is directly testable)
// Exports: RemoteEnvironmentSupervisorPlan, planSupervisedHosts, phaseForStep,
//          statusFor, failedStatus, unsupportedStatus
//
// Split from the service so the reconciliation rules — which are where a
// supervisor goes wrong — can be tested without a tunnel, a settings stream, or
// a clock.

import type {
  RemoteEnvironmentPhase,
  RemoteEnvironmentStatus,
  RemoteHostConfig,
  RemoteHostId,
} from "@synara/contracts";
import { backoffDelayMs } from "@synara/shared/remoteHostConnectivity";

/**
 * What must change to make the running set match the saved set.
 *
 * `restart` is separate from `start` because a host whose CONNECTION FIELDS
 * changed is a different destination wearing the same id: leaving its tunnel up
 * would keep serving the old machine forever, and tearing it down without
 * restarting would silently drop a host the user still has saved.
 */
export interface RemoteEnvironmentSupervisorPlan {
  readonly start: readonly RemoteHostConfig[];
  readonly restart: readonly RemoteHostConfig[];
  readonly stop: readonly RemoteHostId[];
}

/**
 * The fields that decide WHICH machine, and how we reach it.
 *
 * `label` is deliberately absent: renaming a host is a display change and must
 * not tear down a working tunnel. Everything that alters the ssh invocation or
 * the trust decision is present, because a change to any of them means the
 * running tunnel is connected to something the saved config no longer
 * describes.
 */
export function connectionIdentityOf(config: RemoteHostConfig): string {
  return JSON.stringify([
    config.destination,
    config.sshBinary ?? null,
    config.sshArgs,
    config.hostKeyVerification,
    config.connectTimeoutSeconds,
    config.keepalive,
    config.connectionReuse,
    config.shellInit ?? null,
    config.launcher,
    config.binaryPath ?? null,
  ]);
}

/**
 * Diffs the saved hosts against what is running.
 *
 * Duplicate host ids in settings collapse to the FIRST occurrence rather than
 * throwing: settings are user-editable on disk, and a supervisor that crashes
 * on a malformed file takes every other host down with it.
 */
export function planSupervisedHosts(input: {
  readonly saved: readonly RemoteHostConfig[];
  /** Connection identity of each host currently supervised, by id. */
  readonly running: ReadonlyMap<RemoteHostId, string>;
}): RemoteEnvironmentSupervisorPlan {
  const start: RemoteHostConfig[] = [];
  const restart: RemoteHostConfig[] = [];
  const seen = new Set<RemoteHostId>();

  for (const config of input.saved) {
    if (seen.has(config.hostId)) continue;
    seen.add(config.hostId);
    const runningIdentity = input.running.get(config.hostId);
    if (runningIdentity === undefined) {
      start.push(config);
    } else if (runningIdentity !== connectionIdentityOf(config)) {
      restart.push(config);
    }
  }

  const stop = [...input.running.keys()].filter((hostId) => !seen.has(hostId));
  return { start, restart, stop };
}

/**
 * The phase a bootstrap step belongs to.
 *
 * Every step maps to `bootstrapping` — including `handshake`, which happens
 * while the bootstrapper still owns the run. The later, separate handshake over
 * the long-lived tunnel is what `connecting` covers.
 */
export function phaseForStep(_step: string): RemoteEnvironmentPhase {
  return "bootstrapping";
}

export function statusFor(input: {
  readonly hostId: RemoteHostId;
  readonly phase: RemoteEnvironmentPhase;
  readonly nowMs: number;
  readonly environmentId?: string | undefined;
  readonly bootstrapStep?: string | undefined;
}): RemoteEnvironmentStatus {
  return {
    hostId: input.hostId,
    phase: input.phase,
    updatedAt: new Date(input.nowMs).toISOString(),
    ...(input.environmentId === undefined
      ? {}
      : { environmentId: input.environmentId as RemoteEnvironmentStatus["environmentId"] }),
    ...(input.bootstrapStep === undefined ? {} : { bootstrapStep: input.bootstrapStep }),
  };
}

/**
 * A failure, with the next attempt already scheduled.
 *
 * Reuses `backoffDelayMs` — the same jittered curve the connectivity state
 * machine uses — rather than a second schedule of its own. Two backoff policies
 * for one host is how a "quiet" host ends up probed twice as often as either
 * policy intended.
 */
export function failedStatus(input: {
  readonly hostId: RemoteHostId;
  readonly attempt: number;
  readonly error: string;
  readonly nowMs: number;
  readonly random?: () => number;
  /** Preserved across a failure so the UI does not lose a proven id. */
  readonly environmentId?: string | undefined;
}): RemoteEnvironmentStatus {
  return {
    hostId: input.hostId,
    phase: "failed",
    lastError: input.error,
    retryAtMs: input.nowMs + backoffDelayMs(input.attempt, input.random ?? Math.random),
    updatedAt: new Date(input.nowMs).toISOString(),
    ...(input.environmentId === undefined
      ? {}
      : { environmentId: input.environmentId as RemoteEnvironmentStatus["environmentId"] }),
  };
}

/** Terminal. Carries the capability's own reason and schedules no retry. */
export function unsupportedStatus(input: {
  readonly hostId: RemoteHostId;
  readonly reason: string;
  readonly nowMs: number;
}): RemoteEnvironmentStatus {
  return {
    hostId: input.hostId,
    phase: "unsupported",
    unsupportedReason: input.reason,
    updatedAt: new Date(input.nowMs).toISOString(),
  };
}
