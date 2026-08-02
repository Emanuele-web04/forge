import type { RemoteHostProbeResult } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  ADD_STAGE_LABEL,
  ADD_STOPPED,
  REMOVE_CONFIRM_BODY,
  addStageDone,
  addStageHeader,
} from "./remoteHostsCopy";
import {
  addHostStageFromProbe,
  appendBootstrapStage,
  bootstrapStageLabel,
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
    // host-key-unsupported belongs here, not on a key branch: nothing is unknown
    // and nothing changed, so there is nothing to trust — the probe message
    // explains the algorithm mismatch instead.
    for (const unreachableReason of [
      "auth",
      "dns",
      "refused",
      "timeout",
      "unknown",
      "host-key-unsupported",
    ] as const) {
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
    expect(canTrustHostKey(firstContact, { hostname: "devbox", port: 22, fingerprints: [] })).toBe(
      false,
    );
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

  it("refuses trust for a key-algorithm mismatch", () => {
    expect(
      canTrustHostKey(
        probe({ outcome: "unreachable", unreachableReason: "host-key-unsupported" }),
        FINGERPRINT,
      ),
    ).toBe(false);
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

/**
 * The eight steps of `BootstrapProgress`, spelled out here rather than imported.
 *
 * apps/web must not import from apps/server, so this list is a DUPLICATE of the
 * union in remoteBootstrap.ts — and a duplicate is exactly what needs pinning:
 * a step added there and not here would otherwise render nothing at all, with
 * no failure anywhere to say so.
 */
const BOOTSTRAP_STEPS = [
  "preparing",
  "uploading",
  "reusing-staged",
  "verifying",
  "extracting",
  "activating",
  "installing-supervisor",
  "handshake",
] as const;

describe("bootstrap stage copy", () => {
  it("has an approved line for every step the server can emit", () => {
    for (const step of BOOTSTRAP_STEPS) {
      expect(bootstrapStageLabel(step)).toBeTruthy();
    }
    // And no extras: a label with no step behind it would be copy for something
    // that never happens.
    expect(Object.keys(ADD_STAGE_LABEL).sort()).toEqual([...BOOTSTRAP_STEPS].sort());
  });

  it("uses the exact approved wording", () => {
    expect(ADD_STAGE_LABEL).toEqual({
      preparing: "Connecting over SSH",
      uploading: "Copying Synara to the host",
      "reusing-staged": "Reusing what's already on the host",
      verifying: "Checking the transfer",
      extracting: "Unpacking",
      activating: "Starting Synara",
      "installing-supervisor": "Setting it to restart automatically",
      handshake: "Finishing up",
    });
    expect(addStageHeader("devbox")).toBe("Adding devbox");
    expect(addStageDone("devbox")).toBe("devbox is ready.");
  });

  /**
   * A raw step name is an internal identifier, not a sentence. Falling back to
   * one would put unapproved text in front of a user the first time the server
   * gained a step this UI had not been taught.
   */
  it("never renders a raw step name for a step it does not know", () => {
    expect(bootstrapStageLabel("some-future-step")).toBeUndefined();
    const lines = appendBootstrapStage([], "some-future-step");
    expect(lines).toEqual([]);
    // Not even via prototype keys, which `in` would have accepted.
    expect(bootstrapStageLabel("toString")).toBeUndefined();
    expect(bootstrapStageLabel("constructor")).toBeUndefined();
  });

  /**
   * The core promise of the copy doc: no fake sequences, no optimistic
   * advancement. A line exists only because its step fired.
   */
  it("shows only the steps that actually fired, in the order they fired", () => {
    let lines = appendBootstrapStage([], "preparing");
    lines = appendBootstrapStage(lines, "reusing-staged");
    lines = appendBootstrapStage(lines, "extracting");
    expect(lines.map((line) => line.label)).toEqual([
      "Connecting over SSH",
      "Reusing what's already on the host",
      "Unpacking",
    ]);
    // `uploading` never fired on this run, so it is nowhere to be seen.
    expect(lines.map((line) => line.step)).not.toContain("uploading");
  });

  it("collapses a step repeated back to back, but not one revisited later", () => {
    // `uploading` fires once per artifact; two identical adjacent lines read as
    // a rendering bug rather than as progress.
    let lines = appendBootstrapStage([], "uploading");
    lines = appendBootstrapStage(lines, "uploading");
    expect(lines).toHaveLength(1);
    // A genuine second visit, after something else, is real progress.
    lines = appendBootstrapStage(lines, "verifying");
    lines = appendBootstrapStage(lines, "uploading");
    expect(lines.map((line) => line.step)).toEqual(["uploading", "verifying", "uploading"]);
  });
});

describe("cancel copy", () => {
  /**
   * The approved copy offers a stronger sentence — "Nothing was left running on
   * the host." — that this implementation may NOT use.
   *
   * `uninstallRemoteServer` runs its uninstall argv through plain `exec` with no
   * exit-code check and says so ("best-effort per step"), and
   * `bootstrapRemoteServer` calls `ensureDirectories` before taking the lock, so
   * even the earliest cancel can already have created the install tree.
   * Best-effort and "nothing was left" cannot both be true.
   */
  it("claims only what teardown can actually back", () => {
    expect(ADD_STOPPED).toBe("Stopped. Synara may still be installed on the host.");
    expect(ADD_STOPPED).not.toContain("Nothing was left");
  });
});
