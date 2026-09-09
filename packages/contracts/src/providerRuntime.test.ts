import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderRuntimeEvent, type ProviderRuntimeEventType } from "./providerRuntime";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("includes turn.steered in the exported event type", () => {
    const eventType: ProviderRuntimeEventType = "turn.steered";
    expect(eventType).toBe("turn.steered");
  });

  it("decodes turn.tasks.updated for task-list rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.tasks.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        tasks: [
          { task: "Define event union", status: "completed" },
          { task: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.tasks.updated");
    if (parsed.type !== "turn.tasks.updated") {
      throw new Error("expected turn.tasks.updated");
    }
    expect(parsed.payload.tasks).toHaveLength(2);
    expect(parsed.payload.tasks[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes canonical hook completion diagnostics", () => {
    const parsed = decodeRuntimeEvent({
      type: "hook.completed",
      eventId: "event-hook-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        hookId: "hook-run-1",
        hookName: "/Users/example/.codex/hooks.json",
        hookEvent: "preToolUse",
        outcome: "cancelled",
        status: "blocked",
        statusMessage: "Destructive command blocked.",
        durationMs: 12,
        data: { handlerType: "command" },
      },
    });

    expect(parsed.type).toBe("hook.completed");
    if (parsed.type !== "hook.completed") {
      throw new Error("expected hook.completed");
    }
    expect(parsed.payload.status).toBe("blocked");
    expect(parsed.payload.hookEvent).toBe("preToolUse");
    expect(parsed.payload.durationMs).toBe(12);
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          usedPercent: 15.6255,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
    expect(parsed.payload.usage.usedPercent).toBe(15.6255);
  });

  it("decodes item.completed with raw (untrimmed) tool output in detail", () => {
    // Tool output legitimately carries leading/trailing whitespace; the durable
    // journal must not reject it (previously quarantined with
    // "Expected a string with no leading or trailing whitespace").
    const rawOutput = "COMMAND   PID  USER   FD   TYPE\nbun.exe 33263 zachz   10u  IPv4\ndone\n";
    const parsed = decodeRuntimeEvent({
      type: "item.completed",
      eventId: "event-tool-1",
      provider: "pi",
      sessionId: "runtime-session-4",
      createdAt: "2026-02-28T00:00:05.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "bash",
        detail: rawOutput,
      },
    });

    expect(parsed.type).toBe("item.completed");
    if (parsed.type !== "item.completed") {
      throw new Error("expected item.completed");
    }
    expect(parsed.payload.detail).toBe(rawOutput);
  });
});
