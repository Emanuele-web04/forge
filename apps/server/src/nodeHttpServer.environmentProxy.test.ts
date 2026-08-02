// The proxy is only real if the SERVER CONSTRUCTION path installs it. These
// tests drive `makeBoundedNodeHttpServer` — the function `createEffectServer`
// calls — rather than the dispatch in isolation, so a proxy that is fully
// implemented and fully tested but never wired in still fails here.

import http from "node:http";
import type { AddressInfo } from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@synara/contracts";
import { Effect, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { makeEnvironmentProxyDispatch } from "./environmentProxy";
import type { EnvironmentProxyAuthorizer } from "./environmentProxyAuthorization";
import { makeEnvironmentProxyRegistry } from "./environmentProxyTargets";
import { makeBoundedNodeHttpServer } from "./nodeHttpServer";

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of teardown.splice(0).reverse()) await close();
});

/**
 * Boots the real bounded server with a proxy dispatch attached, exactly the way
 * `createEffectServer` does, and returns its port.
 */
async function startServerWithProxy(input: {
  readonly upstreamPort: number;
  readonly environmentId: string;
  readonly authorize?: EnvironmentProxyAuthorizer;
}) {
  const registry = makeEnvironmentProxyRegistry();
  registry.register({
    environmentId: EnvironmentId.makeUnsafe(input.environmentId),
    host: "127.0.0.1",
    port: input.upstreamPort,
    credential: "provisioned",
  });
  const environmentProxy = makeEnvironmentProxyDispatch({
    registry,
    ...(input.authorize ? { authorize: input.authorize } : {}),
  });
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  const localTargets: string[] = [];
  const port = await Effect.runPromise(
    Scope.provide(
      Effect.gen(function* () {
        const httpServer = yield* makeBoundedNodeHttpServer(
          () => {
            nodeServer = http.createServer();
            return nodeServer;
          },
          { host: "127.0.0.1", port: 0 },
          environmentProxy,
        );
        yield* httpServer.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            localTargets.push(request.url);
            return HttpServerResponse.text("local-router");
          }),
        );
        const address = nodeServer?.address();
        if (!address || typeof address === "string") {
          return yield* Effect.die(new Error("expected a TCP address"));
        }
        return address.port;
      }).pipe(Effect.provide(NodeServices.layer)),
      scope,
    ),
  );
  teardown.push(async () => {
    nodeServer?.closeAllConnections?.();
    await Effect.runPromise(Scope.close(scope, undefined as never)).catch(() => undefined);
  });
  return { port, localTargets };
}

function get(port: number, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("makeBoundedNodeHttpServer installs the environment proxy", () => {
  it("diverts /env/:envId/* to the upstream and leaves other paths to the local router", async () => {
    const upstreamTargets: string[] = [];
    const upstream = http.createServer((request, response) => {
      upstreamTargets.push(request.url ?? "");
      response.writeHead(200);
      response.end("from-remote");
    });
    const upstreamPort = await new Promise<number>((resolve) =>
      upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as AddressInfo).port)),
    );
    teardown.push(
      () =>
        new Promise<void>((resolve) => {
          upstream.closeAllConnections?.();
          upstream.close(() => resolve());
        }),
    );

    const server = await startServerWithProxy({ upstreamPort, environmentId: "remote-1" });

    // The proxied path reached the REMOTE server, through the same construction
    // path production uses.
    const proxied = await get(server.port, "/env/remote-1/api/threads");
    expect(proxied.body).toBe("from-remote");
    expect(upstreamTargets).toEqual(["/api/threads"]);
    // ...and the local router never saw it. If it had, its SPA fallback would
    // also answer the deep link and two responses would race one socket.
    expect(server.localTargets).not.toContain("/env/remote-1/api/threads");

    // A local path still reaches the local router, which the proxy must not
    // have replaced.
    const local = await get(server.port, "/local/settings");
    expect(local.body).toBe("local-router");
    expect(server.localTargets).toContain("/local/settings");
    expect(upstreamTargets).toEqual(["/api/threads"]);
  });

  it("runs the authorization gate through the real server construction path", async () => {
    // The gate is only real if the SERVER installs it. A proxy that authorizes
    // correctly in isolation but is wired up without an authorizer is the exact
    // bug this whole file exists to catch, one layer up.
    let upstreamConnections = 0;
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end("from-remote");
    });
    upstream.on("connection", () => {
      upstreamConnections += 1;
    });
    const upstreamPort = await new Promise<number>((resolve) =>
      upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as AddressInfo).port)),
    );
    teardown.push(
      () =>
        new Promise<void>((resolve) => {
          upstream.closeAllConnections?.();
          upstream.close(() => resolve());
        }),
    );

    const server = await startServerWithProxy({
      upstreamPort,
      environmentId: "remote-1",
      authorize: async () => ({ allowed: false, status: 401, message: "Unauthorized" }),
    });

    const denied = await get(server.port, "/env/remote-1/api/threads");
    expect(denied.status).toBe(401);
    // No upstream contact, and no fallthrough to the local router either.
    expect(upstreamConnections).toBe(0);
    expect(server.localTargets).toHaveLength(0);
  });

  it("serves every path locally when no proxy is installed", async () => {
    // The proxy is additive: a deployment that never registers an environment
    // must behave exactly as it did before this feature existed.
    const scope = await Effect.runPromise(Scope.make("sequential"));
    let nodeServer: http.Server | null = null;
    const port = await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* makeBoundedNodeHttpServer(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { host: "127.0.0.1", port: 0 },
          );
          yield* httpServer.serve(Effect.succeed(HttpServerResponse.text("local-router")));
          const address = nodeServer?.address();
          if (!address || typeof address === "string") {
            return yield* Effect.die(new Error("expected a TCP address"));
          }
          return address.port;
        }).pipe(Effect.provide(NodeServices.layer)),
        scope,
      ),
    );
    teardown.push(async () => {
      nodeServer?.closeAllConnections?.();
      await Effect.runPromise(Scope.close(scope, undefined as never)).catch(() => undefined);
    });

    const response = await get(port, "/env/anything/at/all");
    expect(response.body).toBe("local-router");
  });
});
