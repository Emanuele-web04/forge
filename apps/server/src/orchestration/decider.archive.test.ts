import {
  DEFAULT_PROVIDER_PROFILE_ID,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-25T18:00:00.000Z";
const PARENT_THREAD_ID = ThreadId.makeUnsafe("thread-parent");
const CHILD_THREAD_ID = ThreadId.makeUnsafe("subagent:thread-parent:child");
const GRANDCHILD_THREAD_ID = ThreadId.makeUnsafe("subagent:child:grandchild");
const DELETED_CHILD_THREAD_ID = ThreadId.makeUnsafe("subagent:thread-parent:deleted");
const UNRELATED_THREAD_ID = ThreadId.makeUnsafe("thread-unrelated");

function makeThread(input: {
  id: ThreadId;
  parentThreadId?: ThreadId;
  archivedAt?: string;
  deletedAt?: string;
}): OrchestrationReadModel["threads"][number] {
  return {
    id: input.id,
    projectId: ProjectId.makeUnsafe("project-archive"),
    title: `Thread ${input.id}`,
    modelSelection: {
      provider: "claudeAgent",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "claude-opus-4-6",
      supportsAutoMode: true,
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "auto",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
    latestTurn: null,
    handoff: null,
    messages: [],
    session: null,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: input.deletedAt ?? null,
    ...(input.parentThreadId !== undefined ? { parentThreadId: input.parentThreadId } : {}),
    ...(input.archivedAt !== undefined ? { archivedAt: input.archivedAt } : {}),
  };
}

function makeReadModel(
  threads: OrchestrationReadModel["threads"][number][],
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads,
  };
}

function eventThreadIds(result: unknown): ThreadId[] {
  const events = (Array.isArray(result) ? result : [result]) as Omit<
    OrchestrationEvent,
    "sequence"
  >[];
  return events.map((event) => (event.payload as { threadId: ThreadId }).threadId);
}

describe("decider thread archive cascade", () => {
  it("archives the subagent subtree together with the parent", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-archive-parent"),
          threadId: PARENT_THREAD_ID,
        },
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID }),
          makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID }),
          makeThread({ id: GRANDCHILD_THREAD_ID, parentThreadId: CHILD_THREAD_ID }),
          makeThread({
            id: DELETED_CHILD_THREAD_ID,
            parentThreadId: PARENT_THREAD_ID,
            deletedAt: NOW,
          }),
          makeThread({ id: UNRELATED_THREAD_ID }),
        ]),
      }),
    );

    const events = result as Omit<OrchestrationEvent, "sequence">[];
    expect(events.every((event) => event.type === "thread.archived")).toBe(true);
    // Descendants first; the commanded thread comes last so the command receipt
    // records it as the aggregate.
    expect(eventThreadIds(result)).toEqual([
      CHILD_THREAD_ID,
      GRANDCHILD_THREAD_ID,
      PARENT_THREAD_ID,
    ]);
  });

  it("skips subagent threads that are already archived", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-archive-parent-partial"),
          threadId: PARENT_THREAD_ID,
        },
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID }),
          makeThread({
            id: CHILD_THREAD_ID,
            parentThreadId: PARENT_THREAD_ID,
            archivedAt: NOW,
          }),
        ]),
      }),
    );

    expect(eventThreadIds(result)).toEqual([PARENT_THREAD_ID]);
  });

  it("restores the archived subagent subtree together with the parent", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: CommandId.makeUnsafe("cmd-unarchive-parent"),
          threadId: PARENT_THREAD_ID,
        },
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID, archivedAt: NOW }),
          makeThread({
            id: CHILD_THREAD_ID,
            parentThreadId: PARENT_THREAD_ID,
            archivedAt: NOW,
          }),
          // Never archived alongside the parent, so restore leaves it untouched.
          makeThread({ id: GRANDCHILD_THREAD_ID, parentThreadId: CHILD_THREAD_ID }),
        ]),
      }),
    );

    const events = result as Omit<OrchestrationEvent, "sequence">[];
    expect(events.every((event) => event.type === "thread.unarchived")).toBe(true);
    expect(eventThreadIds(result)).toEqual([CHILD_THREAD_ID, PARENT_THREAD_ID]);
  });
});
