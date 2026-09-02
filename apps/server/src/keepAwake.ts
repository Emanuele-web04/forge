/**
 * KeepAwake - Drives macOS `caffeinate -dims` from the persisted
 * `keepAwakeMode` setting and live agent-turn activity.
 *
 * `always` keeps one caffeinate child alive for the server lifetime, `agent`
 * only while at least one thread session is running a turn, `off` never spawns.
 * Process control (spawn, SIGTERM, bounded restart backoff) is isolated behind
 * an injectable runtime so the fold is unit-testable without a real child.
 */
import { execFile, spawn } from "node:child_process";
import {
  type KeepAwakeMode,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ServerKeepAwakeState,
  ThreadSessionSetPayload,
} from "@synara/contracts";
import {
  Deferred,
  Duration,
  Effect,
  Layer,
  PubSub,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ServerSettingsService } from "./serverSettings";

export const KEEP_AWAKE_ARGS = ["-dims"] as const;
export const KEEP_AWAKE_MAX_RESTARTS = 5;

export interface KeepAwakeChild {
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export interface KeepAwakeRuntime {
  readonly platform: NodeJS.Platform;
  /** Resolves true when `caffeinate` is on PATH. */
  readonly isBinaryAvailable: Effect.Effect<boolean>;
  readonly spawnCaffeinate: () => KeepAwakeChild;
  /** Delay before restart attempt `attempt` (1-based) after an unexpected exit. */
  readonly restartDelay: (attempt: number) => Duration.Duration;
}

export interface KeepAwakeShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly getState: Effect.Effect<ServerKeepAwakeState>;
  readonly streamChanges: Stream.Stream<ServerKeepAwakeState>;
}

export class KeepAwakeService extends ServiceMap.Service<KeepAwakeService, KeepAwakeShape>()(
  "synara/keepAwake/KeepAwakeService",
) {}

export function computeDesired(mode: KeepAwakeMode, activeTurnCount: number): boolean {
  return mode === "always" || (mode === "agent" && activeTurnCount > 0);
}

export function isActiveSession(
  session: { readonly status: string; readonly activeTurnId: string | null } | null,
): boolean {
  return session !== null && session.status === "running" && session.activeTurnId !== null;
}

export function seedActiveThreads(
  readModel: Pick<OrchestrationReadModel, "threads">,
): ReadonlySet<string> {
  const active = new Set<string>();
  for (const thread of readModel.threads) {
    if (isActiveSession(thread.session)) {
      active.add(thread.id);
    }
  }
  return active;
}

const decodeSessionSetPayload = Schema.decodeUnknownOption(ThreadSessionSetPayload);

export function applySessionEvent(
  active: ReadonlySet<string>,
  event: OrchestrationEvent,
): ReadonlySet<string> {
  if (event.type !== "thread.session-set") {
    return active;
  }
  const payload = decodeSessionSetPayload(event.payload);
  if (payload._tag === "None") {
    return active;
  }
  const next = new Set(active);
  if (isActiveSession(payload.value.session)) {
    next.add(payload.value.threadId);
  } else {
    next.delete(payload.value.threadId);
  }
  return next;
}

export const defaultKeepAwakeRuntime: KeepAwakeRuntime = {
  platform: process.platform,
  isBinaryAvailable: Effect.callback<boolean>((resume) => {
    execFile("/usr/bin/which", ["caffeinate"], (error) => {
      resume(Effect.succeed(error === null));
    });
  }),
  spawnCaffeinate: () => spawn("caffeinate", [...KEEP_AWAKE_ARGS], { stdio: "ignore" }),
  restartDelay: (attempt) => Duration.millis(Math.min(5_000, 250 * 2 ** Math.max(0, attempt - 1))),
};

interface ProcessState {
  readonly child: KeepAwakeChild | null;
  /** Set while we are tearing the child down on purpose. */
  readonly stopping: Deferred.Deferred<void> | null;
  readonly restarts: number;
}

function sameState(a: ServerKeepAwakeState, b: ServerKeepAwakeState): boolean {
  return (
    a.available === b.available && a.mode === b.mode && a.active === b.active && a.error === b.error
  );
}

export const makeKeepAwake = Effect.fn(function* (runtime: KeepAwakeRuntime) {
  const serverSettings = yield* ServerSettingsService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const stateRef = yield* Ref.make<ServerKeepAwakeState>({
    available: false,
    mode: "off",
    active: false,
    error: null,
  });
  const changesPubSub = yield* PubSub.unbounded<ServerKeepAwakeState>();
  const modeRef = yield* Ref.make<KeepAwakeMode>("off");
  const activeThreadsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const processRef = yield* Ref.make<ProcessState>({ child: null, stopping: null, restarts: 0 });
  const lastDesiredRef = yield* Ref.make(false);
  const reconcileLock = yield* Semaphore.make(1);

  const publish = (patch: Partial<ServerKeepAwakeState>) =>
    Effect.gen(function* () {
      const previous = yield* Ref.get(stateRef);
      const next: ServerKeepAwakeState = { ...previous, ...patch };
      if (sameState(previous, next)) return;
      yield* Ref.set(stateRef, next);
      yield* PubSub.publish(changesPubSub, next);
    });

  const desiredNow = Effect.all({ mode: Ref.get(modeRef), active: Ref.get(activeThreadsRef) }).pipe(
    Effect.map(({ mode, active }) => computeDesired(mode, active.size)),
  );

  // Declared before `reconcile` because the exit listener re-enters it.
  let reconcile: Effect.Effect<void> = Effect.void;

  const onChildExit = (child: KeepAwakeChild, code: number | null, signal: NodeJS.Signals | null) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(processRef);
      if (current.child !== child) return;
      if (current.stopping) {
        yield* Ref.set(processRef, { child: null, stopping: null, restarts: 0 });
        yield* Deferred.succeed(current.stopping, undefined);
        return;
      }
      // Unexpected exit while we still want the child alive.
      const restarts = current.restarts + 1;
      yield* Ref.set(processRef, { child: null, stopping: null, restarts });
      yield* publish({ active: false });
      const desired = yield* desiredNow;
      if (!desired) return;
      if (restarts > KEEP_AWAKE_MAX_RESTARTS) {
        yield* publish({
          error: `caffeinate exited unexpectedly ${restarts} times (last code ${code ?? "null"}, signal ${signal ?? "null"}); giving up until the mode changes`,
        });
        return;
      }
      yield* Effect.logWarning("caffeinate exited unexpectedly; restarting", {
        code,
        signal,
        restarts,
      });
      yield* Effect.sleep(runtime.restartDelay(restarts));
      yield* reconcile;
    });

  const spawnChild = Effect.gen(function* () {
    const child = runtime.spawnCaffeinate();
    child.once("exit", (code, signal) => {
      Effect.runFork(onChildExit(child, code, signal));
    });
    yield* Ref.update(processRef, (current) => ({ ...current, child, stopping: null }));
    yield* publish({ active: true, error: null });
  });

  const stopChild = Effect.gen(function* () {
    const current = yield* Ref.get(processRef);
    if (!current.child || current.stopping) return;
    const stopping = yield* Deferred.make<void>();
    yield* Ref.set(processRef, { ...current, stopping });
    current.child.kill("SIGTERM");
    yield* Deferred.await(stopping);
    yield* publish({ active: false });
  });

  reconcile = reconcileLock.withPermits(1)(
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const desired = state.available && (yield* desiredNow);
      const lastDesired = yield* Ref.get(lastDesiredRef);
      yield* Ref.set(lastDesiredRef, desired);
      if (desired && !lastDesired) {
        // A fresh false→true toggle clears any give-up error and the retry budget.
        yield* Ref.update(processRef, (current) => ({ ...current, restarts: 0 }));
        yield* publish({ error: null });
      }
      const current = yield* Ref.get(processRef);
      if (desired) {
        const latest = yield* Ref.get(stateRef);
        if (current.child === null && latest.error === null) {
          yield* spawnChild;
        }
        return;
      }
      if (current.child !== null) {
        yield* stopChild;
      }
      yield* publish({ error: null });
    }),
  );

  const start: KeepAwakeShape["start"] = Effect.gen(function* () {
    const initialSettings = yield* serverSettings.getSettings.pipe(
      Effect.catch((error) =>
        Effect.logWarning("keep-awake could not read settings; assuming off", {
          detail: error.detail,
        }).pipe(Effect.as(null)),
      ),
    );
    const initialMode: KeepAwakeMode = initialSettings?.keepAwakeMode ?? "off";
    yield* Ref.set(modeRef, initialMode);

    const available = runtime.platform === "darwin" && (yield* runtime.isBinaryAvailable);
    yield* publish({ available, mode: initialMode });

    // Register the domain-event subscriber before seeding so no session
    // transition can slip between the snapshot and the live stream.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    const seeded = yield* projectionSnapshotQuery.getSnapshot().pipe(
      Effect.map(seedActiveThreads),
      Effect.catch((error) =>
        Effect.logWarning("keep-awake could not seed active turns; starting empty", {
          detail: String(error),
        }).pipe(Effect.as<ReadonlySet<string>>(new Set())),
      ),
    );
    yield* Ref.set(activeThreadsRef, seeded);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const current = yield* Ref.get(processRef);
        yield* Ref.set(processRef, { child: null, stopping: null, restarts: 0 });
        current.child?.kill("SIGTERM");
      }),
    );

    yield* reconcile;

    yield* Effect.forkScoped(
      Stream.runForEach(serverSettings.streamChanges, (settings) =>
        Effect.gen(function* () {
          yield* Ref.set(modeRef, settings.keepAwakeMode);
          yield* publish({ mode: settings.keepAwakeMode });
          yield* reconcile;
        }),
      ),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(domainEvents, (event) =>
        Effect.gen(function* () {
          if (event.type !== "thread.session-set") return;
          const before = yield* Ref.get(activeThreadsRef);
          const after = applySessionEvent(before, event);
          if (after === before) return;
          yield* Ref.set(activeThreadsRef, after);
          yield* reconcile;
        }),
      ),
    );
  });

  return {
    start,
    getState: Ref.get(stateRef),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies KeepAwakeShape;
});

export const KeepAwakeLive = Layer.effect(KeepAwakeService, makeKeepAwake(defaultKeepAwakeRuntime));
