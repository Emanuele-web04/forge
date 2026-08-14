// FILE: ConnectionsSettingsPanel.test.tsx
// Purpose: The host and device rows render the states that matter — empty,
//          unreachable, owner vs workspace, and the owner-only toggle.
// Layer: Component rendering tests
// Depends on: the row components and React server rendering.

import type { AccountDevice, AccountHost, EnvironmentId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DeviceRow, HostRow } from "./ConnectionsSettingsPanel";
import type { HostReachability } from "~/lib/hosts/reachability";

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

function makeDevice(overrides: Partial<AccountDevice> = {}): AccountDevice {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    jkt: "thumbprint",
    displayName: "Ada's iPhone",
    platform: "ios",
    createdAt: "2026-08-01T10:00:00.000Z",
    lastUsedAt: "2026-08-13T09:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function renderHostRow(input: {
  host: AccountHost;
  reachability?: HostReachability;
  busy?: boolean;
}): string {
  return renderToStaticMarkup(
    <HostRow
      host={input.host}
      reachability={input.reachability ?? { state: "unknown" }}
      busy={input.busy ?? false}
      onProbe={vi.fn()}
      onToggleDiscoverable={vi.fn()}
    />,
  );
}

describe("HostRow", () => {
  it("renders the host name and platform", () => {
    const html = renderHostRow({ host: makeHost() });

    expect(html).toContain("Ada&#x27;s MacBook");
    expect(html).toContain("macOS");
  });

  it("labels an owned host as mine", () => {
    expect(renderHostRow({ host: makeHost({ mine: true }) })).toContain("Mine");
  });

  it("labels an org-visible host as the workspace's", () => {
    const html = renderHostRow({ host: makeHost({ mine: false }) });

    expect(html).toContain("Workspace");
    expect(html).not.toContain(">Mine<");
  });

  // An absent `mine` means the server did not say; claiming ownership would
  // offer controls the API then refuses.
  it("treats an unset owner flag as not mine", () => {
    const host = makeHost();
    const { mine: _mine, ...withoutMine } = host;
    const html = renderHostRow({ host: withoutMine as AccountHost });

    expect(html).toContain("Workspace");
  });

  it("offers the discoverability toggle only to the owner", () => {
    expect(renderHostRow({ host: makeHost({ mine: true }) })).toContain("Discoverable");
    expect(renderHostRow({ host: makeHost({ mine: false }) })).not.toContain("Discoverable");
  });

  it("reflects the current discoverability in the switch state", () => {
    const on = renderHostRow({ host: makeHost({ mine: true, discoverable: true }) });
    const off = renderHostRow({ host: makeHost({ mine: true, discoverable: false }) });

    expect(on).toContain('aria-checked="true"');
    expect(off).toContain('aria-checked="false"');
  });

  it("names the winning transport once a probe succeeded", () => {
    const html = renderHostRow({
      host: makeHost(),
      reachability: { state: "reachable", transport: "tailscale", at: 1 },
    });

    expect(html).toContain("Reachable over Tailscale");
  });

  it("renders an unreachable host without claiming it is offline forever", () => {
    const html = renderHostRow({
      host: makeHost(),
      reachability: { state: "unreachable", at: 1 },
    });

    expect(html).toContain("Did not answer");
  });

  it("keeps a network failure distinguishable from a refusal", () => {
    const html = renderHostRow({
      host: makeHost(),
      reachability: { state: "no-answer", at: 1 },
    });

    expect(html).toContain("No response");
  });

  it("says nothing has been checked before the first probe", () => {
    expect(renderHostRow({ host: makeHost() })).toContain("Not checked yet");
  });

  // ADR 0010 + the palette: no success/warning token exists, and there is no
  // live presence to justify a light anyway.
  it("renders reachability without a status dot or status color", () => {
    for (const reachability of [
      { state: "reachable", transport: "lan", at: 1 },
      { state: "unreachable", at: 1 },
      { state: "no-answer", at: 1 },
    ] satisfies HostReachability[]) {
      const html = renderHostRow({ host: makeHost(), reachability });
      expect(html).not.toMatch(/bg-success|bg-destructive|text-success|text-warning/);
      expect(html).not.toMatch(/rounded-full[^"]*bg-(green|red|emerald|amber)/);
    }
  });

  it("flags a host that never finished its key exchange", () => {
    const html = renderHostRow({ host: makeHost({ linked: false }) });

    expect(html).toContain("Not linked");
  });

  it("disables the probe button while a probe is running", () => {
    const html = renderHostRow({ host: makeHost(), reachability: { state: "probing" } });

    expect(html).toContain("Checking...");
    expect(html).toContain("disabled");
  });
});

describe("DeviceRow", () => {
  function renderDeviceRow(device: AccountDevice, busy = false): string {
    return renderToStaticMarkup(<DeviceRow device={device} busy={busy} onRevoke={vi.fn()} />);
  }

  it("renders the device name and when it was last used", () => {
    const html = renderDeviceRow(
      makeDevice({ lastUsedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }),
    );

    expect(html).toContain("Ada&#x27;s iPhone");
    expect(html).toContain("Used 3h ago");
  });

  it("says so when a device has never been used", () => {
    expect(renderDeviceRow(makeDevice({ lastUsedAt: null }))).toContain("Never used");
  });

  // --color-destructive is reserved for revoke/delete/unlink.
  it("offers revoke as a destructive action", () => {
    const html = renderDeviceRow(makeDevice());

    expect(html).toContain("Revoke");
    expect(html).toContain("destructive");
  });

  it("does not offer to revoke an already-revoked device", () => {
    const html = renderDeviceRow(makeDevice({ revokedAt: "2026-08-12T10:00:00.000Z" }));

    expect(html).toContain("Revoked");
    expect(html).not.toContain(">Revoke<");
  });

  it("disables revoke while one is in flight", () => {
    expect(renderDeviceRow(makeDevice(), true)).toContain("disabled");
  });
});
