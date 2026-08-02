import http from "node:http";
import type { ListenOptions, Socket } from "node:net";

import { WS_FEATURE_PATH } from "@synara/contracts";
import type { EnvironmentProxyDispatch } from "./environmentProxy";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Scope } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { ServeError } from "effect/unstable/http/HttpServerError";
import { WebSocketServer } from "ws";

export const MAX_WEBSOCKET_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * Node's HTTP parser owns the socket error listener until an upgrade starts.
 * The Effect upgrade handler then runs the route (including authentication)
 * before `ws.handleUpgrade()` installs its own listener. A peer reset during
 * that gap otherwise becomes an unhandled `error` event and terminates the
 * whole backend process.
 *
 * Keep this boundary for the complete lifetime of every accepted connection.
 * Other protocol-specific listeners still receive the event and perform their
 * own cleanup; destroying an already-failed socket here only guarantees that
 * HTTP requests, rejected upgrades, and pending upgrades all release promptly.
 */
function handleClientSocketError(this: Socket): void {
  this.destroy();
}

function protectClientSocket(socket: Socket): void {
  socket.on("error", handleClientSocketError);
}

/**
 * permessage-deflate configuration for the feature WS socket only.
 *
 * The RPC stream is small, highly repetitive JSON (repeated schema keys,
 * UUIDs, event envelopes), which is the best case for DEFLATE with context
 * takeover: the compression window is shared across frames, so each frame is
 * coded against the vocabulary of everything sent before it. Context takeover
 * stays enabled (the negotiated default). A client offering
 * `client_no_context_takeover` still compresses normally; one offering
 * `server_no_context_takeover` loses the shared vocabulary and can end up
 * with frames slightly larger than uncompressed, since framing overhead
 * exceeds the gain on a single small frame.
 *
 * No `threshold` is set: `ws` only honors it when context takeover is
 * disabled, and skipping tiny frames would also skip priming the shared
 * window they benefit from.
 *
 * `maxPayload` admission control is unaffected: `ws` enforces it on the
 * decompressed size — accumulated across continuation frames — so a
 * compressed or fragmented message cannot smuggle past the bound.
 *
 * The pre-auth bootstrap socket deliberately never negotiates compression:
 * each actively compressed connection retains zlib window state (~288 KiB at
 * defaults) plus potentially near-`maxPayload` inflated buffers for
 * incomplete fragmented messages, and the bootstrap path is reachable
 * without credentials. Compression is a post-authentication privilege so
 * unauthenticated connections cannot multiply per-connection memory.
 *
 * Measured on a simulated streaming turn of small repetitive JSON frames:
 * ~80% wire reduction, with CPU dominated by per-invocation zlib overhead
 * rather than compression level (levels 1/3/6 within 2% on both axes), so
 * zlib options stay at their defaults. Numbers in the PR that added this.
 *
 * `ws` already defaults `concurrencyLimit` to 10 and creates its limiter
 * once per process on the first PerMessageDeflate instance, so passing it
 * here would pin the default rather than bound anything new.
 */
const PER_MESSAGE_DEFLATE_OPTIONS = true;

/**
 * The one upgrade route allowed to negotiate compression (post-auth). Shared
 * with the route registration so the dispatcher and the router cannot drift.
 */
const COMPRESSED_UPGRADE_PATH = WS_FEATURE_PATH;

/**
 * Normalizes a raw request target the way the Effect router does before route
 * matching: absolute-form targets, query and fragment, `;params`, duplicate
 * slashes, percent-encoding, case, and trailing slashes all collapse. The
 * router matches case-insensitively on the decoded path, so comparing the raw
 * target here would let `/WS/BOOTSTRAP` or `/ws/%62ootstrap` reach the
 * bootstrap route while classifying as something else.
 */
function normalizeUpgradePath(requestUrl: string | undefined): string {
  const target = requestUrl ?? "";
  // Absolute-form request targets (RFC 9112 §3.2.2) are legal on upgrades.
  const afterAuthority = /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
    ? target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") || "/"
    : target;
  const pathOnly = afterAuthority.split("#")[0]?.split("?")[0] ?? "";
  let decoded = pathOnly;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    // Malformed percent-encoding cannot be a recognized route; leave as-is so
    // it falls through to the uncompressed default.
  }
  const withoutParams = decoded
    .split("/")
    .map((segment) => segment.split(";")[0] ?? "")
    .join("/");
  const collapsed = withoutParams.replace(/\/{2,}/g, "/").toLowerCase();
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/**
 * Fail closed: only the exact feature route negotiates compression. Anything
 * else — the pre-auth bootstrap route, unrecognized paths, malformed targets —
 * lands on the uncompressed server, so no unauthenticated connection can hold
 * zlib state regardless of how its path is spelled.
 */
export function upgradePathAllowsCompression(requestUrl: string | undefined): boolean {
  return normalizeUpgradePath(requestUrl) === COMPRESSED_UPGRADE_PATH;
}

/**
 * Owns the Node HTTP/WebSocket transport so Synara, rather than the platform
 * adapter's 100 MiB default, controls admission before a message is decoded.
 */
export const makeBoundedNodeHttpServer = Effect.fnUntraced(function* (
  evaluate: () => http.Server,
  options: ListenOptions,
  /**
   * Single-origin environment proxy. When present, `/env/:envId/*` requests and
   * upgrades are diverted to a remote Synara server BEFORE the local Effect
   * router or the ws servers see them, and everything else is untouched.
   *
   * Passed in rather than constructed here so the proxy's registry (which is
   * authorization state) is owned by the server lifecycle, and so a deployment
   * with no remote environments has no proxy surface at all.
   */
  environmentProxy?: EnvironmentProxyDispatch,
) {
  const scope = yield* Effect.scope;
  const server = evaluate();

  // Install before `listen()`: no accepted connection may exist without a
  // permanent error boundary, including connections reset during startup.
  server.on("connection", protectClientSocket);

  yield* Scope.addFinalizer(
    scope,
    Effect.callback<void>((resume) => {
      server.off("connection", protectClientSocket);
      if (!server.listening) {
        resume(Effect.void);
        return;
      }
      server.close((error) => {
        if (error) resume(Effect.die(error));
        else resume(Effect.void);
      });
    }),
  );

  yield* Effect.callback<void, ServeError>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(new ServeError({ cause })));
    server.on("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resume(Effect.void);
    });
  });

  const address = server.address()!;
  const makeBoundedWebSocketServer = (perMessageDeflate: boolean) =>
    Effect.acquireRelease(
      Effect.sync(
        () =>
          new WebSocketServer({
            noServer: true,
            maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
            perMessageDeflate: perMessageDeflate ? PER_MESSAGE_DEFLATE_OPTIONS : false,
          }),
      ),
      (server) =>
        Effect.callback<void>((resume) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resume(Effect.void));
        }),
    ).pipe(Scope.provide(scope));
  // Two ws servers sharing one HTTP listener: compression is negotiated only
  // on authenticated feature-socket paths (see PER_MESSAGE_DEFLATE_OPTIONS).
  const featureWebSocketServer = yield* makeBoundedWebSocketServer(true);
  const bootstrapWebSocketServer = yield* makeBoundedWebSocketServer(false);

  return HttpServer.make({
    address:
      typeof address === "string"
        ? { _tag: "UnixAddress", path: address }
        : {
            _tag: "TcpAddress",
            hostname: address.address === "::" ? "0.0.0.0" : address.address,
            port: address.port,
          },
    serve: Effect.fnUntraced(function* (httpApp, middleware) {
      const serveScope = yield* Effect.scope;
      const handler = yield* NodeHttpServer.makeHandler(httpApp, {
        middleware: middleware as any,
        scope: serveScope,
      }) as Effect.Effect<
        (nodeRequest: http.IncomingMessage, nodeResponse: http.ServerResponse) => void
      >;
      const featureUpgradeHandler = yield* NodeHttpServer.makeUpgradeHandler(
        Effect.succeed(featureWebSocketServer),
        httpApp,
        {
          middleware: middleware as any,
          scope: serveScope,
        },
      );
      const bootstrapUpgradeHandler = yield* NodeHttpServer.makeUpgradeHandler(
        Effect.succeed(bootstrapWebSocketServer),
        httpApp,
        {
          middleware: middleware as any,
          scope: serveScope,
        },
      );
      const localUpgradeHandler = (
        nodeRequest: http.IncomingMessage,
        socket: Parameters<typeof featureUpgradeHandler>[1],
        head: Parameters<typeof featureUpgradeHandler>[2],
      ) => {
        const dispatch = upgradePathAllowsCompression(nodeRequest.url)
          ? featureUpgradeHandler
          : bootstrapUpgradeHandler;
        dispatch(nodeRequest, socket, head);
      };

      // Wrapping, not a second listener: Node runs every listener, so a proxied
      // request would otherwise be answered by BOTH the proxy and the local
      // router (whose SPA fallback happily serves index.html for
      // `/env/<id>/threads/...`), racing two responses onto one socket.
      const requestHandler = environmentProxy
        ? environmentProxy.wrapRequestHandler(handler)
        : handler;
      const upgradeHandler = environmentProxy
        ? environmentProxy.wrapUpgradeHandler(
            localUpgradeHandler as Parameters<EnvironmentProxyDispatch["wrapUpgradeHandler"]>[0],
          )
        : localUpgradeHandler;

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.off("request", requestHandler);
          server.off("upgrade", upgradeHandler);
        }),
      );
      server.on("request", requestHandler);
      server.on("upgrade", upgradeHandler);
    }),
  });
});
