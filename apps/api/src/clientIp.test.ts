import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  clientIp,
  resolveClientIp,
  resolveTrustedProxyHops,
  sanitizeForwardableIp,
  sanitizeForwardableUserAgent,
} from "./clientIp";

describe("resolveClientIp", () => {
  // The deployed shape: one trusted proxy appends the real peer as the
  // rightmost entry; everything left of it is client-supplied.
  it("takes the rightmost entry with one trusted hop", () => {
    expect(
      resolveClientIp(
        { forwardedFor: "203.0.113.9, 10.0.0.1, 198.51.100.7", remoteAddress: () => "10.0.0.2" },
        1,
      ),
    ).toBe("198.51.100.7");
  });

  // The spoof the old leftmost-entry key allowed: an attacker-chosen prefix
  // must not move the bucket, so per-IP budgets cannot be minted at will.
  it("ignores client-supplied leftmost entries", () => {
    const spoofed = resolveClientIp(
      { forwardedFor: "6.6.6.6, 198.51.100.7", remoteAddress: () => "10.0.0.2" },
      1,
    );
    const honest = resolveClientIp(
      { forwardedFor: "198.51.100.7", remoteAddress: () => "10.0.0.2" },
      1,
    );
    expect(spoofed).toBe("198.51.100.7");
    expect(spoofed).toBe(honest);
  });

  it("takes the entry N from the right with N trusted hops", () => {
    expect(
      resolveClientIp(
        { forwardedFor: "203.0.113.9, 198.51.100.7, 10.0.0.5", remoteAddress: () => "10.0.0.2" },
        2,
      ),
    ).toBe("198.51.100.7");
  });

  it("trims whitespace around the chosen entry", () => {
    expect(
      resolveClientIp({ forwardedFor: "  203.0.113.9  ", remoteAddress: () => undefined }, 1),
    ).toBe("203.0.113.9");
  });

  // hops=0 is the no-proxy deployment: the header is client-controlled end
  // to end and must be ignored outright.
  it("ignores the header entirely with zero trusted hops", () => {
    expect(
      resolveClientIp({ forwardedFor: "203.0.113.9", remoteAddress: () => "198.51.100.4" }, 0),
    ).toBe("198.51.100.4");
  });

  // A header with fewer entries than trusted hops did not traverse the
  // expected proxies — degrade to the socket, never to a client value.
  it("falls back to the socket when the header has fewer entries than hops", () => {
    expect(
      resolveClientIp({ forwardedFor: "203.0.113.9", remoteAddress: () => "198.51.100.4" }, 2),
    ).toBe("198.51.100.4");
  });

  it("falls back to the socket address when there is no forwarded header", () => {
    expect(
      resolveClientIp({ forwardedFor: undefined, remoteAddress: () => "198.51.100.4" }, 1),
    ).toBe("198.51.100.4");
  });

  it("falls back to the socket address when the forwarded header is blank", () => {
    expect(resolveClientIp({ forwardedFor: "   ", remoteAddress: () => "198.51.100.4" }, 1)).toBe(
      "198.51.100.4",
    );
  });

  it("uses the shared bucket only when neither is available", () => {
    expect(resolveClientIp({ forwardedFor: undefined, remoteAddress: () => undefined }, 1)).toBe(
      "unknown",
    );
  });

  it("does not consult the socket when a trusted forwarded entry is present", () => {
    const remoteAddress = vi.fn(() => "10.0.0.2");
    resolveClientIp({ forwardedFor: "203.0.113.9", remoteAddress }, 1);
    expect(remoteAddress).not.toHaveBeenCalled();
  });
});

describe("resolveTrustedProxyHops", () => {
  // The no-proxy default: a direct/Docker self-host must never key rate
  // limits on a header any caller can forge — proxies opt in explicitly.
  it("defaults to zero hops when unset or blank", () => {
    expect(resolveTrustedProxyHops(undefined)).toBe(0);
    expect(resolveTrustedProxyHops("")).toBe(0);
    expect(resolveTrustedProxyHops("  ")).toBe(0);
  });

  it("accepts explicit non-negative integers", () => {
    expect(resolveTrustedProxyHops("1")).toBe(1);
    expect(resolveTrustedProxyHops("2")).toBe(2);
  });

  it("rejects malformed values back to the default", () => {
    expect(resolveTrustedProxyHops("-1")).toBe(0);
    expect(resolveTrustedProxyHops("two")).toBe(0);
    expect(resolveTrustedProxyHops("1.5")).toBe(0);
  });
});

describe("sanitizeForwardableIp", () => {
  it("passes plain IPv4 and IPv6 literals", () => {
    expect(sanitizeForwardableIp("203.0.113.9")).toBe("203.0.113.9");
    expect(sanitizeForwardableIp("::ffff:127.0.0.1")).toBe("::ffff:127.0.0.1");
  });

  // The value originates in a client-controllable header: anything that is
  // not shaped like an address must be dropped, not forwarded upstream.
  it("drops the shared bucket and non-address values", () => {
    expect(sanitizeForwardableIp("unknown")).toBeUndefined();
    expect(sanitizeForwardableIp("evil header\r\ninjection")).toBeUndefined();
    expect(sanitizeForwardableIp("a".repeat(64))).toBeUndefined();
  });
});

describe("sanitizeForwardableUserAgent", () => {
  it("passes and trims ordinary user agents, dropping empty ones", () => {
    expect(sanitizeForwardableUserAgent("  synara/1.0  ")).toBe("synara/1.0");
    expect(sanitizeForwardableUserAgent(undefined)).toBeUndefined();
    expect(sanitizeForwardableUserAgent("   ")).toBeUndefined();
  });

  it("truncates oversized values", () => {
    expect(sanitizeForwardableUserAgent("x".repeat(1000))?.length).toBe(256);
  });
});

// resolveClientIp's fallback is only worth anything if the socket address is
// actually reachable from a Hono context, which a synthetic app.request()
// cannot demonstrate — so this drives a real listening server.
describe("clientIp", () => {
  it("reads the socket address over a real connection, and honours the trusted hop", async () => {
    const app = new Hono();
    app.get("/ip", (c) => c.text(clientIp(c, 1)));
    const server = serve({ fetch: app.fetch, port: 0 });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server failed to bind");
      const url = `http://127.0.0.1:${address.port}/ip`;

      // A dual-stack listener reports loopback in IPv4-mapped form. The exact
      // spelling does not matter — it only has to be stable per client, which
      // is all a bucket key needs — but it must be a real address, not the
      // shared "unknown" bucket.
      expect(await (await fetch(url)).text()).toBe("::ffff:127.0.0.1");
      // With one trusted hop, the rightmost entry is the caller — a spoofed
      // prefix does not change the bucket.
      expect(
        await (await fetch(url, { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } })).text(),
      ).toBe("203.0.113.9");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("degrades to the shared bucket on a synthetic request with no socket", async () => {
    const app = new Hono();
    app.get("/ip", (c) => c.text(clientIp(c, 0)));

    expect(await (await app.request("/ip")).text()).toBe("unknown");
  });
});
