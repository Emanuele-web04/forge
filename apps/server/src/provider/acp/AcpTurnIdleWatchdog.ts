/**
 * AcpTurnIdleWatchdog - idle-progress backstop for ACP provider turns.
 *
 * ACP providers (Grok, Cursor, Devin) drive a turn by issuing a single
 * `session/prompt` JSON-RPC request to the child agent. That request only
 * settles when the agent finishes the turn. If the child stays alive but goes
 * silent — wedged on an internal retry loop, a stalled upstream API call, or a
 * deadlock — the request never settles, no `turn.completed` is ever emitted, and
 * the UI shows "Working" forever (observed in the wild as a turn stuck for
 * 15+ hours).
 *
 * A process *crash* mid-prompt is already handled (the transport fails the
 * pending request). This watchdog covers the remaining gap: the alive-but-hung
 * child. It is a fail-safe for hangs, NOT a wall-clock cap on legitimate long
 * turns — real turn-progress events reset it (see
 * {@link isAcpTurnProgressEventTag}), and it pauses entirely while the turn is
 * legitimately blocked on a human approval. Heartbeats like mode/config/usage
 * updates must not keep a finished-but-unsettled prompt alive forever.
 *
 * @module AcpTurnIdleWatchdog
 */
import { Effect, Fiber, Scope } from "effect";

/**
 * ACP session-event tags that prove the agent is still doing turn work.
 * Mode/command/usage updates alone are not progress: they can keep arriving
 * after the agent has stopped producing output while `session/prompt` hangs,
 * which would otherwise prevent the idle watchdog from ever firing.
 */
export function isAcpTurnProgressEventTag(tag: string): boolean {
  switch (tag) {
    case "ContentDelta":
    case "ToolCallUpdated":
    case "PlanUpdated":
    case "AssistantItemStarted":
    case "AssistantItemCompleted":
      return true;
    default:
      return false;
  }
}

export interface AcpTurnIdleWatchdogParams {
  /** How long the turn may go without any inbound ACP activity before it is force-failed. */
  readonly idleTimeoutMs: number;
  /** Optional live override for work whose liveness is known outside the parent ACP stream. */
  readonly currentIdleTimeoutMs?: () => number;
  /** Cadence at which the watchdog re-evaluates idle progress. */
  readonly checkIntervalMs: number;
  /** Scope the watchdog fiber is forked into (the session scope). */
  readonly scope: Scope.Closeable;
  /** True while the watched turn is still the session's active turn. */
  readonly isTurnActive: () => boolean;
  /** True while the turn is legitimately blocked on a human (pending approval / elicitation). */
  readonly isAwaitingHuman: () => boolean;
  /** Epoch-ms timestamp of the last inbound activity observed for the turn. */
  readonly lastActivityAt: () => number;
  /** Reset the activity clock to "now" (used while awaiting human input). */
  readonly touchActivity: () => void;
  /** Invoked once when the idle timeout elapses; should force-fail and unwind the turn. */
  readonly onIdleTimeout: (idleMs: number) => Effect.Effect<void>;
}

/** The action the watchdog takes after evaluating a single idle-progress tick. */
export type AcpTurnIdleTickDecision = "stop" | "touch" | "timeout" | "continue";

/**
 * Pure decision for one watchdog tick — extracted so the reliability-critical
 * logic is unit-testable without a clock or fibers:
 *  - `stop`:     the turn is no longer active; the watchdog should exit.
 *  - `touch`:    the turn is legitimately blocked on a human; refresh the clock.
 *  - `timeout`:  the turn has been silent past the threshold; force-fail it.
 *  - `continue`: still within budget; keep watching.
 */
export function evaluateAcpTurnIdleTick(input: {
  readonly isTurnActive: boolean;
  readonly isAwaitingHuman: boolean;
  readonly idleMs: number;
  readonly idleTimeoutMs: number;
}): AcpTurnIdleTickDecision {
  if (!input.isTurnActive) {
    return "stop";
  }
  if (input.isAwaitingHuman) {
    return "touch";
  }
  return input.idleMs >= input.idleTimeoutMs ? "timeout" : "continue";
}

/**
 * Resolves an idle-timeout (ms) from an optional environment override, falling
 * back to `defaultMs` when the variable is unset, empty, non-numeric, or
 * non-positive (so a typo can never silently disable the backstop).
 */
export function resolveAcpTurnIdleTimeoutMs(input: {
  readonly envVar: string;
  readonly defaultMs: number;
  readonly env?: NodeJS.ProcessEnv;
}): number {
  const raw = (input.env ?? process.env)[input.envVar]?.trim();
  if (!raw) {
    return input.defaultMs;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : input.defaultMs;
}

/**
 * Forks an idle-progress watchdog for a single ACP turn into the session scope.
 *
 * The loop wakes every `checkIntervalMs` and:
 *  - exits once the watched turn is no longer active (normal completion already
 *    cleared it, or the session stopped);
 *  - keeps the activity clock fresh while the turn waits on a human decision, so
 *    the turn cannot trip the watchdog the instant it resumes;
 *  - force-fails the turn via `onIdleTimeout` once it has been completely silent
 *    for `idleTimeoutMs`.
 *
 * The returned fiber self-terminates when the turn ends; callers may ignore it
 * (it is also unwound when the session scope closes).
 */
export const forkAcpTurnIdleWatchdog = (
  params: AcpTurnIdleWatchdogParams,
): Effect.Effect<Fiber.Fiber<void>> =>
  Effect.gen(function* () {
    const loop = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(params.checkIntervalMs);
        const idleMs = Date.now() - params.lastActivityAt();
        const currentIdleTimeoutMs = params.currentIdleTimeoutMs?.() ?? params.idleTimeoutMs;
        const decision = evaluateAcpTurnIdleTick({
          isTurnActive: params.isTurnActive(),
          isAwaitingHuman: params.isAwaitingHuman(),
          idleMs,
          idleTimeoutMs: currentIdleTimeoutMs,
        });
        if (decision === "stop") {
          return;
        }
        if (decision === "touch") {
          // The agent is blocked on a human decision, not hung: keep the clock
          // fresh so the turn cannot trip the watchdog the instant it resumes.
          params.touchActivity();
          continue;
        }
        if (decision === "timeout") {
          yield* params.onIdleTimeout(idleMs);
          return;
        }
      }
    });
    return yield* loop.pipe(Effect.forkIn(params.scope));
  });
