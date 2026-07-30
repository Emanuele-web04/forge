// FILE: remoteHostConnectivity.ts
// Purpose: Pure per-host connectivity state machine — connected / degraded /
//          reconnecting / down — with bounded exponential backoff and jitter.
// Layer: Shared runtime (server + tests)
// Exports: initialConnectivity, applyHealthResult, backoffDelayMs,
//          isHostUsable, shouldAttemptNow

import type {
  RemoteHostConnectivityState,
  RemoteHostConnectivityStatus,
  RemoteHostId,
  RemoteHostProbeOutcome,
} from "@synara/contracts";

/**
 * A single failure is a blip: Wi-Fi roams, a laptop sleeps for a second, a NAT
 * rebinds. Declaring an outage on one failure produces an alarm the user learns
 * to ignore. `degraded` is the state where we have seen a failure but still
 * believe the host; `down` is the state where we have stopped believing it.
 */
export const DEGRADED_FAILURE_THRESHOLD = 1;
export const DOWN_FAILURE_THRESHOLD = 4;

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

/**
 * Exponential backoff with full jitter. Jitter is not cosmetic: without it, every
 * host on a machine that lost its network retries in lockstep and hammers the
 * link the moment it returns.
 */
export function backoffDelayMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  if (consecutiveFailures <= 0) return 0;
  const exponent = Math.min(consecutiveFailures - 1, 16);
  const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
  // Full jitter over [ceiling/2, ceiling] keeps a floor so we never busy-retry.
  const floor = ceiling / 2;
  return Math.round(floor + random() * (ceiling - floor));
}

export function initialConnectivity(
  hostId: RemoteHostId,
  nowMs: number,
): RemoteHostConnectivityStatus {
  return {
    hostId,
    state: "reconnecting",
    consecutiveFailures: 0,
    since: new Date(nowMs).toISOString(),
  };
}

export interface HealthResult {
  readonly ok: boolean;
  /**
   * Outcome of the health check. Health checks exercise the REAL command path
   * (the rendered session command with the version check substituted), not a bare
   * TCP connect — a host that accepts connections but has lost the project
   * directory or the binary is not healthy, and a liveness ping would call it so.
   */
  readonly outcome?: RemoteHostProbeOutcome | undefined;
  readonly error?: string | undefined;
}

function nextState(
  previous: RemoteHostConnectivityState,
  failures: number,
): RemoteHostConnectivityState {
  if (failures === 0) return "connected";
  if (failures >= DOWN_FAILURE_THRESHOLD) return "down";
  if (failures > DEGRADED_FAILURE_THRESHOLD) return "reconnecting";
  // Only a previously-connected host degrades. One that was never up (or is
  // already down) stays in its recovery state rather than claiming a demotion
  // it never earned.
  return previous === "connected" || previous === "degraded" ? "degraded" : "reconnecting";
}

export function applyHealthResult(
  current: RemoteHostConnectivityStatus,
  result: HealthResult,
  nowMs: number,
  random: () => number = Math.random,
): RemoteHostConnectivityStatus {
  const failures = result.ok ? 0 : current.consecutiveFailures + 1;
  const state = nextState(current.state, failures);
  // `since` marks when the CURRENT state began, so a host flapping inside
  // `degraded` does not keep resetting the clock a user reads as "just now".
  const since = state === current.state ? current.since : new Date(nowMs).toISOString();

  return {
    hostId: current.hostId,
    state,
    consecutiveFailures: failures,
    since,
    ...(result.ok ? {} : { nextAttemptAtMs: nowMs + backoffDelayMs(failures, random) }),
    ...(result.ok || result.error === undefined ? {} : { lastError: result.error }),
    ...(result.outcome === undefined ? {} : { lastProbeOutcome: result.outcome }),
  };
}

/**
 * Whether a new session may be started against this host right now.
 *
 * `degraded` still counts as usable: one failed health check is not a reason to
 * refuse work that would probably succeed, and the pre-start probe is the real
 * gate. `down` and `reconnecting` are not — starting there produces a session
 * that hangs instead of an error the user can read.
 */
export function isHostUsable(status: RemoteHostConnectivityStatus): boolean {
  return status.state === "connected" || status.state === "degraded";
}

/** Whether the backoff window has elapsed and another attempt is allowed. */
export function shouldAttemptNow(status: RemoteHostConnectivityStatus, nowMs: number): boolean {
  return status.nextAttemptAtMs === undefined || nowMs >= status.nextAttemptAtMs;
}
