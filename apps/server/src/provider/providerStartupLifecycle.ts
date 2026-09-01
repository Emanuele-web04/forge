// FILE: providerStartupLifecycle.ts
// Purpose: Makes provider startup phases, failures, timeout, cancellation, and cleanup explicit.
// Layer: Provider runtime infrastructure

import { ExecutableNotFoundError } from "@synara/shared/platformProcess";
import { Duration, Effect, Option } from "effect";

export type ProviderStartupPhase =
  | "discovering"
  | "starting"
  | "handshaking"
  | "authenticating"
  | "ready"
  | "running"
  | "failed"
  | "stopped";

export type ProviderStartupFailureReason =
  | "ExecutableNotFound"
  | "SpawnFailed"
  | "ExitedDuringStartup"
  | "HandshakeTimeout"
  | "AuthenticationFailed"
  | "ProtocolFailure"
  | "Cancelled";

export interface ProviderStartupTransition {
  readonly phase: ProviderStartupPhase;
  readonly at: number;
  readonly failureReason?: ProviderStartupFailureReason;
}

export interface ProviderStartupSnapshot {
  readonly phase: ProviderStartupPhase;
  readonly failureReason?: ProviderStartupFailureReason;
  readonly transitions: ReadonlyArray<ProviderStartupTransition>;
}

const TERMINAL_PHASES = new Set<ProviderStartupPhase>(["failed", "stopped"]);

const ALLOWED_TRANSITIONS: Readonly<
  Record<ProviderStartupPhase, ReadonlySet<ProviderStartupPhase>>
> = {
  discovering: new Set(["starting", "failed", "stopped"]),
  starting: new Set(["handshaking", "authenticating", "ready", "failed", "stopped"]),
  handshaking: new Set(["authenticating", "ready", "failed", "stopped"]),
  authenticating: new Set(["handshaking", "ready", "failed", "stopped"]),
  ready: new Set(["running", "failed", "stopped"]),
  running: new Set(["failed", "stopped"]),
  failed: new Set(),
  stopped: new Set(),
};

export class ProviderStartupLifecycle {
  readonly #now: () => number;
  readonly #onTransition: ((transition: ProviderStartupTransition) => void) | undefined;
  #phase: ProviderStartupPhase = "discovering";
  #failureReason: ProviderStartupFailureReason | undefined;
  readonly #transitions: ProviderStartupTransition[];

  constructor(
    options: {
      readonly now?: () => number;
      readonly onTransition?: (transition: ProviderStartupTransition) => void;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#onTransition = options.onTransition;
    this.#transitions = [{ phase: "discovering", at: this.#now() }];
  }

  get phase(): ProviderStartupPhase {
    return this.#phase;
  }

  transition(phase: ProviderStartupPhase): void {
    if (phase === this.#phase) return;
    if (TERMINAL_PHASES.has(this.#phase) || !ALLOWED_TRANSITIONS[this.#phase].has(phase)) {
      throw new Error(`Invalid provider startup transition: ${this.#phase} -> ${phase}`);
    }
    this.#phase = phase;
    const transition = { phase, at: this.#now() } satisfies ProviderStartupTransition;
    this.#transitions.push(transition);
    this.#onTransition?.(transition);
  }

  fail(reason: ProviderStartupFailureReason): void {
    if (TERMINAL_PHASES.has(this.#phase)) return;
    this.#failureReason = reason;
    this.#phase = "failed";
    const transition = {
      phase: "failed",
      at: this.#now(),
      failureReason: reason,
    } satisfies ProviderStartupTransition;
    this.#transitions.push(transition);
    this.#onTransition?.(transition);
  }

  stop(reason?: "Cancelled"): void {
    if (TERMINAL_PHASES.has(this.#phase)) return;
    this.#failureReason = reason;
    this.#phase = "stopped";
    const transition = {
      phase: "stopped",
      at: this.#now(),
      ...(reason ? { failureReason: reason } : {}),
    } satisfies ProviderStartupTransition;
    this.#transitions.push(transition);
    this.#onTransition?.(transition);
  }

  snapshot(): ProviderStartupSnapshot {
    return {
      phase: this.#phase,
      ...(this.#failureReason ? { failureReason: this.#failureReason } : {}),
      transitions: [...this.#transitions],
    };
  }
}

function errnoCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | undefined)?.code;
}

export function classifyProviderStartupFailure(cause: unknown): ProviderStartupFailureReason {
  if (cause instanceof ExecutableNotFoundError || errnoCode(cause) === "ENOENT") {
    return "ExecutableNotFound";
  }
  if (cause instanceof Error && cause.name === "AbortError") return "Cancelled";
  const message =
    cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase();
  if (message.includes("auth") || message.includes("login")) return "AuthenticationFailed";
  if (message.includes("spawn")) return "SpawnFailed";
  if (message.includes("exit") || message.includes("closed before")) return "ExitedDuringStartup";
  if (message.includes("timeout") || message.includes("timed out")) return "HandshakeTimeout";
  return "ProtocolFailure";
}

/**
 * Bounds an adapter start with the orchestration deadline and records the outcome
 * on the lifecycle. The deadline is applied *inside* the interruption hook so an
 * expired timeout is recorded as `HandshakeTimeout`, and only an external
 * interruption of the start itself is recorded as `Cancelled`.
 */
export const observeProviderStartup = <A, E, R>(
  start: Effect.Effect<A, E, R>,
  input: {
    readonly lifecycle: ProviderStartupLifecycle;
    readonly timeout: Duration.Input;
  },
): Effect.Effect<Option.Option<A>, E, R> =>
  start.pipe(
    Effect.timeoutOption(input.timeout),
    Effect.tap((started) =>
      Effect.sync(() => {
        if (Option.isNone(started)) input.lifecycle.fail("HandshakeTimeout");
      }),
    ),
    Effect.tapError((cause) =>
      Effect.sync(() => input.lifecycle.fail(classifyProviderStartupFailure(cause))),
    ),
    Effect.onInterrupt(() => Effect.sync(() => input.lifecycle.stop("Cancelled"))),
  );
