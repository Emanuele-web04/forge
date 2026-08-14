import { HOST_SESSION_CLOSE_REVOKED } from "@synara/relay-protocol";
import type { HostAuthorizationSnapshot } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { RemoteSessionRegistry } from "./sessionRegistry";

const authorization = (overrides: Partial<HostAuthorizationSnapshot> = {}) => ({
  discoverable: true,
  ownerUserId: "owner",
  orgId: "org",
  revokedDeviceJkts: [],
  ownerInOrg: true,
  ...overrides,
});

describe("RemoteSessionRegistry", () => {
  it("kills revoked devices and non-owner sessions while owner sessions survive discoverability-off", async () => {
    const registry = new RemoteSessionRegistry();
    const ownerClose = vi.fn();
    const memberClose = vi.fn();
    const otherMemberClose = vi.fn();
    registry.add({
      id: "owner-session",
      userId: "owner",
      deviceJkt: "owner-key",
      expiresAtSeconds: 2_000_000_000,
      via: "direct",
      close: ownerClose,
    });
    registry.add({
      id: "member-session",
      userId: "member",
      deviceJkt: "revoked-key",
      expiresAtSeconds: 2_000_000_000,
      via: "relay",
      close: memberClose,
    });
    registry.add({
      id: "other-member-session",
      userId: "other-member",
      deviceJkt: "other-key",
      expiresAtSeconds: 2_000_000_000,
      via: "ssh-forward",
      close: otherMemberClose,
    });

    await registry.reverify(authorization(), {
      kind: "device_revoked",
      subject: "revoked-key",
    });
    expect(memberClose).toHaveBeenCalledOnce();
    expect(ownerClose).not.toHaveBeenCalled();

    await registry.reverify(authorization({ discoverable: false }), {
      kind: "discoverability_off",
      subject: null,
    });
    expect(otherMemberClose).toHaveBeenCalledOnce();
    expect(ownerClose).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it("kills every session when the host is unlinked", async () => {
    const registry = new RemoteSessionRegistry();
    const close = vi.fn();
    registry.add({
      id: "session",
      userId: "owner",
      deviceJkt: "key",
      expiresAtSeconds: 2_000_000_000,
      via: "relay",
      close,
    });
    await registry.reverify(authorization(), { kind: "host_unlinked", subject: null });
    expect(close).toHaveBeenCalledWith(HOST_SESSION_CLOSE_REVOKED, "host unlinked");
  });

  it("drops a revoked device's session from the snapshot alone, with no event", async () => {
    // The recovery path that matters: a host that missed the push event —
    // relay restarted, host was offline, fan-out cap elided it — must still
    // kill the stolen device's session on its next reverify rather than
    // waiting out the credential TTL.
    const registry = new RemoteSessionRegistry();
    const close = vi.fn();
    registry.add({
      id: "s1",
      userId: "owner_1",
      deviceJkt: "stolen-device",
      expiresAtSeconds: Math.floor(Date.now() / 1_000) + 3_600,
      via: "relay",
      close,
    });
    await registry.reverify({
      discoverable: true,
      ownerUserId: "owner_1",
      orgId: "org_1",
      ownerInOrg: true,
      revokedDeviceJkts: ["stolen-device"],
    });
    expect(close).toHaveBeenCalledWith(HOST_SESSION_CLOSE_REVOKED, "device revoked");
    expect(registry.size).toBe(0);
  });
});
