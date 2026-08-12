import { EventId, ThreadId, TurnId, type ProviderEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  makeUnmappedProviderEventGate,
  MAX_UNMAPPED_PROVIDER_DATA_JSON_CHARS,
  sanitizeUnmappedProviderData,
  sanitizeUnmappedProviderEvent,
} from "./unmappedProviderEvents.ts";

function event(
  method: string,
  threadId = "thread-unmapped",
  lifecycleGeneration?: string,
): ProviderEvent {
  return {
    id: EventId.makeUnsafe(`event-${method}-${threadId}`),
    kind: "notification",
    provider: "codex",
    threadId: ThreadId.makeUnsafe(threadId),
    turnId: TurnId.makeUnsafe("turn-unmapped"),
    createdAt: "2026-08-11T08:00:00.000Z",
    method,
    ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
  };
}

describe("unmapped provider event safety", () => {
  it("redacts and bounds native and durable diagnostic payloads", () => {
    const payload = {
      secretKey: "secret-key-value",
      awsSecretAccessKey: "aws-secret-access-key-value",
      nested: {
        message: "api_key=hunter2",
        detail: "Authorization: Bearer abc.def",
        cookieHeader: "Cookie: session=cookie-secret; theme=dark",
        responseHeader: "Set-Cookie: session=response-secret; HttpOnly",
        note: "private_key=private-key-material",
      },
      safe: "Cookie policy is strict",
      output: "x".repeat(MAX_UNMAPPED_PROVIDER_DATA_JSON_CHARS * 4),
    };

    const sanitizedData = sanitizeUnmappedProviderData(payload);
    const sanitizedEvent = sanitizeUnmappedProviderEvent({ ...event("future/completed"), payload });
    for (const sanitized of [sanitizedData, sanitizedEvent.payload]) {
      const serialized = JSON.stringify(sanitized);
      expect(serialized.length).toBeLessThan(MAX_UNMAPPED_PROVIDER_DATA_JSON_CHARS);
      expect(serialized).not.toContain("secret-key-value");
      expect(serialized).not.toContain("aws-secret-access-key-value");
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("abc.def");
      expect(serialized).not.toContain("cookie-secret");
      expect(serialized).not.toContain("response-secret");
      expect(serialized).not.toContain("private-key-material");
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).toContain("Cookie policy is strict");
      expect(serialized).toContain("__synaraTruncated");
    }
  });

  it("surfaces one bounded burst diagnostic per session and method", () => {
    const shouldSurface = makeUnmappedProviderEventGate(2);
    expect(shouldSurface(event("future/outputDelta"))).toBe(true);
    expect(shouldSurface(event("future/outputDelta"))).toBe(false);
    expect(shouldSurface(event("future/outputDelta", "thread-unmapped", "generation-2"))).toBe(
      true,
    );
    expect(shouldSurface(event("future/outputDelta", "thread-other"))).toBe(true);
    expect(shouldSurface(event("future/completed"))).toBe(true);
  });

  it("sanitizes and caps top-level native diagnostic fields", () => {
    const sanitized = sanitizeUnmappedProviderEvent({
      ...event(`future/${"m".repeat(64_000)}`),
      id: EventId.makeUnsafe("event-oversized-top-level"),
      message: `api_key=message-secret ${"m".repeat(2_000)}`,
      textDelta: `Authorization: Bearer delta-secret ${"d".repeat(2_000)}`,
    });
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.method.length).toBeLessThan(500);
    expect(sanitized.message?.length).toBeLessThan(600);
    expect(sanitized.textDelta?.length).toBeLessThan(600);
    expect(serialized).not.toContain("message-secret");
    expect(serialized).not.toContain("delta-secret");
    expect(serialized.length).toBeLessThan(2_000);
  });
});
