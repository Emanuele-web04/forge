/**
 * Supervision health accounting, shared by every computer backend.
 *
 * The counters are the part of health that is identical whatever the display
 * server is: how many attempts have failed since the last good connection, how
 * many times the backend has come back, what went wrong most recently, and the
 * de-duplication that keeps one outage from being counted twice. What differs
 * per backend is only the *status* — which live objects have to exist for a
 * backend to call itself connected — so that stays a callback the owner
 * supplies rather than state this module tries to model.
 */
import type {
  ComputerHealth,
  ComputerHealthFailure,
  ComputerHealthStatus,
} from "@synara/contracts";

import { clampComputerMessage } from "./ComputerBackend.ts";

/** The part of health only the owning backend can answer. */
export interface ComputerHealthStatusReading {
  readonly status: ComputerHealthStatus;
  readonly captureAvailable: boolean;
  /**
   * Set only by a backend that can tell its input delivery has lost a rung.
   * Left absent everywhere else, so a backend with no such notion encodes
   * exactly as it did before the field existed.
   */
  readonly backgroundInputDegraded?: boolean;
}

export interface ComputerHealthStateOptions {
  /**
   * Read live status. Called on every `health()` so what a panel is told and
   * what the next action will find cannot drift apart, which means it must stay
   * synchronous and side-effect free: it runs from inside the handler of the
   * very event that changed it.
   */
  readonly readStatus: () => ComputerHealthStatusReading;
  /** Publishes a changed health snapshot. Never called for an unchanged one. */
  readonly emit: (health: ComputerHealth) => void;
  readonly now?: () => number;
  /** Used when the failure carried no message of its own. */
  readonly failureFallbackMessage: string;
}

export class ComputerHealthState {
  private readonly readStatus: () => ComputerHealthStatusReading;
  private readonly emit: (health: ComputerHealth) => void;
  private readonly now: () => number;
  private readonly failureFallbackMessage: string;

  private consecutiveFailuresCount = 0;
  private reconnectsCount = 0;
  private lastFailure: ComputerHealthFailure | undefined;
  private hasConnected = false;
  /**
   * The error the failure counters were last moved for. One connection loss
   * reaches the counters twice — the connect path rethrows what the caller then
   * reports — and both hops carry the same object, so identity is what keeps a
   * single outage from counting as two.
   */
  private countedFailure: unknown;
  private publishedHealth: ComputerHealth | undefined;

  constructor(options: ComputerHealthStateOptions) {
    this.readStatus = options.readStatus;
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
    this.failureFallbackMessage = options.failureFallbackMessage;
  }

  get consecutiveFailures(): number {
    return this.consecutiveFailuresCount;
  }

  get reconnects(): number {
    return this.reconnectsCount;
  }

  health(): ComputerHealth {
    const reading = this.readStatus();
    return {
      status: reading.status,
      consecutiveFailures: this.consecutiveFailuresCount,
      reconnects: this.reconnectsCount,
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
      captureAvailable: reading.captureAvailable,
      ...(reading.backgroundInputDegraded === undefined
        ? {}
        : { backgroundInputDegraded: reading.backgroundInputDegraded }),
    };
  }

  /**
   * Records one supervision failure. Mutates only: the transition that follows
   * it — a scheduled reconnect, a refusal with no retry — decides the status,
   * and publishing here would put an "unavailable" event on the wire that the
   * next line immediately corrects.
   */
  recordFailure(error: unknown): void {
    if (error === this.countedFailure) return;
    this.countedFailure = error;
    this.consecutiveFailuresCount += 1;
    this.lastFailure = {
      message: clampComputerMessage(
        error instanceof Error ? error.message : String(error),
        this.failureFallbackMessage,
      ),
      at: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Records a successful connection. A connection re-established after the
   * first one is a recovery, whether a reconnect timer or the next action drove
   * it. `lastFailure` survives on purpose: it is how a healed outage can still
   * be explained.
   */
  recordConnected(): void {
    if (this.hasConnected) this.reconnectsCount += 1;
    this.hasConnected = true;
    this.consecutiveFailuresCount = 0;
    this.countedFailure = undefined;
  }

  /** Publishes health to observers, and only on a real change. */
  publish(): void {
    const health = this.health();
    if (this.publishedHealth && sameComputerHealth(this.publishedHealth, health)) return;
    this.publishedHealth = health;
    this.emit(health);
  }
}

export function sameComputerHealth(left: ComputerHealth, right: ComputerHealth): boolean {
  return (
    left.status === right.status &&
    left.consecutiveFailures === right.consecutiveFailures &&
    left.reconnects === right.reconnects &&
    left.captureAvailable === right.captureAvailable &&
    left.backgroundInputDegraded === right.backgroundInputDegraded &&
    left.lastFailure?.at === right.lastFailure?.at &&
    left.lastFailure?.message === right.lastFailure?.message
  );
}
