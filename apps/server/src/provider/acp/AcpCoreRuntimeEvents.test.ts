import { RuntimeRequestId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
  stampAcpRuntimeEventLifecycleGeneration,
} from "./AcpCoreRuntimeEvents.ts";

describe("AcpCoreRuntimeEvents", () => {
  it("stamps one captured lifecycle generation without mutating legacy events", () => {
    const event = makeAcpContentDeltaEvent({
      stamp: { eventId: "event-generation" as never, createdAt: "2026-07-14T00:00:00.000Z" },
      provider: "cursor",
      threadId: "thread-generation" as never,
      turnId: TurnId.makeUnsafe("turn-generation"),
      text: "hello",
      rawPayload: { sessionId: "session-generation" },
    });

    expect(stampAcpRuntimeEventLifecycleGeneration(event, undefined)).toBe(event);
    expect(stampAcpRuntimeEventLifecycleGeneration(event, "generation-7")).toEqual({
      ...event,
      lifecycleGeneration: "generation-7",
    });
    expect(event).not.toHaveProperty("lifecycleGeneration");
  });

  it("maps ACP permission requests to canonical runtime events", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.makeUnsafe("turn-1");
    const permissionRequest = {
      kind: "execute" as const,
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending" as const,
        command: "cat package.json",
        detail: "cat package.json",
        data: { toolCallId: "tool-1", kind: "execute" },
      },
    };

    expect(
      makeAcpRequestOpenedEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.makeUnsafe("request-1"),
        permissionRequest,
        detail: "cat package.json",
        args: { command: ["cat", "package.json"] },
        source: "acp.jsonrpc",
        method: "session/request_permission",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "exec_command_approval",
        detail: "cat package.json",
      },
    });

    expect(
      makeAcpRequestResolvedEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.makeUnsafe("request-1"),
        permissionRequest,
        decision: "accept",
      }),
    ).toMatchObject({
      type: "request.resolved",
      payload: {
        requestType: "exec_command_approval",
        decision: "accept",
      },
    });
  });

  // An approval whose request type has no renderable kind never reaches the user,
  // so every remaining ACP tool kind has to land on the canonical tool approval.
  it.each(["search", "fetch", "think", "other", "unknown"] as const)(
    "maps the %s ACP permission kind to a canonical tool approval",
    (kind) => {
      const stamp = { eventId: "event-kind" as never, createdAt: "2026-03-27T00:00:00.000Z" };
      const permissionRequest = {
        kind,
        detail: "run the tool",
        toolCall: {
          toolCallId: "tool-kind",
          kind,
          status: "pending" as const,
          detail: "run the tool",
          data: { toolCallId: "tool-kind", kind },
        },
      };

      expect(
        makeAcpRequestOpenedEvent({
          stamp,
          provider: "cursor",
          threadId: "thread-kind" as never,
          turnId: TurnId.makeUnsafe("turn-kind"),
          requestId: RuntimeRequestId.makeUnsafe("request-kind"),
          permissionRequest,
          detail: "run the tool",
          args: {},
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: {},
        }),
      ).toMatchObject({ payload: { requestType: "tool_approval" } });

      expect(
        makeAcpRequestResolvedEvent({
          stamp,
          provider: "cursor",
          threadId: "thread-kind" as never,
          turnId: TurnId.makeUnsafe("turn-kind"),
          requestId: RuntimeRequestId.makeUnsafe("request-kind"),
          permissionRequest,
          decision: "accept",
        }),
      ).toMatchObject({ payload: { requestType: "tool_approval" } });
    },
  );

  it("maps ACP core plan, tool-call, and content updates", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.makeUnsafe("turn-1");

    expect(
      makeAcpPlanUpdatedEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        payload: {
          plan: [{ step: "Inspect state", status: "inProgress" }],
        },
        source: "acp.cursor.extension",
        method: "cursor/update_todos",
        rawPayload: { todos: [] },
      }),
    ).toMatchObject({
      type: "turn.tasks.updated",
      payload: {
        tasks: [{ task: "Inspect state", status: "inProgress" }],
      },
      raw: {
        method: "cursor/update_todos",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          status: "completed",
          title: "Terminal",
          detail: "bun run test",
          data: { command: "bun run test" },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-2",
          kind: "execute",
          status: "pending",
          title: "Terminal",
          detail: "bun run test",
          data: { command: "bun run test" },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "command_execution",
        status: "inProgress",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-search",
          kind: "search",
          status: "pending",
          title: "Searching",
          data: { kind: "search" },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        text: "hello",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      itemId: "assistant:session-1:segment:0",
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        text: "thinking",
        streamKind: "reasoning_text",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "reasoning_text",
        delta: "thinking",
      },
    });

    expect(
      makeAcpAssistantItemEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        lifecycle: "item.started",
      }),
    ).toMatchObject({
      type: "item.started",
      itemId: "assistant:session-1:segment:0",
      payload: {
        itemType: "assistant_message",
        status: "inProgress",
      },
    });
  });
});
