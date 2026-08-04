import { describe, expect, it } from "vitest";

import {
  isPendingInteractionResponseClaimable,
  respondingInteractionReclaimCutoff,
} from "./pendingInteractions.ts";

describe("pending interaction response claims", () => {
  it.each(["pending", "retryable", "uncertain"] as const)(
    "allows %s interactions to be claimed",
    (status) => {
      expect(
        isPendingInteractionResponseClaimable({
          status,
          responseRequestedAt: null,
          requestedAt: "2026-07-14T12:31:00.000Z",
        }),
      ).toBe(true);
    },
  );

  it("only reclaims responding interactions after the grace period", () => {
    expect(respondingInteractionReclaimCutoff("2026-07-14T12:31:00.000Z")).toBe(
      "2026-07-14T12:30:30.000Z",
    );
    expect(
      isPendingInteractionResponseClaimable({
        status: "responding",
        responseRequestedAt: "2026-07-14T12:30:31.000Z",
        requestedAt: "2026-07-14T12:31:00.000Z",
      }),
    ).toBe(false);
    expect(
      isPendingInteractionResponseClaimable({
        status: "responding",
        responseRequestedAt: "2026-07-14T12:30:30.000Z",
        requestedAt: "2026-07-14T12:31:00.000Z",
      }),
    ).toBe(true);
    expect(
      isPendingInteractionResponseClaimable({
        status: "responding",
        responseRequestedAt: null,
        requestedAt: "2026-07-14T12:31:00.000Z",
      }),
    ).toBe(true);
  });

  it("never reclaims confirmed interactions", () => {
    expect(
      isPendingInteractionResponseClaimable({
        status: "confirmed",
        responseRequestedAt: "2026-07-14T12:00:00.000Z",
        requestedAt: "2026-07-14T12:31:00.000Z",
      }),
    ).toBe(false);
  });
});
