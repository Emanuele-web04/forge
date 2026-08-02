// FILE: environmentCapabilities.test.ts
// Purpose: Proves an unavailable feature on a remote host produces an explicit,
//          actionable refusal rather than a silent local fallback.
// Layer: Web environment UX tests

import { describe, expect, it, vi } from "vitest";

import {
  detectEnvironmentVersionSkew,
  environmentUnreachableMessage,
  environmentVersionSkewMessage,
  ENVIRONMENT_CAPABILITIES,
  LOCAL_ONLY_ENVIRONMENT_CAPABILITIES,
  resolveEnvironmentCapabilityRefusal,
  withEnvironmentCapability,
} from "./environmentCapabilities";

describe("capability refusals", () => {
  it("never refuses on the local environment", () => {
    for (const capability of ENVIRONMENT_CAPABILITIES) {
      expect(
        resolveEnvironmentCapabilityRefusal({
          capability,
          isLocalEnvironment: true,
          environmentLabel: "This computer",
        }),
      ).toBeNull();
    }
  });

  it("refuses every local-only capability on a remote host", () => {
    // The allowlist's CONTENTS are asserted, not merely its existence: an entry
    // silently dropped here is a feature that quietly runs against the wrong
    // machine.
    for (const capability of LOCAL_ONLY_ENVIRONMENT_CAPABILITIES) {
      const refusal = resolveEnvironmentCapabilityRefusal({
        capability,
        isLocalEnvironment: false,
        environmentLabel: "prod-vps",
      });
      expect(refusal, `expected ${capability} to be refused on a remote host`).not.toBeNull();
      expect(refusal?.capability).toBe(capability);
    }
  });

  it("names the host and an action in every refusal", () => {
    for (const capability of LOCAL_ONLY_ENVIRONMENT_CAPABILITIES) {
      const refusal = resolveEnvironmentCapabilityRefusal({
        capability,
        isLocalEnvironment: false,
        environmentLabel: "prod-vps",
      });
      // A message that only says what failed leaves the user stuck.
      expect(refusal?.description).toContain("prod-vps");
      expect(refusal?.description.length ?? 0).toBeGreaterThan(40);
      expect(refusal?.title).not.toBe("");
    }
  });

  it("covers exactly the declared capability list", () => {
    // Guards the pairing between the id list and the copy tables: adding a
    // capability without copy would ship an empty refusal dialog.
    for (const capability of ENVIRONMENT_CAPABILITIES) {
      const refusal = resolveEnvironmentCapabilityRefusal({
        capability,
        isLocalEnvironment: false,
        environmentLabel: "prod-vps",
      });
      if (!LOCAL_ONLY_ENVIRONMENT_CAPABILITIES.has(capability)) continue;
      expect(refusal?.description).toBeTruthy();
    }
  });
});

describe("version skew", () => {
  it("detects a differing server version", () => {
    expect(
      detectEnvironmentVersionSkew({
        localVersion: "0.6.3",
        descriptor: { serverVersion: "0.6.1" },
      }),
    ).toEqual({ localVersion: "0.6.3", remoteVersion: "0.6.1" });
  });

  it("reports no skew for a matching version", () => {
    expect(
      detectEnvironmentVersionSkew({
        localVersion: "0.6.3",
        descriptor: { serverVersion: "0.6.3" },
      }),
    ).toBeNull();
  });

  it("tells the user to update the HOST, not to downgrade this app", () => {
    // The remote server is authoritative for its own threads, so downgrading
    // here would be the wrong instruction.
    const message = environmentVersionSkewMessage({
      environmentLabel: "prod-vps",
      skew: { localVersion: "0.6.3", remoteVersion: "0.6.1" },
    });
    expect(message).toContain("Update prod-vps");
    expect(message).toContain("0.6.3");
    expect(message).toContain("0.6.1");
  });
});

describe("unreachable copy", () => {
  it("names the host and both things a user can check", () => {
    const message = environmentUnreachableMessage("prod-vps");
    expect(message).toContain("prod-vps");
    expect(message).toContain("ssh");
    expect(message).toContain("Remote hosts");
  });
});

describe("withEnvironmentCapability", () => {
  // The refusal predicate was already well tested and both call sites could
  // still skip it: deleting `if (refusal) return` at either one left 1129
  // component tests passing while the guard vanished. These pin the funnel that
  // makes skipping require deleting the call itself.

  it("runs the action on the local environment", () => {
    const action = vi.fn();
    const onRefused = vi.fn();
    const ran = withEnvironmentCapability({
      capability: "editor-launch",
      isLocalEnvironment: true,
      environmentLabel: "This computer",
      onRefused,
      action,
    });

    expect(ran).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("REFUSES on a remote host and never runs the action", () => {
    // The property that matters: the action is unreachable, not merely
    // followed by an error. Launching an editor on a remote host opens the
    // LOCAL copy of that path — same name, different machine's contents — and
    // looks like it worked.
    const action = vi.fn();
    const onRefused = vi.fn();
    const ran = withEnvironmentCapability({
      capability: "editor-launch",
      isLocalEnvironment: false,
      environmentLabel: "prod-vps",
      onRefused,
      action,
    });

    expect(ran).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(onRefused.mock.calls[0]?.[0]?.description).toContain("prod-vps");
  });

  it("runs a capability that is NOT local-only even on a remote host", () => {
    // Guards the other direction: a blanket refusal would be just as wrong,
    // and would make every remote host unusable rather than safe.
    const action = vi.fn();
    const ran = withEnvironmentCapability({
      capability: "thread-turns" as never,
      isLocalEnvironment: false,
      environmentLabel: "prod-vps",
      onRefused: vi.fn(),
      action,
    });

    expect(ran).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
