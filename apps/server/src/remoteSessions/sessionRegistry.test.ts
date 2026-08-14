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
      startedAt: "2026-08-14T10:00:00.000Z",
      expiresAtSeconds: 2_000_000_000,
      via: "direct",
      close: ownerClose,
    });
    registry.add({
      id: "member-session",
      userId: "member",
      deviceJkt: "revoked-key",
      startedAt: "2026-08-14T10:01:00.000Z",
      expiresAtSeconds: 2_000_000_000,
      via: "relay",
      close: memberClose,
    });
    registry.add({
      id: "other-member-session",
      userId: "other-member",
      deviceJkt: "other-key",
      startedAt: "2026-08-14T10:02:00.000Z",
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
      startedAt: "2026-08-14T10:00:00.000Z",
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
      startedAt: "2026-08-14T10:00:00.000Z",
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

  it("projects live session identity, transport, and start time without exposing close handles", () => {
    const registry = new RemoteSessionRegistry();
    registry.add({
      id: "session-1",
      userId: "user-1",
      deviceJkt: "device-thumbprint",
      startedAt: "2026-08-14T10:00:00.000Z",
      expiresAtSeconds: 2_000_000_000,
      via: "ssh-forward",
      close: vi.fn(),
    });

    expect(registry.list()).toEqual([
      {
        id: "session-1",
        userId: "user-1",
        deviceJkt: "device-thumbprint",
        transport: "ssh-forward",
        startedAt: "2026-08-14T10:00:00.000Z",
      },
    ]);
    expect(registry.list()[0]).not.toHaveProperty("close");
  });

  it("lets the owner end one live session through the same close path revocation uses", () => {
    const registry = new RemoteSessionRegistry();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    for (const [id, close] of [
      ["session-1", firstClose],
      ["session-2", secondClose],
    ] as const) {
      registry.add({
        id,
        userId: "user-1",
        deviceJkt: `${id}-device`,
        startedAt: "2026-08-14T10:00:00.000Z",
        expiresAtSeconds: 2_000_000_000,
        via: "relay",
        close,
      });
    }

    expect(registry.end("session-1")).toBe(true);
    expect(firstClose).toHaveBeenCalledWith(HOST_SESSION_CLOSE_REVOKED, "ended by host owner");
    expect(secondClose).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
    expect(registry.end("missing-session")).toBe(false);
  });

  it("refuses a revoked device a NEW session, not just its live one", async () => {
    // Killing the session was never enough: the credential stays valid for
    // its full hour and a fresh DPoP proof is trivial for whoever holds the
    // device key, so a revoked device could reconnect over LAN or an SSH
    // forward — no relay, no cloud — and re-admit itself.
    const registry = new RemoteSessionRegistry();
    expect(registry.isDeviceRevoked("stolen")).toBe(false);
    await registry.reverify(
      {
        discoverable: true,
        ownerUserId: "owner_1",
        orgId: "org_1",
        ownerInOrg: true,
        revokedDeviceJkts: [],
      },
      { kind: "device_revoked", subject: "stolen" },
    );
    expect(registry.isDeviceRevoked("stolen")).toBe(true);
    expect(registry.isDeviceRevoked("other-device")).toBe(false);
  });

  it("remembers revocations learned from the snapshot, not only from events", async () => {
    const registry = new RemoteSessionRegistry();
    await registry.reverify({
      discoverable: true,
      ownerUserId: "owner_1",
      orgId: "org_1",
      ownerInOrg: true,
      revokedDeviceJkts: ["swept-device"],
    });
    expect(registry.isDeviceRevoked("swept-device")).toBe(true);
  });

  it("stops refusing once the credential could no longer be presented anyway", async () => {
    const registry = new RemoteSessionRegistry();
    await registry.reverify(
      {
        discoverable: true,
        ownerUserId: "owner_1",
        orgId: "org_1",
        ownerInOrg: true,
        revokedDeviceJkts: [],
      },
      { kind: "device_revoked", subject: "expired-entry" },
    );
    const pastCredentialLifetime = Date.now() + 61 * 60 * 1_000;
    expect(registry.isDeviceRevoked("expired-entry", pastCredentialLifetime)).toBe(false);
  });
});
