import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { Effect, FileSystem, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config";
import {
  buildQuitInterruptCommand,
  buildQuitResumeRecord,
  clearQuitResumeRecord,
  persistQuitResumeRecord,
  planQuitResumeTurns,
  readQuitResumeRecord,
  type QuitResumeRecord,
  type QuitResumeThread,
} from "./quitResume.ts";

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

const makeRecord = (
  threads: ReadonlyArray<{ threadId: string; turnId: string | null }>,
): QuitResumeRecord => ({
  version: 1,
  recordedAt: RECORDED_AT,
  continuationPrompt: PROMPT,
  threads: threads.map((entry) => ({
    threadId: threadId(entry.threadId),
    turnId: entry.turnId === null ? null : turnId(entry.turnId),
  })),
});

const liveProjects = [{ id: PROJECT, deletedAt: null }];

describe("buildQuitResumeRecord", () => {
  it("snapshots known live threads with their latest turn, dropping unknown, deleted, and duplicate ids", () => {
    const record = buildQuitResumeRecord({
      request: {
        threadIds: [threadId("a"), threadId("b"), threadId("a"), threadId("gone"), threadId("c")],
        continuationPrompt: PROMPT,
      },
      threads: [
        makeThread("a"),
        makeThread("b", { latestTurn: null }),
        makeThread("c", { deletedAt: "2026-06-14T09:30:00.000Z" }),
      ],
      now: RECORDED_AT,
    });

    expect(record).toEqual({
      version: 1,
      recordedAt: RECORDED_AT,
      continuationPrompt: PROMPT,
      threads: [
        { threadId: threadId("a"), turnId: turnId("a-turn") },
        { threadId: threadId("b"), turnId: null },
      ],
    });
  });
});

describe("buildQuitInterruptCommand", () => {
  it("derives a deterministic command id and forwards the recorded turn id when present", () => {
    expect(
      buildQuitInterruptCommand({
        threadId: threadId("a"),
        turnId: turnId("a-turn"),
        recordedAt: RECORDED_AT,
      }),
    ).toEqual({
      type: "thread.turn.interrupt",
      commandId: `quit-resume-interrupt:a:${RECORDED_AT}`,
      threadId: threadId("a"),
      turnId: turnId("a-turn"),
      createdAt: RECORDED_AT,
    });
    expect(
      buildQuitInterruptCommand({ threadId: threadId("b"), turnId: null, recordedAt: RECORDED_AT }),
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
        commandId: `quit-resume:a:${RECORDED_AT}`,
        threadId: threadId("a"),
        message: {
          messageId: `quit-resume:a:${RECORDED_AT}`,
          role: "user",
          text: PROMPT,
          attachments: [],
        },
        dispatchMode: "queue",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        createdAt: NOW,
      },
    ]);
    // Model selection is intentionally omitted so the thread's current selection is used.
    expect(plan.commands[0]).not.toHaveProperty("modelSelection");
  });

  it("skips threads that are missing, deleted, archived, project-less, turn-less, progressed, or in flight", () => {
    const plan = planQuitResumeTurns({
      record: makeRecord([
        { threadId: "missing", turnId: "missing-turn" },
        { threadId: "deleted", turnId: "deleted-turn" },
        { threadId: "archived", turnId: "archived-turn" },
        { threadId: "orphan", turnId: "orphan-turn" },
        { threadId: "no-turn", turnId: null },
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
        makeThread("running", { latestTurn: makeLatestTurn("running-turn", "running") }),
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
      { threadId: threadId("no-turn"), reason: "no-turn" },
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

  it("persists, reads, and clears the record; a missing or corrupt file reads as none", async () => {
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
        yield* clearQuitResumeRecord(path);
        return { missing, persisted, cleared, corrupt };
      }),
    );

    expect(Option.isNone(result.missing)).toBe(true);
    expect(Option.getOrNull(result.persisted)).toEqual(record);
    expect(Option.isNone(result.cleared)).toBe(true);
    expect(Option.isNone(result.corrupt)).toBe(true);
  });
});
