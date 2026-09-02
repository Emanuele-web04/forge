/**
 * quitResume - "Resume chats automatically" after a desktop quit.
 *
 * When the user quits the desktop app while chats are running and leaves the
 * "Resume chats automatically" box checked, the renderer calls the
 * `orchestration.prepareQuitResume` RPC *before* answering the quit request.
 * `prepareQuitResume` durably records the listed threads that are genuinely
 * in flight (with the turn that was running at that moment, or none while the
 * provider was still connecting) in a small JSON file next to the other server
 * state, then interrupts those turns. Because the record is written before the
 * renderer replies `allow`, it survives the renderer and the backend being torn
 * down mid-flight; a failed write fails the RPC and the renderer falls back to a
 * plain interrupt-and-quit.
 *
 * A quit can still be cancelled after the record exists (renderer crash, desktop
 * refusing to quit). If this process is still alive `QUIT_RESUME_ABANDON_AFTER_MS`
 * after writing it, the quit evidently did not happen and the record is removed
 * so an unrelated later restart never resumes those chats.
 *
 * At the next server start `claimQuitResumeRecordAtStartup` consumes the record
 * before commands are admitted (so no new quit can race it; atomic rename then
 * delete — a crash in between loses the resume rather than doubling it), then
 * `resumeQuitInterruptedChats` filters out threads that moved on since the record
 * was written and dispatches one ordinary user turn per remaining thread with the
 * recorded continuation prompt. Each turn carries a `resumePrecondition` so the
 * decider re-checks the same conditions atomically inside the serialized
 * dispatch — a client command landing between the plan and the dispatch cannot
 * slip a stale continuation through. No record → one `exists` check and nothing
 * else.
 *
 * Accepted residual windows (all require a second quit or a new turn to land
 * within microseconds of the first): a turn that replaces the recorded one inside
 * the prepare RPC is interrupted and not resumed; a second quit prepared exactly
 * when the first one's abandon sweep fires loses its record.
 *
 * @module quitResume
 */
import type {
  OrchestrationCommand,
  OrchestrationPrepareQuitResumeInput,
  OrchestrationPrepareQuitResumeResult,
  OrchestrationProject,
  OrchestrationThread,
} from "@synara/contracts";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  QUIT_RESUME_MAX_PROMPT_CHARS,
  QUIT_RESUME_MAX_THREADS,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@synara/contracts";
import { Duration, Effect, FileSystem, Schema } from "effect";
import { randomUUID } from "node:crypto";

import { writeFileStringAtomically } from "../atomicWrite";
import { ServerConfig } from "../config";
import {
  threadHasInFlightTurn,
  threadResumePreconditionViolation,
  type ThreadResumePreconditionViolation,
} from "./commandInvariants.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

/**
 * A quit normally stops this process within seconds (desktop shutdown timeout is
 * 10s). A record still owned by a live process this long after it was written
 * belongs to a quit that was cancelled and must not survive.
 */
export const QUIT_RESUME_ABANDON_AFTER_MS = 30_000;

/** Sleep without keeping the Node process alive during a normal desktop shutdown. */
const sleepUnref = (duration: Duration.Input) =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(
      () => resume(Effect.void),
      Duration.toMillis(Duration.fromInputUnsafe(duration)),
    );
    timer.unref();
    return Effect.sync(() => clearTimeout(timer));
  });

export const QuitResumeRecord = Schema.Struct({
  version: Schema.Literal(1),
  /** Unique per quit; command/message ids derive from it so replays dedup and quits never collide. */
  recordId: TrimmedNonEmptyString,
  recordedAt: IsoDateTime,
  continuationPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(QUIT_RESUME_MAX_PROMPT_CHARS)),
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      /** The turn in flight when the record was written; null while the provider was still connecting. */
      turnId: Schema.NullOr(TurnId),
    }),
  ).check(Schema.isMaxLength(QUIT_RESUME_MAX_THREADS)),
});
export type QuitResumeRecord = typeof QuitResumeRecord.Type;

const decodeQuitResumeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(QuitResumeRecord));

type ThreadTurnStartCommand = Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>;
type ThreadTurnInterruptCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.turn.interrupt" }
>;

/** Read-model thread fields needed to snapshot a thread into the record. */
export type QuitResumeRecordableThread = Pick<
  OrchestrationThread,
  "id" | "deletedAt" | "latestTurn" | "session"
>;

/** Read-model thread fields the boot-time planner inspects (a superset is fine). */
export type QuitResumeThread = Pick<
  OrchestrationThread,
  | "id"
  | "projectId"
  | "deletedAt"
  | "archivedAt"
  | "latestTurn"
  | "session"
  | "runtimeMode"
  | "interactionMode"
>;
export type QuitResumeProject = Pick<OrchestrationProject, "id" | "deletedAt">;

export type QuitResumeSkipReason =
  | "thread-missing"
  | "thread-deleted"
  | "project-missing"
  | ThreadResumePreconditionViolation;

export interface QuitResumePlan {
  readonly commands: ReadonlyArray<ThreadTurnStartCommand>;
  readonly skipped: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly reason: QuitResumeSkipReason;
  }>;
}

/** The turn a thread is running right now, or null while its provider is still connecting. */
function inFlightTurnId(thread: QuitResumeRecordableThread): TurnId | null {
  return (
    thread.session?.activeTurnId ??
    (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null)
  );
}

/**
 * Pure: snapshot the requested threads into a record. Only threads that are
 * genuinely in flight are remembered — the dialog shows a snapshot, and a chat
 * that finished while it was open has nothing to resume. Unknown and deleted
 * threads are dropped, duplicates collapse, order is kept.
 */
export function buildQuitResumeRecord(input: {
  readonly request: OrchestrationPrepareQuitResumeInput;
  readonly threads: ReadonlyArray<QuitResumeRecordableThread>;
  readonly recordId: string;
  readonly now: string;
}): QuitResumeRecord {
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  const seen = new Set<ThreadId>();
  const threads: Array<QuitResumeRecord["threads"][number]> = [];
  for (const threadId of input.request.threadIds) {
    if (seen.has(threadId)) {
      continue;
    }
    seen.add(threadId);
    const thread = threadsById.get(threadId);
    if (!thread || thread.deletedAt !== null || !threadHasInFlightTurn(thread)) {
      continue;
    }
    threads.push({ threadId, turnId: inFlightTurnId(thread) });
  }
  return {
    version: 1,
    recordId: input.recordId,
    recordedAt: input.now,
    continuationPrompt: input.request.continuationPrompt,
    threads,
  };
}

export function buildQuitInterruptCommand(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly recordId: string;
  readonly recordedAt: string;
}): ThreadTurnInterruptCommand {
  return {
    type: "thread.turn.interrupt",
    commandId: CommandId.makeUnsafe(`quit-resume-interrupt:${input.recordId}:${input.threadId}`),
    threadId: input.threadId,
    ...(input.turnId !== null ? { turnId: input.turnId } : {}),
    createdAt: input.recordedAt,
  };
}

/**
 * Pure: map a consumed record onto the current read model. A thread is resumed
 * only when it still exists, is not deleted, its project exists, and
 * `threadResumePreconditionViolation` is clear (not archived, nothing in flight,
 * no turn completed on its own since the record). The continuation is an
 * ordinary user turn on the thread's own runtime/interaction settings (model
 * omitted → provider reactor uses the thread's current selection) and carries
 * the same precondition for the decider to enforce atomically.
 *
 * Command and message ids derive from the record so an accidental re-run
 * collides with the engine's receipt dedup instead of starting a second turn.
 */
export function planQuitResumeTurns(input: {
  readonly record: QuitResumeRecord;
  readonly threads: ReadonlyArray<QuitResumeThread>;
  readonly projects: ReadonlyArray<QuitResumeProject>;
  readonly now: string;
}): QuitResumePlan {
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  const liveProjectIds = new Set(
    input.projects.filter((project) => project.deletedAt === null).map((project) => project.id),
  );
  const commands: ThreadTurnStartCommand[] = [];
  const skipped: Array<{ threadId: ThreadId; reason: QuitResumeSkipReason }> = [];
  const skip = (threadId: ThreadId, reason: QuitResumeSkipReason) => {
    skipped.push({ threadId, reason });
  };

  for (const entry of input.record.threads) {
    const thread = threadsById.get(entry.threadId);
    if (!thread) {
      skip(entry.threadId, "thread-missing");
      continue;
    }
    if (thread.deletedAt !== null) {
      skip(entry.threadId, "thread-deleted");
      continue;
    }
    if (!liveProjectIds.has(thread.projectId)) {
      skip(entry.threadId, "project-missing");
      continue;
    }
    const resumePrecondition = {
      recordedTurnId: entry.turnId,
      recordedAt: input.record.recordedAt,
    };
    const violation = threadResumePreconditionViolation(thread, resumePrecondition);
    if (violation) {
      skip(entry.threadId, violation);
      continue;
    }
    const key = `quit-resume:${input.record.recordId}:${entry.threadId}`;
    commands.push({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(key),
      threadId: entry.threadId,
      message: {
        messageId: MessageId.makeUnsafe(key),
        role: "user",
        text: input.record.continuationPrompt,
        attachments: [],
      },
      dispatchMode: "queue",
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      resumePrecondition,
      createdAt: input.now,
    });
  }

  return { commands, skipped };
}

export const persistQuitResumeRecord = (input: {
  readonly path: string;
  readonly record: QuitResumeRecord;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.record)}\n`,
  });

export const clearQuitResumeRecord = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path, { force: true });
  });

export type QuitResumeRecordRead =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "record"; readonly record: QuitResumeRecord };

/**
 * `absent` when there is no file, `invalid` when a file is there but cannot be
 * read or is not a record.
 */
export const readQuitResumeRecord = (
  path: string,
): Effect.Effect<QuitResumeRecordRead, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return { kind: "absent" } as const;
    }
    const raw = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { kind: "invalid" } as const;
    }
    return yield* decodeQuitResumeRecord(trimmed).pipe(
      Effect.map((record) => ({ kind: "record", record }) as const),
      Effect.orElseSucceed(() => ({ kind: "invalid" }) as const),
    );
  });

/**
 * Take exclusive ownership of whatever record is at `path`: an atomic rename to a
 * claimant-unique private path (so a second process claiming the same state dir
 * can win at most once without deleting the first claimant's file), read it,
 * then remove the private copy. `absent` when there was nothing to claim. A
 * private copy left behind by a crash is never mistaken for a fresh record.
 */
export const claimQuitResumeRecord = (
  path: string,
): Effect.Effect<QuitResumeRecordRead, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const claimedPath = `${path}.${process.pid}.${randomUUID()}.claimed`;
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return { kind: "absent" } as const;
    }
    const claimed = yield* fs.rename(path, claimedPath).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("quit-resume record could not be claimed; skipping resume", {
          path,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!claimed) {
      return { kind: "absent" } as const;
    }
    const read = yield* readQuitResumeRecord(claimedPath);
    yield* clearQuitResumeRecord(claimedPath).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("claimed quit-resume record could not be removed", {
          path: claimedPath,
          cause,
        }),
      ),
    );
    return read;
  });

/**
 * Remove the record only if it is still the one with `recordId`: a newer quit
 * may have replaced it in the meantime and must keep its own record.
 */
const clearQuitResumeRecordIfOwned = (path: string, recordId: string) =>
  Effect.gen(function* () {
    const current = yield* readQuitResumeRecord(path);
    if (current.kind !== "record" || current.record.recordId !== recordId) {
      return false;
    }
    yield* clearQuitResumeRecord(path);
    return true;
  });

/**
 * RPC body: record first (failure fails the call so the renderer can fall back to
 * a plain interrupt) and immediately arm the abandon sweep — if this process is
 * still running `QUIT_RESUME_ABANDON_AFTER_MS` later, the quit was cancelled and
 * the record is dropped. Then interrupt every recorded thread. Interrupt failures
 * are logged, not surfaced — the record is already durable and the restart
 * reconciliation heals any turn the interrupt did not reach.
 */
export const prepareQuitResume = (input: {
  readonly request: OrchestrationPrepareQuitResumeInput;
  readonly recordPath: string;
  readonly getReadModel: () => Effect.Effect<
    { readonly threads: ReadonlyArray<QuitResumeRecordableThread> },
    never
  >;
  readonly dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, unknown>;
  readonly abandonAfter?: Duration.Input;
}): Effect.Effect<OrchestrationPrepareQuitResumeResult, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    // Stamp before the snapshot: anything that completes after the snapshot is
    // then provably "completed since the record" for the resume precondition.
    const now = new Date().toISOString();
    const readModel = yield* input.getReadModel();
    const record = buildQuitResumeRecord({
      request: input.request,
      threads: readModel.threads,
      recordId: randomUUID(),
      now,
    });
    yield* persistQuitResumeRecord({ path: input.recordPath, record });
    yield* Effect.logInfo("recorded running chats for resume after quit", {
      recordId: record.recordId,
      threadIds: record.threads.map((entry) => entry.threadId),
    });

    yield* sleepUnref(input.abandonAfter ?? Duration.millis(QUIT_RESUME_ABANDON_AFTER_MS)).pipe(
      Effect.andThen(clearQuitResumeRecordIfOwned(input.recordPath, record.recordId)),
      Effect.flatMap((cleared) =>
        cleared
          ? Effect.logWarning("quit did not complete; dropped the quit-resume record", {
              recordId: record.recordId,
            })
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("quit-resume abandon sweep failed", { recordId: record.recordId, cause }),
      ),
      // Detached on purpose: the sweep must outlive this request. If the process
      // exits first (the normal quit), the fiber simply dies with it.
      Effect.forkDetach,
    );

    // The durable write is the RPC acknowledgement contract. Interrupts are
    // best-effort and must not make the renderer miss its bounded quit wait;
    // process shutdown itself will stop any provider command that remains live.
    yield* Effect.forEach(
      record.threads,
      (entry) =>
        input
          .dispatch(
            buildQuitInterruptCommand({
              threadId: entry.threadId,
              turnId: entry.turnId,
              recordId: record.recordId,
              recordedAt: record.recordedAt,
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to interrupt chat for quit", {
                threadId: entry.threadId,
                cause,
              }),
            ),
          ),
      { discard: true, concurrency: "unbounded" },
    ).pipe(Effect.forkDetach);

    return {
      recordedThreadIds: record.threads.map((entry) => entry.threadId),
      recordedAt: record.recordedAt,
    };
  });

/**
 * Boot-time claim. Must run before commands are admitted so no quit prepared by
 * a freshly connected client can interleave with it; cheap when there is nothing
 * to resume (one `exists` probe). Never fails — resuming is best-effort.
 */
export const claimQuitResumeRecordAtStartup: Effect.Effect<
  QuitResumeRecordRead,
  never,
  ServerConfig | FileSystem.FileSystem
> = Effect.gen(function* () {
  const config = yield* ServerConfig;
  // Claim before dispatching: a second process or a crash mid-dispatch must
  // never resume the same chats twice. An unreadable record is consumed too, so
  // it does not get re-parsed (and silently ignored) on every later boot.
  const claimed = yield* claimQuitResumeRecord(config.quitResumeStatePath);
  if (claimed.kind === "invalid") {
    yield* Effect.logWarning("dropped an unreadable quit-resume record", {
      path: config.quitResumeStatePath,
    });
  }
  return claimed;
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("claiming the quit-resume record failed", { cause }).pipe(
      Effect.as({ kind: "absent" } as const),
    ),
  ),
);

/**
 * Boot-time consumer of a claimed record. Runs once after restart reconciliation
 * has settled the orphaned turns. Every failure is contained and logged —
 * resuming must never affect server startup.
 */
export const resumeQuitInterruptedChats = (
  claimed: QuitResumeRecordRead,
): Effect.Effect<void, never, OrchestrationEngineService> =>
  Effect.gen(function* () {
    if (claimed.kind !== "record") {
      return;
    }
    const record = claimed.record;
    const engine = yield* OrchestrationEngineService;

    const readModel = yield* engine.getReadModel();
    const plan = planQuitResumeTurns({
      record,
      threads: readModel.threads,
      projects: readModel.projects,
      now: new Date().toISOString(),
    });

    if (plan.skipped.length > 0) {
      yield* Effect.logInfo("skipping quit-resume for threads that moved on", {
        recordId: record.recordId,
        skipped: plan.skipped,
      });
    }
    if (plan.commands.length === 0) {
      return;
    }

    yield* Effect.logInfo("resuming chats interrupted by the previous quit", {
      recordId: record.recordId,
      recordedAt: record.recordedAt,
      threadIds: plan.commands.map((command) => command.threadId),
    });

    yield* Effect.forEach(
      plan.commands,
      (command) =>
        engine.dispatch(command).pipe(
          // The decider re-checks the resume precondition atomically; a rejection
          // here means the thread moved on between the plan and the dispatch.
          Effect.catchTag("OrchestrationCommandInvariantError", (error) =>
            Effect.logInfo("quit-resume turn was not accepted", {
              threadId: command.threadId,
              detail: error.detail,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("quit-resume turn failed to dispatch", {
              threadId: command.threadId,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("resuming chats after quit failed", { cause })),
  );
