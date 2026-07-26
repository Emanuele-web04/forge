import { MessageId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveTimelineEntries,
  deriveWorkLogEntries,
  isFileChangeWorkLogEntry,
  isProviderFileEditWorkLogEntry,
  omitRoutedSubagentWorkEntries,
} from "./workLog";
import { makeActivity } from "./storeTestFixtures";

describe("deriveWorkLogEntries", () => {
  it("keeps started tool entries so pending Cursor calls appear immediately", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-start"]);
  });

  it("omits task start and completion lifecycle entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress"]);
  });

  it("omits quiet turn lifecycle entries while keeping failed turn state visible", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-success",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.completed",
        summary: "Turn completed",
        tone: "info",
        payload: {
          state: "completed",
        },
      }),
      makeActivity({
        id: "turn-aborted",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.aborted",
        summary: "Turn aborted",
        tone: "info",
        payload: {
          state: "cancelled",
        },
      }),
      makeActivity({
        id: "turn-failed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "turn.completed",
        summary: "Turn failed",
        tone: "error",
        payload: {
          state: "failed",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["turn-failed"]);
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("keeps work for every visible transcript turn when requested", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "First tool", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Second tool complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "turn-3",
        turnId: "turn-3",
        summary: "Hidden tool",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"), {
      visibleTurnIds: new Set([TurnId.makeUnsafe("turn-1"), TurnId.makeUnsafe("turn-2")]),
    });

    expect(entries.map((entry) => [entry.id, entry.turnId])).toEqual([
      ["turn-1", TurnId.makeUnsafe("turn-1")],
      ["turn-2", TurnId.makeUnsafe("turn-2")],
    ]);
  });

  it("falls back to the latest-turn filter when visible turn ids are empty", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "First tool", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Second tool complete",
        kind: "tool.completed",
      }),
    ];

    const filtered = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"), {
      visibleTurnIds: new Set(),
    });
    expect(filtered.map((entry) => entry.id)).toEqual(["turn-2"]);

    const unfiltered = deriveWorkLogEntries(activities, undefined, {
      visibleTurnIds: new Set(),
    });
    expect(unfiltered.map((entry) => entry.id)).toEqual(["turn-1", "turn-2"]);
  });

  it("keeps created-automation milestones and exposes their card fields despite a null turn id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1",
        turnId: "turn-1",
        summary: "First tool",
        kind: "tool.started",
      }),
      makeActivity({
        id: "automation-created",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "automation.created",
        summary: "Created automation: Watch Synara PR 231 - Every 5m",
        tone: "info",
        payload: {
          source: "chat-composer",
          automationId: "automation-7",
          automationName: "Watch Synara PR 231",
          cadenceLabel: "Every 5m",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-1"), {
      visibleTurnIds: new Set([TurnId.makeUnsafe("turn-1")]),
    });

    const automationEntry = entries.find((entry) => entry.id === "automation-created");
    expect(automationEntry).toBeDefined();
    expect(automationEntry?.automation).toEqual({
      id: "automation-7",
      name: "Watch Synara PR 231",
      cadenceLabel: "Every 5m",
    });
  });

  it("carries pending proposal state into automation transcript cards", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "automation-proposal",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "automation.created",
        summary: "Suggested automation: Watch CI",
        tone: "info",
        payload: {
          source: "agent-gateway",
          automationId: "automation-proposal-1",
          automationName: "Watch CI",
          cadenceLabel: "Every 5m",
          proposalState: "pending",
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)[0]?.automation).toEqual({
      id: "automation-proposal-1",
      name: "Watch CI",
      cadenceLabel: "Every 5m",
      proposalState: "pending",
    });
  });

  it("exposes a provider-independent Synara thread creation recap", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "synara-created-threads",
        createdAt: "2026-02-23T00:00:05.000Z",
        turnId: "turn-1",
        kind: "synara.threads.created",
        summary: "Created 2 Synara threads",
        tone: "info",
        payload: {
          operationId: "gateway:create:two-workers",
          requestedCount: 2,
          createdCount: 2,
          threads: [
            {
              threadId: "thread-terra",
              title: "Explain the repository with Terra",
              provider: "codex",
              model: "gpt-5.6-terra",
              environment: "local",
              status: "task_dispatched",
            },
            {
              threadId: "thread-claude",
              title: "Explain the repository with Claude",
              provider: "claudeAgent",
              model: "claude-sonnet-5",
              environment: "worktree",
              status: "task_dispatched",
            },
          ],
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-1"));
    expect(entry?.synaraThreadCreation).toEqual({
      operationId: "gateway:create:two-workers",
      requestedCount: 2,
      createdCount: 2,
      threads: [
        {
          threadId: "thread-terra",
          title: "Explain the repository with Terra",
          provider: "codex",
          model: "gpt-5.6-terra",
          environment: "local",
          status: "task_dispatched",
        },
        {
          threadId: "thread-claude",
          title: "Explain the repository with Claude",
          provider: "claudeAgent",
          model: "claude-sonnet-5",
          environment: "worktree",
          status: "task_dispatched",
        },
      ],
    });
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits passive rate-limit refresh entries from the chat work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "rate-limits-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "account.rate-limits.updated",
        summary: "Rate limits updated",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("shows runtime warning messages and collapses repeated identical warning rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "opencode-retry-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "runtime.warning",
        summary: "OpenCode retrying",
        tone: "info",
        payload: {
          message: "Provider request failed; retrying.",
        },
      }),
      makeActivity({
        id: "opencode-retry-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "runtime.warning",
        summary: "OpenCode retrying",
        tone: "info",
        payload: {
          message: "Provider request failed; retrying.",
        },
      }),
      makeActivity({
        id: "opencode-retry-3",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "runtime.warning",
        summary: "OpenCode retrying",
        tone: "info",
        payload: {
          message: "Provider request failed; retrying.",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "opencode-retry-3",
      label: "OpenCode retrying",
      detail: "3 notices - Provider request failed; retrying.",
      preview: "3 notices - Provider request failed; retrying.",
    });
  });

  it("does not collapse identical runtime warnings across turn boundaries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1-retry",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "runtime.warning",
        summary: "OpenCode retrying",
        tone: "info",
        turnId: "turn-1",
        payload: {
          message: "Provider request failed; retrying.",
        },
      }),
      makeActivity({
        id: "turn-2-retry",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "runtime.warning",
        summary: "OpenCode retrying",
        tone: "info",
        turnId: "turn-2",
        payload: {
          message: "Provider request failed; retrying.",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["turn-1-retry", "turn-2-retry"]);
    expect(entries.map((entry) => entry.detail)).toEqual([
      "Provider request failed; retrying.",
      "Provider request failed; retrying.",
    ]);
  });

  it("hides repeated non-adjacent recovery rows for the same provider turn", () => {
    const recoveryPayload = {
      provider: "codex",
      action: "settle-terminal-projection",
      projectedTurnId: "turn-stale",
      runtimeTurnId: null,
    };
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "recovery-first",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "provider.runtime.reconciled",
        summary: "Synara recovered a stale running state",
        turnId: "turn-stale",
        payload: recoveryPayload,
      }),
      makeActivity({
        id: "unrelated-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Continuing work",
      }),
      makeActivity({
        id: "recovery-repeat",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "provider.runtime.reconciled",
        summary: "Synara recovered a stale running state",
        turnId: "turn-stale",
        payload: recoveryPayload,
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["recovery-first", "unrelated-progress"]);
  });

  it("keeps recovery rows for different turns, actions, or runtime turns", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "settle-turn-a",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "provider.runtime.reconciled",
        summary: "Recovered turn A",
        payload: {
          provider: "codex",
          action: "settle-interrupted",
          projectedTurnId: "turn-a",
          runtimeTurnId: null,
        },
      }),
      makeActivity({
        id: "settle-turn-b",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.runtime.reconciled",
        summary: "Recovered turn B",
        payload: {
          provider: "codex",
          action: "settle-interrupted",
          projectedTurnId: "turn-b",
          runtimeTurnId: null,
        },
      }),
      makeActivity({
        id: "error-turn-b",
        createdAt: "2026-02-23T00:00:02.500Z",
        kind: "provider.runtime.reconciled",
        summary: "Errored turn B",
        payload: {
          provider: "codex",
          action: "settle-error",
          projectedTurnId: "turn-b",
          runtimeTurnId: null,
        },
      }),
      makeActivity({
        id: "align-turn-b",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "provider.runtime.reconciled",
        summary: "Realigned turn B",
        payload: {
          provider: "codex",
          action: "align-running-turn",
          projectedTurnId: "turn-b",
          runtimeTurnId: "turn-live-1",
        },
      }),
      makeActivity({
        id: "align-turn-b-new-runtime",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "provider.runtime.reconciled",
        summary: "Realigned turn B again",
        payload: {
          provider: "codex",
          action: "align-running-turn",
          projectedTurnId: "turn-b",
          runtimeTurnId: "turn-live-2",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual([
      "settle-turn-a",
      "settle-turn-b",
      "error-turn-b",
      "align-turn-b",
      "align-turn-b-new-runtime",
    ]);
  });

  it("does not collapse recovery rows whose identity payload is incomplete", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "malformed-recovery-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "provider.runtime.reconciled",
        summary: "Recovered an unknown turn",
        payload: {
          provider: "codex",
          action: "settle-interrupted",
        },
      }),
      makeActivity({
        id: "malformed-recovery-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.runtime.reconciled",
        summary: "Recovered an unknown turn",
        payload: {
          provider: "codex",
          action: "settle-interrupted",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual([
      "malformed-recovery-1",
      "malformed-recovery-2",
    ]);
  });

  it("keeps reconciliation rows with delimiter-shaped but distinct turn ids", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "recovery-delimited-projected",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "provider.runtime.reconciled",
        summary: "Realigned a delimited projected turn",
        payload: {
          provider: "codex",
          action: "align-running-turn",
          projectedTurnId: "turn:a",
          runtimeTurnId: "turn-b",
        },
      }),
      makeActivity({
        id: "recovery-delimited-runtime",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.runtime.reconciled",
        summary: "Realigned a delimited runtime turn",
        payload: {
          provider: "codex",
          action: "align-running-turn",
          projectedTurnId: "turn",
          runtimeTurnId: "a:turn-b",
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined).map((entry) => entry.id)).toEqual([
      "recovery-delimited-projected",
      "recovery-delimited-runtime",
    ]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("collapses interleaved parallel tool calls into one row per tool-call id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "a-started",
        createdAt: "2026-02-23T00:00:00.000Z",
        kind: "tool.started",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          detail: "Workflow: {}",
          data: { toolCallId: "toolu_a", toolName: "Workflow", input: {} },
        },
      }),
      makeActivity({
        id: "b-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          detail: "WebFetch: {}",
          data: { toolCallId: "toolu_b", toolName: "WebFetch", input: {} },
        },
      }),
      makeActivity({
        id: "a-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          detail: 'Workflow: {"script":"x"}',
          data: { toolCallId: "toolu_a", toolName: "Workflow", input: { script: "x" } },
        },
      }),
      makeActivity({
        id: "b-completed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          detail: 'WebFetch: {"url":"https://x.dev"}',
          data: { toolCallId: "toolu_b", toolName: "WebFetch", input: { url: "https://x.dev" } },
        },
      }),
    ];

    // Without id-based collapse this is 4 rows (a started, b started, a completed,
    // b completed); each tool call must merge to one row, kept at its start position.
    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["a-completed", "b-completed"]);
    expect(entries.map((entry) => entry.toolName)).toEqual(["Workflow", "WebFetch"]);
  });

  it("keeps distinct calls of the same tool separate by tool-call id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "first-started",
        createdAt: "2026-02-23T00:00:00.000Z",
        kind: "tool.started",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          detail: "Workflow: {}",
          data: { toolCallId: "toolu_1", toolName: "Workflow", input: {} },
        },
      }),
      makeActivity({
        id: "second-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          detail: "Workflow: {}",
          data: { toolCallId: "toolu_2", toolName: "Workflow", input: {} },
        },
      }),
      makeActivity({
        id: "first-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          detail: "Workflow: {}",
          data: { toolCallId: "toolu_1", toolName: "Workflow", input: {} },
        },
      }),
      makeActivity({
        id: "second-completed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          detail: "Workflow: {}",
          data: { toolCallId: "toolu_2", toolName: "Workflow", input: {} },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first-completed", "second-completed"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
  });

  it("keeps full command output details for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-details",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: "command-detail-1",
            item: {
              command: `/bin/zsh -lc 'rg -n "toolDetails" apps/web/src'`,
            },
            rawOutput: {
              stdout: "apps/web/src/session-logic.ts:55: toolDetails\nsecond line",
              stderr: "warning: ignored binary file",
              exitCode: 2,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.toolDetails).toEqual({
      kind: "command",
      title: "Searched",
      command: `/bin/zsh -lc 'rg -n "toolDetails" apps/web/src'`,
      output: {
        stdout: "apps/web/src/session-logic.ts:55: toolDetails\nsecond line",
        stderr: "warning: ignored binary file",
        exitCode: 2,
      },
    });
  });

  it("keeps command output details when rawOutput is stored as a string", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-string-output",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            item: {
              command: "agy --version",
            },
            rawOutput: "agy 1.2.3\n",
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.toolDetails).toEqual({
      kind: "command",
      title: "Ran",
      command: "agy --version",
      output: {
        output: "agy 1.2.3\n",
      },
    });
  });

  it("merges command detail payloads across started and completed lifecycle rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: "command-merge-1",
            command: "bun run --cwd apps/web test session-logic.test.ts",
          },
        },
      }),
      makeActivity({
        id: "command-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: "command-merge-1",
            rawOutput: {
              stdout: "passed",
              exitCode: 0,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.id).toBe("command-complete");
    expect(entry?.toolDetails).toMatchObject({
      kind: "command",
      command: "bun run --cwd apps/web test session-logic.test.ts",
      output: { stdout: "passed", exitCode: 0 },
    });
  });

  it("falls back to command-like detail when structured command metadata is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-detail-only",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          detail: `/bin/zsh -lc "sed -n '240,520p' src/components/provider-card.tsx"`,
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe(
      `/bin/zsh -lc "sed -n '240,520p' src/components/provider-card.tsx"`,
    );
    expect(entry?.toolTitle).toBe("Read");
  });

  it("humanizes generic command titles for better readability", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            item: {
              command: `/bin/zsh -lc 'rg -n "tool call" apps/web/src'`,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.toolTitle).toBe("Searched");
  });

  it("recovers Cursor tool details from stored rawOutput when rawInput is empty", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-find",
        kind: "tool.completed",
        summary: "Find",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Find",
          data: {
            kind: "search",
            rawInput: {},
            rawOutput: {
              totalFiles: 33,
              truncated: false,
            },
          },
        },
      }),
      makeActivity({
        id: "cursor-read",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          data: {
            kind: "read",
            rawInput: {},
            rawOutput: {
              content: "one\ntwo\n",
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toMatchObject([
      {
        id: "cursor-find",
        toolTitle: "Search",
        detail: "33 files found",
      },
      {
        id: "cursor-read",
        toolTitle: "Read",
        detail: "Read 2 lines",
      },
    ]);
  });

  it("recovers readable Cursor labels from older generic Tool projections", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-tool-find",
        kind: "tool.updated",
        summary: "Tool",
        payload: {
          itemType: "dynamic_tool_call",
          status: "inProgress",
          data: {
            toolCallId: "find-1",
            kind: "search",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "cursor-tool-read",
        kind: "tool.completed",
        summary: "Tool",
        payload: {
          itemType: "dynamic_tool_call",
          status: "completed",
          title: "Tool",
          detail: "Read 2 lines",
          data: {
            toolCallId: "read-1",
            kind: "read",
            rawInput: {},
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toMatchObject([
      {
        id: "cursor-tool-find",
        toolTitle: "Search",
      },
      {
        id: "cursor-tool-read",
        toolTitle: "Read",
        detail: "Read 2 lines",
      },
    ]);
  });

  it("collapses Cursor tool lifecycle rows by toolCallId even when titles and details change", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-searching",
        createdAt: "2026-05-05T15:39:01.000Z",
        kind: "tool.started",
        summary: "Searching",
        payload: {
          itemType: "dynamic_tool_call",
          status: "inProgress",
          title: "Searching",
          data: {
            toolCallId: "cursor-find-1",
            kind: "search",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "cursor-searched",
        createdAt: "2026-05-05T15:39:02.000Z",
        kind: "tool.completed",
        summary: "Searched",
        payload: {
          itemType: "dynamic_tool_call",
          status: "completed",
          title: "Searched",
          data: {
            toolCallId: "cursor-find-1",
            kind: "search",
            rawOutput: {
              totalFiles: 52,
              truncated: false,
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toMatchObject([
      {
        id: "cursor-searched",
        toolTitle: "Searched",
        detail: "52 files found",
        itemType: "dynamic_tool_call",
      },
    ]);
  });

  it("keeps same-toolCallId rows collapsed even if later command metadata changes", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-command-start",
        createdAt: "2026-05-05T15:40:01.000Z",
        kind: "tool.updated",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Ran command",
          data: {
            toolCallId: "cursor-command-1",
            kind: "execute",
            command: "git status",
          },
        },
      }),
      makeActivity({
        id: "cursor-command-complete",
        createdAt: "2026-05-05T15:40:02.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          detail: "done",
          data: {
            toolCallId: "cursor-command-1",
            kind: "execute",
            command: "git diff --stat",
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toMatchObject([
      {
        id: "cursor-command-complete",
        command: "git diff --stat",
        detail: "done",
        itemType: "command_execution",
      },
    ]);
  });

  it("recovers Codex command text from nested JSON tool arguments", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-command-json-args",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            item: {
              type: "command_execution",
              arguments: JSON.stringify({
                command: 'rg -n "thread.create" apps/server/src',
              }),
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toMatchObject([
      {
        id: "codex-command-json-args",
        command: 'rg -n "thread.create" apps/server/src',
        toolTitle: "Searching",
      },
    ]);
  });

  it("recovers Codex command text from rawInput command payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-command-raw-input",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            rawInput: {
              command: ["git", "status", "--short"],
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toMatchObject([
      {
        id: "codex-command-raw-input",
        command: "git status --short",
        toolTitle: "Checked",
      },
    ]);
  });

  it("prefers Codex commandActions over the shell wrapper command", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-command-actions",
        kind: "tool.updated",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Ran command",
          detail: `/bin/zsh -lc "sed -n '1,220p' README.md"`,
          data: {
            item: {
              type: "commandExecution",
              command: `/bin/zsh -lc "sed -n '1,220p' README.md"`,
              commandActions: [
                {
                  type: "read",
                  command: "sed -n '1,220p' README.md",
                  name: "README.md",
                  path: "/Users/emanueledipietro/Developer/Testing/synara/README.md",
                },
              ],
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toMatchObject([
      {
        id: "codex-command-actions",
        command: "sed -n '1,220p' README.md",
        rawCommand: `/bin/zsh -lc "sed -n '1,220p' README.md"`,
        toolTitle: "Reading",
        preview: "README.md",
      },
    ]);
  });

  it("rebuilds Codex search labels from commandActions", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-search-action",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          detail: "/bin/zsh -lc 'find apps packages -maxdepth 2 -name package.json -print'",
          data: {
            item: {
              type: "commandExecution",
              command: "/bin/zsh -lc 'find apps packages -maxdepth 2 -name package.json -print'",
              commandActions: [
                {
                  type: "search",
                  command: "find apps packages -maxdepth 2 -name package.json -print",
                  query: "package.json",
                  path: "apps",
                },
              ],
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toMatchObject([
      {
        id: "codex-search-action",
        command: "find apps packages -maxdepth 2 -name package.json -print",
        rawCommand: "/bin/zsh -lc 'find apps packages -maxdepth 2 -name package.json -print'",
        toolTitle: "Searched",
        preview: "for package.json in apps",
      },
    ]);
  });

  it("humanizes Codex commands when commandActions.type is unknown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-unknown-action",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          detail: "/bin/zsh -lc 'git status --short'",
          data: {
            item: {
              type: "commandExecution",
              command: "/bin/zsh -lc 'git status --short'",
              status: "completed",
              commandActions: [{ type: "unknown", command: "git status --short" }],
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toMatchObject([
      {
        id: "codex-unknown-action",
        command: "git status --short",
        rawCommand: "/bin/zsh -lc 'git status --short'",
        toolTitle: "Checked",
      },
    ]);
  });

  it("humanizes Codex commands with the full real-world DB payload shape", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-full-db-shape",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          detail: "/bin/zsh -lc 'git status --short'",
          data: {
            item: {
              type: "commandExecution",
              id: "call_6OII41pekq8cFCpOCF9pbeMu",
              command: "/bin/zsh -lc 'git status --short'",
              cwd: "/Users/emanueledipietro/Developer/Testing/synara",
              status: "completed",
              commandActions: [{ type: "unknown", command: "git status --short" }],
              aggregatedOutput: " M apps/desktop/src/main.ts\n...",
              exitCode: 0,
              durationMs: 0,
            },
            threadId: "019e08d7-1234-5678-90ab-cdef01234567",
            turnId: "019e08d7-1234-5678-90ab-cdef01234567",
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toMatchObject([
      {
        id: "codex-full-db-shape",
        command: "git status --short",
        rawCommand: "/bin/zsh -lc 'git status --short'",
        toolTitle: "Checked",
      },
    ]);
  });

  it("collapses generic Codex start rows into completed rows by item id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-start-generic",
        createdAt: "2026-05-08T21:00:00.000Z",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Ran command",
          data: {
            item: {
              type: "commandExecution",
              id: "call_same_item_id",
              status: "inProgress",
            },
          },
        },
      }),
      makeActivity({
        id: "codex-completed-rich",
        createdAt: "2026-05-08T21:00:01.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          detail: "/bin/zsh -lc 'git status --short'",
          data: {
            item: {
              type: "commandExecution",
              id: "call_same_item_id",
              command: "/bin/zsh -lc 'git status --short'",
              status: "completed",
              commandActions: [{ type: "unknown", command: "git status --short" }],
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toMatchObject([
      {
        id: "codex-completed-rich",
        command: "git status --short",
        rawCommand: "/bin/zsh -lc 'git status --short'",
        toolTitle: "Checked",
      },
    ]);
  });

  it("omits uninformative generic Codex command start rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-start-no-command",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Ran command",
          data: {
            item: {
              type: "commandExecution",
              id: "call_no_command_yet",
              status: "inProgress",
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("reads Codex commandActions from the raw data envelope", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-direct-command-actions",
        kind: "tool.updated",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Ran command",
          data: {
            type: "commandExecution",
            command: `/bin/zsh -lc "ls -la"`,
            commandActions: [
              {
                type: "list_files",
                command: "ls -la",
                path: ".",
              },
            ],
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toMatchObject([
      {
        id: "codex-direct-command-actions",
        command: "ls -la",
        rawCommand: `/bin/zsh -lc "ls -la"`,
        toolTitle: "Listing",
        preview: "current directory",
      },
    ]);
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "apps/web/src/components/ChatView.tsx" },
                { filename: "apps/web/src/session-logic.ts" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
    expect(entry?.toolDetails).toBeUndefined();
  });

  it("does not create tool details from a path-only file-change input", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool-path-only-input",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            rawInput: {
              path: "apps/web/src/session-logic.ts",
            },
            item: {
              changes: [{ path: "apps/web/src/session-logic.ts" }],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual(["apps/web/src/session-logic.ts"]);
    expect(entry?.toolDetails).toBeUndefined();
  });

  it("keeps edit diff details for file-change tool activities", () => {
    const unifiedDiff = [
      "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
      "--- a/apps/web/src/session-logic.ts",
      "+++ b/apps/web/src/session-logic.ts",
      "@@ -1,1 +1,1 @@",
      "-old line",
      "+new line",
    ].join("\n");
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool-details",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          title: "File change",
          data: {
            unifiedDiff,
            rawInput: {
              path: "apps/web/src/session-logic.ts",
              oldText: "old line",
              newText: "new line",
            },
            edits: [
              {
                path: "apps/web/src/session-logic.ts",
                oldText: "old line",
                newText: "new line",
              },
            ],
            files: [{ path: "apps/web/src/session-logic.ts" }],
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.toolDetails).toEqual({
      kind: "file-change",
      title: "Edited",
      diff: unifiedDiff,
      edits: [
        {
          path: "apps/web/src/session-logic.ts",
          oldText: "old line",
          newText: "new line",
        },
      ],
      files: ["apps/web/src/session-logic.ts"],
    });
  });

  it("identifies file-change work by lifecycle metadata, not any changedFiles array", () => {
    const readEntryWithFileMetadata = {
      itemType: "dynamic_tool_call" as const,
      changedFiles: ["apps/web/src/session-logic.ts"],
    };

    expect(isFileChangeWorkLogEntry({ itemType: "file_change" })).toBe(true);
    expect(isFileChangeWorkLogEntry({ requestKind: "file-change" })).toBe(true);
    expect(isFileChangeWorkLogEntry(readEntryWithFileMetadata)).toBe(false);
  });

  it("identifies provider file edits without counting bare file-change approvals", () => {
    expect(isProviderFileEditWorkLogEntry({ itemType: "file_change" })).toBe(true);
    expect(
      isProviderFileEditWorkLogEntry({
        requestKind: "file-change",
        changedFiles: ["apps/web/src/session-logic.ts"],
      }),
    ).toBe(true);
    expect(isProviderFileEditWorkLogEntry({ requestKind: "file-change" })).toBe(false);
  });

  it("extracts Cursor read targets from rawInput and ACP locations", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-read-raw-input",
        kind: "tool.completed",
        summary: "Read",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read",
          data: {
            kind: "read",
            rawInput: {
              file_path: "apps/web/src/session-logic.ts",
            },
          },
        },
      }),
      makeActivity({
        id: "cursor-read-location",
        kind: "tool.completed",
        summary: "Read",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read",
          data: {
            kind: "read",
            locations: [{ path: "apps/server/src/provider/acp/AcpRuntimeModel.ts", line: 12 }],
          },
        },
      }),
    ];

    const entriesById = new Map(
      deriveWorkLogEntries(activities, undefined).map((entry) => [entry.id, entry]),
    );
    expect(entriesById.get("cursor-read-raw-input")?.changedFiles).toEqual([
      "apps/web/src/session-logic.ts",
    ]);
    expect(entriesById.get("cursor-read-location")?.changedFiles).toEqual([
      "apps/server/src/provider/acp/AcpRuntimeModel.ts",
    ]);
  });

  it("does not treat arbitrary rawOutput file strings as changed files", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-search-output",
        kind: "tool.completed",
        summary: "Searched",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Searched",
          data: {
            kind: "search",
            rawOutput: {
              file: "no results",
              path: "not a path",
              totalFiles: 0,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toBeUndefined();
  });

  it("keeps root-level file names as changed file paths", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "root-file-tool",
        kind: "tool.completed",
        summary: "Read",
        payload: {
          itemType: "dynamic_tool_call",
          data: {
            rawInput: {
              file_path: "package.json",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual(["package.json"]);
  });

  it("does not collapse fallback lifecycle rows for different files without toolCallId", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-one",
        createdAt: "2026-05-05T15:41:01.000Z",
        kind: "tool.updated",
        summary: "Read",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read",
          data: {
            rawInput: {
              file_path: "apps/web/src/session-logic.ts",
            },
          },
        },
      }),
      makeActivity({
        id: "read-two",
        createdAt: "2026-05-05T15:41:02.000Z",
        kind: "tool.completed",
        summary: "Read",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read",
          data: {
            rawInput: {
              file_path: "apps/web/src/lib/contextWindow.ts",
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined).map((entry) => entry.id)).toEqual([
      "read-one",
      "read-two",
    ]);
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:03.000Z",
      label: "Tool call completed",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("uses MCP tool names from preserved payload data", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "mcp-progress",
        kind: "tool.updated",
        summary: "mcp__codex_apps__github_fetch_pr",
        payload: {
          itemType: "mcp_tool_call",
          title: "MCP tool call",
          detail: "Fetching PR details",
          data: {
            toolName: "mcp__codex_apps__github_fetch_pr",
            summary: "Fetching PR details",
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      id: "mcp-progress",
      itemType: "mcp_tool_call",
      toolTitle: "Codex Apps: Github Fetch Pr",
      detail: "Fetching PR details",
    });
  });

  it("presents Synara MCP activity consistently across provider item shapes", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "synara-mcp-create-thread-progress",
        kind: "tool.updated",
        summary: "MCP tool call",
        payload: {
          itemType: "mcp_tool_call",
          title: "MCP tool call",
          data: {
            toolCallId: "synara-mcp-create",
            toolName: "mcp__synara__synara_create_thread",
          },
        },
      }),
      makeActivity({
        id: "synara-dynamic-send-message-progress",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Synara__synara_send_message",
          data: {
            toolCallId: "synara-dynamic-send",
          },
        },
      }),
      makeActivity({
        id: "synara-file-change-list-threads-progress",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          title: "mcp__Synara__synara_list_threads",
          data: {
            toolCallId: "synara-file-change-list",
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => [entry.itemType, entry.toolTitle])).toEqual(
      expect.arrayContaining([
        ["mcp_tool_call", "Synara is creating a thread"],
        ["dynamic_tool_call", "Synara is sending a message"],
        ["file_change", "Synara is listing threads"],
      ]),
    );
    expect(entries).toHaveLength(3);
  });

  it("preserves a failed Synara MCP result as a failed activity sentence", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "synara-create-threads-failed",
          kind: "tool.completed",
          summary: "synara__synara_create_threads",
          payload: {
            itemType: "mcp_tool_call",
            status: "failed",
            data: {
              toolCallId: "synara-create-failed",
              toolName: "mcp__synara__synara_create_threads",
              rawOutput: {
                is_error: 1,
                output: { Error: "Invalid target options\n  at target.options" },
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry).toMatchObject({
      toolStatus: "failed",
      toolTitle: "Synara couldn't create threads",
      detail: "Invalid target options",
    });
  });

  it("uses present-tense command headings while the command is still running", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "running-command-tool",
        kind: "tool.updated",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            item: {
              command: `/bin/zsh -lc 'rg -n "tool call" apps/web/src'`,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.toolTitle).toBe("Searching");
  });

  it("collapses Claude-style partial tool-input updates into the final lifecycle row", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read file",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read file",
          detail: 'Read: {"file_path":"',
          data: {
            toolName: "Read",
            input: {},
          },
        },
      }),
      makeActivity({
        id: "claude-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Read file",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read file",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            toolName: "Read",
            input: {
              file_path: "/tmp/app.ts",
            },
          },
        },
      }),
      makeActivity({
        id: "claude-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Read file",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read file",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            toolName: "Read",
            input: {
              file_path: "/tmp/app.ts",
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "claude-complete",
      label: "Read file",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      itemType: "dynamic_tool_call",
      toolTitle: "Read",
      // toolName must survive derivation so the timeline can pick the file-read
      // (search) icon instead of the generic wrench fallback.
      toolName: "Read",
    });
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-complete", "tool-2-complete"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });

  it("omits routed collab subagent tool lifecycle rows from the transcript", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "collab-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Spawn subagents",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Spawn agent",
          data: {
            item: {
              receiverAgents: [
                {
                  threadId: "subagent:thread-1:agent-1",
                  agentNickname: "Locke",
                  agentRole: "explorer",
                },
                {
                  threadId: "subagent:thread-1:agent-2",
                  agentNickname: "Ada",
                  agentRole: "worker",
                },
              ],
            },
          },
        },
      }),
      makeActivity({
        id: "collab-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Spawn subagents",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Spawn agent",
          data: {
            item: {
              receiverThreadIds: ["subagent:thread-1:agent-1", "subagent:thread-1:agent-2"],
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(omitRoutedSubagentWorkEntries(entries)).toEqual([]);
  });

  // Providers stream the agent tool call before its receivers, so the routed
  // entry only becomes recognizable once the later update merges into it.
  it("omits routed collab entries that gain their receivers from a merged update", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "collab-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Agent",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Agent",
          status: "inProgress",
          data: {
            toolCallId: "toolu_merge",
            callId: "toolu_merge",
            toolName: "Agent",
            input: {},
          },
        },
      }),
      makeActivity({
        id: "collab-receivers",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Agent",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Agent",
          status: "inProgress",
          data: {
            toolName: "Agent",
            receiverThreadId: "toolu_merge",
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subagents).toHaveLength(1);
    expect(omitRoutedSubagentWorkEntries(entries)).toEqual([]);
  });

  it("keeps routed collab subagent rows for the composer strip source", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "routed-agent-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Subagent task",
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
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subagents).toEqual([
      expect.objectContaining({ threadId: "toolu_x", providerThreadId: "toolu_x" }),
    ]);
    expect(omitRoutedSubagentWorkEntries(entries)).toEqual([]);
  });

  it("keeps generic OpenCode task tool rows when no subagent route is available", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "opencode-task-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Find changelog implementation",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Find changelog implementation",
          detail: "Find changelog implementation",
          data: {
            tool: "task",
            toolName: "task",
            toolCallId: "toolu_017R8ZQcmmYKgXqNpXxC3tXa",
            callID: "toolu_017R8ZQcmmYKgXqNpXxC3tXa",
            input: {
              description: "Find changelog implementation",
              prompt: "Explore this codebase to find the changelog feature.",
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([
      expect.objectContaining({
        id: "opencode-task-update",
        itemType: "collab_agent_tool_call",
        label: "Find changelog implementation",
        toolCallId: "toolu_017R8ZQcmmYKgXqNpXxC3tXa",
        toolTitle: "Find changelog implementation",
        subagentAction: expect.objectContaining({
          prompt: "Explore this codebase to find the changelog feature.",
        }),
      }),
    ]);
    expect(deriveWorkLogEntries(activities, undefined)[0]?.detail).toBeUndefined();
  });

  it("uses completed generic agent task output instead of truncated task wrapper text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "opencode-task-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Task",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          title: "task",
          detail: '<task id="task-call" state="completed">...',
          data: {
            tool: "task",
            toolName: "task",
            toolCallId: "task-call",
            callID: "task-call",
            input: {
              prompt: "Explore the changelog implementation.",
            },
            state: {
              status: "completed",
              output:
                '<task id="task-call" state="completed">\n<task_result>\nFull changelog report\nwith file references.\n</task_result>\n</task>',
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)[0]).toEqual(
      expect.objectContaining({
        id: "opencode-task-complete",
        itemType: "collab_agent_tool_call",
        detail: "Full changelog report\nwith file references.",
        subagentAction: expect.objectContaining({
          prompt: "Explore the changelog implementation.",
        }),
      }),
    );
  });

  it("preserves the OpenCode task description when the generic completion row collapses", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "opencode-task-started",
        createdAt: "2026-02-23T00:00:00.000Z",
        kind: "tool.started",
        summary: "task started",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "task",
          data: {
            tool: "task",
            toolName: "task",
            toolCallId: "task-call",
            callID: "task-call",
            input: {},
          },
        },
      }),
      makeActivity({
        id: "opencode-task-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Find changelog implementation",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Find changelog implementation",
          detail: "Find changelog implementation",
          data: {
            tool: "task",
            toolName: "task",
            toolCallId: "task-call",
            callID: "task-call",
            input: {
              description: "Find changelog implementation",
              prompt: "Explore the changelog implementation.",
            },
          },
        },
      }),
      makeActivity({
        id: "opencode-task-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "task",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          title: "task",
          detail: '<task id="task-call" state="completed">...',
          data: {
            tool: "task",
            toolName: "task",
            toolCallId: "task-call",
            callID: "task-call",
            input: {
              description: "Find changelog implementation",
              prompt: "Explore the changelog implementation.",
            },
            state: {
              status: "completed",
              output:
                '<task id="task-call" state="completed">\n<task_result>\nFull changelog report\nwith file references.\n</task_result>\n</task>',
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        id: "opencode-task-complete",
        itemType: "collab_agent_tool_call",
        toolTitle: "Find changelog implementation",
        detail: "Full changelog report\nwith file references.",
        subagentAction: expect.objectContaining({
          prompt: "Explore the changelog implementation.",
        }),
      }),
    );
  });

  it("collapses an OpenCode task across an interleaved runtime error by tool-call id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "opencode-task-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Find changelog implementation",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Find changelog implementation",
          data: {
            tool: "task",
            toolName: "task",
            toolCallId: "task-call",
            input: {
              description: "Find changelog implementation",
              prompt: "Explore the changelog implementation.",
            },
          },
        },
      }),
      makeActivity({
        id: "runtime-error",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "runtime.error",
        summary: "Provider runtime error",
        tone: "error",
      }),
      makeActivity({
        id: "opencode-task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "task",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "failed",
          title: "task",
          detail: "Tool execution aborted",
          data: {
            tool: "task",
            toolName: "task",
            toolCallId: "task-call",
            input: {
              description: "Find changelog implementation",
              prompt: "Explore the changelog implementation.",
            },
            state: {
              title: "Find changelog implementation",
              status: "error",
            },
          },
        },
      }),
    ];

    // The task update + completion share a tool-call id and merge into one row even
    // though a runtime error arrived between them; the runtime error stays separate.
    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.itemType === "collab_agent_tool_call")).toEqual(
      expect.objectContaining({
        id: "opencode-task-complete",
        itemType: "collab_agent_tool_call",
        toolTitle: "Find changelog implementation",
        detail: "Tool execution aborted",
      }),
    );
    expect(entries.some((entry) => entry.tone === "error")).toBe(true);
  });

  it("uses completed Claude task result content for generic agent task rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          title: "Subagent task",
          detail: 'Task: {"description":"Review the database layer"}',
          data: {
            toolName: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
            result: {
              type: "tool_result",
              content: [
                {
                  type: "text",
                  text: "Claude subagent found two issues.",
                },
              ],
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)[0]).toEqual(
      expect.objectContaining({
        id: "claude-task-complete",
        itemType: "collab_agent_tool_call",
        detail: "Claude subagent found two issues.",
        subagentAction: expect.objectContaining({
          prompt: "Audit the SQL changes",
        }),
      }),
    );
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("keeps timestamp ties in message, proposed-plan, then work order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-same-time"),
          role: "assistant",
          text: "same time",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-same-time",
          turnId: TurnId.makeUnsafe("turn-same-time"),
          planMarkdown: "# Same time",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
      ],
      [
        {
          id: "work-same-time",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Ran command",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
  });

  it("hides tagged plan markdown from the assistant row when a proposed plan exists", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-plan"),
          role: "assistant",
          text: "Here is the plan:\n<proposed_plan>\n# Ship it\n\n- step\n</proposed_plan>",
          turnId: TurnId.makeUnsafe("turn-plan"),
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-plan",
          turnId: TurnId.makeUnsafe("turn-plan"),
          planMarkdown: "# Ship it\n\n- step",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [],
    );

    expect(entries[0]).toMatchObject({
      kind: "message",
      message: {
        text: "Here is the plan:",
      },
    });
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
    });
  });

  it("omits empty assistant rows that only contain a captured proposed plan block", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-plan-only"),
          role: "assistant",
          text: "<proposed_plan>\n# Ship it\n\n- step\n</proposed_plan>",
          turnId: TurnId.makeUnsafe("turn-plan-only"),
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-plan-only",
          turnId: TurnId.makeUnsafe("turn-plan-only"),
          planMarkdown: "# Ship it\n\n- step",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["proposed-plan"]);
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "context-1",
          turnId: "turn-1",
          kind: "context-window.updated",
          summary: "Context window updated",
          tone: "info",
        }),
        makeActivity({
          id: "context-2",
          turnId: "turn-1",
          kind: "context-window.configured",
          summary: "Context window configured",
          tone: "info",
        }),
        makeActivity({
          id: "tool-1",
          turnId: "turn-1",
          kind: "tool.completed",
          summary: "Ran command",
          tone: "tool",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-1",
          turnId: "turn-1",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });

  it("keeps thread-level compaction progress entries visible without a turn id", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-progress-1",
          kind: "context-compaction",
          summary: "Compacting context",
          tone: "info",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Compacting context");
  });

  it("collapses a compaction progress row into its terminal row", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-progress-1",
          createdAt: "2026-02-23T00:00:00.000Z",
          kind: "context-compaction",
          summary: "Compacting conversation...",
          tone: "info",
        }),
        makeActivity({
          id: "compaction-completed-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });

  it("collapses same-timestamp compaction rows regardless of event id order", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "a-compaction-completed",
          createdAt: "2026-02-23T00:00:00.000Z",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
        makeActivity({
          id: "b-compaction-progress",
          createdAt: "2026-02-23T00:00:00.000Z",
          kind: "context-compaction",
          summary: "Compacting conversation...",
          tone: "info",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });

  it("does not merge a new compaction progress row into an earlier terminal row", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-completed-1",
          createdAt: "2026-02-23T00:00:00.000Z",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
        makeActivity({
          id: "compaction-progress-2",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "context-compaction",
          summary: "Compacting conversation...",
          tone: "info",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]?.label).toBe("Context compacted");
    expect(entries[1]?.label).toBe("Compacting conversation...");
  });
});

describe("deriveWorkLogEntries Codex find regression", () => {
  it("humanizes Codex find commands from real DB payload (regression)", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "5ae75cbe-5cb5-471a-a6ba-d9712170f1c0",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Ran command",
          detail:
            "/bin/zsh -lc \"find apps packages -maxdepth 2 -name package.json -print -exec sed -n '1,120p' {} \\\\;\"",
          data: {
            item: {
              type: "commandExecution",
              id: "call_UmQKQmLCCrj9PF82rupLIFDO",
              command:
                "/bin/zsh -lc \"find apps packages -maxdepth 2 -name package.json -print -exec sed -n '1,120p' {} \\\\;\"",
              cwd: "/Users/emanueledipietro/Developer/Testing/synara",
              processId: "38005",
              source: "unifiedExecStartup",
              status: "inProgress",
              commandActions: [
                {
                  type: "search",
                  command:
                    "find apps packages -maxdepth 2 -name package.json -print -exec sed -n '1,120p' '{}' \";\"",
                  query: "package.json",
                  path: "apps",
                },
              ],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
            threadId: "019e098c-100f-7c92-b2b2-8fdd7b88d19d",
            turnId: "019e098c-13fc-7442-873f-fc99ce2caa8b",
          },
        },
      }),
      makeActivity({
        id: "6631825b-af15-4f7e-bb9a-891dcb98fd2a",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          detail:
            "/bin/zsh -lc \"find apps packages -maxdepth 2 -name package.json -print -exec sed -n '1,120p' {} \\\\;\"",
          data: {
            item: {
              type: "commandExecution",
              id: "call_UmQKQmLCCrj9PF82rupLIFDO",
              command:
                "/bin/zsh -lc \"find apps packages -maxdepth 2 -name package.json -print -exec sed -n '1,120p' {} \\\\;\"",
              cwd: "/Users/emanueledipietro/Developer/Testing/synara",
              processId: "38005",
              source: "unifiedExecStartup",
              status: "completed",
              commandActions: [
                {
                  type: "search",
                  command:
                    "find apps packages -maxdepth 2 -name package.json -print -exec sed -n '1,120p' '{}' \";\"",
                  query: "package.json",
                  path: "apps",
                },
              ],
              aggregatedOutput: "...",
              exitCode: 0,
              durationMs: 0,
            },
            threadId: "019e098c-100f-7c92-b2b2-8fdd7b88d19d",
            turnId: "019e098c-13fc-7442-873f-fc99ce2caa8b",
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatchObject({
      toolTitle: "Searched",
      command:
        "find apps packages -maxdepth 2 -name package.json -print -exec sed -n '1,120p' '{}' \";\"",
      preview: "for package.json in apps",
      itemType: "command_execution",
      toolCallId: "call_UmQKQmLCCrj9PF82rupLIFDO",
    });
  });
});
