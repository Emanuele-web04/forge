// FILE: reachability.test.ts
// Purpose: Candidate building and the attempt-based status line — including
//          that "unreachable" and "no answer" stay distinguishable (ADR 0010).
// Layer: Web remote-access feature tests.

import type { AccountHost, EnvironmentId } from "@synara/contracts";
import type { TransportRaceResult } from "@synara/shared/transportRace";
import { describe, expect, it } from "vitest";

import {
  activeTransportLabel,
  buildHostCandidates,
  reachabilityFromRace,
  reachabilityLabel,
  reachabilityToneClassName,
  relayHostHealthUrl,
  relaySessionUrl,
} from "./reachability";

function makeHost(overrides: Partial<AccountHost> = {}): AccountHost {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    environmentId: "env_1" as EnvironmentId,
    name: "Ada's MacBook",
    platform: "darwin",
    kind: "local",
    endpoints: [],
    ownerUserId: "user_1",
    discoverable: true,
    linked: true,
    keyGeneration: 1,
    mine: true,
    createdAt: "2026-08-13T10:00:00.000Z",
    lastSeenAt: "2026-08-13T10:00:00.000Z",
    ...overrides,
  };
}

describe("buildHostCandidates", () => {
  it("turns directory endpoints into candidates", () => {
    const candidates = buildHostCandidates({
      host: makeHost({
        endpoints: [
          { url: "ws://10.0.0.4:5173", transport: "lan" },
          { url: "ws://ada.tailnet.ts.net:5173", transport: "tailscale" },
        ],
      }),
      relayUrl: null,
    });

    expect(candidates.map((candidate) => candidate.kind)).toEqual(["lan", "tailscale"]);
    expect(candidates[0]?.url).toBe("ws://10.0.0.4:5173");
  });

  // The relay is the only path that works from a foreign network; dropping it
  // because a LAN address exists is how "fine at my desk, dead on the train"
  // happens.
  it("always includes the relay when one is configured", () => {
    const candidates = buildHostCandidates({
      host: makeHost({ endpoints: [{ url: "ws://10.0.0.4:5173", transport: "lan" }] }),
      relayUrl: "wss://relay.example",
    });

    expect(candidates.map((candidate) => candidate.kind)).toContain("relay");
  });

  it("omits the relay when the deployment has none", () => {
    const candidates = buildHostCandidates({
      host: makeHost({ endpoints: [{ url: "ws://10.0.0.4:5173", transport: "lan" }] }),
      relayUrl: null,
    });

    expect(candidates.map((candidate) => candidate.kind)).not.toContain("relay");
  });

  it("appends shell-discovered candidates", () => {
    const candidates = buildHostCandidates({
      host: makeHost(),
      relayUrl: null,
      discovered: [{ kind: "loopback", url: "ws://127.0.0.1:5173", label: "this machine" }],
    });

    expect(candidates).toEqual([
      { kind: "loopback", url: "ws://127.0.0.1:5173", label: "this machine" },
    ]);
  });

  it("produces an empty list for a host with no endpoints and no relay", () => {
    expect(buildHostCandidates({ host: makeHost(), relayUrl: null })).toEqual([]);
  });
});

describe("relaySessionUrl", () => {
  it("addresses the client session route for the host", () => {
    expect(relaySessionUrl("wss://relay.example", "host_1")).toBe(
      "wss://relay.example/client/session?host=host_1",
    );
  });

  it("tolerates a trailing slash on the relay base", () => {
    expect(relaySessionUrl("wss://relay.example/", "host_1")).toBe(
      "wss://relay.example/client/session?host=host_1",
    );
  });

  // The grant is a bearer credential and this URL is rendered in diagnostics.
  it("carries no credential", () => {
    expect(relaySessionUrl("wss://relay.example", "host_1")).not.toContain("grant");
  });
});

describe("relayHostHealthUrl", () => {
  // This is the per-HOST probe, not the relay's own liveness check: probing
  // the relay itself only ever proves the relay is up, which is the
  // regression the docstring warns about (every host reads "Reachable" until
  // a 4404 shows up later at session open).
  it("addresses the per-host healthz route, not the relay-wide one", () => {
    expect(relayHostHealthUrl("wss://relay.example", "host_1")).toBe(
      "https://relay.example/healthz/host/host_1",
    );
  });

  it("does not merely end in /healthz", () => {
    expect(relayHostHealthUrl("wss://relay.example", "host_1")).not.toMatch(/\/healthz$/);
  });

  // The relay base is a ws(s):// URL, which `fetch` cannot use directly — the
  // scheme rewrite is not cosmetic, it is what makes the probe fetchable.
  it("rewrites ws: to http:", () => {
    expect(relayHostHealthUrl("ws://relay.example", "host_1")).toBe(
      "http://relay.example/healthz/host/host_1",
    );
  });

  it("tolerates a trailing slash on the relay base", () => {
    expect(relayHostHealthUrl("wss://relay.example/", "host_1")).toBe(
      "https://relay.example/healthz/host/host_1",
    );
  });

  it("encodes a hostId containing a path separator", () => {
    expect(relayHostHealthUrl("wss://relay.example", "host/1")).toBe(
      "https://relay.example/healthz/host/host%2F1",
    );
  });

  it("encodes a hostId containing query and fragment characters", () => {
    expect(relayHostHealthUrl("wss://relay.example", "host?1#2")).toBe(
      "https://relay.example/healthz/host/host%3F1%232",
    );
  });
});

describe("reachabilityFromRace", () => {
  it("names the winning transport", () => {
    const race: TransportRaceResult = {
      outcome: "reachable",
      candidate: { kind: "lan", url: "ws://10.0.0.4:5173" },
      attempts: [],
    };

    expect(reachabilityFromRace(race, 1000)).toEqual({
      state: "reachable",
      transport: "lan",
      at: 1000,
    });
  });

  // A refused connection is a real answer; silence is a network problem.
  // Collapsing them would tell a user behind a captive portal their machine
  // is down.
  it("keeps a refusal and a timeout distinguishable", () => {
    expect(reachabilityFromRace({ outcome: "unreachable", attempts: [] }, 1).state).toBe(
      "unreachable",
    );
    expect(reachabilityFromRace({ outcome: "timed-out", attempts: [] }, 1).state).toBe("no-answer");
  });

  it("reports no-route when there was nothing to try", () => {
    expect(reachabilityFromRace({ outcome: "no-candidates", attempts: [] }, 1).state).toBe(
      "no-route",
    );
  });
});

describe("reachabilityLabel", () => {
  it("reads as prose for every state", () => {
    expect(reachabilityLabel({ state: "unknown" })).toBe("Not checked yet");
    expect(reachabilityLabel({ state: "probing" })).toBe("Checking…");
    expect(reachabilityLabel({ state: "reachable", transport: "relay", at: 1 })).toBe(
      "Reachable over relay",
    );
    expect(reachabilityLabel({ state: "reachable", transport: "loopback", at: 1 })).toBe(
      "Reachable over this machine",
    );
    expect(reachabilityLabel({ state: "unreachable", at: 1 })).toBe("Did not answer");
    expect(reachabilityLabel({ state: "no-answer", at: 1 })).toBe(
      "No response — check your network",
    );
    expect(reachabilityLabel({ state: "no-route", at: 1 })).toBe("No known address");
  });
});

describe("reachabilityToneClassName", () => {
  // ADR 0010 + the palette: reachability is text and emphasis, never a
  // colored dot. There is no success/warning token to reach for.
  it("uses emphasis rather than color", () => {
    expect(reachabilityToneClassName({ state: "reachable", transport: "lan", at: 1 })).toBe(
      "text-foreground",
    );
    expect(reachabilityToneClassName({ state: "unreachable", at: 1 })).toBe(
      "text-muted-foreground",
    );
    expect(reachabilityToneClassName({ state: "unknown" })).toBe("text-muted-foreground");
  });

  it("never reaches for a status color", () => {
    for (const tone of [
      reachabilityToneClassName({ state: "reachable", transport: "lan", at: 1 }),
      reachabilityToneClassName({ state: "unreachable", at: 1 }),
      reachabilityToneClassName({ state: "no-answer", at: 1 }),
    ]) {
      expect(tone).not.toMatch(/success|warning|green|red|destructive/);
    }
  });
});

describe("activeTransportLabel", () => {
  it("says which path the live session is using", () => {
    expect(activeTransportLabel("tailscale")).toBe("Connected over Tailscale");
    expect(activeTransportLabel("ssh")).toBe("Connected over SSH");
  });
});
