import { describe, expect, it } from "vitest";

import type * as Acp from "@agentclientprotocol/sdk";

import {
  extractModelConfigId,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
} from "./AcpRuntimeModel.ts";

describe("AcpRuntimeModel", () => {
  it("parses session mode state from typed ACP session setup responses", () => {
    const modeState = parseSessionModeState({
      sessionId: "session-1",
      modes: {
        currentModeId: " code ",
        availableModes: [
          { id: " ask ", name: " Ask ", description: " Request approval " },
          { id: " code ", name: " Code " },
        ],
      },
      configOptions: [],
    } satisfies Acp.NewSessionResponse);

    expect(modeState).toEqual({
      currentModeId: "code",
      availableModes: [
        { id: "ask", name: "Ask", description: "Request approval" },
        { id: "code", name: "Code" },
      ],
    });
  });

  it("extracts the model config id from typed ACP config options", () => {
    const modelConfigId = extractModelConfigId({
      sessionId: "session-1",
      configOptions: [
        {
          id: "approval",
          name: "Approval Mode",
          category: "permission",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Auto" }],
        },
      ],
    } satisfies Acp.NewSessionResponse);

    expect(modelConfigId).toBe("model");
  });

  it("projects typed ACP tool call updates into runtime events", () => {
    const created = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: {
          executable: "bun",
          args: ["run", "typecheck"],
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Running checks",
            },
          },
        ],
      },
    } satisfies Acp.SessionNotification);

    expect(created.events).toEqual([
      {
        _tag: "ToolCallUpdated",
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          title: "Ran command",
          status: "pending",
          command: "bun run typecheck",
          detail: "bun run typecheck",
          data: {
            toolCallId: "tool-1",
            kind: "execute",
            command: "bun run typecheck",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
      },
    ]);

    const updated = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    } satisfies Acp.SessionNotification);

    expect(updated.events).toHaveLength(1);
    expect(updated.events[0]?._tag).toBe("ToolCallUpdated");
    const createdEvent = created.events[0];
    const updatedEvent = updated.events[0];
    if (createdEvent?._tag === "ToolCallUpdated" && updatedEvent?._tag === "ToolCallUpdated") {
      expect(mergeToolCallState(createdEvent.toolCall, updatedEvent.toolCall)).toMatchObject({
        toolCallId: "tool-1",
        status: "completed",
        title: "Ran command",
        detail: "bun run typecheck",
        command: "bun run typecheck",
      });
    }
  });

  it("preserves Grok prompt-policy denial text on failed shell tools", () => {
    const pending = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-denied",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: { command: "git pull" },
      },
    } satisfies Acp.SessionNotification);
    const failed = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-denied",
        status: "failed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "denied by prompt policy (tool not pre-approved)",
            },
          },
        ],
      },
    } satisfies Acp.SessionNotification);

    const pendingEvent = pending.events[0];
    const failedEvent = failed.events[0];
    expect(pendingEvent?._tag).toBe("ToolCallUpdated");
    expect(failedEvent?._tag).toBe("ToolCallUpdated");
    if (pendingEvent?._tag === "ToolCallUpdated" && failedEvent?._tag === "ToolCallUpdated") {
      expect(mergeToolCallState(pendingEvent.toolCall, failedEvent.toolCall)).toMatchObject({
        status: "failed",
        command: "git pull",
        detail: "denied by prompt policy (tool not pre-approved)",
      });
    }
  });

  it("derives useful tool details when Cursor sends empty rawInput placeholders", () => {
    const searchCompleted = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "find-1",
        kind: "search",
        status: "completed",
        rawOutput: {
          totalFiles: 33,
          truncated: false,
        },
      },
    } satisfies Acp.SessionNotification);

    expect(searchCompleted.events).toHaveLength(1);
    expect(searchCompleted.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        toolCallId: "find-1",
        kind: "search",
        status: "completed",
        title: "Searched",
        detail: "33 files found",
      },
    });

    const readCompleted = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "read-1",
        kind: "read",
        status: "completed",
        rawOutput: {
          content: "one\ntwo\n",
        },
      },
    } satisfies Acp.SessionNotification);

    expect(readCompleted.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        toolCallId: "read-1",
        kind: "read",
        status: "completed",
        title: "Read",
        detail: "Read 2 lines",
      },
    });

    const locatedRead = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read-2",
        title: "Read File",
        kind: "read",
        status: "pending",
        rawInput: {},
        locations: [{ path: "src/index.ts", line: 12 }],
      },
    } satisfies Acp.SessionNotification);

    expect(locatedRead.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        toolCallId: "read-2",
        title: "Reading",
        kind: "read",
        detail: "src/index.ts:12",
      },
    });
  });

  it("infers Cursor placeholder kinds before deriving display titles", () => {
    const findPending = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "find-placeholder",
        title: "Find",
        status: "pending",
        rawInput: {},
      },
    } satisfies Acp.SessionNotification);

    expect(findPending.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        toolCallId: "find-placeholder",
        kind: "search",
        title: "Searching",
        data: {
          kind: "search",
        },
      },
    });

    const readPending = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read-placeholder",
        title: "Read File",
        status: "pending",
        rawInput: {},
      },
    } satisfies Acp.SessionNotification);

    expect(readPending.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        toolCallId: "read-placeholder",
        kind: "read",
        title: "Reading",
        data: {
          kind: "read",
        },
      },
    });
  });

  it("keeps inferred Cursor action titles when completion updates only contain generic Tool", () => {
    const pending = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "find-placeholder",
        title: "Find",
        status: "pending",
        rawInput: {},
      },
    } satisfies Acp.SessionNotification);
    const completed = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "find-placeholder",
        title: "Tool",
        status: "completed",
        rawOutput: {
          totalFiles: 4,
          truncated: false,
        },
      },
    } satisfies Acp.SessionNotification);

    const pendingEvent = pending.events[0];
    const completedEvent = completed.events[0];
    if (pendingEvent?._tag === "ToolCallUpdated" && completedEvent?._tag === "ToolCallUpdated") {
      expect(mergeToolCallState(pendingEvent.toolCall, completedEvent.toolCall)).toMatchObject({
        toolCallId: "find-placeholder",
        kind: "search",
        status: "completed",
        title: "Searched",
        detail: "4 files found",
      });
    }
  });

  it("trims padded current mode updates before emitting a mode change", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: " code ",
      },
    } satisfies Acp.SessionNotification);

    expect(result.modeId).toBe("code");
    expect(result.events).toEqual([
      {
        _tag: "ModeChanged",
        modeId: "code",
      },
    ]);
  });

  it("projects typed ACP plan and content updates", () => {
    const planResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: " Inspect state ", priority: "high", status: "completed" },
          { content: "", priority: "medium", status: "in_progress" },
        ],
      },
    } satisfies Acp.SessionNotification);

    expect(planResult.events).toEqual([
      {
        _tag: "PlanUpdated",
        payload: {
          plan: [
            { step: "Inspect state", status: "completed" },
            { step: "Step 2", status: "inProgress" },
          ],
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: " Inspect state ", priority: "high", status: "completed" },
              { content: "", priority: "medium", status: "in_progress" },
            ],
          },
        },
      },
    ]);

    const contentResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "hello from acp",
        },
      },
    } satisfies Acp.SessionNotification);

    expect(contentResult.events).toEqual([
      {
        _tag: "ContentDelta",
        text: "hello from acp",
        streamKind: "assistant_text",
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "hello from acp",
            },
          },
        },
      },
    ]);

    const thoughtResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: " thought-1 ",
        content: {
          type: "text",
          text: "checking files",
        },
      },
    } satisfies Acp.SessionNotification);

    expect(thoughtResult.events).toEqual([
      {
        _tag: "ContentDelta",
        itemId: "thought-1",
        text: "checking files",
        streamKind: "reasoning_text",
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            messageId: " thought-1 ",
            content: {
              type: "text",
              text: "checking files",
            },
          },
        },
      },
    ]);
  });

  it("projects ACP usage updates into context-window snapshots", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        size: 1_000_000,
        used: 42_000,
        cost: {
          amount: 0.2,
          currency: "USD",
        },
      },
    } satisfies Acp.SessionNotification);

    expect(result.events).toEqual([
      {
        _tag: "UsageUpdated",
        usage: {
          usedTokens: 42_000,
          usedPercent: 4.2,
          maxTokens: 1_000_000,
          compactsAutomatically: true,
        },
        cost: {
          amount: 0.2,
          currency: "USD",
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "usage_update",
            size: 1_000_000,
            used: 42_000,
            cost: {
              amount: 0.2,
              currency: "USD",
            },
          },
        },
      },
    ]);
  });

  it("keeps permission request parsing compatible with loose extension payloads", () => {
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
      ],
      toolCall: {
        toolCallId: "tool-1",
        title: "`cat package.json`",
        kind: "execute",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Not in allowlist",
            },
          },
        ],
      },
    });

    expect(request).toMatchObject({
      kind: "execute",
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending",
        command: "cat package.json",
      },
    });
  });
});
