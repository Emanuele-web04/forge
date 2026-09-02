import { describe, expect, it } from "vitest";
import type { OrchestrationEvent } from "@synara/contracts";

import {
  decodeDiagnosticCursor,
  diagnosticFilterFingerprint,
  encodeDiagnosticCursor,
} from "./diagnosticCursor.ts";
import { sanitizeDiagnosticValue } from "./diagnosticSanitizer.ts";
import { shapeDiagnosticEvents } from "./threadDiagnosticSummary.ts";

describe("diagnostic cursor", () => {
  it("round-trips a thread-bound stable cursor", () => {
    const filterFingerprint = diagnosticFilterFingerprint({
      turnId: "turn-1",
      kinds: ["tool", "message"],
    });
    const encoded = encodeDiagnosticCursor({
      version: 1,
      kind: "event",
      threadId: "thread-1",
      filterFingerprint,
      highWaterSequence: 42,
      beforeSequence: 30,
    });
    expect(
      decodeDiagnosticCursor(encoded, { kind: "event", threadId: "thread-1", filterFingerprint }),
    ).toEqual({
      version: 1,
      kind: "event",
      threadId: "thread-1",
      filterFingerprint,
      highWaterSequence: 42,
      beforeSequence: 30,
    });
  });

  it("rejects cursors reused for another thread or evidence stream", () => {
    const encoded = encodeDiagnosticCursor({
      version: 1,
      kind: "activity",
      threadId: "thread-1",
      filterFingerprint: diagnosticFilterFingerprint({ kinds: [] }),
      highWaterSequence: 42,
      beforeSequence: 30,
    });
    expect(() =>
      decodeDiagnosticCursor(encoded, {
        kind: "event",
        threadId: "thread-1",
        filterFingerprint: diagnosticFilterFingerprint({ kinds: [] }),
      }),
    ).toThrow("valid event cursor");
    expect(() =>
      decodeDiagnosticCursor(encoded, {
        kind: "activity",
        threadId: "thread-2",
        filterFingerprint: diagnosticFilterFingerprint({ kinds: [] }),
      }),
    ).toThrow("thread-2");
  });

  it("rejects a cursor whose page boundary exceeds its stable high-water mark", () => {
    const filterFingerprint = diagnosticFilterFingerprint({ kinds: [] });
    const encoded = encodeDiagnosticCursor({
      version: 1,
      kind: "activity",
      threadId: "thread-1",
      filterFingerprint,
      highWaterSequence: 42,
      beforeSequence: 43,
    });

    expect(() =>
      decodeDiagnosticCursor(encoded, {
        kind: "activity",
        threadId: "thread-1",
        filterFingerprint,
      }),
    ).toThrow("valid activity cursor");
  });

  it("normalizes set-like filters and rejects a cursor when filters change", () => {
    const originalFingerprint = diagnosticFilterFingerprint({
      kinds: ["tool", "message", "tool"],
    });
    expect(diagnosticFilterFingerprint({ kinds: ["message", "tool"] })).toBe(originalFingerprint);
    const encoded = encodeDiagnosticCursor({
      version: 1,
      kind: "activity",
      threadId: "thread-1",
      filterFingerprint: originalFingerprint,
      highWaterSequence: 42,
      beforeSequence: 30,
    });

    expect(() =>
      decodeDiagnosticCursor(encoded, {
        kind: "activity",
        threadId: "thread-1",
        filterFingerprint: diagnosticFilterFingerprint({ kinds: ["error"] }),
      }),
    ).toThrow("valid activity cursor");
  });
});

describe("diagnostic sanitizer", () => {
  it("redacts sensitive keys and secrets embedded in strings", () => {
    expect(
      sanitizeDiagnosticValue({
        authorization: "Bearer abcdefghijklmnop",
        command: "tool --api-key topsecret sk-abcdefghijk",
        nested: { token: "do-not-return", safe: "visible" },
      }),
    ).toEqual({
      authorization: "[redacted]",
      command: "tool --api-key [redacted] [redacted]",
      nested: { token: "[redacted]", safe: "visible" },
    });
  });

  it("redacts URL credentials and sensitive query parameters", () => {
    expect(
      sanitizeDiagnosticValue({
        callback:
          "https://user:password@example.test/callback?token=supersecret&api_key=alsosecret&safe=visible",
        header: "Authorization: Basic abcdef Cookie=session-secret",
      }),
    ).toEqual({
      callback:
        "https://[redacted]@example.test/callback?token=[redacted]&api_key=[redacted]&safe=visible",
      header: "Authorization: [redacted] Cookie=[redacted]",
    });
  });
});

describe("diagnostic event shaping", () => {
  it("coalesces repeated message events while retaining the newest sequence", () => {
    const event = (sequence: number, text: string) =>
      ({
        sequence,
        type: "thread.message-sent",
        eventId: `event-${sequence}`,
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-07-20T10:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { message: { messageId: "message-1", role: "assistant", text } },
      }) as unknown as OrchestrationEvent;
    expect(shapeDiagnosticEvents([event(2, "complete"), event(1, "partial")], "summary")).toEqual([
      expect.objectContaining({ sequence: 2, coalescedEventCount: 2 }),
    ]);
  });

  it("keeps separated updates distinct so cursor pagination cannot skip intervening events", () => {
    const messageEvent = (sequence: number) =>
      ({
        sequence,
        type: "thread.message-sent",
        eventId: `event-${sequence}`,
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-07-20T10:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { messageId: "message-1", text: `delta-${sequence}` },
      }) as OrchestrationEvent;
    const intervening = {
      ...messageEvent(2),
      type: "thread.archived",
      eventId: "event-2",
      payload: { threadId: "thread-1" },
    } as OrchestrationEvent;

    expect(shapeDiagnosticEvents([messageEvent(3), intervening, messageEvent(1)], "none")).toEqual([
      expect.objectContaining({ sequence: 1 }),
      expect.objectContaining({ sequence: 2 }),
      expect.objectContaining({ sequence: 3 }),
    ]);
  });
});
