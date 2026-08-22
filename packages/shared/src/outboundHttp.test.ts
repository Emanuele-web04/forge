import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";

import { outboundHttp } from "./outboundHttp";

/**
 * A port nothing is listening on, so every connection attempt is refused.
 *
 * HTTPS because the outbound policy rejects plain HTTP destinations outright,
 * which would fail the request before it ever reaches a socket.
 *
 * Taken by opening a server and closing it, which is more reliable than picking
 * a number and hoping: the OS will not hand the same port out again while this
 * process holds the reference.
 */
async function refusedPort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const policyFor = (port: number) => ({
  service: "test",
  allowedOrigins: [`https://127.0.0.1:${port}`],
  timeoutMs: 5_000,
  maxRequestBytes: 0,
  maxResponseBytes: 64 * 1024,
  maxRedirects: 0,
  maxConcurrent: 2,
  maxQueued: 4,
  requirePublicAddress: false,
});

/**
 * These cover the observable contract: a refused connection rejects, and the
 * client is still usable afterwards.
 *
 * The specific regression behind the `on`/`once` change is not reproducible
 * here. It needs a host whose addresses all refuse so Happy Eyeballs emits
 * `error` more than once, and the client pins DNS to a single address, so a
 * request from this suite can only ever emit once. It was reproduced by hand
 * against a real multi-address host: the request rejected correctly, execution
 * continued, and the process then died on the second emit.
 */
describe("outbound requests that cannot connect", () => {
  it("rejects rather than hanging", async () => {
    const port = await refusedPort();

    await expect(
      outboundHttp.request({
        policy: policyFor(port),
        url: `https://127.0.0.1:${port}/favicon.ico`,
        headers: { Accept: "image/*" },
      }),
    ).rejects.toThrow(/Outbound request failed/u);
  });

  it("stays usable for the next caller after a connection failure", async () => {
    const port = await refusedPort();

    await expect(
      outboundHttp.request({
        policy: policyFor(port),
        url: `https://127.0.0.1:${port}/again.ico`,
        headers: { Accept: "image/*" },
      }),
    ).rejects.toThrow(/Outbound request failed/u);
  });
});
