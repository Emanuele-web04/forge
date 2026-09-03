// FILE: AcpLoadReplayGate.ts
// Purpose: Suppresses ACP session/load transcript replay until the inbound stream settles.
// Layer: Provider ACP helper
// Exports: makeAcpLoadReplayGate and its policy/evidence contracts.

import { Clock, Deferred, Effect, Ref } from "effect";

const REPLAY_SETTLE_POLL_MAX_MS = 50;

export interface AcpLoadReplayTimeoutEvidence {
  readonly elapsedMs: number;
}

export interface AcpLoadReplayGateOptions {
  readonly quietMs: number;
  readonly hardTimeoutMs: number;
  readonly onHardTimeout: (evidence: AcpLoadReplayTimeoutEvidence) => Effect.Effect<void, never>;
}

export interface AcpLoadReplayGate {
  readonly attachConsumer: Effect.Effect<void>;
  readonly suppressUpdate: Effect.Effect<boolean>;
  readonly isSuppressing: Effect.Effect<boolean>;
  readonly awaitReady: Effect.Effect<"ready" | "released">;
  readonly settle: Effect.Effect<void>;
  readonly release: Effect.Effect<void>;
}

interface SuppressingReplay {
  readonly _tag: "Suppressing";
  readonly startedAt: number;
  readonly lastSuppressedAt: number;
}

interface WaitingForConsumer {
  readonly _tag: "WaitingForConsumer";
}

interface ReplayReady {
  readonly _tag: "Ready";
}

interface ReplayReleased {
  readonly _tag: "Released";
}

type ReplayGateState = WaitingForConsumer | SuppressingReplay | ReplayReady | ReplayReleased;

type ReplaySettleDecision =
  | { readonly _tag: "Done" }
  | { readonly _tag: "Retry" }
  | {
      readonly _tag: "Opened";
      readonly elapsedMs: number;
      readonly reachedHardTimeout: boolean;
    }
  | { readonly _tag: "Wait"; readonly delayMs: number };

export const makeAcpLoadReplayGate = (
  options: AcpLoadReplayGateOptions,
): Effect.Effect<AcpLoadReplayGate> =>
  Effect.gen(function* () {
    const consumerAttached = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<"ready" | "released">();
    const state = yield* Ref.make<ReplayGateState>({ _tag: "WaitingForConsumer" });

    const release = Effect.gen(function* () {
      const completed = yield* Ref.modify(state, (current) =>
        current._tag === "Released"
          ? ([false, current] as const)
          : current._tag === "Ready"
            ? ([true, current] as const)
            : ([true, { _tag: "Released" } satisfies ReplayReleased] as const),
      );
      if (completed) {
        yield* Deferred.succeed(consumerAttached, undefined);
        yield* Deferred.succeed(ready, "released");
      }
    }).pipe(Effect.asVoid, Effect.uninterruptible);

    const settle = Effect.gen(function* () {
      yield* Deferred.await(consumerAttached);
      while (true) {
        const now = yield* Clock.currentTimeMillis;
        const decision = yield* Effect.gen(function* () {
          const next: ReplaySettleDecision = yield* Ref.modify(
            state,
            (current): readonly [ReplaySettleDecision, ReplayGateState] => {
              if (current._tag === "Ready" || current._tag === "Released") {
                return [{ _tag: "Done" } as const, current] as const;
              }
              if (current._tag === "WaitingForConsumer") {
                return [{ _tag: "Retry" } as const, current] as const;
              }

              const quietForMs = now - current.lastSuppressedAt;
              const elapsedMs = now - current.startedAt;
              const reachedHardTimeout = elapsedMs >= options.hardTimeoutMs;
              if (quietForMs >= options.quietMs || reachedHardTimeout) {
                return [
                  { _tag: "Opened", elapsedMs, reachedHardTimeout } as const,
                  { _tag: "Ready" } satisfies ReplayReady,
                ] as const;
              }

              return [
                {
                  _tag: "Wait",
                  delayMs: Math.max(
                    1,
                    Math.min(
                      options.quietMs - quietForMs,
                      options.hardTimeoutMs - elapsedMs,
                      REPLAY_SETTLE_POLL_MAX_MS,
                    ),
                  ),
                } as const,
                current,
              ] as const;
            },
          );
          if (next._tag === "Opened") {
            yield* Deferred.succeed(ready, "ready");
          }
          return next;
        }).pipe(
          // State must never become Ready without completing its waiter: scope
          // release uses that state to decide whether it still needs to unblock.
          Effect.uninterruptible,
        );

        if (decision._tag === "Done") {
          return;
        }
        if (decision._tag === "Retry") {
          continue;
        }
        if (decision._tag === "Opened") {
          if (decision.reachedHardTimeout) {
            yield* options.onHardTimeout({ elapsedMs: decision.elapsedMs });
          }
          return;
        }
        yield* Effect.sleep(decision.delayMs);
      }
    });

    return {
      attachConsumer: Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.modify(state, (current) =>
            current._tag === "WaitingForConsumer"
              ? ([
                  true,
                  {
                    _tag: "Suppressing",
                    startedAt: now,
                    lastSuppressedAt: now,
                  } satisfies SuppressingReplay,
                ] as const)
              : ([false, current] as const),
          ),
        ),
        Effect.flatMap((attached) =>
          attached
            ? Deferred.succeed(consumerAttached, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.uninterruptible,
      ),
      suppressUpdate: Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.modify(state, (current) =>
            current._tag === "Ready"
              ? ([false, current] as const)
              : current._tag === "Released"
                ? ([true, current] as const)
                : current._tag === "WaitingForConsumer"
                  ? ([true, current] as const)
                  : ([true, { ...current, lastSuppressedAt: now }] as const),
          ),
        ),
      ),
      isSuppressing: Ref.get(state).pipe(
        Effect.map(
          (current) => current._tag === "WaitingForConsumer" || current._tag === "Suppressing",
        ),
      ),
      awaitReady: Deferred.await(ready),
      settle,
      release,
    };
  });
