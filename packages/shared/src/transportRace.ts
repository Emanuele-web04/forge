/**
 * Transport selection: probe every candidate path to a host at once, take the
 * most preferred one that answers.
 *
 * ADR 0007 fixes the order — loopback > LAN > Tailscale > SSH > relay — and
 * explicitly rejects latency-based selection: the fastest answer is not the
 * best path. A relay round-trip that beats a sleepy loopback by 40ms would
 * otherwise push a same-machine session through the cloud for its whole life.
 * So this is a race for *preference*, not for time; latency only decides how
 * long we are willing to wait.
 *
 * ADR 0010 makes this the reachability check as well: there is no presence
 * store and no push channel, so a host's status is whatever the last probe
 * said. That is why the result carries every attempt, not just the winner.
 *
 * No network code lives here. The caller supplies the probe, which keeps the
 * policy — ordering, timeouts, short-circuiting — deterministic and testable
 * without opening a socket, and lets each shell probe the way it can (fetch in
 * the browser, TCP connect on desktop).
 *
 * @module transportRace
 */

export type TransportKind = "loopback" | "lan" | "tailscale" | "ssh" | "relay";

/**
 * Fixed preference order (ADR 0007). Earlier is better. SSH is desktop-only
 * and mDNS/LAN discovery is desktop-only, but that is a question of which
 * candidates a caller builds — this module never invents one, so a web client
 * simply never passes an `ssh` entry.
 */
export const TRANSPORT_PREFERENCE: readonly TransportKind[] = [
  "loopback",
  "lan",
  "tailscale",
  "ssh",
  "relay",
];

export interface TransportCandidate {
  readonly kind: TransportKind;
  readonly url: string;
  /** Human-facing origin of the candidate, e.g. "mDNS" or the endpoint name. */
  readonly label?: string;
}

/** Lower is more preferred. Unknown kinds rank last rather than throwing. */
export function transportPreferenceRank(kind: TransportKind): number {
  const rank = TRANSPORT_PREFERENCE.indexOf(kind);
  return rank === -1 ? TRANSPORT_PREFERENCE.length : rank;
}

/**
 * Preference order, ties broken by the caller's order (stable). Useful on its
 * own for rendering a candidate list the same way the race walks it.
 */
export function sortByTransportPreference(
  candidates: readonly TransportCandidate[],
): readonly TransportCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .toSorted(
      (a, b) =>
        transportPreferenceRank(a.candidate.kind) - transportPreferenceRank(b.candidate.kind) ||
        a.index - b.index,
    )
    .map((entry) => entry.candidate);
}

/**
 * A cheap liveness check. Resolve `true` when the host answered on this path,
 * `false` when it definitively did not (connection refused, wrong host, 404).
 * A rejection is treated as `false`. The signal aborts when the probe's
 * timeout expires or the race has already been decided — honor it so a
 * dropped candidate does not keep a socket open.
 */
export type TransportProbe = (
  candidate: TransportCandidate,
  signal: AbortSignal,
) => Promise<boolean>;

/** Schedules `callback` after `ms` and returns a cancel function. */
export type ScheduleTimeout = (callback: () => void, ms: number) => () => void;

export const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
export const DEFAULT_RACE_DEADLINE_MS = 3_000;

export interface RaceTransportsOptions {
  /** Per-candidate budget; one hanging path never stalls the others. */
  readonly probeTimeoutMs?: number;
  /** Ceiling on the whole race, whatever the individual probes are doing. */
  readonly deadlineMs?: number;
  /** Injected so tests need no real waiting. */
  readonly schedule?: ScheduleTimeout;
}

export type TransportAttemptStatus =
  | "reachable"
  | "unreachable"
  | "timed-out"
  /** Still running when a better candidate had already won. */
  | "cancelled";

export interface TransportAttempt {
  readonly candidate: TransportCandidate;
  readonly status: TransportAttemptStatus;
}

/**
 * Three failure shapes, because a client renders them differently: nothing to
 * try (the host has no endpoints and no relay), tried and refused (the host is
 * off), and tried and heard nothing (the network is swallowing us). Collapsing
 * the last two into one "offline" would tell a user behind a captive portal
 * that their machine is down.
 */
export type TransportRaceResult =
  | {
      readonly outcome: "reachable";
      readonly candidate: TransportCandidate;
      readonly attempts: readonly TransportAttempt[];
    }
  | { readonly outcome: "unreachable"; readonly attempts: readonly TransportAttempt[] }
  | { readonly outcome: "timed-out"; readonly attempts: readonly TransportAttempt[] }
  | { readonly outcome: "no-candidates"; readonly attempts: readonly TransportAttempt[] };

const defaultSchedule: ScheduleTimeout = (callback, ms) => {
  const handle = globalThis.setTimeout(callback, ms);
  return () => {
    globalThis.clearTimeout(handle);
  };
};

/**
 * Probe every candidate concurrently and return the most preferred one that
 * answers.
 *
 * Short-circuits: the race ends as soon as nothing still running could beat
 * what already answered — a loopback win resolves immediately, while a relay
 * win keeps waiting for the direct paths until their timeouts. That is the
 * difference between "connects instantly on the couch" and "always pays 3s".
 */
export function raceTransports(
  candidates: readonly TransportCandidate[],
  probe: TransportProbe,
  options: RaceTransportsOptions = {},
): Promise<TransportRaceResult> {
  if (candidates.length === 0) {
    return Promise.resolve({ outcome: "no-candidates", attempts: [] });
  }

  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_RACE_DEADLINE_MS;
  const schedule = options.schedule ?? defaultSchedule;

  // Preference order up front, so index order *is* the order we prefer and
  // the "could anything still beat this" test is a comparison of indices.
  const ordered = sortByTransportPreference(candidates);

  return new Promise<TransportRaceResult>((resolve) => {
    const statuses: (TransportAttemptStatus | undefined)[] = ordered.map(() => undefined);
    const controllers = ordered.map(() => new AbortController());
    const cancels: (() => void)[] = [];
    let settled = false;

    const buildResult = (): TransportRaceResult => {
      const attempts: TransportAttempt[] = ordered.map((candidate, index) => ({
        candidate,
        status: statuses[index] ?? "cancelled",
      }));
      const winner = attempts.find((attempt) => attempt.status === "reachable");
      if (winner) return { outcome: "reachable", candidate: winner.candidate, attempts };
      // "Everything timed out" means exactly that: one refused connection is a
      // real answer and makes this an ordinary unreachable host.
      const everyAttemptTimedOut = attempts.every((attempt) => attempt.status !== "unreachable");
      return { outcome: everyAttemptTimedOut ? "timed-out" : "unreachable", attempts };
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      for (const cancel of cancels) cancel();
      for (const controller of controllers) controller.abort();
      resolve(buildResult());
    };

    /**
     * Resolve as soon as the answer cannot change. `ordered` is in preference
     * order, so the first index still pending is the best result any
     * outstanding probe could produce: if a reachable candidate sits before it,
     * nothing left running can outrank the winner and we stop immediately.
     * A relay that answers first therefore keeps waiting for loopback and LAN,
     * while a loopback that answers ends the race on the spot.
     */
    const checkCompletion = (): void => {
      const firstPendingIndex = statuses.findIndex((status) => status === undefined);
      const firstReachableIndex = statuses.findIndex((status) => status === "reachable");
      if (firstPendingIndex === -1) {
        finish();
        return;
      }
      if (firstReachableIndex !== -1 && firstReachableIndex < firstPendingIndex) finish();
    };

    const settleProbe = (index: number, status: TransportAttemptStatus): void => {
      if (settled || statuses[index] !== undefined) return;
      statuses[index] = status;
      checkCompletion();
    };

    cancels.push(schedule(finish, deadlineMs));

    ordered.forEach((candidate, index) => {
      const controller = controllers[index];
      if (!controller) return;
      let timedOut = false;
      const cancelTimeout = schedule(() => {
        timedOut = true;
        controller.abort();
        settleProbe(index, "timed-out");
      }, probeTimeoutMs);
      cancels.push(cancelTimeout);
      // Called directly (not behind `Promise.resolve().then`) so the probe
      // starts in this tick and the result needs one microtask hop, not four.
      // A probe that throws synchronously is a failed probe, not a failed race.
      let pending: Promise<boolean>;
      try {
        pending = Promise.resolve(probe(candidate, controller.signal));
      } catch (cause) {
        pending = Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
      void pending.then(
        (reachable) => {
          cancelTimeout();
          settleProbe(index, reachable ? "reachable" : "unreachable");
        },
        () => {
          cancelTimeout();
          settleProbe(index, timedOut ? "timed-out" : "unreachable");
        },
      );
    });

    // A zero/negative deadline (or probe timeout) fires on the next tick; the
    // guard above keeps the first one to fire authoritative.
    checkCompletion();
  });
}
