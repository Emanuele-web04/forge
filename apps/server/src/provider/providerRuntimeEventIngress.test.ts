import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  compactProviderRuntimeEventForIngress,
  PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES,
  providerRuntimeEventBytes,
} from "./providerRuntimeEventIngress.ts";

describe("compactProviderRuntimeEventForIngress", () => {
  it("bounds every unmapped diagnostic field before journal admission", () => {
    const event = {
      eventId: EventId.makeUnsafe("event-unmapped-oversized"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-unmapped-oversized"),
      turnId: TurnId.makeUnsafe("turn-unmapped-oversized"),
      createdAt: "2026-08-11T08:00:00.000Z",
      type: "event.unmapped",
      payload: {
        nativeType: "item/future/completed",
        detail: "d".repeat(PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES * 2),
        data: { token: "journal-secret", output: "x".repeat(64_000) },
      },
      raw: {
        source: "codex.app-server.notification",
        method: "item/future/completed",
        payload: { token: "raw-secret" },
      },
    } satisfies ProviderRuntimeEvent;

    const compacted = compactProviderRuntimeEventForIngress(event);
    expect(providerRuntimeEventBytes(compacted)).toBeLessThanOrEqual(
      PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES,
    );
    expect(JSON.stringify(compacted)).not.toContain("journal-secret");
    expect(JSON.stringify(compacted)).not.toContain("raw-secret");
    expect(compacted.type === "event.unmapped" && compacted.payload.detail.length).toBeLessThan(
      1_000,
    );
  });
});
