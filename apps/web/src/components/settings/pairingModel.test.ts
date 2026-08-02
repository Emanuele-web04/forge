// FILE: pairingModel.test.ts
// Purpose: Proves a pairing QR is only ever produced for a URL a phone can open,
//          and that the credential never lands anywhere the server can log it.
// Layer: Settings logic tests

import { EnvironmentId, type ServerPhoneReachabilityResult } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildPairingUrl, phoneUsableOrigin, resolvePairingHostState } from "./pairingModel";

const ENVIRONMENT_ID = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");

const TAILSCALE_REACHABILITY: ServerPhoneReachabilityResult = {
  kind: "tailscale-serve",
  origin: "https://vps.tail1234.ts.net",
  summary: "Reachable over your tailnet.",
  setupHint: null,
  fallbackCommand: "ssh -N -L 1596:127.0.0.1:1596 me@vps",
};

const FALLBACK_REACHABILITY: ServerPhoneReachabilityResult = {
  kind: "ssh-port-forward",
  origin: null,
  summary: "Reachable only while an SSH port forward is open.",
  setupHint: "Run `tailscale serve --bg 1596` on this host.",
  fallbackCommand: "ssh -N -L 1596:127.0.0.1:1596 me@vps",
};

describe("buildPairingUrl", () => {
  it("puts the credential in the fragment, never the query", () => {
    // A query string is sent to the server, written to access logs, and carried
    // on Referer. The fragment is none of those.
    const url = new URL(
      buildPairingUrl({ origin: "https://vps.tail1234.ts.net", credential: "secret-credential" }),
    );
    expect(url.pathname).toBe("/pair");
    expect(url.search).toBe("");
    expect(url.searchParams.get("token")).toBeNull();
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe("secret-credential");
  });

  it("drops any query already on the origin", () => {
    const url = new URL(
      buildPairingUrl({ origin: "https://vps.example.com/?token=leaked", credential: "fresh" }),
    );
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe("fresh");
  });
});

describe("phoneUsableOrigin", () => {
  it("rejects loopback origins, which resolve to the PHONE itself", () => {
    expect(phoneUsableOrigin("http://localhost:1596")).toBeNull();
    expect(phoneUsableOrigin("http://127.0.0.1:1596")).toBeNull();
    expect(phoneUsableOrigin("http://[::1]:1596")).toBeNull();
  });

  it("accepts a routable origin", () => {
    expect(phoneUsableOrigin("https://synara.example.com")).toBe("https://synara.example.com");
  });

  it("rejects junk rather than throwing into the render", () => {
    expect(phoneUsableOrigin("not a url")).toBeNull();
    expect(phoneUsableOrigin(null)).toBeNull();
  });
});

describe("resolvePairingHostState", () => {
  const base = {
    environmentId: ENVIRONMENT_ID,
    label: "prod-vps",
    reachable: true,
    credential: "secret-credential",
    browserOrigin: null,
  };

  it("produces a QR URL on the Tailscale path", () => {
    const state = resolvePairingHostState({ ...base, reachability: TAILSCALE_REACHABILITY });
    expect(state.pairingUrl).toContain("https://vps.tail1234.ts.net/pair");
    expect(state.blockedReason).toBeNull();
  });

  it("documents the SSH fallback even on the blessed path", () => {
    // The fallback is needed exactly when the tailnet is down — the worst
    // possible moment to go looking for the command.
    const state = resolvePairingHostState({ ...base, reachability: TAILSCALE_REACHABILITY });
    expect(state.fallbackCommand).toBe("ssh -N -L 1596:127.0.0.1:1596 me@vps");
  });

  it("refuses to encode a loopback origin as a QR code", () => {
    const state = resolvePairingHostState({
      ...base,
      reachability: FALLBACK_REACHABILITY,
      browserOrigin: "http://localhost:1596",
    });
    expect(state.pairingUrl).toBeNull();
    // Says what to do next, and it is the actionable Tailscale hint.
    expect(state.blockedReason).toContain("tailscale serve");
  });

  it("uses the browser's own origin when it is routable and the host has no tailnet", () => {
    const state = resolvePairingHostState({
      ...base,
      reachability: FALLBACK_REACHABILITY,
      browserOrigin: "https://synara.example.com",
    });
    expect(state.pairingUrl).toContain("https://synara.example.com/pair");
  });

  it("explains an unreachable host instead of showing a dead code", () => {
    const state = resolvePairingHostState({
      ...base,
      reachable: false,
      reachability: TAILSCALE_REACHABILITY,
    });
    expect(state.pairingUrl).toBeNull();
    expect(state.blockedReason).toContain("cannot reach prod-vps");
  });

  it("explains a missing credential in terms of the action that fixes it", () => {
    const state = resolvePairingHostState({
      ...base,
      credential: null,
      reachability: TAILSCALE_REACHABILITY,
    });
    expect(state.pairingUrl).toBeNull();
    expect(state.blockedReason).toContain("owner");
  });
});
