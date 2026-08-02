// FILE: tailscaleServe.test.ts
// Purpose: Proves Tailscale is offered only when it actually works, and that
//          every other case falls back to the documented SSH forward.
// Layer: Shared runtime tests

import { describe, expect, it } from "vitest";

import {
  parseTailscaleServeMappings,
  parseTailscaleStatus,
  resolvePhoneReachability,
  serveMappingForLocalPort,
  sshPortForwardCommand,
} from "./tailscaleServe";

const RUNNING_STATUS_JSON = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "vps.tail1234.ts.net.", Online: true },
  CertDomains: ["vps.tail1234.ts.net"],
});

describe("parseTailscaleStatus", () => {
  it("reads a running tailnet and strips the MagicDNS trailing dot", () => {
    // The trailing dot makes a valid URL that does NOT match the certificate
    // subject, so a phone would see a TLS warning on an otherwise correct path.
    const status = parseTailscaleStatus(RUNNING_STATUS_JSON);
    expect(status).toEqual({
      online: true,
      dnsName: "vps.tail1234.ts.net",
      httpsAvailable: true,
    });
  });

  it("reports offline for a backend that is not Running", () => {
    const status = parseTailscaleStatus(
      JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "vps.tail1234.ts.net." } }),
    );
    expect(status.online).toBe(false);
  });

  it("fails closed on unparseable output", () => {
    expect(parseTailscaleStatus("not json at all").online).toBe(false);
    expect(parseTailscaleStatus("null").online).toBe(false);
  });

  it("reports HTTPS unavailable when no cert covers this machine's name", () => {
    const status = parseTailscaleStatus(
      JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "vps.tail1234.ts.net." },
        CertDomains: ["other.tail1234.ts.net"],
      }),
    );
    expect(status.online).toBe(true);
    expect(status.httpsAvailable).toBe(false);
  });
});

describe("parseTailscaleServeMappings", () => {
  const SERVE_JSON = JSON.stringify({
    Web: {
      "vps.tail1234.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:1596" } },
      },
    },
  });

  it("reads the public port and its local target", () => {
    expect(parseTailscaleServeMappings(SERVE_JSON)).toEqual([
      { port: 443, target: "http://127.0.0.1:1596" },
    ]);
  });

  it("returns nothing for unparseable or empty config", () => {
    expect(parseTailscaleServeMappings("{}")).toEqual([]);
    expect(parseTailscaleServeMappings("garbage")).toEqual([]);
  });

  it("matches a mapping only against the port Synara actually listens on", () => {
    const mappings = parseTailscaleServeMappings(SERVE_JSON);
    expect(serveMappingForLocalPort(mappings, 1596)).not.toBeNull();
    // A serve mapping pointing at some OTHER local service must not be read as
    // "Synara is reachable" — the QR would open an unrelated app.
    expect(serveMappingForLocalPort(mappings, 3000)).toBeNull();
  });
});

describe("resolvePhoneReachability", () => {
  const mappings = parseTailscaleServeMappings(
    JSON.stringify({
      Web: { "vps.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:1596" } } } },
    }),
  );

  it("offers the Tailscale HTTPS origin when everything is in place", () => {
    const result = resolvePhoneReachability({
      status: parseTailscaleStatus(RUNNING_STATUS_JSON),
      serveMappings: mappings,
      localPort: 1596,
    });
    expect(result.kind).toBe("tailscale-serve");
    expect(result.origin).toBe("https://vps.tail1234.ts.net");
    expect(result.setupHint).toBeNull();
  });

  it("includes a non-standard serve port in the origin", () => {
    const result = resolvePhoneReachability({
      status: parseTailscaleStatus(RUNNING_STATUS_JSON),
      serveMappings: [{ port: 8443, target: "http://127.0.0.1:1596" }],
      localPort: 1596,
    });
    expect(result.origin).toBe("https://vps.tail1234.ts.net:8443");
  });

  it("falls back when Tailscale is not running, and says how to enable it", () => {
    const result = resolvePhoneReachability({
      status: parseTailscaleStatus("{}"),
      serveMappings: [],
      localPort: 1596,
    });
    expect(result.kind).toBe("ssh-port-forward");
    expect(result.origin).toBeNull();
    expect(result.setupHint).toContain("tailscale up");
  });

  it("falls back when HTTPS certs are not enabled rather than offering a URL that warns", () => {
    const result = resolvePhoneReachability({
      status: { online: true, dnsName: "vps.tail1234.ts.net", httpsAvailable: false },
      serveMappings: mappings,
      localPort: 1596,
    });
    expect(result.kind).toBe("ssh-port-forward");
    expect(result.setupHint).toContain("HTTPS certificates");
  });

  it("falls back when serve is not mapped to Synara's port, naming the exact command", () => {
    // An unreachable QR code is worse than none: the user blames their phone.
    const result = resolvePhoneReachability({
      status: parseTailscaleStatus(RUNNING_STATUS_JSON),
      serveMappings: [],
      localPort: 1596,
    });
    expect(result.kind).toBe("ssh-port-forward");
    expect(result.setupHint).toContain("tailscale serve --bg 1596");
  });
});

describe("sshPortForwardCommand", () => {
  it("documents the always-works fallback", () => {
    expect(
      sshPortForwardCommand({ sshDestination: "me@vps", localPort: 1596, remotePort: 1596 }),
    ).toBe("ssh -N -L 1596:127.0.0.1:1596 me@vps");
  });
});
