import * as Http from "node:http";

import { PROVISIONING_IDENTITY_ROUTE_PATH } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { HandshakeProbeError, probeHandshakeOverTunnel } from "./handshakeProbe";
import { verifyProvisioningHandshake } from "./provisioningHandshake";

const servers: Http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/**
 * A stand-in for the remote server at the near end of the tunnel. A real
 * loopback HTTP server rather than a mocked `http.request`, because the
 * behaviours under test — a 401 that must not be retried, a body ceiling, a
 * connection refused that must be — are transport behaviours.
 */
async function listen(
  handler: (request: Http.IncomingMessage, response: Http.ServerResponse) => void,
): Promise<number> {
  const server = Http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

function respondJson(response: Http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("probeHandshakeOverTunnel", () => {
  it("presents the credential as a bearer token and nothing else", async () => {
    let seen: Http.IncomingHttpHeaders | undefined;
    let seenPath: string | undefined;
    const port = await listen((request, response) => {
      seen = request.headers;
      seenPath = request.url;
      respondJson(response, 200, {
        environmentId: "env-abc",
        serverVersion: "1.2.3",
        acceptedToken: "tok-1",
        authenticated: true,
      });
    });

    await probeHandshakeOverTunnel({ localPort: port, credential: { token: "tok-1" } });

    expect(seenPath).toBe(PROVISIONING_IDENTITY_ROUTE_PATH);
    expect(seen?.authorization).toBe("Bearer tok-1");
    // NO provider credential, NO API key, NO cookie. The remote authenticates
    // its own providers; readiness detects and tells.
    expect(seen?.cookie).toBeUndefined();
    const headerNames = Object.keys(seen ?? {}).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("x-api-key");
    expect(headerNames.filter((name) => name.startsWith("x-synara"))).toEqual([]);
  });

  it("returns a claim the broker accepts when the remote answers correctly", async () => {
    const port = await listen((_request, response) =>
      respondJson(response, 200, {
        environmentId: "env-abc",
        serverVersion: "1.2.3",
        acceptedToken: "tok-1",
        authenticated: true,
      }),
    );
    const claim = await probeHandshakeOverTunnel({
      localPort: port,
      credential: { token: "tok-1" },
    });
    expect(
      verifyProvisioningHandshake({
        claim,
        expected: {
          environmentId: "env-abc",
          serverVersion: "1.2.3",
          credential: { token: "tok-1" },
        },
      }),
    ).toEqual({ ok: true });
  });

  /**
   * A 401 is a definitive answer, not "not up yet". Retrying it would burn the
   * whole deadline and then report a timeout, hiding the real reason.
   */
  it("treats a 401 as an unauthenticated claim without retrying", async () => {
    let requests = 0;
    const port = await listen((_request, response) => {
      requests += 1;
      respondJson(response, 401, { error: "Unauthorized" });
    });
    const claim = await probeHandshakeOverTunnel({
      localPort: port,
      credential: { token: "tok-1" },
      deadlineMs: 10_000,
    });
    expect(requests).toBe(1);
    expect(claim.authenticated).toBe(false);
    const verdict = verifyProvisioningHandshake({
      claim,
      expected: {
        environmentId: "env-abc",
        serverVersion: "1.2.3",
        credential: { token: "tok-1" },
      },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("did not accept");
  });

  /**
   * Default-deny at the parser. Every one of these must leave a field absent or
   * false rather than coerced into something the verdict would accept — this is
   * the one direction the parser may never fail in.
   */
  it("never coerces a malformed body into an acceptable claim", async () => {
    for (const body of [
      "not json at all",
      JSON.stringify(null),
      JSON.stringify([]),
      JSON.stringify({ environmentId: "", serverVersion: "", authenticated: "yes" }),
      JSON.stringify({ environmentId: 42, serverVersion: 1.2, authenticated: 1 }),
      JSON.stringify({ environmentId: "env-abc", serverVersion: "1.2.3", authenticated: true }),
    ]) {
      const port = await listen((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(body);
      });
      const claim = await probeHandshakeOverTunnel({
        localPort: port,
        credential: { token: "tok-1" },
      });
      expect(
        verifyProvisioningHandshake({
          claim,
          expected: {
            environmentId: "env-abc",
            serverVersion: "1.2.3",
            credential: { token: "tok-1" },
          },
        }).ok,
      ).toBe(false);
    }
  });

  /**
   * The status is decisive, not the body. A server that answers 401 — or 500,
   * or 403 — while its body claims a perfect identity has NOT authenticated us,
   * and reading the body anyway would let anything that can answer on that port
   * hand us a claim the verdict accepts.
   *
   * Found by mutation: deleting the status check left every other test green,
   * because the 401 above happens to carry an inert body.
   */
  it("ignores the body of a non-200, however convincing it looks", async () => {
    for (const status of [401, 403, 404, 500, 502]) {
      const port = await listen((_request, response) =>
        respondJson(response, status, {
          environmentId: "env-abc",
          serverVersion: "1.2.3",
          acceptedToken: "tok-1",
          authenticated: true,
        }),
      );
      const claim = await probeHandshakeOverTunnel({
        localPort: port,
        credential: { token: "tok-1" },
        deadlineMs: 2_000,
      });
      expect(claim.authenticated).toBe(false);
      expect(claim.acceptedToken).toBeUndefined();
      expect(
        verifyProvisioningHandshake({
          claim,
          expected: {
            environmentId: "env-abc",
            serverVersion: "1.2.3",
            credential: { token: "tok-1" },
          },
        }).ok,
      ).toBe(false);
    }
  });

  /** `authenticated` must be strictly `true`; a truthy value is not a claim. */
  it("does not accept a truthy non-boolean as authenticated", async () => {
    const port = await listen((_request, response) =>
      respondJson(response, 200, {
        environmentId: "env-abc",
        serverVersion: "1.2.3",
        acceptedToken: "tok-1",
        authenticated: "true",
      }),
    );
    const claim = await probeHandshakeOverTunnel({
      localPort: port,
      credential: { token: "tok-1" },
    });
    expect(claim.authenticated).toBe(false);
  });

  it("retries while the remote is not up yet, then succeeds", async () => {
    let attempts = 0;
    const port = await listen((_request, response) => {
      attempts += 1;
      if (attempts < 3) {
        // The shape of a server that has bound the port but is still starting.
        response.destroy();
        return;
      }
      respondJson(response, 200, {
        environmentId: "env-abc",
        serverVersion: "1.2.3",
        acceptedToken: "tok-1",
        authenticated: true,
      });
    });
    const claim = await probeHandshakeOverTunnel({
      localPort: port,
      credential: { token: "tok-1" },
      deadlineMs: 20_000,
    });
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(claim.authenticated).toBe(true);
  });

  it("gives up at the deadline rather than waiting forever", async () => {
    // Nothing listening: every attempt is a connection refused.
    await expect(
      probeHandshakeOverTunnel({
        localPort: 1,
        credential: { token: "tok-1" },
        deadlineMs: 300,
      }),
    ).rejects.toThrow(HandshakeProbeError);
  });

  it("refuses an unbounded identity response", async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      // Far past the ceiling, written in chunks so the bound is hit mid-stream.
      for (let index = 0; index < 40; index += 1) response.write("x".repeat(8_192));
      response.end();
    });
    await expect(
      probeHandshakeOverTunnel({
        localPort: port,
        credential: { token: "tok-1" },
        deadlineMs: 300,
      }),
    ).rejects.toThrow(HandshakeProbeError);
  });
});
