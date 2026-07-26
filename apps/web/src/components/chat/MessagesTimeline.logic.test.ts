import { CheckpointRef, MessageId, OrchestrationProposedPlanId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  buildTurnDiffSummaryByAssistantMessageId,
  capOpenWorkEntryRenderChunks,
  chunkCollapsedTurnItems,
  chunkWorkEntries,
  computeMessageDurationStart,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveTerminalAssistantMessageIds,
  findLastLiveWorkGroupId,
  normalizeCompactToolLabel,
  planWorkEntryRenderChunks,
  resolveAssistantMessageCopyState,
  resolveAssistantMessageDisplayText,
  type CollapsedTurnItem,
  type MessagesTimelineRow,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { TurnDiffSummary, WorktreeSetupSnapshot } from "../../types";

function makeSummary(
  overrides: Omit<Partial<TurnDiffSummary>, "turnId"> & { turnId: string },
): TurnDiffSummary {
  const { turnId, ...rest } = overrides;
  return {
    turnId: TurnId.makeUnsafe(turnId),
    status: "ready",
    completedAt: "2026-01-01T00:00:10Z",
    files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
    checkpointRef: CheckpointRef.makeUnsafe(`checkpoint-${turnId}`),
    checkpointTurnCount: 1,
    assistantMessageId: null,
    ...rest,
  } as TurnDiffSummary;
}

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("computeStableMessagesTimelineRows", () => {
  type MessageTimelineRow = Extract<MessagesTimelineRow, { kind: "message" }>;
  type WorkTimelineRow = Extract<MessagesTimelineRow, { kind: "work" }>;

  const emptyStableRows = (): StableMessagesTimelineRowsState => ({
    byId: new Map(),
    result: [],
  });

  it("replaces work rows when later tool metadata adds visible details", () => {
    const firstRows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "work-group-1",
        createdAt: "2026-05-09T10:00:00.000Z",
        groupedEntries: [
          {
            id: "activity-read",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Read",
            tone: "tool",
            itemType: "dynamic_tool_call",
            toolTitle: "Read",
          },
        ],
      },
    ];
    const first = computeStableMessagesTimelineRows(firstRows, emptyStableRows());

    const enrichedRows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "work-group-1",
        createdAt: "2026-05-09T10:00:00.000Z",
        groupedEntries: [
          {
            id: "activity-read",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Read",
            tone: "tool",
            itemType: "dynamic_tool_call",
            toolTitle: "Read",
            detail: "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:12",
            changedFiles: ["apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts"],
          },
        ],
      },
    ];

    const second = computeStableMessagesTimelineRows(enrichedRows, first);

    expect(second).not.toBe(first);
    expect(second.result[0]).toBe(enrichedRows[0]);
  });

  it("replaces work rows when live activity settles without a final tool event", () => {
    const firstRow: WorkTimelineRow = {
      kind: "work",
      id: "work-group-live-activity",
      createdAt: "2026-05-09T10:00:00.000Z",
      groupedEntries: [
        {
          id: "activity-command",
          createdAt: "2026-05-09T10:00:00.000Z",
          label: "Bash",
          tone: "tool",
          itemType: "command_execution",
          liveActivity: {
            state: "running_tool",
            label: "Bash",
            startedAt: "2026-05-09T10:00:00.000Z",
            lastActivityAt: "2026-05-09T10:00:01.000Z",
            detail: "Running",
            progress: 0.5,
            elapsedSeconds: 1,
          },
        },
      ],
    };
    const first = computeStableMessagesTimelineRows([firstRow], emptyStableRows());
    const settledRow: WorkTimelineRow = {
      ...firstRow,
      groupedEntries: [
        {
          ...firstRow.groupedEntries[0]!,
          liveActivity: {
            state: "completed",
            label: "Bash completed",
            startedAt: "2026-05-09T10:00:00.000Z",
            lastActivityAt: "2026-05-09T10:00:05.000Z",
            detail: "Done",
            progress: 1,
            elapsedSeconds: 5,
          },
        },
      ],
    };

    const second = computeStableMessagesTimelineRows([settledRow], first);

    expect(second).not.toBe(first);
    expect(second.result[0]).toBe(settledRow);
  });

  it("reuses worktree-setup rows until a step status or open state changes", () => {
    const makeRow = (
      status: "active" | "done",
      open: boolean,
    ): Extract<MessagesTimelineRow, { kind: "worktree-setup" }> => ({
      kind: "worktree-setup",
      id: "worktree-setup-row",
      open,
      steps: [{ id: "create-worktree", label: "Creating branch and worktree", status }],
    });

    const first = computeStableMessagesTimelineRows([makeRow("active", true)], emptyStableRows());
    const unchanged = computeStableMessagesTimelineRows([makeRow("active", true)], first);
    expect(unchanged).toBe(first);

    const statusChanged = computeStableMessagesTimelineRows([makeRow("done", true)], unchanged);
    expect(statusChanged).not.toBe(unchanged);
    expect(statusChanged.result[0]).not.toBe(unchanged.result[0]);

    const openChanged = computeStableMessagesTimelineRows([makeRow("done", false)], statusChanged);
    expect(openChanged).not.toBe(statusChanged);
    expect(openChanged.result[0]).not.toBe(statusChanged.result[0]);
  });

  it("replaces work rows when the activity kind changes", () => {
    const firstRow: WorkTimelineRow = {
      kind: "work",
      id: "work-group-user-input",
      createdAt: "2026-05-09T10:00:00.000Z",
      groupedEntries: [
        {
          id: "activity-user-input",
          createdAt: "2026-05-09T10:00:00.000Z",
          label: "Needs input",
          tone: "info",
        },
      ],
    };
    const firstRows: MessagesTimelineRow[] = [firstRow];
    const first = computeStableMessagesTimelineRows(firstRows, emptyStableRows());

    const enrichedRows: MessagesTimelineRow[] = [
      {
        ...firstRow,
        groupedEntries: [
          {
            ...firstRow.groupedEntries[0]!,
            activityKind: "user-input.requested",
          },
        ],
      },
    ];

    const second = computeStableMessagesTimelineRows(enrichedRows, first);

    expect(second).not.toBe(first);
    expect(second.result[0]).toBe(enrichedRows[0]);
  });

  it("replaces work rows when automation card fields are added", () => {
    const firstRows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "work-group-automation",
        createdAt: "2026-05-09T10:00:00.000Z",
        groupedEntries: [
          {
            id: "automation-created",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Created automation",
            tone: "info",
          },
        ],
      },
    ];
    const first = computeStableMessagesTimelineRows(firstRows, emptyStableRows());

    const enrichedRows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "work-group-automation",
        createdAt: "2026-05-09T10:00:00.000Z",
        groupedEntries: [
          {
            id: "automation-created",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Created automation",
            tone: "info",
            automation: {
              id: "automation-7",
              name: "Watch Synara PR 231",
              cadenceLabel: "Every 5m",
            },
          },
        ],
      },
    ];

    const second = computeStableMessagesTimelineRows(enrichedRows, first);

    expect(second).not.toBe(first);
    expect(second.result[0]).toBe(enrichedRows[0]);
  });

  it("replaces assistant rows when inline tool metadata becomes richer", () => {
    const assistantMessage = {
      id: MessageId.makeUnsafe("assistant-1"),
      role: "assistant" as const,
      text: "Working on it.",
      createdAt: "2026-05-09T10:00:01.000Z",
      streaming: true,
    };
    const firstRows: MessageTimelineRow[] = [
      {
        kind: "message",
        id: "assistant-1",
        createdAt: "2026-05-09T10:00:01.000Z",
        message: assistantMessage,
        inlineWorkEntries: [
          {
            id: "activity-command",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            toolTitle: "Ran",
          },
        ],
        inlineWorkGroupId: "activity-command",
        durationStart: "2026-05-09T10:00:01.000Z",
        showAssistantCopyButton: false,
        assistantCopyStreaming: true,
      },
    ];
    const first = computeStableMessagesTimelineRows(firstRows, emptyStableRows());

    const enrichedRows: MessageTimelineRow[] = [
      {
        ...firstRows[0]!,
        inlineWorkEntries: [
          {
            id: "activity-command",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            toolTitle: "Ran",
            command: 'git grep -n "model.rerouted"',
            rawCommand: "/bin/zsh -lc 'git grep -n \"model.rerouted\"'",
            requestKind: "command",
          },
        ],
      },
    ];

    const second = computeStableMessagesTimelineRows(enrichedRows, first);

    expect(second).not.toBe(first);
    expect(second.result[0]).toBe(enrichedRows[0]);
  });
});

describe("deriveTerminalAssistantMessageIds", () => {
  it("keeps only the latest assistant message in a user-visible response segment", () => {
    expect(
      deriveTerminalAssistantMessageIds([
        { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
        { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01Z", turnId: "t1" },
        { id: "a2", role: "assistant", createdAt: "2026-01-01T00:00:02Z", turnId: "t1" },
        { id: "a3", role: "assistant", createdAt: "2026-01-01T00:00:03Z", turnId: "t2" },
      ]),
    ).toEqual(new Set(["a3"]));
  });

  it("treats assistant messages without turn ids as one response per user boundary", () => {
    expect(
      deriveTerminalAssistantMessageIds([
        { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
        { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01Z" },
        { id: "a2", role: "assistant", createdAt: "2026-01-01T00:00:02Z" },
        { id: "u2", role: "user", createdAt: "2026-01-01T00:00:03Z" },
        { id: "a3", role: "assistant", createdAt: "2026-01-01T00:00:04Z" },
      ]),
    ).toEqual(new Set(["a2", "a3"]));
  });
});

describe("buildTurnDiffSummaryByAssistantMessageId", () => {
  it("attaches each summary to the terminal assistant message of its response segment", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" }), makeSummary({ turnId: "turn-2" })],
      messages: [
        { id: MessageId.makeUnsafe("u-1"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-turn-1"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-1"),
        },
        {
          id: MessageId.makeUnsafe("a-turn-2"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-2"),
        },
      ],
    });

    expect(result.get(MessageId.makeUnsafe("a-turn-2"))?.turnId).toBe(TurnId.makeUnsafe("turn-2"));
    expect(result.has(MessageId.makeUnsafe("a-turn-1"))).toBe(false);
    expect(result.size).toBe(1);
  });

  it("moves an earlier mini-turn diff to a later final answer in the same response segment", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-files" })],
      messages: [
        { id: MessageId.makeUnsafe("u-1"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-files"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-files"),
        },
        {
          id: MessageId.makeUnsafe("a-final"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-final"),
        },
      ],
    });

    expect(result.get(MessageId.makeUnsafe("a-final"))?.turnId).toBe(
      TurnId.makeUnsafe("turn-files"),
    );
    expect(result.has(MessageId.makeUnsafe("a-files"))).toBe(false);
  });

  it("keeps files from multiple mini-turn summaries on the final answer", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [
        makeSummary({
          turnId: "turn-files",
          checkpointTurnCount: 1,
          files: [{ path: "a.ts", additions: 1, deletions: 0 }],
        }),
        makeSummary({
          turnId: "turn-final",
          checkpointTurnCount: 2,
          files: [{ path: "b.ts", additions: 0, deletions: 1 }],
        }),
      ],
      messages: [
        { id: MessageId.makeUnsafe("u-1"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-files"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-files"),
        },
        {
          id: MessageId.makeUnsafe("a-final"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-final"),
        },
      ],
    });

    expect(result.get(MessageId.makeUnsafe("a-final"))?.files.map((file) => file.path)).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(result.get(MessageId.makeUnsafe("a-final"))?.checkpointTurnCounts).toEqual([1, 2]);
  });

  it("preserves Undo metadata when an empty placeholder follows file changes", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [
        makeSummary({ turnId: "turn-files", checkpointTurnCount: 1 }),
        makeSummary({
          turnId: "turn-empty-placeholder",
          status: "missing",
          checkpointRef: CheckpointRef.makeUnsafe("provider-diff:event-empty"),
          files: [],
        }),
      ],
      messages: [
        { id: MessageId.makeUnsafe("u-1"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-files"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-files"),
        },
        {
          id: MessageId.makeUnsafe("a-empty-placeholder"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-empty-placeholder"),
        },
      ],
    });

    const summary = result.get(MessageId.makeUnsafe("a-empty-placeholder"));
    expect(summary?.checkpointTurnCounts).toEqual([1]);
    expect(summary?.status).toBe("ready");
    expect(summary?.checkpointRef).toBe(CheckpointRef.makeUnsafe("checkpoint-turn-files"));
  });

  it("excludes no-change and placeholder mini-turns from merged Undo targets", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [
        makeSummary({ turnId: "turn-files", checkpointTurnCount: 1 }),
        makeSummary({ turnId: "turn-no-files", checkpointTurnCount: 2, files: [] }),
        makeSummary({
          turnId: "turn-placeholder",
          checkpointTurnCount: 3,
          checkpointRef: CheckpointRef.makeUnsafe("provider-diff:event-3"),
        }),
        makeSummary({
          turnId: "turn-missing",
          checkpointTurnCount: 4,
          status: "missing",
          checkpointRef: CheckpointRef.makeUnsafe("checkpoint-turn-missing"),
        }),
      ],
      messages: [
        { id: MessageId.makeUnsafe("u-1"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-files"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-files"),
        },
        {
          id: MessageId.makeUnsafe("a-no-files"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-no-files"),
        },
        {
          id: MessageId.makeUnsafe("a-placeholder"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-placeholder"),
        },
        {
          id: MessageId.makeUnsafe("a-missing"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-missing"),
        },
      ],
    });

    expect(result.has(MessageId.makeUnsafe("a-placeholder"))).toBe(false);
    expect(result.get(MessageId.makeUnsafe("a-missing"))?.checkpointTurnCounts).toEqual([]);
  });

  it("keeps separate cards for response segments split by user messages", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" }), makeSummary({ turnId: "turn-2" })],
      messages: [
        { id: MessageId.makeUnsafe("u-1"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-turn-1"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-1"),
        },
        { id: MessageId.makeUnsafe("u-2"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-turn-2"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-2"),
        },
      ],
    });

    expect(result.get(MessageId.makeUnsafe("a-turn-1"))?.turnId).toBe(TurnId.makeUnsafe("turn-1"));
    expect(result.get(MessageId.makeUnsafe("a-turn-2"))?.turnId).toBe(TurnId.makeUnsafe("turn-2"));
    expect(result.size).toBe(2);
  });

  it("does not leak a summary to an unrelated message even when ids look similar", () => {
    // Regression for the "Files changed on wrong thread" bug: before the fix,
    // the server synthesized `assistant:<turnId>` ids that could collide with
    // the real message id of a different turn. Anchoring by the matching turn's
    // response segment prevents the card from attaching to unrelated rows.
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-files-changed" })],
      messages: [
        {
          id: MessageId.makeUnsafe("a-unrelated"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-no-changes"),
        },
      ],
    });

    expect(result.size).toBe(0);
  });

  it("ignores summaries for turns that have no rendered assistant message yet", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" })],
      messages: [],
    });

    expect(result.size).toBe(0);
  });

  it("attaches the summary to the LAST assistant message of a turn when multiple exist", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" })],
      messages: [
        {
          id: MessageId.makeUnsafe("a-turn-1-first"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-1"),
        },
        {
          id: MessageId.makeUnsafe("a-turn-1-last"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-1"),
        },
      ],
    });

    expect(result.get(MessageId.makeUnsafe("a-turn-1-last"))?.turnId).toBe(
      TurnId.makeUnsafe("turn-1"),
    );
    expect(result.has(MessageId.makeUnsafe("a-turn-1-first"))).toBe(false);
    expect(result.size).toBe(1);
  });

  it("returns an empty map when there are no summaries", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [],
      messages: [
        { id: MessageId.makeUnsafe("a-1"), role: "assistant", turnId: TurnId.makeUnsafe("turn-1") },
      ],
    });

    expect(result.size).toBe(0);
  });

  it("ignores assistant messages without a turnId", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" })],
      messages: [{ id: MessageId.makeUnsafe("a-nullturn"), role: "assistant", turnId: null }],
    });

    expect(result.size).toBe(0);
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("shows copy only for non-empty settled assistant text", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "Hello",
        showCopyButton: true,
        streaming: false,
      }),
    ).toEqual({ text: "Hello", visible: true });
  });

  it("hides copy while the active assistant response is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "Hello",
        showCopyButton: true,
        streaming: true,
      }),
    ).toEqual({ text: "Hello", visible: false });
  });

  it("hides copy for empty responses", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "   ",
        showCopyButton: true,
        streaming: false,
      }),
    ).toEqual({ text: null, visible: false });
  });
});

describe("resolveAssistantMessageDisplayText", () => {
  it("suppresses the empty placeholder when the turn visibly completed an image", () => {
    expect(
      resolveAssistantMessageDisplayText({
        message: { text: "", streaming: false },
        collapsedTurnItems: [
          {
            kind: "work",
            id: "generated-image",
            entry: {
              id: "generated-image",
              createdAt: "2026-07-08T10:00:00.000Z",
              label: "Generated image",
              tone: "tool",
              itemType: "image_generation",
              activityKind: "tool.completed",
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it("keeps the placeholder when a settled turn produced no visible content", () => {
    expect(
      resolveAssistantMessageDisplayText({
        message: { text: "", streaming: false },
      }),
    ).toBe("(empty response)");
  });

  it("does not mistake an unfinished or failed image tool row for produced content", () => {
    const imageEntry = {
      id: "generated-image",
      createdAt: "2026-07-08T10:00:00.000Z",
      label: "Generating image",
      tone: "tool" as const,
      itemType: "image_generation" as const,
      activityKind: "tool.started",
    };
    expect(
      resolveAssistantMessageDisplayText({
        message: { text: "", streaming: false },
        leadingWorkEntries: [imageEntry],
      }),
    ).toBe("(empty response)");
    expect(
      resolveAssistantMessageDisplayText({
        message: { text: "", streaming: false },
        leadingWorkEntries: [
          { ...imageEntry, activityKind: "tool.completed", tone: "error" as const },
        ],
      }),
    ).toBe("(empty response)");
  });

  it("preserves real assistant text even when the same turn generated an image", () => {
    expect(
      resolveAssistantMessageDisplayText({
        message: { text: "Here is your image.", streaming: false },
        inlineWorkEntries: [
          {
            id: "generated-image",
            createdAt: "2026-07-08T10:00:00.000Z",
            label: "Generated image",
            tone: "tool",
            itemType: "image_generation",
            activityKind: "tool.completed",
          },
        ],
      }),
    ).toBe("Here is your image.");
  });
});

describe("deriveMessagesTimelineRows", () => {
  type MessageTimelineRow = Extract<MessagesTimelineRow, { kind: "message" }>;

  const baseInput = {
    isWorking: false,
    worktreeSetup: null as WorktreeSetupSnapshot | null,
    worktreeSetupOpen: false,
    activeTurnStartedAt: null as string | null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  };

  const userEntry = (id: string, createdAt: string): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.makeUnsafe(id),
      role: "user",
      text: "ask",
      createdAt,
      streaming: false,
    },
  });

  const assistantEntry = (
    id: string,
    createdAt: string,
    opts: { turnId?: string; text?: string; streaming?: boolean; completedAt?: string },
  ): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text: opts.text ?? "reply",
      createdAt,
      streaming: opts.streaming ?? false,
      ...(opts.turnId ? { turnId: TurnId.makeUnsafe(opts.turnId) } : {}),
      ...(opts.completedAt ? { completedAt: opts.completedAt } : {}),
    },
  });

  const workEntry = (
    id: string,
    createdAt: string,
    label: string,
    tone: "thinking" | "tool" | "info" | "error" = "tool",
  ): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "work",
    createdAt,
    entry: { id, createdAt, label, tone },
  });

  const proposedPlanEntry = (id: string, createdAt: string, turnId: string): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "proposed-plan",
    createdAt,
    proposedPlan: {
      id: OrchestrationProposedPlanId.makeUnsafe(id),
      turnId: TurnId.makeUnsafe(turnId),
      planMarkdown: "# Plan",
      implementedAt: null,
      implementationThreadId: null,
      createdAt,
      updatedAt: createdAt,
    },
  });

  const messageRow = (rows: MessagesTimelineRow[], id: string): MessageTimelineRow | undefined =>
    rows.find(
      (row): row is MessageTimelineRow =>
        row.kind === "message" && row.message.id === MessageId.makeUnsafe(id),
    );

  const collapsedSignature = (row: MessageTimelineRow): string[] =>
    (row.collapsedTurnItems ?? []).map((item) => `${item.kind}:${String(item.id)}`);

  it("folds a settled turn's narration and work into one collapsed group on the terminal message", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        assistantEntry("a1", "2026-01-01T00:00:01Z", {
          turnId: "t1",
          text: "Looking into it",
          completedAt: "2026-01-01T00:00:01Z",
        }),
        workEntry("w1", "2026-01-01T00:00:02Z", "tool 1"),
        assistantEntry("a2", "2026-01-01T00:00:03Z", {
          turnId: "t1",
          text: "Almost there",
          completedAt: "2026-01-01T00:00:03Z",
        }),
        workEntry("w2", "2026-01-01T00:00:04Z", "tool 2"),
        assistantEntry("a3", "2026-01-01T00:00:05Z", {
          turnId: "t1",
          text: "All done",
          completedAt: "2026-01-01T00:00:06Z",
        }),
      ],
    });

    const visibleMessageIds = rows
      .filter((row): row is MessageTimelineRow => row.kind === "message")
      .map((row) => String(row.message.id));
    expect(visibleMessageIds).toEqual(["u1", "a3"]);

    const terminal = messageRow(rows, "a3");
    expect(terminal).toBeDefined();
    expect(collapsedSignature(terminal!)).toEqual([
      "narration:a1",
      "work:w1",
      "narration:a2",
      "work:w2",
    ]);
    expect(terminal!.inlineWorkEntries).toBeUndefined();
    // Timed from the user message, not from the last intermediate narration.
    expect(terminal!.collapsedWorkElapsed).toBe("6.0s");
    expect(rows.some((row) => row.kind === "work")).toBe(false);
  });

  it("folds settled reasoning traces into the terminal turn disclosure", () => {
    const reasoning = workEntry("reasoning-1", "2026-01-01T00:00:02Z", "Reasoning trace");
    if (reasoning.kind === "work") {
      reasoning.entry = {
        ...reasoning.entry,
        detail: "Inspecting apps/web/src/store.ts",
        toolTitle: "Reasoning trace",
      };
    }

    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        reasoning,
        assistantEntry("a1", "2026-01-01T00:00:03Z", {
          turnId: "t1",
          text: "All done",
          completedAt: "2026-01-01T00:00:04Z",
        }),
      ],
    });

    const terminal = messageRow(rows, "a1");
    expect(collapsedSignature(terminal!)).toEqual(["work:reasoning-1"]);
    expect(rows.some((row) => row.kind === "work")).toBe(false);
  });

  it("times the collapsed disclosure from the turn start, not the last intermediate assistant message", () => {
    // Mirrors a provider failure + retry: the first attempt's assistant message
    // completes 22m20s in, the retry answers 40s later. The disclosure folds
    // the whole run, so the timer must cover it too — not just the retry tail.
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        workEntry("w1", "2026-01-01T00:00:05Z", "long tool work"),
        assistantEntry("a1", "2026-01-01T00:22:20Z", {
          turnId: "t1",
          text: "The provider run failed",
          completedAt: "2026-01-01T00:22:20Z",
        }),
        workEntry("w2", "2026-01-01T00:22:30Z", "retry work"),
        assistantEntry("a2", "2026-01-01T00:23:00Z", {
          turnId: "t2",
          text: "All done",
          completedAt: "2026-01-01T00:23:00Z",
        }),
      ],
    });

    const terminal = messageRow(rows, "a2");
    expect(terminal).toBeDefined();
    expect(collapsedSignature(terminal!)).toEqual(["work:w1", "narration:a1", "work:w2"]);
    expect(terminal!.collapsedWorkElapsed).toBe("23m");
  });

  it("keeps the live turn expanded instead of collapsing while it streams", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      isWorking: true,
      activeTurnInProgress: true,
      activeTurnId: TurnId.makeUnsafe("t1"),
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        assistantEntry("a1", "2026-01-01T00:00:01Z", {
          turnId: "t1",
          text: "Looking into it",
          completedAt: "2026-01-01T00:00:01Z",
        }),
        workEntry("w1", "2026-01-01T00:00:02Z", "tool 1"),
        assistantEntry("a3", "2026-01-01T00:00:05Z", {
          turnId: "t1",
          text: "still going",
          streaming: true,
        }),
      ],
    });

    expect(messageRow(rows, "a1")).toBeDefined();
    const terminal = messageRow(rows, "a3");
    expect(terminal).toBeDefined();
    expect(terminal!.collapsedTurnItems).toBeUndefined();
  });

  it("keeps pre-existing tool work above the new live narration text", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      isWorking: true,
      activeTurnInProgress: true,
      activeTurnId: TurnId.makeUnsafe("t1"),
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        assistantEntry("a1", "2026-01-01T00:00:01Z", {
          turnId: "t1",
          text: "I will inspect it.",
          completedAt: "2026-01-01T00:00:01Z",
        }),
        workEntry("w1", "2026-01-01T00:00:02Z", "read files"),
        assistantEntry("a2", "2026-01-01T00:00:03Z", {
          turnId: "t1",
          text: "Here is what I found so far.",
          streaming: true,
        }),
        workEntry("w2", "2026-01-01T00:00:04Z", "search files"),
      ],
    });

    const streamingNarration = messageRow(rows, "a2");

    expect(streamingNarration?.leadingWorkEntries?.map((entry) => entry.id)).toEqual(["w1"]);
    expect(streamingNarration?.leadingWorkGroupId).toBe("entry-w1");
    expect(streamingNarration?.inlineWorkEntries?.map((entry) => entry.id)).toEqual(["w2"]);
    expect(streamingNarration?.inlineWorkGroupId).toBe("entry-w2");
  });

  it("keeps a just-settled tail assistant expanded when the active turn id is briefly unavailable", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      isWorking: true,
      activeTurnInProgress: true,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        workEntry("w1", "2026-01-01T00:00:01Z", "tool 1"),
        assistantEntry("a1", "2026-01-01T00:00:02Z", {
          turnId: "t1",
          text: "All done",
          completedAt: "2026-01-01T00:00:03Z",
        }),
      ],
    });

    const terminal = messageRow(rows, "a1");
    expect(terminal).toBeDefined();
    expect(terminal!.leadingWorkEntries?.map((entry) => entry.id)).toEqual(["w1"]);
    expect(terminal!.inlineWorkEntries).toBeUndefined();
    expect(terminal!.collapsedTurnItems).toBeUndefined();
    expect(rows.some((row) => row.kind === "work")).toBe(false);
  });

  it("collapses an older settled turn when a follow-up user message is waiting for output", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      isWorking: true,
      activeTurnInProgress: true,
      activeTurnStartedAt: "2026-01-01T00:00:05Z",
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        workEntry("w1", "2026-01-01T00:00:01Z", "tool 1"),
        assistantEntry("a1", "2026-01-01T00:00:02Z", {
          turnId: "t1",
          text: "All done",
          completedAt: "2026-01-01T00:00:03Z",
        }),
        userEntry("u2", "2026-01-01T00:00:05Z"),
      ],
    });

    const previousAssistant = messageRow(rows, "a1");
    expect(previousAssistant).toBeDefined();
    expect(collapsedSignature(previousAssistant!)).toEqual(["work:w1"]);
    expect(previousAssistant!.inlineWorkEntries).toBeUndefined();
    expect(messageRow(rows, "u2")).toBeDefined();
    expect(rows.some((row) => row.kind === "work")).toBe(false);
  });

  it("collapses adjacent provider mini-turns into the same user-visible response", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        assistantEntry("a1", "2026-01-01T00:00:01Z", {
          turnId: "t1",
          text: "first preamble",
          completedAt: "2026-01-01T00:00:01Z",
        }),
        workEntry("w1", "2026-01-01T00:00:02Z", "tool 1"),
        assistantEntry("a2", "2026-01-01T00:00:03Z", {
          turnId: "t1",
          text: "first final",
          completedAt: "2026-01-01T00:00:03Z",
        }),
        assistantEntry("a3", "2026-01-01T00:00:04Z", {
          turnId: "t2",
          text: "second preamble",
          completedAt: "2026-01-01T00:00:04Z",
        }),
        workEntry("w2", "2026-01-01T00:00:05Z", "tool 2"),
        assistantEntry("a4", "2026-01-01T00:00:06Z", {
          turnId: "t2",
          text: "second final",
          completedAt: "2026-01-01T00:00:06Z",
        }),
      ],
    });

    const visibleMessageIds = rows
      .filter((row): row is MessageTimelineRow => row.kind === "message")
      .map((row) => String(row.message.id));
    expect(visibleMessageIds).toEqual(["u1", "a4"]);

    expect(collapsedSignature(messageRow(rows, "a4")!)).toEqual([
      "narration:a1",
      "work:w1",
      "narration:a2",
      "narration:a3",
      "work:w2",
    ]);
  });

  it("collapses turn work across an intervening proposed plan card", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        assistantEntry("a1", "2026-01-01T00:00:01Z", {
          turnId: "t1",
          text: "I have a plan",
          completedAt: "2026-01-01T00:00:01Z",
        }),
        workEntry("w1", "2026-01-01T00:00:02Z", "tool 1"),
        proposedPlanEntry("plan-1", "2026-01-01T00:00:03Z", "t1"),
        assistantEntry("a2", "2026-01-01T00:00:04Z", {
          turnId: "t1",
          text: "final",
          completedAt: "2026-01-01T00:00:05Z",
        }),
      ],
    });

    expect(rows.some((row) => row.kind === "proposed-plan")).toBe(true);
    expect(collapsedSignature(messageRow(rows, "a2")!)).toEqual(["narration:a1", "work:w1"]);
  });

  it("preserves Synara tool calls when a separate creation recap is present", () => {
    const createTool = workEntry(
      "synara-create-tool",
      "2026-01-01T00:00:01Z",
      "Synara created threads",
    );
    const creationRecap: TimelineEntry = {
      id: "entry-synara-create-recap",
      kind: "work",
      createdAt: "2026-01-01T00:00:02Z",
      entry: {
        id: "synara-create-recap",
        createdAt: "2026-01-01T00:00:02Z",
        label: "Created 2 Synara threads",
        tone: "info",
        synaraThreadCreation: {
          operationId: "gateway:create:two",
          requestedCount: 2,
          createdCount: 2,
          threads: [
            {
              threadId: "thread-1",
              title: "First",
              provider: "codex",
              model: "gpt-5.6-terra",
              environment: "local",
              status: "task_dispatched",
            },
            {
              threadId: "thread-2",
              title: "Second",
              provider: "claudeAgent",
              model: "claude-sonnet-5",
              environment: "local",
              status: "task_dispatched",
            },
          ],
        },
      },
    };
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        createTool,
        creationRecap,
        assistantEntry("a1", "2026-01-01T00:00:03Z", {
          turnId: "t1",
          text: "final",
          completedAt: "2026-01-01T00:00:04Z",
        }),
      ],
    });

    expect(collapsedSignature(messageRow(rows, "a1")!)).toEqual([
      "work:synara-create-tool",
      "work:synara-create-recap",
    ]);
  });

  const worktreeSetupSnapshot = (): WorktreeSetupSnapshot => ({
    steps: [
      { id: "create-worktree", label: "Creating branch and worktree", status: "done" },
      { id: "prepare-thread", label: "Linking thread workspace", status: "active" },
      { id: "start-session", label: "Starting session", status: "pending" },
    ],
  });

  it("appends an open worktree-setup row and suppresses the generic working shimmer", () => {
    const setup = worktreeSetupSnapshot();
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      isWorking: true,
      worktreeSetup: setup,
      worktreeSetupOpen: true,
      timelineEntries: [userEntry("u1", "2026-01-01T00:00:00Z")],
    });

    const setupRow = rows.at(-1);
    expect(setupRow).toMatchObject({
      kind: "worktree-setup",
      id: "worktree-setup-row",
      open: true,
      steps: setup.steps,
    });
    expect(rows.some((row) => row.kind === "working")).toBe(false);
  });

  it("restores the working shimmer while the worktree-setup row animates closed", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      isWorking: true,
      worktreeSetup: worktreeSetupSnapshot(),
      worktreeSetupOpen: false,
      timelineEntries: [userEntry("u1", "2026-01-01T00:00:00Z")],
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "worktree-setup", "working"]);
    expect(rows.find((row) => row.kind === "worktree-setup")).toMatchObject({ open: false });
  });

  it("omits the worktree-setup row entirely once the snapshot is gone", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      isWorking: true,
      timelineEntries: [userEntry("u1", "2026-01-01T00:00:00Z")],
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "working"]);
  });
});

const toolItem = (
  id: string,
  overrides: Partial<WorkLogEntry> = {},
): Extract<CollapsedTurnItem, { kind: "work" }> => ({
  kind: "work",
  id,
  entry: {
    id,
    createdAt: "2026-01-01T00:00:00Z",
    label: `tool ${id}`,
    tone: "tool",
    ...overrides,
  },
});

const narrationItem = (id: string): CollapsedTurnItem => ({
  kind: "narration",
  id,
  message: {
    id: MessageId.makeUnsafe(id),
    role: "assistant",
    text: "narration",
    createdAt: "2026-01-01T00:00:00Z",
    streaming: false,
  },
});

const chunkSignature = (items: ReadonlyArray<CollapsedTurnItem>): string[] =>
  chunkCollapsedTurnItems(items).map((chunk) =>
    chunk.kind === "tool-group"
      ? `group:${chunk.id}:${chunk.entries.map((entry) => entry.id).join("+")}`
      : `item:${chunk.item.kind}:${String(chunk.item.id)}`,
  );

describe("chunkCollapsedTurnItems", () => {
  it("folds consecutive tool runs and lets narration split them", () => {
    expect(
      chunkSignature([
        toolItem("w1"),
        toolItem("w2"),
        narrationItem("a1"),
        toolItem("w3"),
        toolItem("w4"),
        toolItem("w5"),
      ]),
    ).toEqual(["group:w1:w1+w2", "item:narration:a1", "group:w3:w3+w4+w5"]);
  });

  it("keeps singleton runs as individual items", () => {
    expect(chunkSignature([toolItem("w1"), narrationItem("a1"), toolItem("w2")])).toEqual([
      "item:work:w1",
      "item:narration:a1",
      "item:work:w2",
    ]);
  });

  it("lets non-summarizable work rows split runs and render individually", () => {
    expect(
      chunkSignature([
        toolItem("w1"),
        toolItem("w2"),
        toolItem("err", { tone: "error" }),
        toolItem("w3"),
        toolItem("w4"),
      ]),
    ).toEqual(["group:w1:w1+w2", "item:work:err", "group:w3:w3+w4"]);
  });
});

describe("chunkWorkEntries", () => {
  it("preserves rich rows between independently collapsible tool runs", () => {
    const entries = [
      toolItem("w1").entry,
      toolItem("w2").entry,
      toolItem("err", { tone: "error" }).entry,
      toolItem("w3").entry,
      toolItem("w4").entry,
    ];

    expect(
      chunkWorkEntries(entries).map((chunk) =>
        chunk.kind === "tool-group"
          ? `group:${chunk.entries.map((entry) => entry.id).join("+")}`
          : `item:${chunk.entry.id}`,
      ),
    ).toEqual(["group:w1+w2", "item:err", "group:w3+w4"]);
  });
});

const planSignature = (
  entries: ReadonlyArray<WorkLogEntry>,
  options: { tailIsLive: boolean },
): string[] =>
  planWorkEntryRenderChunks(entries, options).map((chunk) => {
    const ids = chunk.entries.map((entry) => entry.id).join("+");
    return chunk.summary === null ? `open:${ids}` : `collapsed:${ids}`;
  });

describe("planWorkEntryRenderChunks", () => {
  it("collapses the earlier run across a thinking boundary while the live tail stays open", () => {
    expect(
      planSignature(
        [
          toolItem("w1").entry,
          toolItem("w2").entry,
          toolItem("think", { tone: "thinking" }).entry,
          toolItem("w3").entry,
          toolItem("w4").entry,
        ],
        { tailIsLive: true },
      ),
    ).toEqual(["collapsed:w1+w2", "open:think", "open:w3+w4"]);
  });

  it("collapses every run when narration is the trailing block", () => {
    expect(
      planSignature(
        [toolItem("w1").entry, toolItem("w2").entry, toolItem("think", { tone: "thinking" }).entry],
        { tailIsLive: true },
      ),
    ).toEqual(["collapsed:w1+w2", "open:think"]);
  });

  it("collapses the trailing run once the tail is no longer live", () => {
    expect(
      planSignature([toolItem("w1").entry, toolItem("w2").entry], { tailIsLive: false }),
    ).toEqual(["collapsed:w1+w2"]);
  });

  it("never collapses a run that still has running work", () => {
    expect(
      planSignature(
        [
          toolItem("w1", { toolStatus: "running" }).entry,
          toolItem("w2").entry,
          toolItem("think", { tone: "thinking" }).entry,
          toolItem("w3").entry,
          toolItem("w4").entry,
        ],
        { tailIsLive: false },
      ),
    ).toEqual(["open:w1+w2", "open:think", "collapsed:w3+w4"]);
  });

  it("keeps singleton runs open: nothing to summarize", () => {
    expect(
      planSignature(
        [toolItem("w1").entry, toolItem("think", { tone: "thinking" }).entry, toolItem("w2").entry],
        { tailIsLive: false },
      ),
    ).toEqual(["open:w1", "open:think", "open:w2"]);
  });
});

describe("capOpenWorkEntryRenderChunks", () => {
  it("preserves collapsed summaries while limiting later open entries", () => {
    const chunks = planWorkEntryRenderChunks(
      [
        toolItem("w1").entry,
        toolItem("w2").entry,
        toolItem("think", { tone: "thinking" }).entry,
        toolItem("w3").entry,
        toolItem("w4").entry,
        toolItem("w5").entry,
        toolItem("w6").entry,
        toolItem("w7").entry,
      ],
      { tailIsLive: true },
    );

    const result = capOpenWorkEntryRenderChunks(chunks, {
      expanded: false,
      maxVisibleEntries: 3,
      keep: "last",
    });

    expect(
      result.chunks.map((chunk) => ({
        ids: chunk.entries.map((entry) => entry.id),
        collapsed: chunk.summary !== null,
      })),
    ).toEqual([
      { ids: ["w1", "w2"], collapsed: true },
      { ids: [], collapsed: false },
      { ids: ["w5", "w6", "w7"], collapsed: false },
    ]);
    expect(result.hasOverflow).toBe(true);
    expect(result.hiddenEntryCount).toBe(3);
  });

  it("does not count separately rendered status boundaries against the tool cap", () => {
    const chunks = planWorkEntryRenderChunks(
      [
        toolItem("w1").entry,
        toolItem("w2").entry,
        toolItem("think", { tone: "thinking" }).entry,
        toolItem("w3").entry,
        toolItem("w4").entry,
        toolItem("w5").entry,
      ],
      { tailIsLive: true },
    );

    const result = capOpenWorkEntryRenderChunks(chunks, {
      expanded: false,
      maxVisibleEntries: 2,
      keep: "first",
      shouldCapEntry: (entry) => entry.tone === "tool",
    });

    expect(result.chunks.map((chunk) => chunk.entries.map((entry) => entry.id))).toEqual([
      ["w1", "w2"],
      ["think"],
      ["w3", "w4"],
    ]);
    expect(result.hiddenEntryCount).toBe(1);
  });

  it("restores every open entry when expanded while retaining overflow state", () => {
    const chunks = planWorkEntryRenderChunks(
      [toolItem("w1").entry, toolItem("w2").entry, toolItem("w3").entry],
      { tailIsLive: true },
    );

    const result = capOpenWorkEntryRenderChunks(chunks, {
      expanded: true,
      maxVisibleEntries: 2,
      keep: "last",
    });

    expect(result.chunks.flatMap((chunk) => chunk.entries.map((entry) => entry.id))).toEqual([
      "w1",
      "w2",
      "w3",
    ]);
    expect(result.hasOverflow).toBe(true);
    expect(result.hiddenEntryCount).toBe(0);
  });
});

const workRow = (id: string): MessagesTimelineRow => ({
  kind: "work",
  id,
  createdAt: "2026-01-01T00:00:00Z",
  groupedEntries: [{ id, createdAt: "2026-01-01T00:00:00Z", label: "tool", tone: "tool" }],
});

const messageRowOf = (
  id: string,
  role: "user" | "assistant",
  groups: { leadingWorkGroupId?: string; inlineWorkGroupId?: string } = {},
): MessagesTimelineRow => ({
  kind: "message",
  id: `row-${id}`,
  createdAt: "2026-01-01T00:00:00Z",
  message: {
    id: MessageId.makeUnsafe(id),
    role,
    text: "text",
    createdAt: "2026-01-01T00:00:00Z",
    streaming: false,
  },
  durationStart: "2026-01-01T00:00:00Z",
  showAssistantCopyButton: false,
  assistantCopyStreaming: false,
  ...groups,
});

const workingRow: MessagesTimelineRow = {
  kind: "working",
  id: "working-indicator-row",
  createdAt: null,
};

describe("findLastLiveWorkGroupId", () => {
  it("returns the trailing standalone work row", () => {
    expect(
      findLastLiveWorkGroupId([
        messageRowOf("u1", "user"),
        messageRowOf("a1", "assistant", { inlineWorkGroupId: "g1" }),
        workRow("g2"),
        workingRow,
      ]),
    ).toBe("g2");
  });

  it("prefers a message's inline group over its leading group", () => {
    expect(
      findLastLiveWorkGroupId([
        messageRowOf("u1", "user"),
        messageRowOf("a1", "assistant", { leadingWorkGroupId: "g1", inlineWorkGroupId: "g2" }),
      ]),
    ).toBe("g2");
  });

  it("falls back to the leading group when no inline group exists", () => {
    expect(
      findLastLiveWorkGroupId([
        messageRowOf("u1", "user"),
        messageRowOf("a1", "assistant", { leadingWorkGroupId: "g1" }),
      ]),
    ).toBe("g1");
  });

  it("stops at a trailing user message: the next turn has no live group yet", () => {
    expect(
      findLastLiveWorkGroupId([
        messageRowOf("a1", "assistant", { inlineWorkGroupId: "g1" }),
        messageRowOf("u2", "user"),
        workingRow,
      ]),
    ).toBeNull();
  });

  it("returns null when the transcript has no work groups", () => {
    expect(findLastLiveWorkGroupId([messageRowOf("u1", "user")])).toBeNull();
  });
});
