import { describe, expect, it } from "vitest";

import type { ActiveBackgroundTasksState } from "../../session-logic";
import {
  deriveComposerBackgroundTaskRows,
  summarizeComposerBackgroundTaskRows,
} from "./ComposerBackgroundTasksPanel.logic";

function state(tasks: ActiveBackgroundTasksState["tasks"]): ActiveBackgroundTasksState {
  return { activeCount: tasks.length, taskIds: tasks.map((task) => task.taskId), tasks };
}

describe("deriveComposerBackgroundTaskRows", () => {
  it("lists backgrounded commands with their descriptions and start times", () => {
    const rows = deriveComposerBackgroundTaskRows({
      activeBackgroundTasks: state([
        {
          taskId: "bash-1",
          taskType: "local_bash",
          description: "Wait for fork CI to complete",
          toolUseId: "toolu_1",
          startedAt: "2026-09-07T14:53:27.242Z",
        },
        {
          taskId: "bash-2",
          taskType: "local_bash",
          toolUseId: "toolu_2",
          startedAt: "2026-09-07T14:53:30.000Z",
        },
      ]),
    });

    expect(rows).toEqual([
      {
        key: "bash-1",
        taskId: "bash-1",
        kind: "command",
        label: "Wait for fork CI to complete",
        startedAt: "2026-09-07T14:53:27.242Z",
      },
      {
        key: "bash-2",
        taskId: "bash-2",
        kind: "command",
        label: "Background command",
        startedAt: "2026-09-07T14:53:30.000Z",
      },
    ]);
  });

  it("skips work that the workflow card and subagent strip already show", () => {
    const rows = deriveComposerBackgroundTaskRows({
      activeBackgroundTasks: state([
        { taskId: "wf-1", taskType: "local_workflow", startedAt: "2026-09-07T14:00:00.000Z" },
        {
          taskId: "wf-earlier",
          taskType: "local_workflow",
          description: "Run the baseline workflow",
          startedAt: "2026-09-07T13:00:00.000Z",
        },
        { taskId: "wf-member", startedAt: "2026-09-07T14:00:01.000Z" },
        {
          taskId: "agent-strip",
          subagentType: "reviewer",
          toolUseId: "toolu_task",
          startedAt: "2026-09-07T14:00:02.000Z",
        },
        {
          taskId: "agent-untracked",
          subagentType: "researcher",
          toolUseId: "toolu_other",
          startedAt: "2026-09-07T14:00:03.000Z",
        },
        { taskId: "agent-plain", taskType: "subagent", startedAt: "2026-09-07T14:00:04.000Z" },
        {
          taskId: "bash-1",
          taskType: "local_bash",
          description: "Run the baseline",
          startedAt: "2026-09-07T14:00:05.000Z",
        },
      ]),
      workflowTaskIds: ["wf-1", "wf-member"],
      subagentToolUseIds: new Set(["toolu_task"]),
    });

    expect(rows.map((row) => [row.taskId, row.kind, row.label])).toEqual([
      ["wf-earlier", "task", "Run the baseline workflow"],
      ["agent-untracked", "agent", "researcher"],
      ["agent-plain", "agent", "Subagent"],
      ["bash-1", "command", "Run the baseline"],
    ]);
  });

  it("returns nothing without active background work", () => {
    expect(deriveComposerBackgroundTaskRows({ activeBackgroundTasks: null })).toEqual([]);
    expect(deriveComposerBackgroundTaskRows({ activeBackgroundTasks: state([]) })).toEqual([]);
  });
});

describe("summarizeComposerBackgroundTaskRows", () => {
  const row = (taskId: string, kind: "command" | "agent" | "task") => ({
    key: taskId,
    taskId,
    kind,
    label: taskId,
    startedAt: "2026-09-07T14:00:00.000Z",
  });

  it("names the kind when every row shares one", () => {
    expect(summarizeComposerBackgroundTaskRows([row("a", "command")])).toBe(
      "1 background command running",
    );
    expect(summarizeComposerBackgroundTaskRows([row("a", "command"), row("b", "command")])).toBe(
      "2 background commands running",
    );
    expect(summarizeComposerBackgroundTaskRows([row("a", "agent")])).toBe(
      "1 background agent running",
    );
  });

  it("falls back to tasks for mixed kinds and null for none", () => {
    expect(summarizeComposerBackgroundTaskRows([row("a", "command"), row("b", "agent")])).toBe(
      "2 background tasks running",
    );
    expect(summarizeComposerBackgroundTaskRows([])).toBeNull();
  });
});
