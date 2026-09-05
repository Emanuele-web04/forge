import { describe, expect, it } from "vitest";

import { isThreadDetailVerifiedInSync } from "./threadDetailCatchupPolicy";

describe("isThreadDetailVerifiedInSync", () => {
  it("is false before any replay poll has resolved empty", () => {
    expect(
      isThreadDetailVerifiedInSync({ appliedEventSerial: 0, emptyReplayAtEventSerial: null }),
    ).toBe(false);
    expect(
      isThreadDetailVerifiedInSync({ appliedEventSerial: 5, emptyReplayAtEventSerial: null }),
    ).toBe(false);
  });

  it("is true when the empty replay observed the current applied-event serial", () => {
    expect(
      isThreadDetailVerifiedInSync({ appliedEventSerial: 0, emptyReplayAtEventSerial: 0 }),
    ).toBe(true);
    expect(
      isThreadDetailVerifiedInSync({ appliedEventSerial: 7, emptyReplayAtEventSerial: 7 }),
    ).toBe(true);
  });

  it("is false once any event has been applied after the empty replay", () => {
    expect(
      isThreadDetailVerifiedInSync({ appliedEventSerial: 8, emptyReplayAtEventSerial: 7 }),
    ).toBe(false);
  });
});
