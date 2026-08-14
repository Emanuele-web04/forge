import http from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { NonNegativeInt } from "@synara/contracts";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { ServerSecretStoreLive } from "../../../server/src/auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "../../../server/src/auth/Layers/SessionCredentialService";
import {
  AuthError,
  ServerAuth,
  type ServerAuthShape,
} from "../../../server/src/auth/Services/ServerAuth";
import { SessionCredentialService } from "../../../server/src/auth/Services/SessionCredentialService";
import { ServerConfig, type ServerConfigShape } from "../../../server/src/config";
import { startHostConnectivity } from "../../../server/src/hostConnectivity";
import { makeBoundedNodeHttpServer } from "../../../server/src/nodeHttpServer";
import { patchBunWebSocketCloseEventCompatibility } from "../../../server/src/bunWebSocketCompatibility";
import { SqlitePersistenceMemory } from "../../../server/src/persistence/Layers/Sqlite";
import { hostRemoteWebSocketRouteLayer } from "../../../server/src/remoteSessions";
import { makeWebsocketRpcRouteLayer } from "../../../server/src/wsRpc";
import {
  makeWsConnectionSessions,
  WsConnectionSessions,
} from "../../../server/src/wsConnectionSessions";

const EchoRpc = Rpc.make("e2e.echo", {
  payload: Schema.Struct({ sequence: NonNegativeInt, payload: Schema.String }),
  success: Schema.Struct({ sequence: NonNegativeInt, payload: Schema.String }),
});
const EchoRpcGroup = RpcGroup.make(EchoRpc);

export interface RunningHost extends AsyncDisposable {
  readonly config: ServerConfigShape;
  readonly directUrl: string;
}

/** Test-only JSON RPC serialization that makes the echo server preserve frame kind. */
export function makeFrameKindEchoRpcSerialization() {
  return {
    contentType: RpcSerialization.json.contentType,
    includesFraming: RpcSerialization.json.includesFraming,
    makeUnsafe: () => {
      const parser = RpcSerialization.json.makeUnsafe();
      const binaryRequests = new Set<string>();
      const encoder = new TextEncoder();
      return {
        decode: (data: Uint8Array | string) => {
          const messages = parser.decode(data);
          if (typeof data !== "string") {
            for (const message of messages) {
              if (
                message &&
                typeof message === "object" &&
                "_tag" in message &&
                message._tag === "Request" &&
                "id" in message &&
                typeof message.id === "string"
              ) {
                binaryRequests.add(message.id);
              }
            }
          }
          return messages;
        },
        encode: (response: unknown) => {
          const encoded = parser.encode(response);
          if (typeof encoded !== "string" || !response || typeof response !== "object") {
            return encoded;
          }
          if (!("requestId" in response) || typeof response.requestId !== "string") {
            return encoded;
          }
          const binary = binaryRequests.has(response.requestId);
          if ("_tag" in response && response._tag === "Exit") {
            binaryRequests.delete(response.requestId);
          }
          return binary ? encoder.encode(encoded) : encoded;
        },
      };
    },
  } satisfies RpcSerialization.RpcSerialization["Service"];
}

/** Polls the relay's health endpoint until it reports a connected host. */
async function waitForRelayRegistration(relayOrigin: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = new URL("/healthz", relayOrigin).toString();
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = (await response.json()) as { hosts?: number };
        if ((body.hosts ?? 0) > 0) return;
      }
    } catch {
      // Relay not answering yet; keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("host never registered its relay control socket");
}

export async function startRealHost(input: {
  readonly baseDir: string;
  readonly relayOrigin: string;
}): Promise<RunningHost> {
  const baseConfigLayer = ServerConfig.layerTest(process.cwd(), input.baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const configLayer = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return {
        ...config,
        authToken: "e2e-force-session-auth",
        relayUrl: new URL(input.relayOrigin),
      } satisfies ServerConfigShape;
    }),
  ).pipe(Layer.provide(baseConfigLayer));
  const sessionsLayer = SessionCredentialServiceLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(configLayer),
    Layer.provide(NodeServices.layer),
  );
  const serverAuthLayer = Layer.effect(
    ServerAuth,
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      return {
        authenticateWebSocketUpgrade: (request) => {
          const token = request.url?.searchParams.get("wsToken") ?? "";
          return sessions.verifyWebSocketToken(token).pipe(
            Effect.map((session) => ({
              sessionId: session.sessionId,
              subject: session.subject,
              method: session.method,
              role: session.role,
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            })),
            Effect.mapError(
              (cause) => new AuthError({ message: "Unauthorized request.", status: 401, cause }),
            ),
          );
        },
        logoutSession: (sessionId) =>
          sessions
            .revoke(sessionId)
            .pipe(
              Effect.mapError(
                (cause) => new AuthError({ message: "Failed to log out session.", cause }),
              ),
            ),
      } as ServerAuthShape;
    }),
  ).pipe(Layer.provide(sessionsLayer));

  const serializationLayer = Layer.succeed(
    RpcSerialization.RpcSerialization,
    makeFrameKindEchoRpcSerialization(),
  );
  const handlers = EchoRpcGroup.toLayer(
    Effect.succeed({
      "e2e.echo": (payload: { readonly sequence: number; readonly payload: string }) =>
        Effect.succeed(payload),
    }),
  );
  const rpcSource = RpcServer.toHttpEffectWebsocket(EchoRpcGroup).pipe(
    Effect.provide(handlers.pipe(Layer.provideMerge(serializationLayer))),
  );
  const connectionSessions = await Effect.runPromise(makeWsConnectionSessions);
  const routes = Layer.mergeAll(
    makeWebsocketRpcRouteLayer(rpcSource),
    hostRemoteWebSocketRouteLayer,
  ).pipe(Layer.provide(Layer.succeed(WsConnectionSessions, connectionSessions)));

  const scope = await Effect.runPromise(Scope.make("sequential"));
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.mergeAll(configLayer, sessionsLayer, serverAuthLayer, NodeServices.layer),
      scope,
    ),
  );
  let nodeServer: http.Server | null = null;
  let stopConnectivity: (() => void) | undefined;
  let closed = false;
  try {
    const started = await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const sessions = yield* SessionCredentialService;
          patchBunWebSocketCloseEventCompatibility();
          const server = yield* makeBoundedNodeHttpServer(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const httpApp = yield* HttpRouter.toHttpEffect(routes);
          yield* server.serve(httpApp);
          return { config, sessions };
        }).pipe(Effect.provide(context)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("real host did not bind TCP");
    stopConnectivity = await startHostConnectivity({
      config: started.config,
      listeningPort: address.port,
      localSessions: started.sessions,
    });
    // The relay dial is asynchronous: startHostConnectivity returns before the
    // control socket has connected and sent `ready`. A client that grants and
    // connects in that window reaches a relay with no host registered, and its
    // splice sits pending until the relay's timeout — so wait for the relay to
    // actually report the host before handing the fixture back.
    await waitForRelayRegistration(input.relayOrigin);
    return {
      config: started.config,
      directUrl: `ws://127.0.0.1:${address.port}/ws/host`,
      async [Symbol.asyncDispose]() {
        if (closed) return;
        closed = true;
        stopConnectivity?.();
        await Effect.runPromise(Scope.close(scope, Exit.void));
      },
    };
  } catch (error) {
    stopConnectivity?.();
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
    throw error;
  }
}
