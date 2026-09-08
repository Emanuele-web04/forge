import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compactProviderRuntimeEventForIngress,
  PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES,
} from "./providerRuntimeEventIngress.ts";

function runtimeDelta(rawPayload: unknown): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    eventId: EventId.makeUnsafe("runtime-ingress-event"),
    provider: "codex",
    createdAt: "2026-08-20T00:00:00.000Z",
    threadId: ThreadId.makeUnsafe("runtime-ingress-thread"),
    turnId: TurnId.makeUnsafe("runtime-ingress-turn"),
    payload: { streamKind: "assistant_text", delta: "hello" },
    raw: {
      source: "codex.app-server.notification",
      method: "item/agentMessage/delta",
      payload: rawPayload,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider runtime event ingress sizing", () => {
  it("measures a normal event once and carries its exact byte count", () => {
    const event = runtimeDelta({ delta: "hello" });
    const expectedBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    const stringify = vi.spyOn(JSON, "stringify");
    const sized = compactProviderRuntimeEventForIngress(event);

    expect(sized.event).toBe(event);
    expect(sized.bytes).toBe(expectedBytes);
    expect(stringify).toHaveBeenCalledTimes(1);
  });

  it("measures the original and replacement objects once when compaction is required", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const event = runtimeDelta({
      output: "x".repeat(PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES),
    });
    const sized = compactProviderRuntimeEventForIngress(event);
    const callsBeforeAssertion = stringify.mock.calls.length;

    expect(sized.event).not.toBe(event);
    expect(sized.event.raw?.payload).toMatchObject({
      synaraTruncated: true,
      originalBytes: expect.any(Number),
    });
    expect(callsBeforeAssertion).toBe(2);
    expect(sized.bytes).toBe(Buffer.byteLength(JSON.stringify(sized.event), "utf8"));
  });
});

it("strips images from canonical and raw payloads before ingress sizing", () => {
  const data = "a".repeat(700_000);
  const event: ProviderRuntimeEvent = {
    ...runtimeDelta({ content: [{ type: "image", data, mimeType: "image/png" }] }),
    type: "item.completed",
    payload: {
      itemType: "mcp_tool_call",
      data: { result: { content: [{ type: "image", data, mimeType: "image/png" }] } },
    },
  };
  const stringify = vi.spyOn(JSON, "stringify");
  const sized = compactProviderRuntimeEventForIngress(event);
  expect(sized.bytes).toBeLessThan(2000);
  expect(stringify.mock.calls).toHaveLength(1);
  expect(JSON.stringify(stringify.mock.calls[0]?.[0])).not.toContain(data);
  expect(JSON.stringify(event)).toContain(data);
});
