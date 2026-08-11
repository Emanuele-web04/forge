import { EventId, ThreadId, TurnId, type ProviderEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { MAX_ACTIVITY_DATA_JSON_CHARS } from "../activityData.ts";
import {
  makeUnmappedProviderEventGate,
  sanitizeUnmappedProviderData,
  sanitizeUnmappedProviderEvent,
} from "./unmappedProviderEvents.ts";

const CREATED_AT = "2026-08-11T08:00:00.000Z";

function providerEvent(method: string, overrides: Partial<ProviderEvent> = {}): ProviderEvent {
  return {
    id: EventId.makeUnsafe(`event-${method}`),
    kind: "notification",
    provider: "codex",
    threadId: ThreadId.makeUnsafe("thread-unmapped-gate"),
    turnId: TurnId.makeUnsafe("turn-unmapped-gate"),
    createdAt: CREATED_AT,
    method,
    ...overrides,
  };
}

describe("sanitizeUnmappedProviderData", () => {
  it("redacts secret-shaped fields and bounds the retained diagnostic payload", () => {
    const sanitized = sanitizeUnmappedProviderData({
      authorization: "Bearer top-secret",
      api_key: "api-secret",
      nested: {
        refreshToken: "refresh-secret",
        safe: "visible",
      },
      output: "x".repeat(MAX_ACTIVITY_DATA_JSON_CHARS * 4),
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized.length).toBeLessThanOrEqual(MAX_ACTIVITY_DATA_JSON_CHARS);
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("api-secret");
    expect(serialized).not.toContain("refresh-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("visible");
    expect(serialized).toContain("__synaraTruncated");
  });

  it("sanitizes the native event before it enters the callback ingress", () => {
    const sanitized = sanitizeUnmappedProviderEvent(
      providerEvent("item/future/completed", {
        payload: {
          accessToken: "native-event-secret",
          summary: "Useful summary",
        },
      }),
    );
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("native-event-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("Useful summary");
  });
});

describe("unmapped provider event gate", () => {
  it("surfaces one burst diagnostic per method and turn, then releases the turn", () => {
    const gate = makeUnmappedProviderEventGate();
    const delta = providerEvent("item/future/outputDelta");

    expect(gate.shouldSurface(delta)).toBe(true);
    expect(gate.shouldSurface(providerEvent("item/future/outputDelta"))).toBe(false);
    expect(gate.shouldSurface(providerEvent("item/future/progress"))).toBe(true);
    expect(gate.shouldSurface(providerEvent("item/future/updated"))).toBe(true);
    expect(gate.shouldSurface(providerEvent("item/future/updated"))).toBe(false);
    expect(gate.shouldSurface(providerEvent("item/future/completed"))).toBe(true);

    gate.release(providerEvent("turn/completed"));

    expect(gate.shouldSurface(providerEvent("item/future/outputDelta"))).toBe(true);
  });
});
