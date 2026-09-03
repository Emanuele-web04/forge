import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, TurnId, type OrchestrationCommand } from "@synara/contracts";
import { Duration, Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config";
import {
  buildQuitInterruptCommand,
  buildQuitResumeRecord,
  claimQuitResumeRecord,
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
const BEFORE_RECORD = "2026-06-14T09:59:00.000Z";
const AFTER_RECORD = "2026-06-14T10:00:30.000Z";
const NOW = "2026-06-14T10:05:00.000Z";
const PROMPT = "Synara was closed while this chat was still running. Continue where you left off.";

const threadId = (id: string) => ThreadId.makeUnsafe(id);
const turnId = (id: string) => TurnId.makeUnsafe(id);
const PROJECT = ProjectId.makeUnsafe("project-1");

const makeLatestTurn = (
  id: string,
  state: NonNullable<QuitResumeThread["latestTurn"]>["state"] = "interrupted",
  completedAt: string = AFTER_RECORD,
): NonNullable<QuitResumeThread["latestTurn"]> => ({
  turnId: turnId(id),
  state,
  requestedAt: "2026-06-14T09:00:00.000Z",
  startedAt: "2026-06-14T09:00:01.000Z",
  completedAt: state === "running" ? null : completedAt,
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
  threads: ReadonlyArray<{ threadId: string; turnId: string | null }>,
): QuitResumeRecord => ({
  version: 1,
  recordId: RECORD_ID,
  recordedAt: RECORDED_AT,
  continuationPrompt: PROMPT,
  threads: threads.map((entry) => ({
    threadId: threadId(entry.threadId),
    turnId: entry.turnId === null ? null : turnId(entry.turnId),
  })),
});

/** A thread whose provider is still connecting: session starting, no turn yet. */
const makeConnectingThread = (id: string, overrides: Partial<QuitResumeThread> = {}) =>
  makeThread(id, {
    latestTurn: null,
    session: makeSession(id, { status: "starting", activeTurnId: null }),
    ...overrides,
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
          threadId("connecting"),
          threadId("reconnecting"),
          threadId("b"),
        ],
        continuationPrompt: PROMPT,
      },
      threads: [
        makeRunningThread("a"),
        // Finished while the dialog was open: nothing to resume.
        makeThread("finished", { latestTurn: makeLatestTurn("finished-turn", "completed") }),
        makeRunningThread("deleted", { deletedAt: "2026-06-14T09:30:00.000Z" }),
        // Provider still starting: in flight, but no turn to name yet.
        makeConnectingThread("connecting"),
        makeConnectingThread("reconnecting", {
          latestTurn: makeLatestTurn("reconnecting-old", "completed", BEFORE_RECORD),
        }),
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
        { threadId: threadId("connecting"), turnId: null },
        { threadId: threadId("reconnecting"), turnId: null },
        { threadId: threadId("b"), turnId: turnId("b-turn") },
      ],
    });
  });
});

describe("buildQuitInterruptCommand", () => {
  it("derives a deterministic command id and targets the recorded turn when there is one", () => {
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
    expect(
      buildQuitInterruptCommand({
        threadId: threadId("b"),
        turnId: null,
        recordId: RECORD_ID,
        recordedAt: RECORDED_AT,
      }),
    ).not.toHaveProperty("turnId");
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
        resumePrecondition: { recordedTurnId: turnId("a-turn"), recordedAt: RECORDED_AT },
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
        // A later turn interrupted by the quit still counts as "where you left off".
        { threadId: "superseded", turnId: "superseded-turn" },
        { threadId: "completed", turnId: "completed-turn" },
        { threadId: "completed-later", turnId: "completed-later-turn" },
      ]),
      threads: [
        makeThread("interrupted"),
        makeThread("errored", { latestTurn: makeLatestTurn("errored-turn", "error") }),
        makeThread("superseded", { latestTurn: makeLatestTurn("superseded-turn-2") }),
        makeThread("completed", { latestTurn: makeLatestTurn("completed-turn", "completed") }),
        makeThread("completed-later", {
          latestTurn: makeLatestTurn("completed-later-turn-2", "completed", AFTER_RECORD),
        }),
      ],
      projects: liveProjects,
      now: NOW,
    });

    expect(plan.commands.map((command) => command.threadId)).toEqual([
      threadId("interrupted"),
      threadId("errored"),
      threadId("superseded"),
    ]);
    expect(plan.skipped).toEqual([
      { threadId: threadId("completed"), reason: "turn-completed" },
      { threadId: threadId("completed-later"), reason: "turn-completed" },
    ]);
  });

  it("resumes chats that were still connecting at quit unless a turn completed since", () => {
    const plan = planQuitResumeTurns({
      record: makeRecord([
        { threadId: "fresh", turnId: null },
        { threadId: "follow-up", turnId: null },
        { threadId: "started-then-stopped", turnId: null },
        { threadId: "answered", turnId: null },
      ]),
      threads: [
        // Never reached the provider: still no turn after restart reconciliation.
        makeThread("fresh", { latestTurn: null }),
        // Previous turn had completed before the record; the new one never started.
        makeThread("follow-up", {
          latestTurn: makeLatestTurn("follow-up-old", "completed", BEFORE_RECORD),
        }),
        // The pending turn started after the record and was interrupted by the quit.
        makeThread("started-then-stopped", { latestTurn: makeLatestTurn("started-turn") }),
        // A turn finished on its own after the record: nothing left to continue.
        makeThread("answered", {
          latestTurn: makeLatestTurn("answered-turn", "completed", AFTER_RECORD),
        }),
      ],
      projects: liveProjects,
      now: NOW,
    });

    expect(plan.commands.map((command) => command.threadId)).toEqual([
      threadId("fresh"),
      threadId("follow-up"),
      threadId("started-then-stopped"),
    ]);
    expect(plan.commands[0]?.resumePrecondition).toEqual({
      recordedTurnId: null,
      recordedAt: RECORDED_AT,
    });
    expect(plan.skipped).toEqual([{ threadId: threadId("answered"), reason: "turn-completed" }]);
  });

  it("skips threads that are missing, deleted, archived, project-less, or in flight", () => {
    const plan = planQuitResumeTurns({
      record: makeRecord([
        { threadId: "missing", turnId: "missing-turn" },
        { threadId: "deleted", turnId: "deleted-turn" },
        { threadId: "archived", turnId: "archived-turn" },
        { threadId: "orphan", turnId: "orphan-turn" },
        { threadId: "running", turnId: "running-turn" },
        { threadId: "connecting", turnId: "connecting-turn" },
        { threadId: "ok", turnId: "ok-turn" },
      ]),
      threads: [
        makeThread("deleted", { deletedAt: "2026-06-14T10:01:00.000Z" }),
        makeThread("archived", { archivedAt: "2026-06-14T10:01:00.000Z" }),
        makeThread("orphan", { projectId: ProjectId.makeUnsafe("project-gone") }),
        makeRunningThread("running"),
        makeConnectingThread("connecting"),
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
      { threadId: threadId("running"), reason: "turn-in-flight" },
      { threadId: threadId("connecting"), reason: "turn-in-flight" },
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

  it("claiming consumes the record atomically and leaves a record written meanwhile alone", async () => {
    const first = makeRecord([{ threadId: "a", turnId: "a-turn" }]);
    const second = { ...first, recordId: "record-2" };
    const result = await run(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const path = config.quitResumeStatePath;
        const nothing = yield* claimQuitResumeRecord(path);
        yield* persistQuitResumeRecord({ path, record: first });
        const claimed = yield* claimQuitResumeRecord(path);
        const afterClaim = yield* readQuitResumeRecord(path);
        // A quit prepared while boot is still running must keep its own record.
        yield* persistQuitResumeRecord({ path, record: second });
        const next = yield* claimQuitResumeRecord(path);
        yield* persistQuitResumeRecord({ path, record: first });
        const concurrent = yield* Effect.all(
          [claimQuitResumeRecord(path), claimQuitResumeRecord(path)],
          { concurrency: "unbounded" },
        );
        return { nothing, claimed, afterClaim, next, concurrent };
      }),
    );

    expect(result.nothing).toEqual({ kind: "absent" });
    expect(result.claimed).toEqual({ kind: "record", record: first });
    expect(result.afterClaim).toEqual({ kind: "absent" });
    expect(result.next).toEqual({ kind: "record", record: second });
    expect(result.concurrent.filter((entry) => entry.kind === "record")).toHaveLength(1);
    expect(result.concurrent.filter((entry) => entry.kind === "absent")).toHaveLength(1);
  });

  it("prepareQuitResume records in-flight threads, interrupts them, and drops the record if the quit never happens", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const result = await run(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const path = config.quitResumeStatePath;
        const prepared = yield* prepareQuitResume({
          request: {
            threadIds: [threadId("a"), threadId("connecting"), threadId("finished")],
            continuationPrompt: PROMPT,
          },
          recordPath: path,
          getReadModel: () =>
            Effect.succeed({
              threads: [
                makeRunningThread("a"),
                makeConnectingThread("connecting"),
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

    expect(result.prepared.recordedThreadIds).toEqual([threadId("a"), threadId("connecting")]);
    expect(result.persisted.kind).toBe("record");
    if (result.persisted.kind === "record") {
      expect(result.persisted.record.threads).toEqual([
        { threadId: threadId("a"), turnId: turnId("a-turn") },
        { threadId: threadId("connecting"), turnId: null },
      ]);
      expect(result.persisted.record.recordedAt).toBe(result.prepared.recordedAt);
    }
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "thread.turn.interrupt",
        threadId: threadId("a"),
        turnId: turnId("a-turn"),
      }),
      expect.objectContaining({ type: "thread.turn.interrupt", threadId: threadId("connecting") }),
    ]);
    expect(dispatched[1]).not.toHaveProperty("turnId");
    expect(result.abandoned).toEqual({ kind: "absent" });
  });

  it("acknowledges the durable record without waiting for best-effort interrupts", async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        run(
          Effect.gen(function* () {
            const config = yield* ServerConfig;
            const prepared = yield* prepareQuitResume({
              request: {
                threadIds: [threadId("a")],
                continuationPrompt: PROMPT,
              },
              recordPath: config.quitResumeStatePath,
              getReadModel: () => Effect.succeed({ threads: [makeRunningThread("a")] }),
              dispatch: () => Effect.never,
              abandonAfter: Duration.hours(1),
            });
            const persisted = yield* readQuitResumeRecord(config.quitResumeStatePath);
            yield* clearQuitResumeRecord(config.quitResumeStatePath);
            return { prepared, persisted };
          }),
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("prepareQuitResume waited for an interrupt")),
            250,
          );
        }),
      ]);

      expect(result.prepared.recordedThreadIds).toEqual([threadId("a")]);
      expect(result.persisted.kind).toBe("record");
    } finally {
      clearTimeout(timeout);
    }
  });
});
