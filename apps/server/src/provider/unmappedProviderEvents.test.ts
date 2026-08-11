import { EventId, ThreadId, TurnId, type ProviderEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { MAX_ACTIVITY_DATA_JSON_CHARS } from "../activityData.ts";
import {
  makeUnmappedProviderEventGate,
  sanitizeUnmappedProviderData,
  sanitizeUnmappedProviderDetail,
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

  it("redacts credentials embedded in ordinary native-event string fields", () => {
    const sanitized = sanitizeUnmappedProviderEvent(
      providerEvent("item/future/completed", {
        payload: {
          message: "Retrying with api_key=hunter2",
          nested: {
            detail: "Authorization: Bearer abc.def",
          },
        },
      }),
    );

    expect(sanitized.payload).toEqual({
      message: "Retrying with api_key=[REDACTED]",
      nested: {
        detail: "Authorization: [REDACTED]",
      },
    });
  });

  it("redacts nested camel and snake case secret-key families without hiding ordinary fields", () => {
    expect(
      sanitizeUnmappedProviderData({
        nested: {
          secretKey: "secret-key-value",
          secret_key: "snake-secret-key-value",
          awsSecretAccessKey: "aws-secret-access-key-value",
          clientSecret: "client-secret-value",
          tokenCount: 42,
          secretLabel: "safe diagnostic label",
          keyboardShortcut: "Command+K",
          monkey: "banana",
        },
      }),
    ).toEqual({
      nested: {
        secretKey: "[REDACTED]",
        secret_key: "[REDACTED]",
        awsSecretAccessKey: "[REDACTED]",
        clientSecret: "[REDACTED]",
        tokenCount: 42,
        secretLabel: "safe diagnostic label",
        keyboardShortcut: "Command+K",
        monkey: "banana",
      },
    });
  });

  it("redacts credential assignments and authorization headers from readable details", () => {
    expect(
      sanitizeUnmappedProviderDetail(
        "Retry failed: api_key=hunter2; Authorization: Bearer abc.def; status=unauthorized",
      ),
    ).toBe("Retry failed: api_key=[REDACTED]; Authorization: [REDACTED]; status=unauthorized");
    expect(sanitizeUnmappedProviderDetail("Authorization is required for this operation")).toBe(
      "Authorization is required for this operation",
    );
  });

  it("redacts cookie headers and private-key assignments from diagnostic data string leaves", () => {
    expect(
      sanitizeUnmappedProviderData({
        cookieHeader: "Cookie: session=abc; theme=dark",
        responseHeader: "Set-Cookie: session=def; Path=/; HttpOnly",
        note: "private_key=private-material",
        safe: "Cookie policy is strict and private keys are never logged",
      }),
    ).toEqual({
      cookieHeader: "Cookie: [REDACTED]",
      responseHeader: "Set-Cookie: [REDACTED]",
      note: "private_key=[REDACTED]",
      safe: "Cookie policy is strict and private keys are never logged",
    });
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

  it("releases abandoned scopes by thread and caps retained scope state", () => {
    const gate = makeUnmappedProviderEventGate({ maxTrackedScopes: 2 });
    const first = providerEvent("item/future/outputDelta", {
      threadId: ThreadId.makeUnsafe("thread-first"),
    });
    const second = providerEvent("item/future/outputDelta", {
      threadId: ThreadId.makeUnsafe("thread-second"),
    });
    const third = providerEvent("item/future/outputDelta", {
      threadId: ThreadId.makeUnsafe("thread-third"),
    });

    expect(gate.shouldSurface(first)).toBe(true);
    expect(gate.shouldSurface(second)).toBe(true);
    expect(gate.shouldSurface(third)).toBe(true);
    expect(gate.shouldSurface(first)).toBe(true);
    expect(gate.shouldSurface(second)).toBe(true);
    expect(gate.shouldSurface(second)).toBe(false);

    gate.releaseThread(first.threadId);

    expect(gate.shouldSurface(first)).toBe(true);
  });
});
