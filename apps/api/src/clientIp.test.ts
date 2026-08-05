import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { clientIp, resolveClientIp } from "./clientIp";

describe("resolveClientIp", () => {
  it("prefers the first forwarded hop over the socket address", () => {
    expect(
      resolveClientIp({
        forwardedFor: "203.0.113.9, 10.0.0.1, 10.0.0.2",
        remoteAddress: () => "10.0.0.2",
      }),
    ).toBe("203.0.113.9");
  });

  it("trims whitespace around the forwarded hop", () => {
    expect(
      resolveClientIp({ forwardedFor: "  203.0.113.9  ", remoteAddress: () => undefined }),
    ).toBe("203.0.113.9");
  });

  // The no-proxy deployment: without this, every caller shares one bucket.
  it("falls back to the socket address when there is no forwarded header", () => {
    expect(resolveClientIp({ forwardedFor: undefined, remoteAddress: () => "198.51.100.4" })).toBe(
      "198.51.100.4",
    );
  });

  it("falls back to the socket address when the forwarded header is blank", () => {
    expect(resolveClientIp({ forwardedFor: "   ", remoteAddress: () => "198.51.100.4" })).toBe(
      "198.51.100.4",
    );
  });

  it("uses the shared bucket only when neither is available", () => {
    expect(resolveClientIp({ forwardedFor: undefined, remoteAddress: () => undefined })).toBe(
      "unknown",
    );
  });

  it("does not consult the socket when a forwarded hop is present", () => {
    const remoteAddress = vi.fn(() => "10.0.0.2");
    resolveClientIp({ forwardedFor: "203.0.113.9", remoteAddress });
    expect(remoteAddress).not.toHaveBeenCalled();
  });
});

// resolveClientIp's fallback is only worth anything if the socket address is
// actually reachable from a Hono context, which a synthetic app.request()
// cannot demonstrate — so this drives a real listening server.
describe("clientIp", () => {
  it("reads the socket address over a real connection, and prefers a forwarded hop", async () => {
    const app = new Hono();
    app.get("/ip", (c) => c.text(clientIp(c)));
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
      expect(
        await (await fetch(url, { headers: { "x-forwarded-for": "203.0.113.9" } })).text(),
      ).toBe("203.0.113.9");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("degrades to the shared bucket on a synthetic request with no socket", async () => {
    const app = new Hono();
    app.get("/ip", (c) => c.text(clientIp(c)));

    expect(await (await app.request("/ip")).text()).toBe("unknown");
  });
});
