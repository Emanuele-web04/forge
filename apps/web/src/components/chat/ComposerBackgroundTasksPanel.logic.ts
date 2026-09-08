// FILE: ComposerBackgroundTasksPanel.logic.ts
// Purpose: Derives the rows for the composer's background-work panel from the
// active background task state, skipping work that another composer panel
// already represents (workflow card members, subagent strip rows).
// Layer: Chat composer logic
// Exports: deriveComposerBackgroundTaskRows, summarizeComposerBackgroundTaskRows

import { pluralize } from "@synara/shared/text";

import type { ActiveBackgroundTask, ActiveBackgroundTasksState } from "../../session-logic";

export type ComposerBackgroundTaskKind = "command" | "agent" | "task";

export interface ComposerBackgroundTaskRow {
  key: string;
  taskId: string;
  kind: ComposerBackgroundTaskKind;
  label: string;
  startedAt: string;
}

function backgroundTaskKind(task: ActiveBackgroundTask): ComposerBackgroundTaskKind {
  if (task.taskType === "local_bash") return "command";
  if (task.subagentType !== undefined || task.taskType === "subagent") return "agent";
  return "task";
}

function backgroundTaskLabel(task: ActiveBackgroundTask, kind: ComposerBackgroundTaskKind): string {
  if (task.description) return task.description;
  if (kind === "command") return "Background command";
  if (kind === "agent") return task.subagentType ?? "Subagent";
  return "Background task";
}

export function deriveComposerBackgroundTaskRows(input: {
  activeBackgroundTasks: ActiveBackgroundTasksState | null;
  // Workflow run + member task ids the workflow card already lists.
  workflowTaskIds?: ReadonlyArray<string> | undefined;
  // Task tool_use_ids the subagent strip already shows as rows.
  subagentToolUseIds?: ReadonlySet<string> | undefined;
}): ComposerBackgroundTaskRow[] {
  const tasks = input.activeBackgroundTasks?.tasks ?? [];
  if (tasks.length === 0) {
    return [];
  }
  const workflowTaskIds = new Set(input.workflowTaskIds ?? []);
  return tasks
    .filter((task) => {
      if (workflowTaskIds.has(task.taskId)) {
        return false;
      }
      // Only hide a subagent when the strip actually represents it.
      if (task.toolUseId !== undefined) {
        if (input.subagentToolUseIds?.has(task.toolUseId)) return false;
      }
      return true;
    })
    .map((task) => {
      const kind = backgroundTaskKind(task);
      return {
        key: task.taskId,
        taskId: task.taskId,
        kind,
        label: backgroundTaskLabel(task, kind),
        startedAt: task.startedAt,
      };
    });
}

// "3 background commands running" / "1 background agent running"; mixed kinds
// fall back to the neutral "tasks".
export function summarizeComposerBackgroundTaskRows(
  rows: ReadonlyArray<ComposerBackgroundTaskRow>,
): string | null {
  if (rows.length === 0) {
    return null;
  }
  const kinds = new Set(rows.map((row) => row.kind));
  const noun = kinds.size === 1 ? [...kinds][0]! : "task";
  return `${rows.length} background ${pluralize(rows.length, noun)} running`;
}
