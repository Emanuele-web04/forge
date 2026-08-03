// End-to-end tests for the single-origin `/env/:envId/*` proxy, against REAL
// sockets and a REAL `ws` server standing in for the remote Synara server.
//
// Nothing here mocks the transport. The properties under test — permessage-
// deflate negotiating end to end, a Pong overtaking a multi-MB snapshot, a slow
// consumer producing an explicit resync instead of memory growth — are all
// properties of bytes on a socket, and a fake would assert only that the fake
// behaves as written.

import http, { type IncomingMessage } from "node:http";
import net, { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import {
  EnvironmentId,
  WS_CLOSE_PROXY_RESYNC_REQUIRED,
  WS_CLOSE_PROXY_TUNNEL_LOST,
} from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  makeEnvironmentProxyDispatch,
  MAX_WEBSOCKET_MESSAGE_BYTES_FOR_PROXY,
  proxyEnvironmentWebSocket,
  serializeUpgradeRequest,
  UpgradeRequestSerializationError,
} from "./environmentProxy";
import type { EnvironmentProxyAuthorizer } from "./environmentProxyAuthorization";
import { makeEnvironmentProxyRegistry } from "./environmentProxyTargets";
import { MAX_WEBSOCKET_MESSAGE_BYTES } from "./nodeHttpServer";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function portOf(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(portOf(server)));
  });
}

/**
 * Tracks a server for teardown, destroying every socket it ever accepted.
 *
 * A proxied WebSocket keeps a live upgraded socket on BOTH servers, and
 * `close()` alone waits on them indefinitely, so sockets are collected
 * explicitly rather than relying on the server to know about them.
 */
function track(server: http.Server): void {
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  );
}

/** A stand-in for the remote Synara server: real HTTP + real ws, on loopback. */
async function startFakeRemote(
  options: {
    readonly perMessageDeflate?: boolean;
    readonly onRequest?: (request: http.IncomingMessage, response: http.ServerResponse) => void;
    readonly onConnection?: (socket: WebSocket, request: http.IncomingMessage) => void;
  } = {},
) {
  const seenAuthorization: Array<string | undefined> = [];
  const seenCookies: Array<string | undefined> = [];
  const seenTargets: string[] = [];
  let connectionCount = 0;
  const server = http.createServer((request, response) => {
    seenTargets.push(request.url ?? "");
    seenAuthorization.push(request.headers.authorization);
    seenCookies.push(request.headers.cookie);
    if (options.onRequest) {
      options.onRequest(request, response);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "synara_session=remote-token; Path=/; HttpOnly",
    });
    response.end(JSON.stringify({ target: request.url }));
  });
  const wss = new WebSocketServer({
    server,
    perMessageDeflate: options.perMessageDeflate ?? true,
  });
  wss.on("connection", (socket, request) => {
    seenTargets.push(request.url ?? "");
    seenAuthorization.push(request.headers.authorization);
    seenCookies.push(request.headers.cookie);
    options.onConnection?.(socket, request);
  });
  // Counted at the TCP layer, not the HTTP one: "the upstream was never
  // contacted" must mean no socket was opened, not merely that no request was
  // parsed.
  server.on("connection", () => {
    connectionCount += 1;
  });
  const port = await listen(server);
  track(server);
  return {
    server,
    wss,
    port,
    seenTargets,
    seenAuthorization,
    seenCookies,
    connections: () => connectionCount,
  };
}

/** The local server: nothing but the proxy dispatch wired the way production wires it. */
/**
 * A gate that allows everything, for tests exercising TRANSPORT behaviour.
 *
 * Stated explicitly rather than omitted: `authorize` is required precisely
 * because an absent gate used to be indistinguishable from a deliberate one.
 */
const allowAll: EnvironmentProxyAuthorizer = async () => ({ allowed: true });

async function startLocalProxy(input: {
  readonly registry: ReturnType<typeof makeEnvironmentProxyRegistry>;
  readonly queueOptions?: { maxBytes?: number; maxFrames?: number };
  readonly localResponseBody?: string;
  readonly authorize?: EnvironmentProxyAuthorizer;
  readonly upstreamTimeoutMs?: number;
}) {
  const proxyErrors: string[] = [];
  const dispatch = makeEnvironmentProxyDispatch({
    registry: input.registry,
    ...(input.queueOptions ? { queueOptions: input.queueOptions } : {}),
    authorize: input.authorize ?? allowAll,
    ...(input.upstreamTimeoutMs !== undefined
      ? { upstreamTimeoutMs: input.upstreamTimeoutMs }
      : {}),
    onError: (message) => proxyErrors.push(message),
  });
  const localRequests: string[] = [];
  const server = http.createServer(
    dispatch.wrapRequestHandler((request, response) => {
      localRequests.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(input.localResponseBody ?? "local-server");
    }),
  );
  const localUpgrades: string[] = [];
  server.on(
    "upgrade",
    dispatch.wrapUpgradeHandler((request, socket) => {
      localUpgrades.push(request.url ?? "");
      socket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
    }),
  );
  const port = await listen(server);
  track(server);
  return { server, port, localRequests, localUpgrades, dispatch, proxyErrors };
}

const cookieNameOf = (setCookie: string) => setCookie.split("=")[0];

/** Frames the way a CLIENT sends them: masked, as RFC 6455 §5.1 requires. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([0xa1, 0xb2, 0xc3, 0xd4]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.byteLength; index += 1) {
    masked[index] = masked[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.byteLength]), mask, masked]);
}

const denyAll: EnvironmentProxyAuthorizer = async () => ({
  allowed: false,
  status: 401,
  message: "Unauthorized",
});

function registryWith(id: string, port: number) {
  const registry = makeEnvironmentProxyRegistry();
  registry.register({
    environmentId: EnvironmentId.makeUnsafe(id),
    host: "127.0.0.1",
    port,
    credential: `provisioned-${id}`,
  });
  return registry;
}

function fetchText(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path, headers }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      });
      request.on("error", reject);
      request.end();
    },
  );
}

function openProxiedSocket(port: number, path: string, options: Record<string, unknown> = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, options);
  cleanups.push(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  });
  return socket;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("close", (code) => reject(new Error(`closed before open: ${code}`)));
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe("environment proxy — routing and isolation", () => {
  it("forwards a proxied path upstream and leaves every other path to the local server", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });

    const proxied = await fetchText(local.port, "/env/host-a/api/threads");
    expect(proxied.status).toBe(200);
    expect(JSON.parse(proxied.body).target).toBe("/api/threads");
    // The local router must never have seen it. If it had, its SPA fallback
    // would happily serve index.html for a remote deep link and race the
    // proxy's response onto the same socket.
    expect(local.localRequests).not.toContain("/env/host-a/api/threads");

    // A path only the local server serves, distinct from anything the proxied
    // request above would strip down to.
    const localOnly = await fetchText(local.port, "/local-only/settings");
    expect(localOnly.body).toBe("local-server");
    expect(local.localRequests).toContain("/local-only/settings");
    expect(remote.seenTargets).not.toContain("/local-only/settings");
  });

  it("resolves a deep link to the same path on the remote server", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const response = await fetchText(
      local.port,
      "/env/host-a/threads/9f2c-4a/messages?after=17&limit=50",
    );
    expect(JSON.parse(response.body).target).toBe("/threads/9f2c-4a/messages?after=17&limit=50");
  });

  it("404s an unregistered environment without reaching any upstream", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const response = await fetchText(local.port, "/env/host-b/api/threads");
    expect(response.status).toBe(404);
    expect(remote.seenTargets).toHaveLength(0);
    // And it did not silently fall through to the local server either.
    expect(local.localRequests).toHaveLength(0);
  });

  it("cannot be steered to a second environment through a traversal spelling", async () => {
    // Both environments are registered, so a traversal that "worked" would
    // reach a real, unintended upstream rather than merely 404.
    const authorized = await startFakeRemote();
    const forbidden = await startFakeRemote();
    const registry = registryWith("allowed", authorized.port);
    registry.register({
      environmentId: EnvironmentId.makeUnsafe("secret"),
      host: "127.0.0.1",
      port: forbidden.port,
      credential: "provisioned-secret",
    });
    const local = await startLocalProxy({ registry });

    for (const path of [
      "/env/../secret/api",
      "/env/allowed/../../secret/api",
      "/env/allowed/..%2f..%2fsecret",
      "/env/%2e%2e/secret/api",
    ]) {
      const response = await fetchText(local.port, path);
      expect(response.status, path).not.toBe(200);
    }
    expect(forbidden.seenTargets).toHaveLength(0);
  });

  it("presents the environment's provisioned credential and never the client's", async () => {
    // A browser must not be able to choose which credential the local server
    // presents to a remote host.
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    await fetchText(local.port, "/env/host-a/api/threads", {
      authorization: "Bearer attacker-chosen-token",
    });
    expect(remote.seenAuthorization).toEqual(["Bearer provisioned-host-a"]);
  });

  it("scopes an upstream Set-Cookie to the environment's path", async () => {
    // One origin serves every environment, so an unscoped cookie from A would
    // be sent by the browser to B.
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const response = await fetchText(local.port, "/env/host-a/api/auth/bootstrap");
    const cookies = response.headers["set-cookie"] ?? [];
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain("Path=/env/host-a");
    expect(cookies[0]).not.toMatch(/Path=\/;/);
    expect(cookies[0]).toContain("HttpOnly");
  });

  it("never forwards the browser's LOCAL session cookie to a remote environment", async () => {
    // The local session cookie is issued with Path=/, so the browser attaches
    // it to every /env/<id>/* request. Relaying it hands the LOCAL session
    // token — the credential that authenticates against THIS machine — to every
    // remote environment operator.
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    await fetchText(local.port, "/env/host-a/api/threads", {
      cookie: "synara_session=local-session-secret; env~host-a~synara_session=remote-token",
    });
    expect(remote.seenCookies).toHaveLength(1);
    expect(remote.seenCookies[0] ?? "").not.toContain("local-session-secret");
    // The environment's OWN cookie still crosses, under the name its server set.
    expect(remote.seenCookies[0]).toBe("synara_session=remote-token");
  });

  it("never forwards the LOCAL session cookie on the WebSocket upgrade either", async () => {
    // The upgrade path builds its request by hand, so it is a second, entirely
    // separate opportunity to leak the same credential.
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/env/host-a/ws", {
      headers: {
        cookie: "synara_session=local-session-secret; env~host-a~synara_session=remote-token",
      },
    });
    await waitForOpen(client);
    expect(remote.seenCookies).toHaveLength(1);
    expect(remote.seenCookies[0] ?? "").not.toContain("local-session-secret");
    expect(remote.seenCookies[0]).toBe("synara_session=remote-token");
  });

  it("does not send one environment's cookies to another", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    await fetchText(local.port, "/env/host-a/api/threads", {
      cookie: "env~host-b~synara_session=other-environments-token",
    });
    expect(remote.seenCookies[0]).toBeUndefined();
  });

  it("namespaces an upstream Set-Cookie so two environments cannot collide in one jar", async () => {
    // Both remotes call their cookie `synara_session`, and one origin serves
    // both. Without a rename the second response overwrites the first token.
    const remoteA = await startFakeRemote();
    const remoteB = await startFakeRemote();
    const registry = registryWith("host-a", remoteA.port);
    registry.register({
      environmentId: EnvironmentId.makeUnsafe("host-b"),
      host: "127.0.0.1",
      port: remoteB.port,
      credential: "provisioned-host-b",
    });
    const local = await startLocalProxy({ registry });

    const fromA = (await fetchText(local.port, "/env/host-a/api/auth/bootstrap")).headers[
      "set-cookie"
    ]!;
    const fromB = (await fetchText(local.port, "/env/host-b/api/auth/bootstrap")).headers[
      "set-cookie"
    ]!;
    expect(cookieNameOf(fromA[0]!)).not.toBe(cookieNameOf(fromB[0]!));
    expect(fromA[0]).toContain("Path=/env/host-a");
    expect(fromB[0]).toContain("Path=/env/host-b");
  });

  it("answers 502 rather than hanging when the tunnel is down", async () => {
    const remote = await startFakeRemote();
    const registry = registryWith("host-a", remote.port);
    const local = await startLocalProxy({ registry });
    await new Promise<void>((resolve) => remote.server.close(() => resolve()));
    const response = await fetchText(local.port, "/env/host-a/api/threads");
    expect(response.status).toBe(502);
  });

  it("gives up on an upstream that accepts the request and never answers", async () => {
    // Distinct from "tunnel down": the connection succeeds, so nothing errors —
    // the client just waits forever. Over a WAN tunnel these accumulate until
    // the socket budget is gone, and each one also pins a browser connection.
    const remote = await startFakeRemote({
      // Accepted, parsed, and then deliberately never answered.
      onRequest: () => {},
    });
    const local = await startLocalProxy({
      registry: registryWith("host-a", remote.port),
      upstreamTimeoutMs: 150,
    });
    const started = Date.now();
    const response = await fetchText(local.port, "/env/host-a/api/threads");
    expect(response.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not leave the client hanging when the tunnel dies MID-response", async () => {
    // Distinct from both cases above: headers and part of the body already
    // reached the browser, so 502 is no longer available — the status line is
    // spent. A graceful FIN short of the declared Content-Length is the shape
    // that hangs: nothing errors, `upstreamRequest` never fires, and the
    // browser waits forever for bytes that are never coming.
    const upstream = net.createServer((socket) => {
      socket.on("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nContent-Type: text/plain\r\n\r\npartial",
        );
        setTimeout(() => socket.end(), 40);
      });
    });
    const upstreamPort = await new Promise<number>((resolve) =>
      upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as AddressInfo).port)),
    );
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    const local = await startLocalProxy({ registry: registryWith("host-a", upstreamPort) });

    const outcome = await new Promise<string>((resolve) => {
      const hung = setTimeout(() => resolve("hung"), 3_000);
      const request = http.request(
        { host: "127.0.0.1", port: local.port, path: "/env/host-a/api/stream" },
        (response) => {
          response.on("data", () => {});
          response.on("end", () => {
            clearTimeout(hung);
            // `complete` false means the browser KNOWS the body was truncated,
            // which is the honest outcome once the status line is spent.
            resolve(response.complete ? "ended-complete" : "ended-truncated");
          });
          response.on("error", () => {
            clearTimeout(hung);
            resolve("errored");
          });
        },
      );
      request.on("error", () => {
        clearTimeout(hung);
        resolve("errored");
      });
      request.end();
    });

    // Either honest ending is acceptable; hanging forever is not.
    expect(outcome, "the client must not wait forever for a truncated body").not.toBe("hung");
    expect(["ended-truncated", "errored"]).toContain(outcome);
  });

  it("releases the tunnel socket when the browser abandons a streaming response", async () => {
    // The leak is on a COMPLETED request: the browser sent a whole GET, so
    // `aborted` never fires, and only the response is still streaming. Nothing
    // then destroys the upstream request — the remote keeps producing into a
    // socket nobody reads. Repeat against a streaming endpoint and the tunnel
    // runs out of sockets.
    let liveUpstreamResponses = 0;
    const tickers: NodeJS.Timeout[] = [];
    const upstream = http.createServer((_request, response) => {
      liveUpstreamResponses += 1;
      response.writeHead(200, { "Content-Type": "text/plain" });
      const ticker = setInterval(() => {
        if (!response.writableEnded && !response.destroyed) response.write("tick\n");
      }, 25);
      tickers.push(ticker);
      response.on("close", () => {
        liveUpstreamResponses -= 1;
        clearInterval(ticker);
      });
    });
    const upstreamPort = await new Promise<number>((resolve) =>
      upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as AddressInfo).port)),
    );
    cleanups.push(async () => {
      for (const ticker of tickers) clearInterval(ticker);
      // `closeAllConnections` first: a LEAKED upstream socket keeps `close()`
      // waiting forever, which would surface as a 90s hook timeout instead of
      // as this test's own assertion. Teardown must not be what reports the bug.
      upstream.closeAllConnections?.();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });

    const local = await startLocalProxy({ registry: registryWith("host-a", upstreamPort) });

    // A raw socket so the request completes but the response is abandoned.
    const browser = net.connect({ host: "127.0.0.1", port: local.port });
    await new Promise<void>((resolve) => browser.on("connect", () => resolve()));
    browser.write("GET /env/host-a/api/stream HTTP/1.1\r\nHost: local\r\n\r\n");
    await delay(200);
    expect(liveUpstreamResponses, "the upstream should be streaming by now").toBe(1);

    browser.destroy();
    await delay(500);
    expect(
      liveUpstreamResponses,
      "the tunnel socket must be released when the browser goes away",
    ).toBe(0);
  });

  it("does not cut off a slow but healthy streaming response", async () => {
    // The bound is time-to-first-byte, not a cap on how long a response may
    // take. A remote turn that streams for minutes must not be severed.
    const remote = await startFakeRemote({
      onRequest: (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.write("first");
        setTimeout(() => response.end("-last"), 300);
      },
    });
    const local = await startLocalProxy({
      registry: registryWith("host-a", remote.port),
      upstreamTimeoutMs: 150,
    });
    const response = await fetchText(local.port, "/env/host-a/api/stream");
    expect(response.status).toBe(200);
    expect(response.body).toBe("first-last");
  });
});

describe("environment proxy — local authorization", () => {
  // Diverting to the proxy skips the Effect router, and with it the auth every
  // local route runs — while the proxy goes on to attach the environment's
  // provisioned credential. Without a gate here an unauthenticated local caller
  // is UPGRADED into a fully authenticated remote one.

  it("rejects an unauthenticated HTTP request before contacting any upstream", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({
      registry: registryWith("host-a", remote.port),
      authorize: denyAll,
    });
    const response = await fetchText(local.port, "/env/host-a/api/threads");
    expect(response.status).toBe(401);
    // Not one TCP connection, let alone a request: a denial must cost the
    // remote host nothing and must not confirm that the environment exists.
    expect(remote.connections()).toBe(0);
    expect(remote.seenTargets).toHaveLength(0);
  });

  it("rejects an unauthenticated WebSocket upgrade before contacting any upstream", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({
      registry: registryWith("host-a", remote.port),
      authorize: denyAll,
    });
    const client = openProxiedSocket(local.port, "/env/host-a/ws");
    await expect(waitForOpen(client)).rejects.toThrow();
    expect(remote.connections()).toBe(0);
    expect(remote.seenTargets).toHaveLength(0);
  });

  it("asks the authorizer for the request's own target and headers, on both paths", async () => {
    // The gate can only be policy-driven if it sees what the caller sent. A
    // wrapper that authorized some other request would pass every test above
    // and still be wrong.
    const seen: Array<{ url: string | undefined; kind: string; origin?: string }> = [];
    const remote = await startFakeRemote();
    const local = await startLocalProxy({
      registry: registryWith("host-a", remote.port),
      authorize: async ({ request, kind }) => {
        seen.push({
          url: request.url,
          kind,
          ...(request.headers.origin ? { origin: String(request.headers.origin) } : {}),
        });
        return { allowed: true };
      },
    });
    await fetchText(local.port, "/env/host-a/api/threads", { origin: "https://evil.example" });
    const client = openProxiedSocket(local.port, "/env/host-a/ws");
    await waitForOpen(client);

    expect(seen).toEqual([
      { url: "/env/host-a/api/threads", kind: "http", origin: "https://evil.example" },
      { url: "/env/host-a/ws", kind: "upgrade" },
    ]);
  });

  it("fails closed when the authorizer itself throws", async () => {
    // A session store that is down must deny, not pass. An authorizer that
    // rejects is an unanswered question, and the answer is never "yes".
    const remote = await startFakeRemote();
    const local = await startLocalProxy({
      registry: registryWith("host-a", remote.port),
      authorize: async () => {
        throw new Error("session store unavailable");
      },
    });
    const response = await fetchText(local.port, "/env/host-a/api/threads");
    expect(response.status).toBe(500);
    expect(remote.connections()).toBe(0);
  });

  it("never lets a denied request fall through to the LOCAL router either", async () => {
    // The other failure shape: refusing to proxy but then serving the path
    // locally, so `/env/<id>/...` returns the local SPA instead of a refusal.
    const remote = await startFakeRemote();
    const local = await startLocalProxy({
      registry: registryWith("host-a", remote.port),
      authorize: denyAll,
    });
    const response = await fetchText(local.port, "/env/host-a/api/threads");
    expect(response.status).toBe(401);
    expect(response.body).not.toContain("local-server");
    expect(local.localRequests).toHaveLength(0);
    // Nor did it quietly succeed against the remote, which is the shape the
    // status assertion alone would not distinguish from a local answer.
    expect(remote.seenTargets).toHaveLength(0);
  });

  it("still authorizes a target no environment is registered for", async () => {
    // Authorization runs BEFORE the registry lookup, so an unauthenticated
    // caller cannot use the 404-vs-401 difference to enumerate environment ids.
    const remote = await startFakeRemote();
    const local = await startLocalProxy({
      registry: registryWith("host-a", remote.port),
      authorize: denyAll,
    });
    const registered = await fetchText(local.port, "/env/host-a/api/threads");
    const unregistered = await fetchText(local.port, "/env/does-not-exist/api/threads");
    expect(unregistered.status).toBe(registered.status);
  });
});

describe("environment proxy — upgrade request serialization", () => {
  const upstream = {
    host: "127.0.0.1",
    port: 41_000,
    credential: "cred",
    environmentId: EnvironmentId.makeUnsafe("host-a"),
  };

  it("throws on CR, LF or NUL in a header value, a header name, or the target", () => {
    // The request is built by CONCATENATION, so these characters are not data —
    // they are structure. One \r\n in a value appends whatever follows as its
    // OWN header, including a second Authorization ahead of the proxy's real
    // one. Node's parser happens to reject these spellings first today, but
    // this function is exported and must hold on its own.
    for (const injection of ["\r\n", "\r", "\n", "\0"]) {
      expect(() =>
        serializeUpgradeRequest({
          method: "GET",
          target: "/ws",
          headers: { "x-thing": `value${injection}authorization: Bearer attacker` },
          upstream,
        }),
      ).toThrow(UpgradeRequestSerializationError);

      expect(() =>
        serializeUpgradeRequest({
          method: "GET",
          target: `/ws${injection}authorization: Bearer attacker`,
          headers: {},
          upstream,
        }),
      ).toThrow(UpgradeRequestSerializationError);

      expect(() =>
        serializeUpgradeRequest({
          method: `GET${injection}`,
          target: "/ws",
          headers: {},
          upstream,
        }),
      ).toThrow(UpgradeRequestSerializationError);

      expect(() =>
        serializeUpgradeRequest({
          method: "GET",
          target: "/ws",
          headers: { [`x-name${injection}injected`]: "v" },
          upstream,
        }),
      ).toThrow(UpgradeRequestSerializationError);

      // Array-valued headers take a different code path to the wire.
      expect(() =>
        serializeUpgradeRequest({
          method: "GET",
          target: "/ws",
          headers: { "x-multi": ["ok", `bad${injection}authorization: Bearer attacker`] },
          upstream,
        }),
      ).toThrow(UpgradeRequestSerializationError);
    }
  });

  it("still serializes an ordinary upgrade unchanged", () => {
    // The guard must reject injection, not legitimate traffic.
    const serialized = serializeUpgradeRequest({
      method: "GET",
      target: "/ws?token=abc",
      headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
      upstream,
    });
    expect(serialized.startsWith("GET /ws?token=abc HTTP/1.1\r\n")).toBe(true);
    expect(serialized).toContain("sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==");
    expect(serialized).toContain("authorization: Bearer cred");
    expect(serialized.endsWith("\r\n\r\n")).toBe(true);
  });
});

describe("environment proxy — WebSocket transparency", () => {
  it("carries a full request/response exchange through to the remote server", async () => {
    const remote = await startFakeRemote({
      onConnection: (socket) => {
        socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
      },
    });
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/env/host-a/ws?token=x");
    await waitForOpen(client);

    const received = new Promise<string>((resolve) =>
      client.once("message", (data) => resolve(data.toString())),
    );
    client.send("hello remote");
    expect(await received).toBe("echo:hello remote");
    // The upstream saw the target with the prefix stripped and the query intact.
    expect(remote.seenTargets).toContain("/ws?token=x");
  });

  it("negotiates permessage-deflate END TO END through the proxy", async () => {
    // A byte-for-byte proxy gets this for free because the extension handshake
    // passes through untouched — but "for free" is exactly the kind of claim
    // that silently stops being true, so it is pinned here.
    const remote = await startFakeRemote({
      perMessageDeflate: true,
      onConnection: (socket) => {
        socket.on("message", (data) => socket.send(data.toString().toUpperCase()));
      },
    });
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/env/host-a/ws", {
      perMessageDeflate: true,
    });
    await waitForOpen(client);

    // The extension is active on the CLIENT's socket, meaning the browser and
    // the remote server negotiated it with each other across the proxy.
    expect(client.extensions).toContain("permessage-deflate");

    // And a compressed round trip actually works: RSV1-flagged payloads crossed
    // the proxy as opaque bytes and only the endpoints inflated them.
    const highlyCompressible = "synara".repeat(20_000);
    const echoed = new Promise<string>((resolve) =>
      client.once("message", (data) => resolve(data.toString())),
    );
    client.send(highlyCompressible);
    expect(await echoed).toBe(highlyCompressible.toUpperCase());
  });

  it("does not fabricate compression when the client did not offer it", async () => {
    // The proxy has no opinion about the extension. If it did, it could enable
    // compression a client cannot decode.
    const remote = await startFakeRemote({ perMessageDeflate: true });
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/env/host-a/ws", {
      perMessageDeflate: false,
    });
    await waitForOpen(client);
    expect(client.extensions).toBe("");
  });

  it("closes with 404 for an unregistered environment instead of upgrading", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/env/nope/ws");
    await expect(waitForOpen(client)).rejects.toThrow();
    expect(remote.seenTargets).toHaveLength(0);
  });

  it("leaves a non-proxied upgrade to the local handler", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/ws");
    await expect(waitForOpen(client)).rejects.toThrow();
    expect(local.localUpgrades).toContain("/ws");
  });
});

describe("environment proxy — flow control and head-of-line blocking", () => {
  // Flow control cannot be exercised through a loopback TCP pair: the kernel
  // socket buffers absorb megabytes, so `write()` never returns false and the
  // proxy's queue never fills. These tests therefore drive the relay through
  // its `connect` seam with a duplex whose writable side we control exactly —
  // the SAME production code path, with the one variable that matters (when the
  // consumer accepts bytes) made deterministic instead of left to the kernel.

  /**
   * A socket stand-in that records every byte written to it and can be told to
   * report backpressure — `write()` returning false — the way a saturated
   * kernel socket buffer does.
   *
   * Recording is unconditional so the test can see what the proxy TRIED to
   * send, including the Close frame it writes while tearing down. Backpressure
   * is modelled by the return value alone, which is exactly the signal the
   * relay's flow control keys on.
   */
  function makeControllableUpstream() {
    const written: Buffer[] = [];
    let stalled = false;
    const socket = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        written.push(Buffer.from(chunk));
        callback();
      },
    });
    const realWrite = socket.write.bind(socket);
    (socket as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      realWrite(chunk as Buffer);
      // A stalled consumer accepts the byte into its buffer but tells the
      // writer to stop — precisely what a full socket does.
      return !stalled;
    };
    return {
      socket,
      written,
      /** Stop accepting writes: the consumer has stalled. */
      stall() {
        stalled = true;
      },
      release() {
        stalled = false;
        socket.emit("drain");
      },
      /** Feed bytes as if they arrived from the far end. */
      deliver(bytes: Buffer) {
        socket.push(bytes);
      },
      writtenBytes() {
        return written.reduce((total, chunk) => total + chunk.byteLength, 0);
      },
    };
  }

  /**
   * Frames the way a server sends them: unmasked, FIN set unless told otherwise.
   *
   * `fin: false` builds a fragment of a multi-frame MESSAGE, which is a
   * different code path from a frame split across TCP chunks.
   */
  function serverFrame(opcode: number, payload: Buffer, options: { fin?: boolean } = {}): Buffer {
    const first = (options.fin === false ? 0x00 : 0x80) | opcode;
    if (payload.byteLength < 126) {
      return Buffer.concat([Buffer.from([first, payload.byteLength]), payload]);
    }
    if (payload.byteLength <= 0xffff) {
      const header = Buffer.alloc(4);
      header[0] = first;
      header[1] = 126;
      header.writeUInt16BE(payload.byteLength, 2);
      return Buffer.concat([header, payload]);
    }
    const header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
    return Buffer.concat([header, payload]);
  }

  /**
   * Every Close code written to a socket, in order.
   *
   * Walks the frame headers rather than scanning for a byte whose low nibble is
   * 8 — the handshake's leading `H` is 0x48, which a naive scan reports as a
   * Close frame. Skipping the HTTP head and then honouring each frame's length
   * is what makes "exactly one terminal frame" a trustworthy assertion.
   */
  function closeCodesWritten(written: readonly Buffer[]): number[] {
    const all = Buffer.concat([...written]);
    const headEnd = all.indexOf(HEADER_TERMINATOR_BYTES);
    const body = headEnd === -1 ? all : all.subarray(headEnd + HEADER_TERMINATOR_BYTES.byteLength);
    const codes: number[] = [];
    let offset = 0;
    while (offset + 2 <= body.byteLength) {
      const opcode = body[offset]! & 0x0f;
      const marker = body[offset + 1]! & 0x7f;
      let headerLength = 2;
      let payloadLength = marker;
      if (marker === 126) {
        payloadLength = body.readUInt16BE(offset + 2);
        headerLength = 4;
      } else if (marker === 127) {
        payloadLength = Number(body.readBigUInt64BE(offset + 2));
        headerLength = 10;
      }
      if (opcode === 0x8) {
        codes.push(payloadLength >= 2 ? body.readUInt16BE(offset + headerLength) : -1);
      }
      offset += headerLength + payloadLength;
    }
    return codes;
  }

  const HEADER_TERMINATOR_BYTES = Buffer.from("\r\n\r\n");

  const HANDSHAKE_101 = Buffer.from(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n",
  );

  /**
   * Drives `proxyEnvironmentWebSocket` directly with two controllable duplexes,
   * standing in for the browser socket and the tunnel socket.
   */
  function makeControlledProxy(
    queueOptions?: { maxBytes?: number; maxFrames?: number },
    /**
     * Node's upgrade `head`: bytes it already read past the request headers.
     * Defaults to empty, which is the common case — pass a value to exercise
     * the replay path a fast client's first frames actually take.
     */
    head: Buffer = Buffer.alloc(0),
  ) {
    const registry = makeEnvironmentProxyRegistry();
    registry.register({
      environmentId: EnvironmentId.makeUnsafe("host-a"),
      host: "127.0.0.1",
      port: 41_000,
      credential: "cred",
    });
    const upstream = makeControllableUpstream();
    const client = makeControllableUpstream();
    const proxyErrors: string[] = [];
    const request = { url: "/env/host-a/ws", method: "GET", headers: {} } as IncomingMessage;
    proxyEnvironmentWebSocket(
      {
        registry,
        authorize: allowAll,
        connect: () => upstream.socket,
        ...(queueOptions ? { queueOptions } : {}),
        onError: (message) => proxyErrors.push(message),
      },
      request,
      client.socket,
      head,
    );
    // Complete the handshake so the upstream direction starts framing.
    upstream.deliver(HANDSHAKE_101);
    return { upstream, client, proxyErrors };
  }

  it("replays the bytes Node already read past the upgrade headers", async () => {
    // Node hands the upgrade handler a `head` containing whatever it read past
    // the request headers. A fast client's FIRST frames live there — it can
    // send them in the same TCP segment as the handshake — so discarding it
    // silently loses the opening of the session, which then looks like a
    // client bug. Every other test here passes an empty head, so this replay
    // path was previously never exercised at all.
    const first = clientFrame(0x1, Buffer.from("from-the-head"));
    const { upstream, client } = makeControlledProxy(undefined, first);
    await delay(5);

    // The upgrade request itself goes first, then the replayed head bytes.
    const afterHandshake = Buffer.concat(upstream.written).subarray(
      Buffer.concat(upstream.written).indexOf("\r\n\r\n") + 4,
    );
    expect(afterHandshake.byteLength, "the head bytes must reach the upstream").toBe(
      first.byteLength,
    );
    // Byte for byte, mask included: the proxy must not unmask or re-frame them.
    expect(afterHandshake).toEqual(first);

    // ...and the socket is still live afterwards, so replaying the head did not
    // desynchronise the splitter for what follows.
    const second = clientFrame(0x1, Buffer.from("live"));
    client.deliver(second);
    await delay(5);
    const all = Buffer.concat(upstream.written);
    expect(all.subarray(all.indexOf("\r\n\r\n") + 4)).toEqual(Buffer.concat([first, second]));
  });

  it("does NOT let a Close frame overtake queued data", async () => {
    // Close is terminal: once the browser sees it, it completes the closing
    // handshake and stops processing. A Close that jumps ahead of queued data
    // therefore DISCARDS that data silently — on every slow-client disconnect,
    // which is exactly when a stall made the queue deep in the first place.
    //
    // Ping/Pong may reorder (a heartbeat is idempotent and time-critical).
    // A terminal frame may not. That is the distinction under test.
    const { upstream, client } = makeControlledProxy({ maxBytes: 32 * 1024 * 1024 });
    await delay(5);
    client.written.length = 0;
    client.stall();

    upstream.deliver(serverFrame(0x2, Buffer.alloc(500_000, 1)));
    upstream.deliver(serverFrame(0x2, Buffer.alloc(500_000, 2)));
    upstream.deliver(serverFrame(0x8, Buffer.from([0x03, 0xe8]))); // Close, 1000
    await delay(5);
    client.release();
    await delay(20);

    const opcodes = client.written.map((chunk) => chunk[0]! & 0x0f);
    const closeIndex = opcodes.indexOf(0x8);
    const dataIndexes = opcodes.flatMap((opcode, index) => (opcode === 0x2 ? [index] : []));
    expect(closeIndex, "the Close must be delivered").toBeGreaterThanOrEqual(0);
    expect(dataIndexes, "both data frames must be delivered").toHaveLength(2);
    // Every data frame that arrived BEFORE the Close must be written before it.
    for (const dataIndex of dataIndexes) {
      expect(dataIndex, "data queued before a Close must not be dropped behind it").toBeLessThan(
        closeIndex,
      );
    }
  });

  it("still lets a Ping and a Pong overtake queued data", async () => {
    // The other half of the same rule. Narrowing the priority to exclude Close
    // must not accidentally demote the heartbeat frames the optimisation exists
    // for — that would reintroduce the reconnect churn.
    for (const controlOpcode of [0x9, 0xa]) {
      const { upstream, client } = makeControlledProxy({ maxBytes: 32 * 1024 * 1024 });
      await delay(5);
      client.written.length = 0;
      client.stall();

      upstream.deliver(serverFrame(0x2, Buffer.alloc(500_000, 1)));
      upstream.deliver(serverFrame(0x2, Buffer.alloc(500_000, 2)));
      upstream.deliver(serverFrame(controlOpcode, Buffer.from("beat")));
      await delay(5);
      client.release();
      await delay(20);

      const opcodes = client.written.map((chunk) => chunk[0]! & 0x0f);
      const controlIndex = opcodes.indexOf(controlOpcode);
      const dataIndexes = opcodes.flatMap((opcode, index) => (opcode === 0x2 ? [index] : []));
      expect(controlIndex, `opcode ${controlOpcode} must be delivered`).toBeGreaterThanOrEqual(0);
      expect(dataIndexes, `opcode ${controlOpcode}`).toHaveLength(2);
      // The first write always escapes before backpressure is observable, so
      // the property is that it overtakes what is still QUEUED.
      expect(controlIndex, `opcode ${controlOpcode} must overtake queued data`).toBeLessThan(
        dataIndexes[1]!,
      );
    }
  });

  it("does not let a Close jump ahead of the fragments of a message already queued", async () => {
    // The worst shape of finding A: a fragmented message is split across
    // frames, so a Close that overtakes them delivers a message the browser can
    // never reassemble — it sees a start with no end and then a terminal frame.
    const { upstream, client } = makeControlledProxy({ maxBytes: 32 * 1024 * 1024 });
    await delay(5);
    client.written.length = 0;
    client.stall();

    // FIN=0 text, FIN=0 continuation, FIN=1 continuation: one logical message.
    upstream.deliver(serverFrame(0x1, Buffer.alloc(400_000, 1), { fin: false }));
    upstream.deliver(serverFrame(0x0, Buffer.alloc(400_000, 2), { fin: false }));
    upstream.deliver(serverFrame(0x0, Buffer.alloc(400_000, 3)));
    upstream.deliver(serverFrame(0x8, Buffer.from([0x03, 0xe8])));
    await delay(5);
    client.release();
    await delay(20);

    const opcodes = client.written.map((chunk) => chunk[0]! & 0x0f);
    const closeIndex = opcodes.indexOf(0x8);
    const fragmentIndexes = opcodes.flatMap((opcode, index) =>
      opcode === 0x1 || opcode === 0x0 ? [index] : [],
    );
    expect(fragmentIndexes, "all three fragments must be delivered").toHaveLength(3);
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(Math.max(...fragmentIndexes), "the whole message must precede the Close").toBeLessThan(
      closeIndex,
    );
    // ...and in order: a reassembler cannot recover from reordered fragments.
    expect(fragmentIndexes).toEqual(fragmentIndexes.toSorted((a, b) => a - b));
  });

  it("delivers a Pong ahead of a queued multi-megabyte snapshot", async () => {
    // The symptom this prevents: a 15-byte Pong queued behind a multi-MB
    // snapshot arrives after the peer's heartbeat deadline, and a healthy
    // connection churns through a reconnect.
    const { upstream, client } = makeControlledProxy({ maxBytes: 32 * 1024 * 1024 });
    await delay(5);
    client.written.length = 0;

    // The browser stops accepting writes, so everything the remote sends queues
    // inside the proxy — the exact condition where ordering decides the outcome.
    client.stall();
    // Just under the per-frame ceiling, so this is queueing pressure rather
    // than an oversized-frame rejection.
    upstream.deliver(serverFrame(0x2, Buffer.alloc(1_500_000, 1)));
    upstream.deliver(serverFrame(0x2, Buffer.alloc(1_500_000, 2)));
    upstream.deliver(serverFrame(0xa, Buffer.from("pong-payload"))); // Pong
    await delay(5);

    client.release();
    await delay(20);

    const opcodes = client.written.map((chunk) => chunk[0]! & 0x0f);
    const pongIndex = opcodes.indexOf(0xa);
    const dataIndexes = opcodes.flatMap((opcode, index) => (opcode === 0x2 ? [index] : []));
    expect(pongIndex, "the Pong must be delivered").toBeGreaterThanOrEqual(0);
    // The first write always goes out before backpressure can be observed, so
    // the property under test is that the Pong overtakes everything still
    // QUEUED — here, the second 1.5 MB snapshot that arrived before it.
    expect(dataIndexes).toHaveLength(2);
    expect(pongIndex).toBeLessThan(dataIndexes[1]!);
    expect(client.written[pongIndex]!.subarray(2).toString()).toBe("pong-payload");
    // ...and the snapshots still arrive, in their original order: a proxy that
    // reordered data would corrupt every ordered stream on the socket.
    expect(client.written[dataIndexes[0]!]!.at(-1)).toBe(1);
    expect(client.written[dataIndexes[1]!]!.at(-1)).toBe(2);
  });

  it("signals an explicit resync when a slow consumer overflows the bound", async () => {
    // The requirement, stated exactly: never silent drops, never unbounded
    // queueing. A client that stops reading must be told its stream is no
    // longer complete, with a code it can act on.
    const { upstream, client, proxyErrors } = makeControlledProxy({ maxBytes: 256 * 1024 });
    await delay(5);
    client.written.length = 0;
    client.stall();

    // A slow cellular consumer: the producer keeps streaming while nothing is
    // read.
    for (let index = 0; index < 40; index += 1) {
      upstream.deliver(serverFrame(0x2, Buffer.alloc(64_000, index)));
      await delay(1);
    }
    await delay(20);

    expect(
      proxyErrors.some((message) => message.includes("queue overflow")),
      "the bounded queue must overflow rather than grow without limit",
    ).toBe(true);

    // The last thing written to the browser is a Close frame carrying the
    // resync code — not a bare disconnect the client would retry as if nothing
    // were wrong.
    // Release the stalled writes so Node flushes everything queued behind them,
    // including the Close frame the proxy wrote during teardown.
    client.release();
    await delay(50);
    const closeFrame = client.written.find((chunk) => (chunk[0]! & 0x0f) === 0x8);
    expect(
      closeFrame,
      `a Close frame must be sent; saw opcodes ${client.written.map((c) => c[0]! & 0x0f).join(",")}`,
    ).toBeDefined();
    // The NUMERIC LITERAL, deliberately — do NOT "helpfully" refactor this back
    // to WS_CLOSE_PROXY_RESYNC_REQUIRED. Production computes the wire value
    // from that same constant, so importing it here makes the assertion
    // vacuous: changing 4002 to any other private-range value would leave this
    // test green while every deployed client stopped recognising the signal.
    // The literal is the contract; a deliberate change must update both.
    expect(closeFrame!.readUInt16BE(2)).toBe(4002);
    expect(WS_CLOSE_PROXY_RESYNC_REQUIRED, "the constant must still be the wire value").toBe(4002);
    // EXACTLY ONE terminal frame, not "a 4002 appears somewhere". Destroying the
    // upstream during teardown fires its own `close` listener, and without a
    // one-shot guard that emits a SECOND Close — so the client is told to
    // resync and then told the tunnel was lost, and acts on whichever it reads
    // last. "Find a 4002" passes happily while that happens.
    expect(closeCodesWritten(client.written), "one terminal frame, and only one").toEqual([4002]);
  });

  it("still signals tunnel loss after the upstream has sent a Ping", async () => {
    // The re-conflation hazard in the fix for the previous test: "the upstream
    // already closed" must be set by a CLOSE, never by any control frame. If a
    // Ping set it, a heartbeat followed by a dead tunnel would produce NO
    // terminal frame at all — the client would sit on a socket that is never
    // coming back, which is worse than the double-close this guard replaced.
    const { upstream, client } = makeControlledProxy();
    await delay(5);
    client.written.length = 0;

    upstream.deliver(serverFrame(0x9, Buffer.from("heartbeat")));
    await delay(10);
    upstream.socket.destroy();
    await delay(60);

    expect(
      closeCodesWritten(client.written),
      "a Ping must not suppress the tunnel-lost signal",
    ).toEqual([4003]);
  });

  it("emits exactly one terminal frame, and preserves the upstream's own close code", async () => {
    // A graceful close carries information: 1000 means the remote finished
    // deliberately. Overwriting it with the proxy's synthetic 4003 tells the
    // client the TUNNEL failed, so it reattaches to a session that ended
    // normally. The upstream's code must survive, and nothing may follow it.
    const { upstream, client } = makeControlledProxy();
    await delay(5);
    client.written.length = 0;

    // The remote closes normally: its own Close frame, then the socket.
    upstream.deliver(serverFrame(0x8, Buffer.from([0x03, 0xe8]))); // 1000
    await delay(10);
    upstream.socket.destroy();
    await delay(60);

    expect(
      closeCodesWritten(client.written),
      "the upstream's 1000 must reach the client, with no synthetic code after it",
    ).toEqual([1000]);
  });

  it("stops retaining bytes once it overflows, rather than growing without limit", async () => {
    // The failure being prevented is a memory leak, so the retained-byte count
    // is asserted directly: after overflow the proxy holds nothing, no matter
    // how much more the producer sends.
    const MAX_QUEUE_BYTES = 256 * 1024;
    const { upstream, client, proxyErrors } = makeControlledProxy({
      maxBytes: MAX_QUEUE_BYTES,
    });
    await delay(5);
    client.stall();
    const writtenBeforeFlood = client.writtenBytes();

    for (let index = 0; index < 200; index += 1) {
      upstream.deliver(serverFrame(0x2, Buffer.alloc(64_000, 7)));
    }
    await delay(20);

    expect(proxyErrors.some((message) => message.includes("queue overflow"))).toBe(true);
    // 200 * 64 KB = ~12.8 MB offered. What actually reached the browser socket
    // is bounded by the ceiling plus the Close frame — nothing near the volume
    // offered, and nothing still queued.
    const forwarded = client.writtenBytes() - writtenBeforeFlood;
    expect(forwarded).toBeLessThan(MAX_QUEUE_BYTES * 4);
  });

  it("does not leak the backlog into the destination's own unbounded buffer", async () => {
    // Regression guard. Without latching the saturated state, each incoming
    // chunk called drain() again and pushed exactly one more frame past a
    // `write()` that had already returned false. The backlog then migrated
    // frame by frame out of the BOUNDED queue and into Node's writable buffer,
    // which has no ceiling: the queue never overflowed, no resync was ever
    // signalled, and the memory leak was back with the guard still in place.
    const { upstream, client, proxyErrors } = makeControlledProxy({ maxBytes: 256 * 1024 });
    await delay(5);
    const beforeStall = client.writtenBytes();
    client.stall();

    // Deliver in separate chunks, which is what re-triggered the leak: one
    // `data` event per frame.
    for (let index = 0; index < 60; index += 1) {
      upstream.deliver(serverFrame(0x2, Buffer.alloc(64_000, index & 0xff)));
      await delay(0);
    }
    await delay(20);

    // ~3.8 MB offered to a stalled consumer with a 256 KB ceiling. Only the one
    // write that discovered the backpressure may have gone through; everything
    // after it must have been refused, not handed to Node to buffer.
    const forwardedWhileStalled = client.writtenBytes() - beforeStall;
    expect(forwardedWhileStalled).toBeLessThan(512 * 1024);
    expect(proxyErrors.some((message) => message.includes("queue overflow"))).toBe(true);
  });

  it("does not overflow on a healthy connection that keeps draining", async () => {
    // The guard must be a real ceiling, not a hair trigger: a consumer that
    // reads normally can carry far more than the ceiling over its lifetime.
    const { upstream, client, proxyErrors } = makeControlledProxy({ maxBytes: 256 * 1024 });
    await delay(5);
    for (let index = 0; index < 200; index += 1) {
      upstream.deliver(serverFrame(0x2, Buffer.alloc(64_000, 3)));
      await delay(0);
    }
    await delay(20);
    expect(proxyErrors).toEqual([]);
    expect(client.writtenBytes()).toBeGreaterThan(200 * 64_000);
  });

  it("uses a code in the application-private range so no intermediary reinterprets it", () => {
    // 4000-4999 is reserved for the application (RFC 6455 §7.4.2). A code
    // outside it could be assigned meaning by a library or a proxy in between.
    for (const code of [WS_CLOSE_PROXY_RESYNC_REQUIRED, WS_CLOSE_PROXY_TUNNEL_LOST]) {
      expect(code).toBeGreaterThanOrEqual(4_000);
      expect(code).toBeLessThanOrEqual(4_999);
    }
    expect(WS_CLOSE_PROXY_RESYNC_REQUIRED).not.toBe(WS_CLOSE_PROXY_TUNNEL_LOST);
  });

  it("pins the proxy frame ceiling to the WS server's own message bound", () => {
    // If the proxy's ceiling drifted above the server's `maxPayload`, it would
    // buffer frames the server will refuse anyway; below it, it would sever
    // connections carrying legitimate messages.
    expect(MAX_WEBSOCKET_MESSAGE_BYTES_FOR_PROXY).toBe(MAX_WEBSOCKET_MESSAGE_BYTES);
  });
});
describe("environment proxy — tunnel teardown and reattach", () => {
  it("tells the client the tunnel was lost, distinguishably from a resync", async () => {
    // A resync means "you are missing frames". A tunnel loss means "nothing was
    // dropped, the remote session is intact, reattach and resume". Conflating
    // them makes a client either re-snapshot needlessly or skip a resync it
    // needed.
    const sockets: WebSocket[] = [];
    const remote = await startFakeRemote({
      onConnection: (socket) => sockets.push(socket),
    });
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/env/host-a/ws");
    await waitForOpen(client);

    const closed = waitForClose(client);
    // The tunnel dies, not the remote server.
    sockets[0]?.terminate();
    const { code } = await closed;
    // Numeric literal on purpose — see the note on the 4002 assertion above.
    // Asserting against the imported constant would pass for ANY value, and
    // this code is a wire contract with already-deployed clients.
    expect(code).toBe(4003);
    expect(WS_CLOSE_PROXY_TUNNEL_LOST, "the constant must still be the wire value").toBe(4003);
  });

  it("leaves the remote session untouched and allows a clean reattach", async () => {
    // The durability that is the entire reason for this architecture: the turn
    // runs on the remote server, so tearing the proxy connection down and
    // reattaching must not disturb it.
    let counter = 0;
    const liveSockets: WebSocket[] = [];
    const remote = await startFakeRemote({
      onConnection: (socket) => {
        liveSockets.push(socket);
        socket.on("message", (data) => {
          if (data.toString() === "advance") counter += 1;
          if (data.toString() === "read") socket.send(String(counter));
        });
      },
    });
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });

    const first = openProxiedSocket(local.port, "/env/host-a/ws");
    await waitForOpen(first);
    first.send("advance");
    first.send("advance");
    // Read back through the same socket rather than sleeping: this only
    // resolves once the remote has processed both preceding messages, so the
    // teardown below cannot race ahead of them under CI contention.
    const advanced = new Promise<string>((resolve) =>
      first.once("message", (data) => resolve(data.toString())),
    );
    first.send("read");
    expect(await advanced).toBe("2");

    const firstClosed = waitForClose(first);
    first.terminate();
    await firstClosed;

    // Reattach on a brand-new proxy connection.
    const second = openProxiedSocket(local.port, "/env/host-a/ws");
    await waitForOpen(second);
    const value = new Promise<string>((resolve) =>
      second.once("message", (data) => resolve(data.toString())),
    );
    second.send("read");
    // State advanced before the teardown is still there: the proxy never
    // touched the remote session.
    expect(await value).toBe("2");
    expect(liveSockets).toHaveLength(2);
  });

  it("does not disturb a second environment when one tunnel dies", async () => {
    const remoteA = await startFakeRemote();
    const remoteB = await startFakeRemote({
      onConnection: (socket) => socket.send("b-alive"),
    });
    const registry = registryWith("a", remoteA.port);
    registry.register({
      environmentId: EnvironmentId.makeUnsafe("b"),
      host: "127.0.0.1",
      port: remoteB.port,
      credential: "provisioned-b",
    });
    const local = await startLocalProxy({ registry });

    const clientB = openProxiedSocket(local.port, "/env/b/ws");
    await waitForOpen(clientB);
    const heard = new Promise<string>((resolve) =>
      clientB.once("message", (data) => resolve(data.toString())),
    );
    expect(await heard).toBe("b-alive");

    await new Promise<void>((resolve) => remoteA.server.close(() => resolve()));
    // B is still serving after A's tunnel is gone.
    const stillWorks = await fetchText(local.port, "/env/b/health");
    expect(stillWorks.status).toBe(200);
  });
});

describe("environment proxy — WAN-like latency", () => {
  it("completes a full session lifecycle over a delay-injecting tunnel", async () => {
    // No tc/netem in this environment, so latency is injected by a TCP relay
    // that holds every chunk for a fixed delay in BOTH directions. That is the
    // property that matters: a round trip costs 2x the delay, so anything with
    // a hidden per-message round trip shows up as a timeout rather than as
    // "slightly slower".
    const ONE_WAY_DELAY_MS = 40;
    const remote = await startFakeRemote({
      onConnection: (socket) => {
        socket.on("message", (data) => socket.send(`ack:${data.toString()}`));
      },
    });

    const net = await import("node:net");
    const relay = net.createServer((clientSide) => {
      const upstreamSide = net.connect({ host: "127.0.0.1", port: remote.port });
      const forward = (from: NodeJS.ReadableStream, to: NodeJS.WritableStream) =>
        from.on("data", (chunk: Buffer) => {
          setTimeout(() => to.write(chunk), ONE_WAY_DELAY_MS);
        });
      forward(clientSide, upstreamSide);
      forward(upstreamSide, clientSide);
      clientSide.on("error", () => upstreamSide.destroy());
      upstreamSide.on("error", () => clientSide.destroy());
      clientSide.on("close", () => upstreamSide.destroy());
    });
    const relayPort = await new Promise<number>((resolve) =>
      relay.listen(0, "127.0.0.1", () => resolve((relay.address() as AddressInfo).port)),
    );
    cleanups.push(() => new Promise<void>((resolve) => relay.close(() => resolve())));

    const local = await startLocalProxy({ registry: registryWith("wan", relayPort) });

    const started = Date.now();
    const client = openProxiedSocket(local.port, "/env/wan/ws");
    await waitForOpen(client);

    const replies: string[] = [];
    client.on("message", (data) => replies.push(data.toString()));
    for (let index = 0; index < 5; index += 1) client.send(`turn-${index}`);
    // 5 messages pipelined: with a working proxy this costs ~1 round trip, not 5.
    await delay(ONE_WAY_DELAY_MS * 6);
    expect(replies).toEqual(["ack:turn-0", "ack:turn-1", "ack:turn-2", "ack:turn-3", "ack:turn-4"]);
    // A per-message round trip would cost at least 5 * 2 * 40ms = 400ms; the
    // pipelined path is comfortably under that.
    expect(Date.now() - started).toBeLessThan(ONE_WAY_DELAY_MS * 10);

    const httpAtLatency = await fetchText(local.port, "/env/wan/api/threads");
    expect(httpAtLatency.status).toBe(200);
    expect(JSON.parse(httpAtLatency.body).target).toBe("/api/threads");
  });
});
