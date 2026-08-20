/**
 * quitResume - "Resume chats automatically" after a desktop quit.
 *
 * When the user quits the desktop app while chats are running and leaves the
 * "Resume chats automatically" box checked, the renderer calls the
 * `orchestration.prepareQuitResume` RPC *before* answering the quit request.
 * `prepareQuitResume` durably records the listed threads (with the turn that was
 * running at that moment) in a small JSON file next to the other server state,
 * then interrupts those turns. Because the record is written before the renderer
 * replies `allow`, it survives the renderer and the backend being torn down
 * mid-flight; a failed write fails the RPC and the renderer falls back to a plain
 * interrupt-and-quit.
 *
 * At the next server start `resumeQuitInterruptedChats` consumes the record
 * (delete first, then dispatch — a crash in between loses the resume rather than
 * doubling it), filters out threads that moved on since the record was written,
 * and dispatches one ordinary user turn per remaining thread with the recorded
 * continuation prompt. No record → one `exists` check and nothing else.
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
import { Effect, FileSystem, Option, Schema } from "effect";
import { randomUUID } from "node:crypto";

import { writeFileStringAtomically } from "../atomicWrite";
import { ServerConfig } from "../config";
import { threadHasInFlightTurn } from "./commandInvariants.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

export const QuitResumeRecord = Schema.Struct({
  version: Schema.Literal(1),
  /** Unique per quit; command/message ids derive from it so replays dedup and quits never collide. */
  recordId: TrimmedNonEmptyString,
  recordedAt: IsoDateTime,
  continuationPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(QUIT_RESUME_MAX_PROMPT_CHARS)),
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      /** Latest turn when the record was written; `null` when the thread had none yet. */
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
  "id" | "deletedAt" | "latestTurn"
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
  | "thread-archived"
  | "project-missing"
  | "no-turn"
  | "turn-changed"
  | "turn-in-flight";

export interface QuitResumePlan {
  readonly commands: ReadonlyArray<ThreadTurnStartCommand>;
  readonly skipped: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly reason: QuitResumeSkipReason;
  }>;
}

/**
 * Pure: snapshot the requested threads into a record. Unknown and deleted threads
 * are dropped (nothing to resume), duplicates collapse, order is preserved.
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
    if (!thread || thread.deletedAt !== null) {
      continue;
    }
    threads.push({ threadId, turnId: thread.latestTurn?.turnId ?? null });
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
 * only when it still exists, is neither deleted nor archived, its project exists,
 * its latest turn is exactly the one recorded at quit time, and nothing is in
 * flight on it. The continuation is an ordinary user turn on the thread's own
 * model/runtime/interaction settings (model omitted → provider reactor uses the
 * thread's current selection).
 *
 * Command and message ids are derived from the record so an accidental re-run
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
    if (thread.archivedAt != null) {
      skip(entry.threadId, "thread-archived");
      continue;
    }
    if (!liveProjectIds.has(thread.projectId)) {
      skip(entry.threadId, "project-missing");
      continue;
    }
    if (entry.turnId === null) {
      skip(entry.threadId, "no-turn");
      continue;
    }
    if ((thread.latestTurn?.turnId ?? null) !== entry.turnId) {
      skip(entry.threadId, "turn-changed");
      continue;
    }
    if (threadHasInFlightTurn(thread)) {
      skip(entry.threadId, "turn-in-flight");
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

/** `None` when the file is absent, empty, or does not decode (a corrupt record is ignored). */
export const readQuitResumeRecord = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none<QuitResumeRecord>();
    }
    const raw = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return Option.none<QuitResumeRecord>();
    }
    return yield* decodeQuitResumeRecord(trimmed).pipe(Effect.option);
  });

/**
 * RPC body: record first (failure fails the call so the renderer can fall back to
 * a plain interrupt), then interrupt every recorded thread. Interrupt failures
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
}): Effect.Effect<OrchestrationPrepareQuitResumeResult, unknown> =>
  Effect.gen(function* () {
    const readModel = yield* input.getReadModel();
    const record = buildQuitResumeRecord({
      request: input.request,
      threads: readModel.threads,
      recordId: randomUUID(),
      now: new Date().toISOString(),
    });
    yield* persistQuitResumeRecord({ path: input.recordPath, record });
    yield* Effect.logInfo("recorded running chats for resume after quit", {
      threadIds: record.threads.map((entry) => entry.threadId),
    });

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
      { discard: true },
    );

    return {
      recordedThreadIds: record.threads.map((entry) => entry.threadId),
      recordedAt: record.recordedAt,
    };
  });

/**
 * Boot-time consumer. Runs once after restart reconciliation has settled the
 * orphaned turns; cheap when there is nothing to resume (one `exists` probe).
 * Every failure is contained and logged — resuming is best-effort and must never
 * affect server startup.
 */
export const resumeQuitInterruptedChats: Effect.Effect<
  void,
  never,
  OrchestrationEngineService | ServerConfig | FileSystem.FileSystem
> = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const path = config.quitResumeStatePath;

  const recordOption = yield* readQuitResumeRecord(path);
  if (Option.isNone(recordOption)) {
    return;
  }
  const record = recordOption.value;

  // Consume before dispatching: a second process or a crash mid-dispatch must
  // never resume the same chats twice.
  const cleared = yield* clearQuitResumeRecord(path).pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.logWarning("quit-resume record could not be consumed; skipping resume", {
        path,
        cause,
      }).pipe(Effect.as(false)),
    ),
  );
  if (!cleared) {
    return;
  }

  const readModel = yield* engine.getReadModel();
  const plan = planQuitResumeTurns({
    record,
    threads: readModel.threads,
    projects: readModel.projects,
    now: new Date().toISOString(),
  });

  if (plan.skipped.length > 0) {
    yield* Effect.logInfo("skipping quit-resume for threads that moved on", {
      skipped: plan.skipped,
    });
  }
  if (plan.commands.length === 0) {
    return;
  }

  yield* Effect.logInfo("resuming chats interrupted by the previous quit", {
    recordedAt: record.recordedAt,
    threadIds: plan.commands.map((command) => command.threadId),
  });

  yield* Effect.forEach(
    plan.commands,
    (command) =>
      engine.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to resume chat after quit", {
            threadId: command.threadId,
            cause,
          }),
        ),
      ),
    { discard: true },
  );
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("quit-resume failed; continuing startup", { cause }),
  ),
);
