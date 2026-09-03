import type { OrchestrationThreadActivity, ProviderRuntimeEvent } from "@synara/contracts";
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  OrchestrationCommand,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  projectProviderRuntimeActivities,
  providerActivityUpdateDedupeKey,
  providerActivityUpdateFingerprint,
} from "./providerRuntimeActivityProjection.ts";

const CREATED_AT = "2026-07-20T10:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-activity-projection");
const TURN_ID = TurnId.makeUnsafe("turn-activity-projection");

function runtimeEvent(input: Record<string, unknown> & { eventId: string }): ProviderRuntimeEvent {
  return {
    provider: "codex",
    createdAt: CREATED_AT,
    threadId: THREAD_ID,
    ...input,
    eventId: EventId.makeUnsafe(input.eventId),
  } as ProviderRuntimeEvent;
}

/**
 * The single invariant that matters: every activity this projection emits has to
 * survive the schema of the command that carries it. Server-built commands never
 * cross the WebSocket decode boundary, so nothing else enforces the schema-only
 * refinements (`TrimmedNonEmptyString`, `Schema.Json`) that TypeScript cannot express.
 */
function decodeActivityAppendCommand(activity: OrchestrationThreadActivity): unknown {
  return Schema.decodeUnknownSync(OrchestrationCommand)({
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe("cmd-activity-append"),
    threadId: THREAD_ID,
    activity,
    createdAt: CREATED_AT,
  });
}

function expectSchemaValidActivities(event: ProviderRuntimeEvent, sessionSequence?: number): void {
  const activities = projectProviderRuntimeActivities(event, sessionSequence);
  expect(activities.length).toBeGreaterThan(0);
  for (const activity of activities) {
    expect(() => decodeActivityAppendCommand(activity)).not.toThrow();
  }
}

describe("projected activities satisfy the orchestration command schema", () => {
  it("omits an absent approval request id instead of emitting an explicit undefined", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-without-request-id",
        turnId: TURN_ID,
        payload: { requestType: "command_execution_approval", detail: "rm -rf build" },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "request.resolved",
        eventId: "approval-resolved-without-request-id",
        turnId: TURN_ID,
        payload: { requestType: "command_execution_approval", decision: "approved" },
      }),
    );
    const [opened] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-without-request-id",
        turnId: TURN_ID,
        payload: { requestType: "command_execution_approval" },
      }),
    );
    expect(Object.keys(opened?.payload as Record<string, unknown>)).not.toContain("requestId");

    // `ApprovalRequestId.makeUnsafe` rejects untrimmed input instead of trimming it.
    const [padded] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-padded-request-id",
        turnId: TURN_ID,
        requestId: "  approval-7  ",
        payload: { requestType: "command_execution_approval" },
      }),
    );
    expect(padded?.payload).toMatchObject({ requestId: "approval-7" });
  });

  it("never derives a blank summary from a blank tool name or title", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "tool.progress",
        eventId: "tool-progress-blank-name",
        turnId: TURN_ID,
        payload: { toolUseId: "tool-blank", toolName: "   ", summary: "" },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "item-completed-blank-title",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("tool-item"),
        payload: { itemType: "command_execution", status: "completed", title: "" },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "item.updated",
        eventId: "item-updated-blank-title",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("tool-item"),
        payload: { itemType: "command_execution", status: "inProgress", title: "  " },
      }),
    );
  });

  // `TurnId.makeUnsafe` validates: it rejects "" *and* untrimmed input rather than
  // normalizing it, so an unnormalized runtime turn id throws inside the projection
  // itself before it can even reach the command schema.
  it("normalizes a blank or untrimmed runtime turn id instead of throwing", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "turn.completed",
        eventId: "turn-blank-turn-id",
        turnId: "",
        payload: { state: "completed" },
      }),
    );
    const [padded] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "turn.completed",
        eventId: "turn-padded-turn-id",
        turnId: "  turn-padded  ",
        payload: { state: "completed" },
      }),
    );
    expect(padded?.turnId).toBe("turn-padded");
  });

  it("drops a fractional runtime sequence rather than emitting a non-integer", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "turn.steered",
        eventId: "turn-steered-fractional-sequence",
        turnId: TURN_ID,
        payload: { message: "keep going" },
      }),
      12.5,
    );
  });

  it("projects a subagent steer but not a steer of the thread's own turn", () => {
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "turn.steered",
          eventId: "turn-steered-own-turn",
          turnId: TURN_ID,
          payload: { message: "dimmi ciao subito", target: "turn" },
        }),
      ),
    ).toEqual([]);
    expectSchemaValidActivities(
      runtimeEvent({
        type: "turn.steered",
        eventId: "turn-steered-subagent",
        turnId: TURN_ID,
        payload: { message: "dimmi ciao subito", target: "subagent" },
      }),
    );
  });

  it("keeps raw provider payloads inside what Schema.Json admits", () => {
    const cyclic: Record<string, unknown> = { window: "5h" };
    cyclic.self = cyclic;
    const rateLimitsEvent = runtimeEvent({
      type: "account.rate-limits.updated",
      eventId: "rate-limits-hostile",
      payload: {
        rateLimits: {
          status: "rejected",
          utilization: 0.9,
          resetsAt: undefined,
          planTier: undefined,
          requestCount: 42n,
          onReset: () => undefined,
          observedAt: new Date("2026-07-27T00:00:00.000Z"),
          cyclic,
        },
      },
    });
    expectSchemaValidActivities(rateLimitsEvent);
    const rateLimitsActivity = projectProviderRuntimeActivities(rateLimitsEvent).find(
      (activity) => activity.kind === "account.rate-limits.updated",
    );
    expect(rateLimitsActivity?.payload).toMatchObject({
      observedAt: "2026-07-27T00:00:00.000Z",
    });
    expectSchemaValidActivities(
      runtimeEvent({
        type: "thread.token-usage.updated",
        eventId: "token-usage-explicit-undefined",
        turnId: TURN_ID,
        payload: { usage: { usedTokens: 1_000, maxTokens: 200_000, usedPercent: undefined } },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "task.progress",
        eventId: "task-progress-raw-usage",
        turnId: TURN_ID,
        payload: {
          taskId: "task-1",
          description: "Working",
          usage: { inputTokens: 10, outputTokens: undefined, costUsd: Number.NaN },
        },
      }),
    );
  });
});

describe("provider runtime activity projection", () => {
  it("keeps assistant text and assistant lifecycle events out of work activity", () => {
    const events = [
      runtimeEvent({
        type: "content.delta",
        eventId: "assistant-delta",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("assistant-item"),
        payload: { streamKind: "assistant_text", delta: "hello" },
      }),
      runtimeEvent({
        type: "item.started",
        eventId: "assistant-started",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("assistant-item"),
        payload: { itemType: "assistant_message", status: "inProgress" },
      }),
      runtimeEvent({
        type: "item.completed",
        eventId: "assistant-completed",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("assistant-item"),
        payload: { itemType: "assistant_message", status: "completed" },
      }),
    ];

    expect(events.map(projectProviderRuntimeActivities)).toEqual([[], [], []]);
  });

  it("projects only readable completed Codex-family reasoning summaries", () => {
    const absent = [
      runtimeEvent({
        type: "content.delta",
        eventId: "reasoning-delta",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-item"),
        payload: { streamKind: "reasoning_summary_text", delta: "Inspecting code" },
      }),
      runtimeEvent({
        type: "item.completed",
        eventId: "reasoning-private",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-private"),
        payload: {
          itemType: "reasoning",
          status: "completed",
          detail: "  <!-- encrypted reasoning -->  ",
        },
      }),
      runtimeEvent({
        type: "item.completed",
        eventId: "reasoning-cursor",
        provider: "cursor",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-cursor"),
        payload: { itemType: "reasoning", status: "completed", detail: "Readable" },
      }),
    ];
    expect(absent.map(projectProviderRuntimeActivities)).toEqual([[], [], []]);

    for (const provider of ["codex", "antigravity"] as const) {
      const [activity] = projectProviderRuntimeActivities(
        runtimeEvent({
          type: "item.completed",
          eventId: `reasoning-${provider}`,
          provider,
          turnId: TURN_ID,
          itemId: RuntimeItemId.makeUnsafe(`reasoning-${provider}`),
          payload: {
            itemType: "reasoning",
            status: "completed",
            detail: "Read the protocol mapping",
          },
        }),
      );
      expect(activity).toMatchObject({
        id: `provider-reasoning:${THREAD_ID}:reasoning-${provider}`,
        kind: "task.progress",
        summary: "Reasoning trace",
        payload: {
          status: "completed",
          detail: "Read the protocol mapping",
          data: { toolCallId: `reasoning-${provider}` },
        },
      });
    }
  });

  it("maps tool progress without losing call identity", () => {
    const event = runtimeEvent({
      type: "tool.progress",
      eventId: "tool-progress",
      turnId: TURN_ID,
      payload: {
        toolUseId: "tool-1",
        toolName: "mcp__github__fetch_pr",
        summary: "Fetching PR",
        elapsedSeconds: 1.2,
      },
    });
    const [activity] = projectProviderRuntimeActivities(event);

    expect(activity).toMatchObject({
      kind: "tool.updated",
      tone: "tool",
      summary: "mcp__github__fetch_pr",
      payload: {
        itemType: "mcp_tool_call",
        title: "MCP tool call",
        detail: "Fetching PR",
        data: {
          toolUseId: "tool-1",
          toolName: "mcp__github__fetch_pr",
          summary: "Fetching PR",
          elapsedSeconds: 1.2,
        },
      },
    });
    expect(providerActivityUpdateDedupeKey(event, THREAD_ID, activity!)).toBe(
      `${THREAD_ID}:codex:tool.updated:tool-1`,
    );
    expect(providerActivityUpdateFingerprint(activity!)).toContain('"kind":"tool.updated"');
  });

  it("keeps the fast JSON fingerprint byte-identical to the legacy JSON-like serializer", () => {
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "tool.progress",
        eventId: "tool-progress-fingerprint",
        turnId: TURN_ID,
        payload: {
          toolUseId: "tool-fingerprint",
          toolName: "mcp__github__fetch_pr",
          summary: "Fetching PR",
          elapsedSeconds: 2.4,
        },
      }),
    );
    const legacyFingerprint = JSON.stringify(
      {
        kind: activity!.kind,
        summary: activity!.summary,
        payload: activity!.payload,
        turnId: activity!.turnId,
      },
      (() => {
        const seen = new WeakSet<object>();
        return (_key: string, entry: unknown) => {
          if (typeof entry === "bigint") return entry.toString();
          if (typeof entry === "function" || typeof entry === "symbol") return undefined;
          if (entry && typeof entry === "object") {
            if (seen.has(entry)) return "[Circular]";
            seen.add(entry);
          }
          return entry;
        };
      })(),
    );

    expect(providerActivityUpdateFingerprint(activity!)).toBe(legacyFingerprint);
  });

  it.each(["antigravity", "codex"] as const)(
    "projects %s tool lifecycle events through the same canonical activities",
    (provider) => {
      const itemId = RuntimeItemId.makeUnsafe(`${provider}-tool-1`);
      const data = { toolCallId: itemId, toolName: "run_command" };
      const [started] = projectProviderRuntimeActivities(
        runtimeEvent({
          provider,
          type: "item.started",
          eventId: `${provider}-tool-started`,
          turnId: TURN_ID,
          itemId,
          payload: {
            itemType: "command_execution",
            status: "inProgress",
            title: "run_command",
            data,
          },
        }),
      );
      const [completed] = projectProviderRuntimeActivities(
        runtimeEvent({
          provider,
          type: "item.completed",
          eventId: `${provider}-tool-completed`,
          turnId: TURN_ID,
          itemId,
          payload: {
            itemType: "command_execution",
            status: "completed",
            title: "run_command",
            data,
          },
        }),
      );

      expect(started).toMatchObject({
        kind: "tool.started",
        summary: "run_command started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "run_command",
          data,
        },
      });
      expect(completed).toMatchObject({
        kind: "tool.completed",
        summary: "run_command",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "run_command",
          data,
        },
      });
      expect(() => decodeActivityAppendCommand(started!)).not.toThrow();
      expect(() => decodeActivityAppendCommand(completed!)).not.toThrow();
    },
  );

  it("maps canonical approvals and structured user input", () => {
    const approval = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-request",
        lifecycleGeneration: "generation-1",
        requestId: ApprovalRequestId.makeUnsafe("request-1"),
        payload: {
          requestType: "command_execution_approval",
          detail: "pwd",
          args: { sessionApprovalAvailable: false },
        },
      }),
    )[0];
    expect(approval).toMatchObject({
      kind: "approval.requested",
      summary: "Command approval requested",
      payload: {
        requestId: "request-1",
        lifecycleGeneration: "generation-1",
        requestKind: "command",
        requestType: "command_execution_approval",
        detail: "pwd",
        sessionApprovalAvailable: false,
      },
    });

    const permissionApproval = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "permission-approval-request",
        requestId: ApprovalRequestId.makeUnsafe("permission-request-1"),
        payload: {
          requestType: "permissions_approval",
          detail: "Needs package metadata",
          args: {
            permissions: {
              network: { enabled: true },
              fileSystem: { read: ["/tmp/example"] },
            },
          },
        },
      }),
    )[0];
    expect(permissionApproval).toMatchObject({
      kind: "approval.requested",
      summary: "Permission approval requested",
      payload: {
        requestKind: "permissions",
        detail: "Needs package metadata",
        permissionProfile: {
          network: { enabled: true },
          fileSystem: { read: ["/tmp/example"] },
        },
      },
    });

    const userInput = [
      runtimeEvent({
        type: "user-input.requested",
        eventId: "user-input-requested",
        turnId: TURN_ID,
        lifecycleGeneration: "generation-2",
        requestId: ApprovalRequestId.makeUnsafe("request-2"),
        payload: {
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode?",
              options: [{ label: "workspace-write", description: "Workspace writes" }],
            },
          ],
        },
      }),
      runtimeEvent({
        type: "user-input.resolved",
        eventId: "user-input-resolved",
        turnId: TURN_ID,
        lifecycleGeneration: "generation-2",
        requestId: ApprovalRequestId.makeUnsafe("request-2"),
        payload: { answers: { sandbox_mode: "workspace-write" } },
      }),
    ].flatMap(projectProviderRuntimeActivities);

    expect(userInput).toMatchObject([
      {
        kind: "user-input.requested",
        payload: {
          requestId: "request-2",
          lifecycleGeneration: "generation-2",
          questions: [{ id: "sandbox_mode" }],
        },
      },
      {
        kind: "user-input.resolved",
        payload: {
          requestId: "request-2",
          lifecycleGeneration: "generation-2",
          answers: { sandbox_mode: "workspace-write" },
        },
      },
    ]);
  });

  it("bounds pathological tool payloads before persistence", () => {
    const data = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `field-${index.toString().padStart(3, "0")}`,
        "x".repeat(3_000),
      ]),
    );
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "large-tool-payload",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("large-tool"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Large command",
          data,
        },
      }),
    );
    const payload = activity?.payload as { data?: Record<string, unknown> };

    expect(JSON.stringify(payload.data).length).toBeLessThanOrEqual(16_000);
    expect(payload.data?.__synaraTruncated).toBe(true);
    expect(payload.data?.originalJsonChars).toBeGreaterThan(300_000);
  });

  it("compacts context and per-model usage into stable activity payloads", () => {
    const [usage] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "thread.token-usage.updated",
        eventId: "context-usage",
        provider: "claudeAgent",
        payload: { usage: { usedTokens: 1_200, maxTokens: 200_000, usedPercent: 0.6 } },
      }),
    );
    expect(usage).toMatchObject({
      kind: "context-window.updated",
      payload: {
        usedTokens: 1_200,
        maxTokens: 200_000,
        usedPercent: 0.6,
        provider: "claudeAgent",
      },
    });

    const [accountingOnlyUsage] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "thread.token-usage.updated",
        eventId: "context-usage-accounting-only",
        provider: "claudeAgent",
        payload: { usage: { usedTokens: 0, totalProcessedTokens: 340_000 } },
      }),
    );
    expect(accountingOnlyUsage).toMatchObject({
      kind: "context-window.updated",
      payload: {
        usedTokens: 0,
        totalProcessedTokens: 340_000,
        provider: "claudeAgent",
      },
    });

    const [configured] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "context-configured",
        provider: "claudeAgent",
        payload: { config: { autoCompactWindow: "1m" } },
      }),
    );
    expect(configured).toMatchObject({
      kind: "context-window.configured",
      payload: { maxTokens: 1_000_000, contextWindow: "1m" },
    });

    const [legacyConfigured] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "legacy-context-configured",
        provider: "claudeAgent",
        payload: { config: { contextWindow: "200k" } },
      }),
    );
    expect(legacyConfigured).toMatchObject({
      kind: "context-window.configured",
      payload: { maxTokens: 200_000, contextWindow: "200k" },
    });

    const [clearedConfigured] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "cleared-context-configured",
        provider: "claudeAgent",
        payload: { config: { autoCompactWindow: null } },
      }),
    );
    expect(clearedConfigured).toMatchObject({
      kind: "context-window.configured",
      payload: { cleared: true },
    });

    const [turn] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "turn.completed",
        eventId: "turn-usage",
        provider: "claudeAgent",
        turnId: TURN_ID,
        payload: {
          state: "completed",
          modelUsage: {
            "claude-fable-5": {
              inputTokens: 100,
              outputTokens: 40,
              cacheReadInputTokens: 800,
              cacheCreationInputTokens: 60,
            },
            unused: { inputTokens: 0, outputTokens: 0 },
          },
        },
      }),
    );
    expect(turn).toMatchObject({
      kind: "turn.completed",
      payload: {
        state: "completed",
        modelUsage: {
          "claude-fable-5": { inputTokens: 960, outputTokens: 40, totalTokens: 1_000 },
        },
      },
    });
    expect(
      Object.keys((turn?.payload as { modelUsage?: Record<string, unknown> }).modelUsage ?? {}),
    ).toEqual(["claude-fable-5"]);
  });

  it("projects unmapped passthrough events instead of dropping them", () => {
    const oversizedDiagnostic = "x".repeat(64_000);
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "event.unmapped",
        eventId: "unmapped-native-event",
        turnId: TURN_ID,
        payload: {
          nativeType: "item/agentMessage/completed",
          detail: "Finished the refactor",
          data: {
            secretKey: "must-not-reach-the-activity-snapshot",
            note: "api_key=another-secret",
            output: oversizedDiagnostic,
          },
        },
      }),
    );
    expect(activity).toMatchObject({
      tone: "info",
      kind: "provider.event.unmapped",
      // Raw native type/label is the row title.
      summary: "item/agentMessage/completed",
      turnId: TURN_ID,
      payload: {
        nativeEventType: "item/agentMessage/completed",
        detail: "Finished the refactor",
        data: expect.objectContaining({ __synaraTruncated: true }),
      },
    });
    const serializedPayload = JSON.stringify(activity?.payload);
    expect(serializedPayload.length).toBeLessThan(17_000);
    expect(serializedPayload).not.toContain("must-not-reach-the-activity-snapshot");
    expect(serializedPayload).not.toContain("another-secret");
    // The activity must survive the schema of the command that carries it.
    expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

    // A passthrough event without a native type is the one case still dropped.
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "event.unmapped",
          eventId: "unmapped-without-type",
          payload: { detail: "no type" },
        }),
      ),
    ).toEqual([]);
  });

  it("keeps routine hook lifecycle internal and surfaces only consequential completions", () => {
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "hook.started",
          eventId: "hook-started",
          turnId: TURN_ID,
          payload: {
            hookId: "hook-run-1",
            hookName: "/Users/example/.codex/hooks.json",
            hookEvent: "preToolUse",
          },
        }),
      ),
    ).toEqual([]);
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "hook.progress",
          eventId: "hook-progress",
          turnId: TURN_ID,
          payload: {
            hookId: "hook-run-1",
            stdout: "Still running.",
          },
        }),
      ),
    ).toEqual([]);
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "hook.completed",
          eventId: "hook-success",
          turnId: TURN_ID,
          payload: {
            hookId: "hook-run-1",
            hookName: "/Users/example/.codex/hooks.json",
            hookEvent: "preToolUse",
            outcome: "success",
            status: "completed",
            durationMs: 8,
          },
        }),
      ),
    ).toEqual([]);
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "hook.completed",
          eventId: "hook-cancelled",
          turnId: TURN_ID,
          payload: {
            hookId: "hook-run-2",
            outcome: "cancelled",
          },
        }),
      ),
    ).toEqual([]);

    const [failed] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "hook.completed",
        eventId: "hook-failed",
        turnId: TURN_ID,
        payload: {
          hookId: "hook-run-3",
          hookName: "/Users/example/.codex/hooks.json",
          hookEvent: "postToolUse",
          outcome: "error",
          status: "failed",
          statusMessage: "Hook process exited with code 1.",
          durationMs: 20,
        },
      }),
    );
    expect(failed).toMatchObject({
      tone: "error",
      kind: "runtime.warning",
      summary: "postToolUse hook failed",
      payload: {
        message: "Hook process exited with code 1.",
        hookId: "hook-run-3",
        hookEvent: "postToolUse",
        outcome: "error",
        status: "failed",
        durationMs: 20,
      },
    });
    expect(() => decodeActivityAppendCommand(failed!)).not.toThrow();

    const [blocked] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "hook.completed",
        eventId: "hook-blocked",
        turnId: TURN_ID,
        payload: {
          hookId: "hook-run-4",
          hookEvent: "preToolUse",
          outcome: "cancelled",
          status: "blocked",
          statusMessage: "Policy blocked the command.",
        },
      }),
    );
    expect(blocked).toMatchObject({
      tone: "info",
      kind: "runtime.warning",
      summary: "preToolUse hook blocked an action",
      payload: {
        message: "Policy blocked the command.",
        outcome: "cancelled",
        status: "blocked",
      },
    });
    expect(() => decodeActivityAppendCommand(blocked!)).not.toThrow();
  });
});
