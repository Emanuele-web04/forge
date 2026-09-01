// FILE: providerStartupLifecycle.ts
// Purpose: Makes provider startup phases, failures, timeout, cancellation, and cleanup explicit.
// Layer: Provider runtime infrastructure

import { ExecutableNotFoundError } from "@synara/shared/platformProcess";

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

export class ProviderStartupError extends Error {
  readonly _tag = "ProviderStartupError";
  readonly reason: ProviderStartupFailureReason;
  readonly phase: ProviderStartupPhase;

  constructor(
    reason: ProviderStartupFailureReason,
    phase: ProviderStartupPhase,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProviderStartupError";
    this.reason = reason;
    this.phase = phase;
  }
}

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
  if (cause instanceof ProviderStartupError) return cause.reason;
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

export interface ProviderStartupControl {
  readonly lifecycle: ProviderStartupLifecycle;
  markHandshaking(): void;
  markAuthenticating(): void;
}

export async function superviseProviderStartup<A>(input: {
  readonly start: (control: ProviderStartupControl) => Promise<A>;
  readonly cleanup: () => Promise<unknown>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly lifecycle?: ProviderStartupLifecycle;
}): Promise<A> {
  const lifecycle = input.lifecycle ?? new ProviderStartupLifecycle();
  lifecycle.transition("starting");

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let cleanupStarted = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    await input.cleanup().then(
      () => undefined,
      () => undefined,
    );
  };

  const control: ProviderStartupControl = {
    lifecycle,
    markHandshaking: () => lifecycle.transition("handshaking"),
    markAuthenticating: () => lifecycle.transition("authenticating"),
  };

  const terminal = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new ProviderStartupError(
          "HandshakeTimeout",
          lifecycle.phase,
          `Provider startup timed out after ${input.timeoutMs}ms.`,
        ),
      );
    }, input.timeoutMs);
    timeout.unref?.();

    if (input.signal) {
      abortListener = () => {
        reject(
          new ProviderStartupError("Cancelled", lifecycle.phase, "Provider startup was cancelled."),
        );
      };
      input.signal.addEventListener("abort", abortListener, { once: true });
      if (input.signal.aborted) abortListener();
    }
  });

  try {
    const result = await Promise.race([input.start(control), terminal]);
    lifecycle.transition("ready");
    return result;
  } catch (cause) {
    const reason = classifyProviderStartupFailure(cause);
    const failedPhase = lifecycle.phase;
    await cleanup();
    if (reason === "Cancelled") lifecycle.stop("Cancelled");
    else lifecycle.fail(reason);
    if (cause instanceof ProviderStartupError) throw cause;
    throw new ProviderStartupError(
      reason,
      failedPhase,
      cause instanceof Error ? cause.message : String(cause),
      cause,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    if (input.signal && abortListener) input.signal.removeEventListener("abort", abortListener);
  }
}
