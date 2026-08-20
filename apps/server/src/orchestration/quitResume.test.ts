import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, TurnId, type OrchestrationCommand } from "@synara/contracts";
import { Duration, Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config";
import {
  buildQuitInterruptCommand,
  buildQuitResumeRecord,
  clearQuitResumeRecord,
  persistQuitResumeRecord,
  planQuitResumeTurns,
  prepareQuitResume,
  readQuitResumeRecord,
  type QuitResumeRecord,
  type QuitResumeThread,
} from "./quitResume.ts";

const RECORD_ID = "record-1";
const RECORDED_AT = "2026-06-14T10:00:00.000Z";
const NOW = "2026-06-14T10:05:00.000Z";
const PROMPT = "Synara was closed while this chat was still running. Continue where you left off.";

const threadId = (id: string) => ThreadId.makeUnsafe(id);
const turnId = (id: string) => TurnId.makeUnsafe(id);
const PROJECT = ProjectId.makeUnsafe("project-1");

const makeLatestTurn = (
  id: string,
  state: NonNullable<QuitResumeThread["latestTurn"]>["state"] = "interrupted",
): NonNullable<QuitResumeThread["latestTurn"]> => ({
  turnId: turnId(id),
  state,
  requestedAt: "2026-06-14T09:00:00.000Z",
  startedAt: "2026-06-14T09:00:01.000Z",
  completedAt: state === "running" ? null : "2026-06-14T09:59:00.000Z",
  assistantMessageId: null,
});

const makeSession = (
  id: string,
  overrides: Partial<NonNullable<QuitResumeThread["session"]>> = {},
): NonNullable<QuitResumeThread["session"]> => ({
  threadId: threadId(id),
  providerName: "codex",
  runtimeMode: "full-access",
  status: "running",
  activeTurnId: turnId(`${id}-turn`),
  lastError: null,
  updatedAt: "2026-06-14T09:00:01.000Z",
  ...overrides,
});

const makeThread = (id: string, overrides: Partial<QuitResumeThread> = {}): QuitResumeThread => ({
  id: threadId(id),
  projectId: PROJECT,
  deletedAt: null,
  archivedAt: null,
  latestTurn: makeLatestTurn(`${id}-turn`),
  session: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  ...overrides,
});

/** A thread whose latest turn is genuinely running right now. */
const makeRunningThread = (id: string, overrides: Partial<QuitResumeThread> = {}) =>
  makeThread(id, {
    latestTurn: makeLatestTurn(`${id}-turn`, "running"),
    session: makeSession(id),
    ...overrides,
  });

const makeRecord = (
  threads: ReadonlyArray<{ threadId: string; turnId: string }>,
): QuitResumeRecord => ({
  version: 1,
  recordId: RECORD_ID,
  recordedAt: RECORDED_AT,
  continuationPrompt: PROMPT,
  threads: threads.map((entry) => ({
    threadId: threadId(entry.threadId),
    turnId: turnId(entry.turnId),
  })),
});

const liveProjects = [{ id: PROJECT, deletedAt: null }];

describe("buildQuitResumeRecord", () => {
  it("snapshots only threads that are in flight right now, dropping unknown, deleted, idle, and duplicate ids", () => {
    const record = buildQuitResumeRecord({
      request: {
        threadIds: [
          threadId("a"),
          threadId("finished"),
          threadId("a"),
          threadId("gone"),
          threadId("deleted"),
          threadId("no-turn"),
          threadId("b"),
        ],
        continuationPrompt: PROMPT,
      },
      threads: [
        makeRunningThread("a"),
        // Finished while the dialog was open: nothing to resume.
        makeThread("finished", { latestTurn: makeLatestTurn("finished-turn", "completed") }),
        makeRunningThread("deleted", { deletedAt: "2026-06-14T09:30:00.000Z" }),
        makeThread("no-turn", { latestTurn: null, session: makeSession("no-turn") }),
        makeRunningThread("b"),
      ],
      recordId: RECORD_ID,
      now: RECORDED_AT,
    });

    expect(record).toEqual({
      version: 1,
      recordId: RECORD_ID,
      recordedAt: RECORDED_AT,
      continuationPrompt: PROMPT,
      threads: [
        { threadId: threadId("a"), turnId: turnId("a-turn") },
        { threadId: threadId("b"), turnId: turnId("b-turn") },
      ],
    });
  });
});

describe("buildQuitInterruptCommand", () => {
  it("derives a deterministic command id and targets the recorded turn", () => {
    expect(
      buildQuitInterruptCommand({
        threadId: threadId("a"),
        turnId: turnId("a-turn"),
        recordId: RECORD_ID,
        recordedAt: RECORDED_AT,
      }),
    ).toEqual({
      type: "thread.turn.interrupt",
      commandId: `quit-resume-interrupt:${RECORD_ID}:a`,
      threadId: threadId("a"),
      turnId: turnId("a-turn"),
      createdAt: RECORDED_AT,
    });
  });
});

describe("planQuitResumeTurns", () => {
  it("queues an ordinary user turn on each unchanged thread using its own runtime settings", () => {
    const plan = planQuitResumeTurns({
      record: makeRecord([{ threadId: "a", turnId: "a-turn" }]),
      threads: [makeThread("a", { runtimeMode: "approval-required", interactionMode: "plan" })],
      projects: liveProjects,
      now: NOW,
    });

    expect(plan.skipped).toEqual([]);
    expect(plan.commands).toEqual([
      {
        type: "thread.turn.start",
        commandId: `quit-resume:${RECORD_ID}:a`,
        threadId: threadId("a"),
        message: {
          messageId: `quit-resume:${RECORD_ID}:a`,
          role: "user",
          text: PROMPT,
          attachments: [],
        },
        dispatchMode: "queue",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        // Re-checked by the decider inside the serialized dispatch.
        resumePrecondition: { expectedLatestTurnId: turnId("a-turn") },
        createdAt: NOW,
      },
    ]);
    // Model selection is intentionally omitted so the thread's current selection is used.
    expect(plan.commands[0]).not.toHaveProperty("modelSelection");
  });

  it("resumes turns that ended as interrupted or error, not ones that completed on their own", () => {
    const plan = planQuitResumeTurns({
      record: makeRecord([
        { threadId: "interrupted", turnId: "interrupted-turn" },
        { threadId: "errored", turnId: "errored-turn" },
        { threadId: "completed", turnId: "completed-turn" },
      ]),
      threads: [
        makeThread("interrupted"),
        makeThread("errored", { latestTurn: makeLatestTurn("errored-turn", "error") }),
        makeThread("completed", { latestTurn: makeLatestTurn("completed-turn", "completed") }),
      ],
      projects: liveProjects,
      now: NOW,
    });

    expect(plan.commands.map((command) => command.threadId)).toEqual([
      threadId("interrupted"),
      threadId("errored"),
    ]);
    expect(plan.skipped).toEqual([{ threadId: threadId("completed"), reason: "turn-completed" }]);
  });

  it("skips threads that are missing, deleted, archived, project-less, progressed, or in flight", () => {
    const plan = planQuitResumeTurns({
      record: makeRecord([
        { threadId: "missing", turnId: "missing-turn" },
        { threadId: "deleted", turnId: "deleted-turn" },
        { threadId: "archived", turnId: "archived-turn" },
        { threadId: "orphan", turnId: "orphan-turn" },
        { threadId: "no-turn", turnId: "no-turn-turn" },
        { threadId: "progressed", turnId: "progressed-turn" },
        { threadId: "running", turnId: "running-turn" },
        { threadId: "ok", turnId: "ok-turn" },
      ]),
      threads: [
        makeThread("deleted", { deletedAt: "2026-06-14T10:01:00.000Z" }),
        makeThread("archived", { archivedAt: "2026-06-14T10:01:00.000Z" }),
        makeThread("orphan", { projectId: ProjectId.makeUnsafe("project-gone") }),
        makeThread("no-turn", { latestTurn: null }),
        makeThread("progressed", { latestTurn: makeLatestTurn("progressed-turn-2") }),
        makeRunningThread("running"),
        makeThread("ok"),
      ],
      projects: [...liveProjects, { id: ProjectId.makeUnsafe("project-gone"), deletedAt: NOW }],
      now: NOW,
    });

    expect(plan.commands.map((command) => command.threadId)).toEqual([threadId("ok")]);
    expect(plan.skipped).toEqual([
      { threadId: threadId("missing"), reason: "thread-missing" },
      { threadId: threadId("deleted"), reason: "thread-deleted" },
      { threadId: threadId("archived"), reason: "thread-archived" },
      { threadId: threadId("orphan"), reason: "project-missing" },
      { threadId: threadId("no-turn"), reason: "turn-changed" },
      { threadId: threadId("progressed"), reason: "turn-changed" },
      { threadId: threadId("running"), reason: "turn-in-flight" },
    ]);
  });
});

describe("quit resume record file", () => {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-quit-resume-",
  }).pipe(Layer.provide(NodeServices.layer));
  const testLayer = Layer.merge(NodeServices.layer, serverConfigLayer);
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);

  it("persists, reads, and clears the record; missing reads as absent, corrupt as invalid", async () => {
    const record = makeRecord([{ threadId: "a", turnId: "a-turn" }]);
    const result = await run(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const path = config.quitResumeStatePath;
        const missing = yield* readQuitResumeRecord(path);
        yield* persistQuitResumeRecord({ path, record });
        const persisted = yield* readQuitResumeRecord(path);
        yield* clearQuitResumeRecord(path);
        const cleared = yield* readQuitResumeRecord(path);
        // Clearing twice is fine (force remove).
        yield* clearQuitResumeRecord(path);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(path, "{ not json");
        const corrupt = yield* readQuitResumeRecord(path);
        yield* fs.writeFileString(path, "   \n");
        const empty = yield* readQuitResumeRecord(path);
        yield* clearQuitResumeRecord(path);
        return { missing, persisted, cleared, corrupt, empty };
      }),
    );

    expect(result.missing).toEqual({ kind: "absent" });
    expect(result.persisted).toEqual({ kind: "record", record });
    expect(result.cleared).toEqual({ kind: "absent" });
    expect(result.corrupt).toEqual({ kind: "invalid" });
    expect(result.empty).toEqual({ kind: "invalid" });
  });

  it("prepareQuitResume records in-flight threads, interrupts them, and drops the record if the quit never happens", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const result = await run(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const path = config.quitResumeStatePath;
        const prepared = yield* prepareQuitResume({
          request: {
            threadIds: [threadId("a"), threadId("finished")],
            continuationPrompt: PROMPT,
          },
          recordPath: path,
          getReadModel: () =>
            Effect.succeed({
              threads: [
                makeRunningThread("a"),
                makeThread("finished", {
                  latestTurn: makeLatestTurn("finished-turn", "completed"),
                }),
              ],
            }),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
            }),
          abandonAfter: Duration.millis(50),
        });
        const persisted = yield* readQuitResumeRecord(path);
        // Still alive well after the abandon delay → the quit was cancelled.
        const abandoned = yield* Effect.sleep(Duration.millis(400)).pipe(
          Effect.andThen(readQuitResumeRecord(path)),
        );
        return { prepared, persisted, abandoned };
      }),
    );

    expect(result.prepared.recordedThreadIds).toEqual([threadId("a")]);
    expect(result.persisted.kind).toBe("record");
    if (result.persisted.kind === "record") {
      expect(result.persisted.record.threads).toEqual([
        { threadId: threadId("a"), turnId: turnId("a-turn") },
      ]);
      expect(result.persisted.record.recordedAt).toBe(result.prepared.recordedAt);
    }
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "thread.turn.interrupt",
        threadId: threadId("a"),
        turnId: turnId("a-turn"),
      }),
    ]);
    expect(result.abandoned).toEqual({ kind: "absent" });
  });
});
