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
  readonly onHardTimeout: (
    evidence: AcpLoadReplayTimeoutEvidence,
  ) => Effect.Effect<void, never>;
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

export const makeAcpLoadReplayGate = (
  options: AcpLoadReplayGateOptions,
): Effect.Effect<AcpLoadReplayGate> =>
  Effect.gen(function* () {
    const consumerAttached = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<"ready" | "released">();
    const state = yield* Ref.make<ReplayGateState>({ _tag: "WaitingForConsumer" });

    const complete = (outcome: "ready" | "released") =>
      Effect.gen(function* () {
        const nextState =
          outcome === "ready"
            ? ({ _tag: "Ready" } satisfies ReplayReady)
            : ({ _tag: "Released" } satisfies ReplayReleased);
        const completed = yield* Ref.modify(state, (current) =>
          current._tag === "Ready" || current._tag === "Released"
            ? ([false, current] as const)
            : ([true, nextState] as const),
        );
        if (completed) {
          yield* Deferred.succeed(consumerAttached, undefined);
          yield* Deferred.succeed(ready, outcome);
        }
        return completed;
      });

    const open = complete("ready");

    const settle = Effect.gen(function* () {
      yield* Deferred.await(consumerAttached);
      while (true) {
        const current = yield* Ref.get(state);
        if (current._tag === "Ready" || current._tag === "Released") {
          return;
        }

        const now = yield* Clock.currentTimeMillis;
        const quietForMs = now - current.lastSuppressedAt;
        const elapsedMs = now - current.startedAt;
        const reachedHardTimeout = elapsedMs >= options.hardTimeoutMs;
        if (quietForMs >= options.quietMs || reachedHardTimeout) {
          const opened = yield* open;
          if (opened && reachedHardTimeout) {
            yield* options.onHardTimeout({ elapsedMs });
          }
          return;
        }

        const untilQuietMs = options.quietMs - quietForMs;
        const untilHardTimeoutMs = options.hardTimeoutMs - elapsedMs;
        yield* Effect.sleep(
          Math.max(
            1,
            Math.min(untilQuietMs, untilHardTimeoutMs, REPLAY_SETTLE_POLL_MAX_MS),
          ),
        );
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
          (current) =>
            current._tag === "WaitingForConsumer" || current._tag === "Suppressing",
        ),
      ),
      awaitReady: Deferred.await(ready),
      settle,
      release: complete("released").pipe(Effect.asVoid),
    };
  });
