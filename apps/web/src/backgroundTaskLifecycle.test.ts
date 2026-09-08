import { describe, expect, it } from "vitest";
import { collectTaskBackgroundStates } from "./backgroundTaskLifecycle";
import { makeActivity } from "./storeTestFixtures";
import { deriveActiveBackgroundTasksState } from "./session-logic";

describe("background task evidence", () => {
  it("lets the latest explicit transition override background tool input", () => {
    const activities = [
      makeActivity({
        sequence: 1,
        kind: "tool.started",
        payload: { data: { toolCallId: "tool-1", input: { run_in_background: true } } },
      }),
      makeActivity({
        sequence: 2,
        kind: "task.started",
        payload: { taskId: "task-1", taskType: "local_bash", toolUseId: "tool-1" },
      }),
    ];
    expect(collectTaskBackgroundStates(activities).get("task-1")).toBe(true);
    const foreground = [
      ...activities,
      makeActivity({
        sequence: 3,
        kind: "task.updated",
        payload: { taskId: "task-1", isBackgrounded: true },
      }),
      makeActivity({
        sequence: 4,
        kind: "task.updated",
        payload: { taskId: "task-1", isBackgrounded: false },
      }),
    ];
    expect(collectTaskBackgroundStates(foreground).get("task-1")).toBe(false);
    expect(deriveActiveBackgroundTasksState(foreground)).toBeNull();
    expect(
      deriveActiveBackgroundTasksState([
        ...foreground,
        makeActivity({
          sequence: 5,
          kind: "task.updated",
          payload: { taskId: "task-1", isBackgrounded: true },
        }),
      ])?.taskIds,
    ).toEqual(["task-1"]);
  });

  it("includes explicitly detached Antigravity command and scheduled tasks", () => {
    for (const taskType of ["command_execution", "dynamic_tool_call"]) {
      expect(
        deriveActiveBackgroundTasksState([
          makeActivity({
            kind: "task.started",
            payload: { taskId: "async-task", taskType, isBackgrounded: true },
          }),
        ])?.taskIds,
      ).toEqual(["async-task"]);
    }
  });

  it("honors foreground transitions for known asynchronous task types too", () => {
    expect(
      deriveActiveBackgroundTasksState([
        makeActivity({
          kind: "task.started",
          sequence: 1,
          payload: { taskId: "agent", taskType: "subagent", isBackgrounded: true },
        }),
        makeActivity({
          kind: "task.updated",
          sequence: 2,
          payload: { taskId: "agent", isBackgrounded: false },
        }),
      ]),
    ).toBeNull();
  });
});
