// FILE: httpRoute.ts
// Purpose: The local `/ws/remote/:hostId` upgrade a renderer uses to reach a
//          host this shell has dialed, plus the negotiate answer the renderer's
//          transport asks for before upgrading.
// Layer: server host connections
//
// Owner-only: the socket is a full-privilege bridge onto another machine, so
// only a connection the shell itself trusts as its console (the same rule the
// local `/ws` applies for the desktop bridge and loopback) may take it.

import { EventEmitter } from "node:events";

import { WS_FEATURE_PATH, WS_NEGOTIATE_HTTP_PATH, WsCompatibilityError } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { CloseEvent } from "effect/unstable/socket/Socket";
import type { RawData } from "ws";

import { ServerAuth } from "../auth/Services/ServerAuth";
import { makeEffectAuthRequest } from "../auth/effectHttp";
import { ServerConfig } from "../config";
import type { RelaySocket } from "../relayDial";
import { shouldRejectUntrustedRequestOrigin } from "../trustedOrigins";
import { negotiateWsCompatibility, parseWsNegotiateSearchParams } from "../wsCompatibility";
import { authenticateRpcWebSocketUpgrade } from "../wsRpc";
import { HOST_CONNECTION_WS_PATH_PREFIX, HostConnectionRegistryService } from "./registry";

class EffectSocketAdapter extends EventEmitter implements RelaySocket {
  readyState = 1;

  constructor(
    private readonly write: (
      chunk: Uint8Array | string | CloseEvent,
    ) => Effect.Effect<void, unknown>,
  ) {
    super();
  }

  send(data: string | Uint8Array): void {
    Effect.runFork(this.write(data).pipe(Effect.ignore));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    Effect.runFork(this.write(new CloseEvent(code, reason)).pipe(Effect.ignore));
  }

  receive(data: string | Uint8Array): void {
    // `ws` emits (data, isBinary); the Effect socket hands us the raw type.
    this.emit("message", data as RawData, typeof data !== "string");
  }

  closed(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }
}

function hostIdParam(params: Readonly<Record<string, string | undefined>>): string | null {
  const raw = params.hostId;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * The renderer's transport negotiates over HTTP before upgrading, against the
 * same origin it will upgrade on. For a remote session that negotiation is
 * answered locally: the wire the renderer speaks is bridged verbatim, and the
 * remote host validates the actual `/ws` compatibility itself when the
 * shell's bridge connects to it (localRpcBridge on the far side). The instance
 * id is namespaced by host so a switch between hosts resets the renderer's
 * resume cursors, as a server restart would.
 */
export const hostConnectionRouteLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add(
      "GET",
      `${HOST_CONNECTION_WS_PATH_PREFIX}:hostId${WS_FEATURE_PATH}`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        const serverAuth = yield* ServerAuth;
        const registry = yield* HostConnectionRegistryService;
        const url = HttpServerRequest.toURL(request);
        if (
          !url ||
          shouldRejectUntrustedRequestOrigin({
            rawOrigin: request.headers.origin,
            requestOrigin: url.origin,
            config,
          })
        ) {
          return HttpServerResponse.text("Forbidden", { status: 403 });
        }
        const hostId = hostIdParam(yield* HttpRouter.params);
        if (!hostId) return HttpServerResponse.text("Not Found", { status: 404 });

        // Same admission as the local `/ws`: loopback/desktop-bridge trust, or
        // an authenticated owner session. A paired client-role session is not
        // allowed to pivot through this shell onto another machine.
        const authenticated = yield* authenticateRpcWebSocketUpgrade({
          config,
          legacyToken: url.searchParams.get("token"),
          request: makeEffectAuthRequest(request),
          serverAuth,
        }).pipe(Effect.catch(() => Effect.succeed("refused" as const)));
        if (authenticated === "refused") {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
        if (authenticated && authenticated.role !== "owner") {
          return HttpServerResponse.text("Forbidden", { status: 403 });
        }
        if (!registry.get(hostId)) {
          return HttpServerResponse.text("No open connection to that host", { status: 404 });
        }

        const socket = yield* request.upgrade;
        const writer = yield* socket.writer;
        const adapter = new EffectSocketAdapter(writer);
        if (!registry.attach(hostId, adapter)) {
          return HttpServerResponse.empty();
        }
        yield* socket
          .runRaw((message) => adapter.receive(message))
          .pipe(Effect.ensuring(Effect.sync(() => adapter.closed())));
        return HttpServerResponse.empty();
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty()))),
    );

    // `/ws/remote/:hostId/ws/negotiate` — answered locally, see above.
    // (`/ws/remote/:hostId/ws/bootstrap` is deliberately not served: every
    // shell new enough to bridge also serves HTTP negotiate, so the legacy
    // bootstrap socket is never needed on this path.)
    yield* router.add(
      "GET",
      `${HOST_CONNECTION_WS_PATH_PREFIX}:hostId${WS_NEGOTIATE_HTTP_PATH}`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        const registry = yield* HostConnectionRegistryService;
        const url = HttpServerRequest.toURL(request);
        if (
          !url ||
          shouldRejectUntrustedRequestOrigin({
            rawOrigin: request.headers.origin,
            requestOrigin: url.origin,
            config,
          })
        ) {
          return HttpServerResponse.text("Forbidden", { status: 403 });
        }
        const hostId = hostIdParam(yield* HttpRouter.params);
        const connection = hostId ? registry.get(hostId) : undefined;
        if (!connection) {
          return HttpServerResponse.text("No open connection to that host", { status: 404 });
        }
        const headers = { "Cache-Control": "no-store" };
        const input = parseWsNegotiateSearchParams(url.searchParams);
        if (input instanceof WsCompatibilityError) {
          return HttpServerResponse.jsonUnsafe(input, { status: 426, headers });
        }
        return yield* negotiateWsCompatibility(input).pipe(
          Effect.map((result) =>
            HttpServerResponse.jsonUnsafe(
              { ...result, serverInstanceId: `${result.serverInstanceId}:${connection.hostId}` },
              { status: 200, headers },
            ),
          ),
          Effect.catch((error) =>
            Effect.succeed(HttpServerResponse.jsonUnsafe(error, { status: 426, headers })),
          ),
        );
      }),
    );
  }),
);
