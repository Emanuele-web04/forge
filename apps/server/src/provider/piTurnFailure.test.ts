import { describe, expect, it } from "vitest";

import { classifyPiTurnFailure } from "./piTurnFailure.ts";

describe("classifyPiTurnFailure", () => {
  it("treats Pi abort messages as interrupted turns", () => {
    expect(classifyPiTurnFailure("Error: Request was aborted.")).toEqual({
      state: "interrupted",
      stopReason: "aborted",
    });
  });

  it("treats retry-backoff cancellation as an interrupted turn", () => {
    // End task during SDK backoff settles with "Retry cancelled" — a
    // user-initiated interrupt, not a failure (issue #1027).
    for (const message of ["Retry cancelled", "retry canceled"]) {
      expect(classifyPiTurnFailure(message)).toEqual({
        state: "interrupted",
        stopReason: "aborted",
      });
    }
  });

  it("keeps rate-limit errors failed (SDK retry owns them, not the classifier)", () => {
    expect(
      classifyPiTurnFailure("[rate_limit_exceeded] Rate limit exceeded. Please retry ..."),
    ).toEqual({ state: "failed", stopReason: "error" });
  });

  it("keeps real Pi failures failed", () => {
    expect(classifyPiTurnFailure("Model provider returned a 500")).toEqual({
      state: "failed",
      stopReason: "error",
    });
  });
});
