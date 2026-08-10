// FILE: ComposerSubagentStrip.logic.test.ts
// Purpose: Locks composer subagent strip row derivation to live-turn scoping,
// snapshot merging, and retire-once-finished behavior.
// Layer: Web chat composer tests
// Depends on: deriveComposerSubagentStripItems

import { DEFAULT_PROVIDER_PROFILE_ID, EventId, ThreadId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveWorkLogEntries,
  omitRoutedSubagentWorkEntries,
  type WorkLogEntry,
  type WorkLogSubagent,
} from "../../session-logic";
import type { Thread } from "../../types";
import { enrichSubagentWorkEntries } from "../ChatView.logic";
import { localSubagentThreadId } from "../ChatView.selectors";
import {
  collectForegroundRunningSubagentStripItems,
  collectRunningSubagentStripItems,
  deriveComposerSubagentStripItems,
  type ComposerSubagentStripItem,
  type ComposerSubagentStripRow,
} from "./ComposerSubagentStrip.logic";

function workEntry(
  overrides: Partial<Omit<WorkLogEntry, "turnId">> & { id: string; turnId?: string | null },
): WorkLogEntry {
  const { turnId, ...rest } = overrides;
  return {
    createdAt: "2026-07-14T00:00:00.000Z",
    label: "Ran subagents",
    tone: "tool",
    turnId: turnId ? TurnId.makeUnsafe(turnId) : null,
    ...rest,
  };
}

function subagent(overrides: Partial<WorkLogSubagent> & { threadId: string }): WorkLogSubagent {
  return overrides;
}

function subagentRows(rows: ComposerSubagentStripRow[]): ComposerSubagentStripItem[] {
  return rows.filter((row): row is ComposerSubagentStripItem => row.kind === "subagent");
}

describe("deriveComposerSubagentStripItems", () => {
  it("returns no rows when the work log has no subagents", () => {
    expect(
      deriveComposerSubagentStripItems({
        workEntries: [workEntry({ id: "entry-1", turnId: "turn-1" })],
        liveTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toEqual([]);
  });

  it("keeps prior running background rows alongside subagents from the live turn", () => {
    const items = deriveComposerSubagentStripItems({
      workEntries: [
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          subagents: [subagent({ threadId: "old-agent", nickname: "Ada", rawStatus: "running" })],
        }),
        workEntry({
          id: "entry-2",
          turnId: "turn-2",
          subagents: [
            subagent({
              threadId: "sub-1",
              nickname: "Blue",
              role: "reviewer",
              rawStatus: "running",
              isActive: true,
            }),
          ],
        }),
      ],
      liveTurnId: TurnId.makeUnsafe("turn-2"),
    });

    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "old-agent",
          primaryLabel: "Ada",
          statusKind: "running",
        }),
        expect.objectContaining({
          threadId: "sub-1",
          primaryLabel: "Blue",
          role: "reviewer",
          fullLabel: "Blue [reviewer]",
          statusKind: "running",
          isActive: true,
        }),
      ]),
    );
  });

  it("merges snapshots of one subagent, keeping identity while the latest status wins", () => {
    const items = subagentRows(
      deriveComposerSubagentStripItems({
        workEntries: [
          workEntry({
            id: "entry-1",
            turnId: "turn-1",
            subagents: [
              subagent({
                threadId: "sub-1",
                agentId: "agent-1",
                nickname: "Ada",
                role: "builder",
                model: "opus-4.5",
                rawStatus: "running",
                isActive: true,
              }),
            ],
          }),
          workEntry({
            id: "entry-2",
            turnId: "turn-1",
            subagents: [
              subagent({
                threadId: "sub-1",
                agentId: "agent-1",
                resolvedThreadId: "subagent:parent:sub-1",
                rawStatus: "completed",
              }),
            ],
          }),
        ],
        liveTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      threadId: "subagent:parent:sub-1",
      primaryLabel: "Ada",
      role: "builder",
      statusLabel: "Completed",
      statusKind: "completed",
      isActive: false,
    });
    expect(items[0]?.modelLabel).toBeDefined();
  });

  it("keeps the latest prior set visible only while a subagent still works", () => {
    const entries = (status: string) => [
      workEntry({
        id: "entry-1",
        turnId: "turn-1",
        subagents: [
          subagent({ threadId: "sub-1", nickname: "Ada", rawStatus: status }),
          subagent({ threadId: "sub-2", nickname: "Blue", rawStatus: "completed" }),
        ],
      }),
    ];

    const stillRunning = subagentRows(
      deriveComposerSubagentStripItems({
        workEntries: entries("running"),
        liveTurnId: null,
      }),
    );
    expect(stillRunning.map((item) => item.primaryLabel)).toEqual(["Ada", "Blue"]);

    expect(
      deriveComposerSubagentStripItems({
        workEntries: entries("completed"),
        liveTurnId: null,
      }),
    ).toEqual([]);
  });

  it("appends the worker-tier effort to the model label", () => {
    const items = subagentRows(
      deriveComposerSubagentStripItems({
        workEntries: [
          workEntry({
            id: "entry-1",
            turnId: "turn-1",
            subagents: [
              subagent({
                threadId: "sub-1",
                nickname: "Ada",
                model: "sonnet",
                effort: "high",
                rawStatus: "running",
                isActive: true,
              }),
              subagent({
                threadId: "sub-2",
                nickname: "Blue",
                effort: "low",
                rawStatus: "running",
                isActive: true,
              }),
            ],
          }),
        ],
        liveTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    );

    expect(items[0]?.modelLabel).toBe("Sonnet · high");
    // No model hint: the effort still reads on its own.
    expect(items[1]?.modelLabel).toBe("low");
  });

  it("marks rows background from spawn hints and confirmed backgrounded tool use ids", () => {
    const items = subagentRows(
      deriveComposerSubagentStripItems({
        workEntries: [
          workEntry({
            id: "entry-1",
            turnId: "turn-1",
            subagents: [
              subagent({
                threadId: "sub-fg",
                providerThreadId: "sub-fg",
                nickname: "Ada",
                rawStatus: "running",
                isActive: true,
              }),
              subagent({
                threadId: "sub-bg-spawn",
                providerThreadId: "sub-bg-spawn",
                nickname: "Blue",
                background: true,
                rawStatus: "running",
                isActive: true,
              }),
              subagent({
                threadId: "sub-bg-patch",
                providerThreadId: "sub-bg-patch",
                nickname: "Cleo",
                rawStatus: "running",
                isActive: true,
              }),
            ],
          }),
        ],
        liveTurnId: TurnId.makeUnsafe("turn-1"),
        backgroundedProviderThreadIds: new Set(["sub-bg-patch"]),
      }),
    );

    expect(items.map((item) => [item.providerThreadId, item.isBackground])).toEqual([
      ["sub-fg", false],
      ["sub-bg-spawn", true],
      ["sub-bg-patch", true],
    ]);
  });

  it("matches confirmed backgrounded patches by tool_use_id when it differs from the row key", () => {
    const items = subagentRows(
      deriveComposerSubagentStripItems({
        workEntries: [
          workEntry({
            id: "entry-1",
            turnId: "turn-1",
            subagents: [
              subagent({
                threadId: "agent-1",
                providerThreadId: "toolu_1",
                nickname: "Ada",
                rawStatus: "running",
                isActive: true,
              }),
            ],
          }),
        ],
        liveTurnId: TurnId.makeUnsafe("turn-1"),
        backgroundedProviderThreadIds: new Set(["toolu_1"]),
      }),
    );

    expect(items[0]).toMatchObject({ providerThreadId: "toolu_1", isBackground: true });
  });

  it("falls back to prior subagents when the live turn spawned none", () => {
    const items = subagentRows(
      deriveComposerSubagentStripItems({
        workEntries: [
          workEntry({
            id: "entry-1",
            turnId: "turn-1",
            subagents: [
              subagent({
                threadId: "sub-1",
                nickname: "Ada",
                rawStatus: "running",
                isActive: true,
              }),
            ],
          }),
        ],
        liveTurnId: TurnId.makeUnsafe("turn-2"),
      }),
    );

    expect(items.map((item) => item.primaryLabel)).toEqual(["Ada"]);
  });

  it("marks the viewed subagent row and leaves siblings unmarked", () => {
    const items = subagentRows(
      deriveComposerSubagentStripItems({
        workEntries: [
          workEntry({
            id: "entry-1",
            turnId: "turn-1",
            subagents: [
              subagent({
                threadId: "sub-1",
                nickname: "Ada",
                rawStatus: "running",
                isActive: true,
              }),
              subagent({
                threadId: "sub-2",
                nickname: "Blue",
                rawStatus: "running",
                isActive: true,
              }),
            ],
          }),
        ],
        liveTurnId: TurnId.makeUnsafe("turn-1"),
        viewedThreadId: ThreadId.makeUnsafe("sub-2"),
      }),
    );

    expect(items.map((item) => [item.primaryLabel, item.isViewed])).toEqual([
      ["Ada", false],
      ["Blue", true],
    ]);
  });

  it("prepends a parent row while a subagent thread is open, absent on the main thread", () => {
    const workEntries = [
      workEntry({
        id: "entry-1",
        turnId: "turn-1",
        subagents: [
          subagent({ threadId: "sub-1", nickname: "Ada", rawStatus: "running", isActive: true }),
        ],
      }),
    ];

    const fromSubagentView = deriveComposerSubagentStripItems({
      workEntries,
      liveTurnId: TurnId.makeUnsafe("turn-1"),
      viewedThreadId: ThreadId.makeUnsafe("sub-1"),
      parentRow: { threadId: ThreadId.makeUnsafe("thread-main"), label: "Fix the bug" },
    });
    expect(fromSubagentView[0]).toEqual({
      kind: "parent",
      key: "parent:thread-main",
      threadId: "thread-main",
      label: "Fix the bug",
    });
    expect(subagentRows(fromSubagentView)).toHaveLength(1);

    // Untitled parent threads fall back to a generic label.
    const untitled = deriveComposerSubagentStripItems({
      workEntries,
      liveTurnId: TurnId.makeUnsafe("turn-1"),
      parentRow: { threadId: ThreadId.makeUnsafe("thread-main"), label: null },
    });
    expect(untitled[0]).toMatchObject({ kind: "parent", label: "Main thread" });

    // Main thread view passes no parentRow, so no parent row appears.
    const fromMainView = deriveComposerSubagentStripItems({
      workEntries,
      liveTurnId: TurnId.makeUnsafe("turn-1"),
    });
    expect(fromMainView.every((row) => row.kind === "subagent")).toBe(true);
  });

  it("keeps parent-derived rows while the viewed subagent still runs, then retires fully", () => {
    const entries = (viewedStatus: string) => [
      workEntry({
        id: "entry-1",
        turnId: "turn-1",
        subagents: [
          subagent({ threadId: "sub-1", nickname: "Ada", rawStatus: "completed" }),
          subagent({ threadId: "sub-2", nickname: "Blue", rawStatus: viewedStatus }),
        ],
      }),
    ];
    const parentRow = { threadId: ThreadId.makeUnsafe("thread-main"), label: "Fix the bug" };

    // Parent turn settled but the viewed subagent still works: rows stay visible.
    const stillRunning = deriveComposerSubagentStripItems({
      workEntries: entries("running"),
      liveTurnId: null,
      viewedThreadId: ThreadId.makeUnsafe("sub-2"),
      parentRow,
    });
    expect(stillRunning.map((row) => row.kind)).toEqual(["parent", "subagent", "subagent"]);

    // Everything finished and the parent turn settled: the strip retires whole,
    // parent row included.
    expect(
      deriveComposerSubagentStripItems({
        workEntries: entries("completed"),
        liveTurnId: null,
        viewedThreadId: ThreadId.makeUnsafe("sub-2"),
        parentRow,
      }),
    ).toEqual([]);
  });

  describe("settled subagent status", () => {
    const parentThreadId = ThreadId.makeUnsafe("thread-main");

    // A finished subagent's thread parks in an idle session state; the row must
    // surface the work log's terminal status instead of "Idle".
    function settledSubagentThread(providerThreadId: string): Thread {
      return {
        id: localSubagentThreadId(parentThreadId, providerThreadId),
        codexThreadId: null,
        projectId: "project-1" as Thread["projectId"],
        title: "Subagent task",
        modelSelection: { provider: "claudeAgent", profileId: DEFAULT_PROVIDER_PROFILE_ID, model: "sonnet" },
        runtimeMode: "full-access",
        interactionMode: "default",
        session: {
          provider: "claudeAgent",
          status: "ready",
          createdAt: "2026-07-14T00:00:01.000Z",
          updatedAt: "2026-07-14T00:00:02.000Z",
          orchestrationStatus: "idle",
        },
        messages: [],
        proposedPlans: [],
        error: null,
        createdAt: "2026-07-14T00:00:01.000Z",
        latestTurn: null,
        parentThreadId,
        turnDiffSummaries: [],
        activities: [],
        branch: null,
        worktreePath: null,
      };
    }

    function enrichedItems(entry: WorkLogEntry): ComposerSubagentStripItem[] {
      const enriched = enrichSubagentWorkEntries(
        [entry],
        [settledSubagentThread("toolu_x")],
        parentThreadId,
      );
      return subagentRows(
        deriveComposerSubagentStripItems({
          workEntries: enriched,
          liveTurnId: TurnId.makeUnsafe("turn-1"),
        }),
      );
    }

    it("prefers a terminal rawStatus over the idle child-thread session state", () => {
      const items = enrichedItems(
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          itemType: "collab_agent_tool_call",
          subagents: [
            subagent({
              threadId: "toolu_x",
              providerThreadId: "toolu_x",
              nickname: "Ada",
              rawStatus: "completed",
            }),
          ],
        }),
      );
      expect(items[0]).toMatchObject({
        statusLabel: "Completed",
        statusKind: "completed",
        isActive: false,
      });
    });

    it("falls back to the settled collab item status when no per-agent status exists", () => {
      const items = enrichedItems(
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          itemType: "collab_agent_tool_call",
          subagentAction: { tool: "spawnAgent", status: "failed", summaryText: "Agent activity" },
          subagents: [
            subagent({ threadId: "toolu_x", providerThreadId: "toolu_x", nickname: "Ada" }),
          ],
        }),
      );
      expect(items[0]).toMatchObject({
        statusLabel: "Failed",
        statusKind: "failed",
        isActive: false,
      });
    });

    it("keeps Idle for a child thread idling mid-lifecycle without a terminal signal", () => {
      const items = enrichedItems(
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          itemType: "collab_agent_tool_call",
          subagentAction: {
            tool: "spawnAgent",
            status: "in_progress",
            summaryText: "Agent activity",
          },
          subagents: [
            subagent({ threadId: "toolu_x", providerThreadId: "toolu_x", nickname: "Ada" }),
          ],
        }),
      );
      expect(items[0]).toMatchObject({ statusLabel: "Idle", statusKind: "idle" });
    });
  });

  it("derives a strip row end-to-end from a routed collab activity omitted by the timeline", () => {
    const parentThreadId = ThreadId.makeUnsafe("thread-1");
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.makeUnsafe("routed-agent-update"),
        createdAt: "2026-07-14T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Subagent task",
        tone: "tool",
        turnId: TurnId.makeUnsafe("turn-1"),
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          data: {
            toolCallId: "toolu_x",
            callId: "toolu_x",
            toolName: "Agent",
            input: {},
            receiverThreadId: "toolu_x",
          },
        },
      },
    ];

    // The transcript omits the routed activity; the strip source must not.
    const stripEntries = deriveWorkLogEntries(activities, undefined);
    expect(omitRoutedSubagentWorkEntries(stripEntries)).toEqual([]);

    const subagentThread: Thread = {
      id: localSubagentThreadId(parentThreadId, "toolu_x"),
      codexThreadId: null,
      projectId: "project-1" as Thread["projectId"],
      title: "Subagent task",
      modelSelection: { provider: "claudeAgent", profileId: DEFAULT_PROVIDER_PROFILE_ID, model: "sonnet" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: {
        provider: "claudeAgent",
        status: "running",
        createdAt: "2026-07-14T00:00:01.000Z",
        updatedAt: "2026-07-14T00:00:01.000Z",
        orchestrationStatus: "running",
      },
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-07-14T00:00:01.000Z",
      latestTurn: null,
      parentThreadId,
      turnDiffSummaries: [],
      activities: [],
      branch: null,
      worktreePath: null,
    };
    const enriched = enrichSubagentWorkEntries(stripEntries, [subagentThread], parentThreadId);

    // Background case: parent turn already settled (liveTurnId null) while the
    // subagent keeps running.
    const items = deriveComposerSubagentStripItems({
      workEntries: enriched,
      liveTurnId: null,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      threadId: subagentThread.id,
      providerThreadId: "toolu_x",
      statusKind: "running",
      isActive: true,
    });
  });
});

describe("worker-tier role suppression", () => {
  it("hides worker-tier agent types while keeping the effort in the model label", () => {
    const items = subagentRows(
      deriveComposerSubagentStripItems({
        workEntries: [
          workEntry({
            id: "entry-1",
            turnId: "turn-1",
            subagents: [
              subagent({
                threadId: "sub-1",
                nickname: "Ada",
                role: "worker-low",
                model: "haiku-4.5",
                effort: "low",
                rawStatus: "running",
                isActive: true,
              }),
              subagent({
                threadId: "sub-2",
                nickname: "Blue",
                role: "reviewer",
                rawStatus: "running",
                isActive: true,
              }),
            ],
          }),
        ],
        liveTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    );

    expect(items[0]).toMatchObject({
      primaryLabel: "Ada",
      role: null,
      fullLabel: "Ada",
    });
    expect(items[0]?.modelLabel).toContain("low");
    expect(items[1]).toMatchObject({
      primaryLabel: "Blue",
      role: "reviewer",
      fullLabel: "Blue [reviewer]",
    });
  });

  it("strips worker-tier suffixes from title-derived labels", () => {
    const items = subagentRows(
      deriveComposerSubagentStripItems({
        workEntries: [
          workEntry({
            id: "entry-1",
            turnId: "turn-1",
            subagents: [
              subagent({
                threadId: "sub-1",
                title: "Research scheduling market - players [worker-low]",
                rawStatus: "running",
                isActive: true,
              }),
            ],
          }),
        ],
        liveTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    );

    expect(items[0]).toMatchObject({
      primaryLabel: "Research scheduling market - players",
      role: null,
      fullLabel: "Research scheduling market - players",
    });
  });
});

describe("collectRunningSubagentStripItems", () => {
  it("collects only running subagent rows, skipping parent and settled rows", () => {
    const rows = deriveComposerSubagentStripItems({
      workEntries: [
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          subagents: [
            subagent({ threadId: "sub-1", nickname: "Ada", rawStatus: "running", isActive: true }),
            subagent({ threadId: "sub-2", nickname: "Blue", rawStatus: "completed" }),
            subagent({ threadId: "sub-3", nickname: "Cass", rawStatus: "running", isActive: true }),
          ],
        }),
      ],
      liveTurnId: TurnId.makeUnsafe("turn-1"),
      parentRow: { threadId: ThreadId.makeUnsafe("thread-1"), label: "Main thread" },
    });

    const running = collectRunningSubagentStripItems(rows);
    expect(running.map((item) => item.threadId)).toEqual(["sub-1", "sub-3"]);
    expect(running.every((item) => item.kind === "subagent" && item.isActive)).toBe(true);
  });

  it("returns no rows when nothing is running", () => {
    const rows = deriveComposerSubagentStripItems({
      workEntries: [
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          subagents: [subagent({ threadId: "sub-1", nickname: "Ada", rawStatus: "queued" })],
        }),
      ],
      liveTurnId: TurnId.makeUnsafe("turn-1"),
    });

    expect(collectRunningSubagentStripItems(rows)).toEqual([]);
  });
});

describe("collectForegroundRunningSubagentStripItems", () => {
  it("keeps only running rows not backgrounded by spawn hint or confirmed patch", () => {
    const rows = deriveComposerSubagentStripItems({
      workEntries: [
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          subagents: [
            subagent({ threadId: "sub-fg", nickname: "Ada", rawStatus: "running", isActive: true }),
            subagent({
              threadId: "sub-bg-spawn",
              nickname: "Blue",
              background: true,
              rawStatus: "running",
              isActive: true,
            }),
            subagent({
              threadId: "sub-bg-patch",
              providerThreadId: "toolu_patch",
              nickname: "Cleo",
              rawStatus: "running",
              isActive: true,
            }),
            subagent({ threadId: "sub-done", nickname: "Dot", rawStatus: "completed" }),
          ],
        }),
      ],
      liveTurnId: TurnId.makeUnsafe("turn-1"),
      backgroundedProviderThreadIds: new Set(["toolu_patch"]),
      parentRow: { threadId: ThreadId.makeUnsafe("thread-1"), label: "Main thread" },
    });

    const foreground = collectForegroundRunningSubagentStripItems(rows);
    expect(foreground.map((item) => item.primaryLabel)).toEqual(["Ada"]);
  });
});
