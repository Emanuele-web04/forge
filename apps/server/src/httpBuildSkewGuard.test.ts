// Pins the HTTP-side build-skew guard. Before it existed, degradation was
// enforced on the WebSocket transport only: the client's `assertNotSkewedWrite`
// covers `transport.request` and therefore nothing sent by `fetch`, so a client
// showing the read-only banner could still upload attachments and voice audio.
import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { WS_COMPATIBILITY_QUERY } from "@synara/contracts";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
  VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH,
} from "@synara/shared/binaryTransfer";

import { binaryUploadEffectRouteLayer } from "./http";
import {
  addBuildSkewGuardedWriteRoute,
  BUILD_SKEW_EXEMPT_HTTP_PATH_PREFIX,
  isBuildSkewExemptHttpPath,
  isHttpRequestBuildSkewed,
} from "./httpBuildSkewGuard";
import { version as serverBuild } from "../package.json" with { type: "json" };

function urlFor(pathname: string, clientBuild?: string): URL {
  const url = new URL(`http://127.0.0.1${pathname}`);
  if (clientBuild !== undefined) {
    url.searchParams.set(WS_COMPATIBILITY_QUERY.clientBuild, clientBuild);
  }
  return url;
}

describe("http build-skew classification", () => {
  it("does not treat a matching client build as skewed", () => {
    expect(isHttpRequestBuildSkewed(urlFor("/api/attachments/upload", serverBuild))).toBe(false);
  });

  it("treats a mismatched major or minor build as skewed", () => {
    const [major = "0", minor = "0"] = serverBuild.split(".");
    expect(
      isHttpRequestBuildSkewed(
        urlFor("/api/attachments/upload", `${Number(major) + 1}.${minor}.0`),
      ),
    ).toBe(true);
    expect(
      isHttpRequestBuildSkewed(
        urlFor("/api/attachments/upload", `${major}.${Number(minor) + 1}.0`),
      ),
    ).toBe(true);
  });

  // Deliberately NOT the WebSocket direction. The WS upgrade fails a missing
  // build closed because negotiation makes it mandatory there; HTTP has no
  // negotiation and these routes accept bearer auth from callers that are not
  // the web client and have no build to declare. Failing those closed would
  // deny them outright and mask the routes' own auth/origin refusals.
  it("does not treat an absent build identity as skewed", () => {
    expect(isHttpRequestBuildSkewed(urlFor("/api/attachments/upload"))).toBe(false);
    expect(isHttpRequestBuildSkewed(urlFor("/api/attachments/upload", "   "))).toBe(false);
  });

  // A client that DOES assert a build is held to it: an unparseable value is a
  // claim that cannot be matched against the server's, so it degrades.
  it("treats an asserted but unparseable build as skewed", () => {
    expect(isHttpRequestBuildSkewed(urlFor("/api/attachments/upload", "not-a-version"))).toBe(true);
  });

  // A patch difference is routine within a release line and must not degrade.
  it("does not degrade across a patch-only difference", () => {
    const [major = "0", minor = "0"] = serverBuild.split(".");
    expect(
      isHttpRequestBuildSkewed(urlFor("/api/attachments/upload", `${major}.${minor}.999`)),
    ).toBe(false);
  });
});

describe("auth recovery-path exemption", () => {
  // Non-negotiable: re-pairing is how a user fixes a skewed client. Blocking
  // /api/auth/* under skew strands the session that needs to recover.
  it.each([
    "/api/auth/session",
    "/api/auth/bootstrap",
    "/api/auth/bootstrap/bearer",
    "/api/auth/ws-token",
    "/api/auth/pairing-token",
    "/api/auth/pairing-links",
    // Ends the CALLER'S OWN session only, and is how a user reaches a clean
    // re-pair. Recovery, not destruction.
    "/api/auth/logout",
  ])("exempts recovery route %s from the guard", (pathname) => {
    expect(isBuildSkewExemptHttpPath(pathname)).toBe(true);
  });

  // The other direction, and the reason the prefix was replaced by a list.
  // These destroy access for someone ELSE, irreversibly, from a client the
  // server has already declared read-only. None of them helps anyone recover,
  // so none may ride along on the recovery exemption.
  it.each([
    "/api/auth/clients/revoke",
    "/api/auth/clients/revoke-others",
    "/api/auth/pairing-links/revoke",
  ])("guards destructive route %s", (pathname) => {
    expect(isBuildSkewExemptHttpPath(pathname)).toBe(false);
  });

  it("normalizes a trailing slash in both directions", () => {
    // A recovery route must not miss the list and strand a user; a destructive
    // one must not slip past it and stay exempt.
    expect(isBuildSkewExemptHttpPath("/api/auth/logout/")).toBe(true);
    expect(isBuildSkewExemptHttpPath("/api/auth/clients/revoke/")).toBe(false);
  });

  it("guards a NEW route under the auth prefix by default", () => {
    // The point of an allowlist over a prefix: a route added later is guarded
    // unless someone explicitly decides it is recovery, rather than exempt by
    // accident of where it was filed.
    expect(isBuildSkewExemptHttpPath("/api/auth/some-future-route")).toBe(false);
  });

  it("exempts nothing outside the recovery list", () => {
    for (const pathname of [
      "/api/attachments/upload",
      "/api/attachments/cancel",
      "/api/voice/transcribe",
      "/api/authorize",
      "/health",
    ]) {
      expect(isBuildSkewExemptHttpPath(pathname), `${pathname} was exempted`).toBe(false);
    }
  });

  it("anchors the exemption at a path prefix, not a substring", () => {
    expect(isBuildSkewExemptHttpPath("/api/attachments/upload?next=/api/auth/session")).toBe(false);
    expect(BUILD_SKEW_EXEMPT_HTTP_PATH_PREFIX).toBe("/api/auth/");
  });
});

describe("guarded write-route registration", () => {
  it("refuses to register a recovery-path route as a guarded write", () => {
    expect(() =>
      addBuildSkewGuardedWriteRoute(
        "POST",
        "/api/auth/bootstrap",
        Effect.succeed(HttpServerResponse.empty()),
      ),
    ).toThrow(/Refusing to register/);
  });
});

/**
 * End to end over a real socket. The unit tests above pin the classification;
 * this pins that a guarded route actually refuses the request BEFORE its
 * handler runs — the property that was false for all three upload routes.
 */
describe("guarded write route over HTTP", () => {
  const TEST_ROUTE = "/api/test/write";

  async function withGuardedServer(run: (origin: string) => Promise<void>): Promise<boolean> {
    let handlerRan = false;
    const scope = await Effect.runPromise(Scope.make("sequential"));
    let nodeServer: http.Server | null = null;
    try {
      await Effect.runPromise(
        Scope.provide(
          Effect.gen(function* () {
            const httpServer = yield* NodeHttpServer.make(
              () => {
                nodeServer = http.createServer();
                return nodeServer;
              },
              { port: 0, host: "127.0.0.1" },
            );
            yield* httpServer.serve(
              yield* HttpRouter.toHttpEffect(
                addBuildSkewGuardedWriteRoute(
                  "*",
                  TEST_ROUTE,
                  Effect.sync(() => {
                    handlerRan = true;
                    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
                  }),
                ),
              ),
            );
          }).pipe(Effect.provide(NodeHttpServer.layerHttpServices)),
          scope,
        ),
      );
      const address = (nodeServer as http.Server | null)?.address();
      if (!address || typeof address !== "object") throw new Error("Expected server address");
      await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    return handlerRan;
  }

  it("refuses a skewed write without reaching the handler", async () => {
    const [major = "0", minor = "0"] = serverBuild.split(".");
    const handlerRan = await withGuardedServer(async (origin) => {
      const response = await fetch(
        `${origin}${TEST_ROUTE}?${WS_COMPATIBILITY_QUERY.clientBuild}=${Number(major) + 1}.${minor}.0`,
        { method: "POST", body: "payload" },
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("different Synara build"),
      });
    });
    expect(handlerRan).toBe(false);
  });

  // A caller that declares no build (explicit bearer auth, not the web client)
  // reaches the handler and is then subject to that route's own auth checks.
  it("admits a write carrying no build identity at all", async () => {
    const handlerRan = await withGuardedServer(async (origin) => {
      const response = await fetch(`${origin}${TEST_ROUTE}`, { method: "POST", body: "payload" });
      expect(response.status).toBe(200);
    });
    expect(handlerRan).toBe(true);
  });

  it("refuses a write whose asserted build is unparseable", async () => {
    const handlerRan = await withGuardedServer(async (origin) => {
      const response = await fetch(
        `${origin}${TEST_ROUTE}?${WS_COMPATIBILITY_QUERY.clientBuild}=not-a-version`,
        { method: "POST", body: "payload" },
      );
      expect(response.status).toBe(409);
    });
    expect(handlerRan).toBe(false);
  });

  it("admits a write from a matching build", async () => {
    const handlerRan = await withGuardedServer(async (origin) => {
      const response = await fetch(
        `${origin}${TEST_ROUTE}?${WS_COMPATIBILITY_QUERY.clientBuild}=${serverBuild}`,
        { method: "POST", body: "payload" },
      );
      expect(response.status).toBe(200);
    });
    expect(handlerRan).toBe(true);
  });

  // CORS preflight is not a write. It must still answer, or the browser reports
  // an opaque CORS failure instead of surfacing the 409.
  it("passes an OPTIONS preflight through to the handler even when skewed", async () => {
    const handlerRan = await withGuardedServer(async (origin) => {
      const response = await fetch(`${origin}${TEST_ROUTE}`, { method: "OPTIONS" });
      expect(response.status).toBe(200);
    });
    expect(handlerRan).toBe(true);
  });
});

/**
 * The WIRING, over the route layer that actually ships. The tests above pin the
 * guard's own behaviour but say nothing about whether the real upload routes
 * were registered through it — reverting one route to a bare `HttpRouter.add`
 * left every other test in this file green.
 *
 * A skewed request is refused before the handler needs any of its services, so
 * this can serve the production layer with none of them provided: reaching the
 * handler at all fails the test.
 */
describe("shipped binary upload routes are registered with the guard", () => {
  async function postSkewed(routePath: string): Promise<number> {
    const scope = await Effect.runPromise(Scope.make("sequential"));
    let nodeServer: http.Server | null = null;
    try {
      const serve = Effect.gen(function* () {
        const httpServer = yield* NodeHttpServer.make(
          () => {
            nodeServer = http.createServer();
            return nodeServer;
          },
          { port: 0, host: "127.0.0.1" },
        );
        yield* httpServer.serve(yield* HttpRouter.toHttpEffect(binaryUploadEffectRouteLayer));
      }).pipe(Effect.provide(NodeHttpServer.layerHttpServices));
      // The handler's own services (ServerConfig, the attachment repository,
      // the provider registry) are deliberately NOT provided: a skewed request
      // is refused before the handler runs, so needing one would mean the guard
      // did not fire. The cast covers only those unprovided requirements — the
      // 409 the test asserts is genuine runtime behaviour, not a typing artifact.
      await Effect.runPromise(Scope.provide(serve as Effect.Effect<void, unknown, never>, scope));
      const address = (nodeServer as http.Server | null)?.address();
      if (!address || typeof address !== "object") throw new Error("Expected server address");
      const [major = "0", minor = "0"] = serverBuild.split(".");
      const response = await fetch(
        `http://127.0.0.1:${address.port}${routePath}?${WS_COMPATIBILITY_QUERY.clientBuild}=${
          Number(major) + 1
        }.${minor}.0`,
        { method: "POST", body: "payload" },
      );
      return response.status;
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  }

  it.each([
    ATTACHMENT_UPLOAD_ROUTE_PATH,
    ATTACHMENT_CANCEL_ROUTE_PATH,
    VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH,
  ])("refuses a skewed write to %s", async (routePath) => {
    await expect(postSkewed(routePath)).resolves.toBe(409);
  });
});
