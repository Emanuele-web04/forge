// FILE: threadUnblock.test.ts
// Purpose: Guards the "Unblock thread" recovery flow against reconciliation regressions.
// Layer: Web orchestration helper tests
// Depends on: threadUnblock helpers with a stubbed orchestration API.

import type { OrchestrationListProviderDeliveryBlockersResult } from "@synara/contracts";
import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  describeThreadUnblockResult,
  isProviderDeliveryReconciliationConflict,
  PROVIDER_DELIVERY_RECONCILIATION_CONFLICT_CODE,
  unblockThreadFromClient,
} from "./threadUnblock";

const threadId = ThreadId.makeUnsafe("thread-blocked");

function blocker(input: {
  readonly eventSequence: number;
  readonly state: "dead" | "uncertain";
}): OrchestrationListProviderDeliveryBlockersResult[number] {
  return {
    consumerName: "provider-command-reactor.v1",
    eventSequence: input.eventSequence,
    eventId: "event-1",
    eventType: "thread.turn-start-requested",
    occurredAt: "2026-07-26T10:00:00.000Z",
    threadId,
    state: input.state,
    attemptCount: 1,
    lastError: "External provider command claim expired without a durable acceptance result;",
    updatedAt: "2026-07-26T10:00:00.000Z",
    lastReconciliationOutcome: null,
    lastReconciledAt: null,
    lastReconciledBy: null,
    lastReconciliationNote: null,
  } as OrchestrationListProviderDeliveryBlockersResult[number];
}

function conflictError() {
  return Object.assign(new Error("Provider delivery no longer matches the requested thread."), {
    code: PROVIDER_DELIVERY_RECONCILIATION_CONFLICT_CODE,
  });
}

describe("unblockThreadFromClient", () => {
  it("abandons every blocker oldest-first", async () => {
    const listProviderDeliveryBlockers = vi.fn(async () => [
      blocker({ eventSequence: 42, state: "dead" }),
      blocker({ eventSequence: 17, state: "uncertain" }),
    ]);
    const reconcileProviderDelivery = vi.fn(async (input: { eventSequence: number }) => ({
      eventSequence: input.eventSequence,
      threadId,
      outcome: "abandon" as const,
      state: "succeeded" as const,
      reconciledAt: "2026-07-26T10:01:00.000Z",
    }));

    const result = await unblockThreadFromClient(
      {
        listProviderDeliveryBlockers,
        reconcileProviderDelivery,
      } as never,
      threadId,
    );

    expect(result).toEqual({ kind: "unblocked", reconciledCount: 2 });
    expect(listProviderDeliveryBlockers).toHaveBeenCalledWith({ threadId });
    expect(
      reconcileProviderDelivery.mock.calls.map(
        ([input]) => (input as never as { eventSequence: number }).eventSequence,
      ),
    ).toEqual([17, 42]);
    expect(reconcileProviderDelivery.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      expectedState: "uncertain",
      outcome: "abandon",
    });
    expect(reconcileProviderDelivery.mock.calls[1]?.[0]).toMatchObject({ expectedState: "dead" });
  });

  it("reports an already-clear thread without reconciling anything", async () => {
    const reconcileProviderDelivery = vi.fn();

    const result = await unblockThreadFromClient(
      {
        listProviderDeliveryBlockers: vi.fn(async () => []),
        reconcileProviderDelivery,
      } as never,
      threadId,
    );

    expect(result).toEqual({ kind: "already-clear" });
    expect(reconcileProviderDelivery).not.toHaveBeenCalled();
  });

  it("treats a reconciliation conflict as settled elsewhere", async () => {
    const result = await unblockThreadFromClient(
      {
        listProviderDeliveryBlockers: vi.fn(async () => [
          blocker({ eventSequence: 17, state: "uncertain" }),
        ]),
        reconcileProviderDelivery: vi.fn(async () => {
          throw conflictError();
        }),
      } as never,
      threadId,
    );

    expect(result).toEqual({ kind: "resolved-elsewhere" });
  });

  it("still unblocks when only a later blocker conflicts", async () => {
    let call = 0;
    const result = await unblockThreadFromClient(
      {
        listProviderDeliveryBlockers: vi.fn(async () => [
          blocker({ eventSequence: 17, state: "uncertain" }),
          blocker({ eventSequence: 42, state: "uncertain" }),
        ]),
        reconcileProviderDelivery: vi.fn(async () => {
          call += 1;
          if (call === 2) throw conflictError();
          return {
            eventSequence: 17,
            threadId,
            outcome: "abandon" as const,
            state: "succeeded" as const,
            reconciledAt: "2026-07-26T10:01:00.000Z",
          };
        }),
      } as never,
      threadId,
    );

    expect(result).toEqual({ kind: "unblocked", reconciledCount: 1 });
  });

  it("propagates unexpected reconciliation failures", async () => {
    await expect(
      unblockThreadFromClient(
        {
          listProviderDeliveryBlockers: vi.fn(async () => [
            blocker({ eventSequence: 17, state: "uncertain" }),
          ]),
          reconcileProviderDelivery: vi.fn(async () => {
            throw new Error("Socket closed");
          }),
        } as never,
        threadId,
      ),
    ).rejects.toThrow("Socket closed");
  });
});

describe("isProviderDeliveryReconciliationConflict", () => {
  it("matches only the server conflict code", () => {
    expect(isProviderDeliveryReconciliationConflict(conflictError())).toBe(true);
    expect(isProviderDeliveryReconciliationConflict(new Error("Socket closed"))).toBe(false);
    expect(isProviderDeliveryReconciliationConflict(null)).toBe(false);
    expect(isProviderDeliveryReconciliationConflict({ code: "WS_REQUEST_TIMEOUT" })).toBe(false);
  });
});

describe("describeThreadUnblockResult", () => {
  it("always tells the user to resend the failed message", () => {
    for (const result of [
      { kind: "unblocked", reconciledCount: 1 },
      { kind: "already-clear" },
      { kind: "resolved-elsewhere" },
    ] as const) {
      const notice = describeThreadUnblockResult(result);
      expect(notice.title.length).toBeGreaterThan(0);
      expect(notice.description.toLowerCase()).toContain("resend");
    }
  });
});
