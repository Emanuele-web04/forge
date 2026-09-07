// FILE: connect.test.ts
// Purpose: The connection flow picks the transport-race winner by preference
//          (not by speed), and relay close codes map to the right retry.
// Layer: Web remote-access feature tests.

import {
  HOST_SESSION_CLOSE_AUTH_FAILED,
  HOST_SESSION_CLOSE_PROTOCOL_ERROR,
  HOST_SESSION_CLOSE_REVOKED,
  RELAY_CLOSE_BAD_TOKEN,
  RELAY_CLOSE_GRANT_REPLAY,
  RELAY_CLOSE_HOST_UNAVAILABLE,
  RELAY_CLOSE_KEEPALIVE_LOST,
  RELAY_CLOSE_OVERLOADED,
  RELAY_CLOSE_SPLICE_CLAIMED,
  RELAY_CLOSE_SUPERSEDED,
} from "@synara/relay-protocol";
import type { TransportCandidate } from "@synara/shared/transportRace";
import { describe, expect, it, vi } from "vitest";

import { connectToHost, relayRetryPlan, requiresFreshGrant } from "./connect";

const LOOPBACK: TransportCandidate = { kind: "loopback", url: "ws://127.0.0.1:5173" };
const LAN: TransportCandidate = { kind: "lan", url: "ws://10.0.0.4:5173" };
const RELAY: TransportCandidate = { kind: "relay", url: "wss://relay.example/client/session" };

/** Answers `true` for the listed kinds after an optional per-kind delay. */
function probeReaching(
  reachable: readonly string[],
  delays: Record<string, number> = {},
): (candidate: TransportCandidate) => Promise<boolean> {
  return (candidate) => {
    const answer = reachable.includes(candidate.kind);
    const delay = delays[candidate.kind] ?? 0;
    if (delay === 0) return Promise.resolve(answer);
    return new Promise((resolve) => setTimeout(() => resolve(answer), delay));
  };
}

describe("connectToHost", () => {
  it("mints over the transport-race winner and returns the credential", async () => {
    const requestGrant = vi.fn().mockResolvedValue("grant-token");
    const mint = vi.fn().mockResolvedValue("session-credential");

    const result = await connectToHost({
      hostId: "host_1",
      candidates: [RELAY, LAN, LOOPBACK],
      requestGrant,
      probe: probeReaching(["loopback", "lan", "relay"]),
      mint,
    });

    expect(result.outcome).toBe("connected");
    if (result.outcome !== "connected") throw new Error("expected a connection");
    expect(result.candidate).toEqual(LOOPBACK);
    expect(result.credential).toBe("session-credential");
    expect(requestGrant).toHaveBeenCalledWith("host_1");
    expect(mint).toHaveBeenCalledWith({ candidate: LOOPBACK, grant: "grant-token" });
  });

  // ADR 0007 is a race for PREFERENCE, not for time. A relay that answers
  // first must not win over a loopback that answers late, or a same-machine
  // session spends its whole life going through the cloud.
  it("prefers a slow loopback over a fast relay", async () => {
    const result = await connectToHost({
      hostId: "host_1",
      candidates: [RELAY, LOOPBACK],
      requestGrant: () => Promise.resolve("grant-token"),
      probe: probeReaching(["loopback", "relay"], { loopback: 30, relay: 0 }),
      mint: () => Promise.resolve("session-credential"),
    });

    if (result.outcome !== "connected") throw new Error("expected a connection");
    expect(result.candidate.kind).toBe("loopback");
  });

  it("falls back to the relay when the direct paths refuse", async () => {
    const result = await connectToHost({
      hostId: "host_1",
      candidates: [LOOPBACK, LAN, RELAY],
      requestGrant: () => Promise.resolve("grant-token"),
      probe: probeReaching(["relay"]),
      mint: () => Promise.resolve("session-credential"),
    });

    if (result.outcome !== "connected") throw new Error("expected a connection");
    expect(result.candidate.kind).toBe("relay");
  });

  it("reports unreachable with every attempt when nothing answers", async () => {
    const mint = vi.fn();

    const result = await connectToHost({
      hostId: "host_1",
      candidates: [LOOPBACK, RELAY],
      requestGrant: () => Promise.resolve("grant-token"),
      probe: probeReaching([]),
      mint,
    });

    expect(result.outcome).toBe("unreachable");
    expect(result.race.attempts.map((attempt) => attempt.candidate.kind)).toEqual([
      "loopback",
      "relay",
    ]);
    expect(mint).not.toHaveBeenCalled();
  });

  it("reports no-route when the host has no candidates at all", async () => {
    const result = await connectToHost({
      hostId: "host_1",
      candidates: [],
      requestGrant: () => Promise.resolve("grant-token"),
      probe: probeReaching([]),
      mint: () => Promise.resolve("session-credential"),
    });

    expect(result.outcome).toBe("unreachable");
    expect(result.race.outcome).toBe("no-candidates");
  });

  // Grants live 60s and a full race can burn 3 of them; minting the grant
  // after the race is how a winning path gets an already-expired grant.
  it("fetches the grant before racing", async () => {
    const order: string[] = [];
    const result = await connectToHost({
      hostId: "host_1",
      candidates: [LOOPBACK],
      requestGrant: () => {
        order.push("grant");
        return Promise.resolve("grant-token");
      },
      probe: (candidate) => {
        order.push(`probe:${candidate.kind}`);
        return Promise.resolve(true);
      },
      mint: () => {
        order.push("mint");
        return Promise.resolve("session-credential");
      },
    });

    expect(result.outcome).toBe("connected");
    expect(order).toEqual(["grant", "probe:loopback", "mint"]);
  });

  it("propagates a grant failure instead of racing", async () => {
    const probe = vi.fn();

    await expect(
      connectToHost({
        hostId: "host_1",
        candidates: [LOOPBACK],
        requestGrant: () => Promise.reject(new Error("host_not_linked")),
        probe,
        mint: () => Promise.resolve("session-credential"),
      }),
    ).rejects.toThrow("host_not_linked");
    expect(probe).not.toHaveBeenCalled();
  });

  it("reaches a direct host with an existing credential while the account API is down", async () => {
    const requestGrant = vi.fn(() => Promise.reject(new Error("account API returned 503")));
    const mint = vi.fn();

    const result = await connectToHost({
      hostId: "host_1",
      candidates: [LAN, RELAY],
      existingCredential: "still-valid-session-credential",
      requestGrant,
      probe: probeReaching(["lan"]),
      mint,
    });

    expect(result.outcome).toBe("connected");
    if (result.outcome !== "connected") throw new Error("expected a connection");
    expect(result.candidate).toEqual(LAN);
    expect(result.credential).toBe("still-valid-session-credential");
    expect(requestGrant).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });
});

describe("relayRetryPlan", () => {
  // 4401/4403 are the two shapes of "your grant is no good"; only a fresh
  // grant cures either, and redialing with the same one reproduces the close.
  it("re-grants on a refused grant (4401)", () => {
    expect(relayRetryPlan(RELAY_CLOSE_BAD_TOKEN).action).toBe("re-grant");
    expect(requiresFreshGrant(RELAY_CLOSE_BAD_TOKEN)).toBe(true);
  });

  it("re-grants on a replayed grant (4403)", () => {
    expect(relayRetryPlan(RELAY_CLOSE_GRANT_REPLAY).action).toBe("re-grant");
    expect(requiresFreshGrant(RELAY_CLOSE_GRANT_REPLAY)).toBe(true);
  });

  it("reports the host offline on 4404", () => {
    const plan = relayRetryPlan(RELAY_CLOSE_HOST_UNAVAILABLE);
    expect(plan.action).toBe("host-offline");
    expect(requiresFreshGrant(RELAY_CLOSE_HOST_UNAVAILABLE)).toBe(false);
  });

  it("backs off on relay overload (1013)", () => {
    expect(relayRetryPlan(RELAY_CLOSE_OVERLOADED).action).toBe("back-off");
  });

  it("stops rather than fighting a takeover", () => {
    expect(relayRetryPlan(RELAY_CLOSE_SUPERSEDED).action).toBe("stop");
    expect(relayRetryPlan(RELAY_CLOSE_SPLICE_CLAIMED).action).toBe("stop");
  });

  it("reconnects normally on keepalive loss and unknown codes", () => {
    expect(relayRetryPlan(RELAY_CLOSE_KEEPALIVE_LOST).action).toBe("reconnect");
    expect(relayRetryPlan(1006).action).toBe("reconnect");
    expect(relayRetryPlan(1000).action).toBe("reconnect");
  });

  it("gives every plan a reason worth showing", () => {
    for (const code of [
      RELAY_CLOSE_BAD_TOKEN,
      RELAY_CLOSE_GRANT_REPLAY,
      RELAY_CLOSE_HOST_UNAVAILABLE,
      RELAY_CLOSE_OVERLOADED,
      RELAY_CLOSE_SUPERSEDED,
      RELAY_CLOSE_KEEPALIVE_LOST,
      HOST_SESSION_CLOSE_REVOKED,
      HOST_SESSION_CLOSE_AUTH_FAILED,
      HOST_SESSION_CLOSE_PROTOCOL_ERROR,
      1006,
    ]) {
      expect(relayRetryPlan(code).reason.length).toBeGreaterThan(0);
    }
  });
});

// Host-session codes (45xx) travel verbatim through the splice, so they need
// the same scrutiny as the relay's own codes — and specifically the 4503
// case: a revoked session is NOT a bad grant, and re-granting it would only
// produce a 403 from the account API instead of telling the user access was
// revoked.
describe("relayRetryPlan — host-session codes (45xx)", () => {
  it.each([
    { code: HOST_SESSION_CLOSE_REVOKED, action: "stop", freshGrant: false },
    { code: HOST_SESSION_CLOSE_AUTH_FAILED, action: "re-grant", freshGrant: true },
    { code: HOST_SESSION_CLOSE_PROTOCOL_ERROR, action: "stop", freshGrant: false },
  ] as const)(
    "code $code -> $action (requiresFreshGrant: $freshGrant)",
    ({ code, action, freshGrant }) => {
      expect(relayRetryPlan(code).action).toBe(action);
      expect(requiresFreshGrant(code)).toBe(freshGrant);
    },
  );

  // The test and the product read the SAME constant, so a symbol-only
  // assertion would stay green even if the constant's VALUE drifted. Pin the
  // literals, then re-check the mapping with the raw number so the branch
  // stays reachable even if the export above it changes.
  it("pins the numeric close codes and re-checks the mapping by raw number", () => {
    expect(HOST_SESSION_CLOSE_REVOKED).toBe(4503);
    expect(HOST_SESSION_CLOSE_AUTH_FAILED).toBe(4501);
    expect(HOST_SESSION_CLOSE_PROTOCOL_ERROR).toBe(4500);

    expect(relayRetryPlan(4503).action).toBe("stop");
    expect(relayRetryPlan(4501).action).toBe("re-grant");
    expect(relayRetryPlan(4500).action).toBe("stop");
  });
});
