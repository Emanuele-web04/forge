import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  HostToRelayControlMessage,
  RELAY_CLOSE_BAD_TOKEN,
  RELAY_CLOSE_GRANT_REPLAY,
  RELAY_CLOSE_HOST_UNAVAILABLE,
  RELAY_CLOSE_KEEPALIVE_LOST,
  RELAY_CLOSE_OVERLOADED,
  RELAY_CLOSE_SPLICE_CLAIMED,
  RELAY_CLOSE_SUPERSEDED,
  RelayToHostControlMessage,
} from "./index";

const hostId = "00000000-0000-4000-8000-000000000001";

describe("relay control protocol", () => {
  it("decodes every relay-to-host control message", () => {
    const decode = Schema.decodeUnknownSync(RelayToHostControlMessage);
    expect(decode({ v: 1, type: "ping" })).toEqual({ v: 1, type: "ping" });
    expect(
      decode({
        v: 1,
        type: "splice_request",
        spliceId: "A".repeat(43),
        hostId,
        userId: "user_1",
        deviceJkt: "device-thumbprint",
        expiresAtMs: 1_800_000_000_000,
      }),
    ).toMatchObject({ type: "splice_request", hostId });
    const revocation = decode({
      v: 1,
      type: "revocation",
      events: [
        {
          id: 1,
          hostId,
          kind: "device_revoked",
          subject: "device_1",
          createdAt: "2026-08-13T10:00:00.000Z",
        },
      ],
    });
    expect(revocation.type).toBe("revocation");
    if (revocation.type !== "revocation") throw new Error("expected revocation");
    expect(revocation.events).toHaveLength(1);
  });

  it("decodes only ready and pong from a host", () => {
    const decode = Schema.decodeUnknownSync(HostToRelayControlMessage);
    expect(decode({ v: 1, type: "ready" })).toEqual({ v: 1, type: "ready" });
    expect(decode({ v: 1, type: "pong" })).toEqual({ v: 1, type: "pong" });
    expect(() => decode({ v: 1, type: "ping" })).toThrow();
    expect(() => decode({ v: 2, type: "ready" })).toThrow();
  });

  it("exports the specified close codes", () => {
    expect([
      RELAY_CLOSE_BAD_TOKEN,
      RELAY_CLOSE_GRANT_REPLAY,
      RELAY_CLOSE_HOST_UNAVAILABLE,
      RELAY_CLOSE_KEEPALIVE_LOST,
      RELAY_CLOSE_SUPERSEDED,
      RELAY_CLOSE_SPLICE_CLAIMED,
      RELAY_CLOSE_OVERLOADED,
    ]).toEqual([4401, 4403, 4404, 4408, 4409, 4413, 1013]);
  });
});
