import type { RemoteHostProbeResult } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { REMOVE_CONFIRM_BODY } from "./remoteHostsCopy";
import {
  addHostStageFromProbe,
  canTrustHostKey,
  connectivityLabelFor,
  isDestinationComplete,
} from "./remoteHostsModel";

function probe(overrides: Partial<RemoteHostProbeResult> = {}): RemoteHostProbeResult {
  return {
    outcome: "ok",
    signature: "sig",
    checkedAt: new Date(0).toISOString(),
    message: "ok",
    ...overrides,
  } as RemoteHostProbeResult;
}

const FINGERPRINT = {
  hostname: "devbox",
  port: 22,
  fingerprints: [{ keyType: "ssh-ed25519", displayType: "ed25519", fingerprint: "SHA256:abc" }],
};

describe("addHostStageFromProbe", () => {
  it("routes an unknown key to its own stage", () => {
    const stage = addHostStageFromProbe(
      probe({ outcome: "unreachable", unreachableReason: "host-key-unknown" }),
    );
    expect(stage.kind).toBe("host-key-unknown");
  });

  it("routes a CHANGED key to a stage that is not the trust stage", () => {
    const stage = addHostStageFromProbe(
      probe({ outcome: "unreachable", unreachableReason: "host-key-changed" }),
    );
    expect(stage.kind).toBe("host-key-changed");
    expect(stage.kind).not.toBe("host-key-unknown");
  });

  it("treats other connection failures as failed, not as a key problem", () => {
    for (const unreachableReason of ["auth", "dns", "refused", "timeout", "unknown"] as const) {
      expect(addHostStageFromProbe(probe({ outcome: "unreachable", unreachableReason })).kind).toBe(
        "failed",
      );
    }
  });

  it("does NOT let readiness gate adding a host", () => {
    // A host that answered but has no agent installed is still worth adding.
    for (const outcome of ["ok", "missing-binary", "missing-path", "noisy-shell"] as const) {
      expect(addHostStageFromProbe(probe({ outcome })).kind).toBe("ready");
    }
  });
});

describe("canTrustHostKey", () => {
  it("offers trust on first contact WITH a fingerprint to compare", () => {
    expect(
      canTrustHostKey(
        probe({ outcome: "unreachable", unreachableReason: "host-key-unknown" }),
        FINGERPRINT,
      ),
    ).toBe(true);
  });

  it("NEVER offers trust on a changed key, even with a fingerprint", () => {
    // The security property. A changed key has no trust affordance, ever.
    expect(
      canTrustHostKey(
        probe({ outcome: "unreachable", unreachableReason: "host-key-changed" }),
        FINGERPRINT,
      ),
    ).toBe(false);
  });

  it("refuses trust when no fingerprint could be fetched", () => {
    // Trusting without a fingerprint is trusting whatever answered — exactly
    // what the prompt exists to prevent.
    const firstContact = probe({ outcome: "unreachable", unreachableReason: "host-key-unknown" });
    expect(canTrustHostKey(firstContact, undefined)).toBe(false);
    expect(
      canTrustHostKey(firstContact, { hostname: "devbox", port: 22, fingerprints: [] }),
    ).toBe(false);
    expect(
      canTrustHostKey(firstContact, {
        hostname: "devbox",
        port: 22,
        fingerprints: [],
        error: "The host did not offer a readable key.",
      }),
    ).toBe(false);
  });

  it("refuses trust for a reachable host", () => {
    expect(canTrustHostKey(probe({ outcome: "ok" }), FINGERPRINT)).toBe(false);
  });
});

describe("connectivityLabelFor", () => {
  it("uses the approved word for every state", () => {
    expect(connectivityLabelFor("connected")).toBe("Ready");
    expect(connectivityLabelFor("degraded")).toBe("Unstable connection");
    expect(connectivityLabelFor("reconnecting")).toBe("Reconnecting…");
    expect(connectivityLabelFor("down")).toBe("Not connected");
  });
});

describe("isDestinationComplete", () => {
  it("requires a non-empty destination and nothing else", () => {
    expect(isDestinationComplete("devbox")).toBe(true);
    expect(isDestinationComplete("")).toBe(false);
    expect(isDestinationComplete("   ")).toBe(false);
  });
});

describe("remove confirmation copy", () => {
  it("claims threads survive, which Remove must keep true", () => {
    // This string is only honest while Remove is a local forget. If a future
    // change points Remove at uninstallRemoteServer (`rm -rf` over the install
    // root, which contains state/userdata/state.sqlite), the sentence becomes a
    // lie. This assertion is a marker for that review.
    expect(REMOVE_CONFIRM_BODY).toContain("stay on the host itself");
  });
});
