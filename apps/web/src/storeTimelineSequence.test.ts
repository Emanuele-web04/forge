import { MessageId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { applyOrchestrationEventsHotPath } from "./storeEventReducer";
import { withOrchestrationEventSequence } from "./storeNormalization";
import { syncServerThreadDetailHotPath } from "./storeProjection";
import {
  makeActivity,
  makeDomainEvent,
  makeState,
  makeThread,
  makeReadModelThread,
  threadsOf,
} from "./storeTestFixtures";
import { deriveTimelineEntries, deriveWorkLogEntries } from "./workLog";
import { deriveMessagesTimelineRows } from "./components/chat/MessagesTimeline.logic";
import type { ChatMessage } from "./types";

const at = (second: number) => new Date(Date.UTC(2026, 8, 5, 0, 0, second)).toISOString();
const oldTurn = TurnId.makeUnsafe("old-turn");
const newTurn = TurnId.makeUnsafe("new-turn");
const message = (
  id: string,
  role: "user" | "assistant",
  second: number,
  turnId: TurnId,
): ChatMessage => ({
  id: MessageId.makeUnsafe(id),
  role,
  text: id,
  createdAt: at(second),
  turnId,
  streaming: false,
});

describe("snapshot and live activity sequence parity", () => {
  it.each([0, 2000])("preserves canonical activity sequence %s", (sequence) => {
    expect(withOrchestrationEventSequence(makeActivity({ sequence }), 100).sequence).toBe(sequence);
  });

  it("falls back to the orchestration sequence for an activity without one", () => {
    expect(withOrchestrationEventSequence(makeActivity({}), 100).sequence).toBe(100);
  });

  it.each(["batched", "sequential"] as const)(
    "keeps historical tools and compaction in their original response after %s live events",
    (mode) => {
      // Runtime journal and orchestration log counters are both durable but
      // not interchangeable. History arrived in a snapshot; only the new
      // printf calls go through the live event reducer.
      const historical = [
        makeActivity({
          id: "old-tool",
          turnId: oldTurn,
          kind: "tool.completed",
          tone: "tool",
          summary: "Old command",
          createdAt: at(2),
          sequence: 1000,
        }),
        makeActivity({
          id: "old-compaction",
          kind: "context-compaction",
          tone: "info",
          summary: "Context compacted",
          createdAt: at(3),
          sequence: 1001,
        }),
      ];
      const current = [
        makeActivity({
          id: "printf-a",
          turnId: newTurn,
          kind: "tool.completed",
          tone: "tool",
          summary: "printf H1-A",
          createdAt: at(12),
          sequence: 2000,
        }),
        makeActivity({
          id: "printf-b",
          turnId: newTurn,
          kind: "tool.completed",
          tone: "tool",
          summary: "printf H1-B",
          createdAt: at(14),
          sequence: 2001,
        }),
      ];
      const messages = [
        message("old-user", "user", 0, oldTurn),
        { ...message("old-answer", "assistant", 4, oldTurn), completedAt: at(5) },
        message("new-user", "user", 10, newTurn),
        message("H1-PRE", "assistant", 11, newTurn),
        message("H1-MID", "assistant", 13, newTurn),
      ];
      const thread = makeThread({ messages, activities: historical });
      const events = current.map((activity, index) =>
        makeDomainEvent(
          "thread.activity-appended",
          { threadId: thread.id, activity },
          { sequence: 100 + index },
        ),
      );
      const initial = makeState(thread);
      const state =
        mode === "batched"
          ? applyOrchestrationEventsHotPath(initial, events)
          : events.reduce(
              (previous, event) => applyOrchestrationEventsHotPath(previous, [event]),
              initial,
            );
      const liveActivities = threadsOf(state)[0]!.activities;
      const derive = (activities: typeof liveActivities) =>
        deriveTimelineEntries(
          messages,
          [],
          deriveWorkLogEntries(activities, newTurn, {
            visibleTurnIds: new Set([oldTurn, newTurn]),
            activeTurnId: newTurn,
          }),
        );
      const timeline = derive(liveActivities);
      const snapshotTimeline = derive([...historical, ...current]);
      const refreshed = syncServerThreadDetailHotPath(
        state,
        makeReadModelThread({
          id: thread.id,
          activities: [...historical, ...current],
          updatedAt: at(15),
        }),
      );
      expect(timeline.map((entry) => entry.id)).toEqual([
        "old-user",
        "old-tool",
        "old-compaction",
        "old-answer",
        "new-user",
        "H1-PRE",
        "printf-a",
        "H1-MID",
        "printf-b",
      ]);
      expect(timeline).toEqual(snapshotTimeline);
      expect(derive(threadsOf(refreshed)[0]!.activities)).toEqual(timeline);
      for (const active of [true, false]) {
        const rows = deriveMessagesTimelineRows({
          timelineEntries: timeline,
          isWorking: active,
          activeTurnInProgress: active,
          activeTurnId: newTurn,
          activeTurnStartedAt: at(10),
          worktreeSetup: null,
          worktreeSetupOpen: false,
          turnDiffSummaryByAssistantMessageId: new Map(),
          revertTurnCountByUserMessageId: new Map(),
        });
        const oldAnswer = rows.find((row) => row.id === "old-answer");
        expect(
          oldAnswer?.kind === "message" && oldAnswer.collapsedTurnItems?.map((item) => item.id),
        ).toEqual(["old-tool", "old-compaction"]);
        const newBoundary = rows.findIndex((row) => row.id === "new-user");
        expect(JSON.stringify(rows.slice(newBoundary + 1))).not.toContain("old-tool");
        expect(JSON.stringify(rows.slice(newBoundary + 1))).not.toContain("old-compaction");
        const workIds = rows.slice(newBoundary + 1).flatMap((row) => {
          if (row.kind === "work") return row.groupedEntries.map((entry) => entry.id);
          if (row.kind !== "message") return [];
          return [
            ...(row.leadingWorkEntries ?? []),
            ...(row.inlineWorkEntries ?? []),
            ...(row.collapsedTurnItems ?? []).flatMap((item) =>
              item.kind === "work" ? [item.entry] : [],
            ),
          ].map((entry) => entry.id);
        });
        expect(workIds).toEqual(["printf-a", "printf-b"]);
      }
    },
  );
});
