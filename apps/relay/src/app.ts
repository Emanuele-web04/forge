import { Hono } from "hono";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

import type { RelayConfig } from "./config";
import type { RelayFetch } from "./http";
import { ApiJwtVerifier } from "./jwtVerifier";
import { RelayCore } from "./relayCore";
import { RevocationPoller } from "./revocationPoller";
import { WsSpliceSocket } from "./wsSocket";

const CONTROL_MAX_PAYLOAD_BYTES = 64 * 1024;
/**
 * Largest single spliced frame. Synara's protocol frames are far smaller;
 * this exists so one pair cannot pin `ws`'s 100 MiB default per direction.
 */
const SPLICE_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

type Logger = Pick<Console, "error" | "warn">;

export type RelayAppOptions = {
  fetch?: RelayFetch;
  logger?: Logger;
  jwksRefreshIntervalMs?: number;
  unknownKidRefreshMinIntervalMs?: number;
  revocationPollIntervalMs?: number;
  revocationInitialBackoffMs?: number;
  revocationMaxBackoffMs?: number;
  pendingTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  stallTimeoutMs?: number;
  backpressurePollMs?: number;
};

export type RelayApplication = {
  app: Hono;
  core: RelayCore;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
};

function rejectUpgrade(socket: Duplex, status: 404 | 503): void {
  const reason = status === 404 ? "Not Found" : "Service Unavailable";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export async function createRelayApp(
  config: RelayConfig,
  options: RelayAppOptions = {},
): Promise<RelayApplication> {
  const logger = options.logger ?? console;
  const verifier = new ApiJwtVerifier({
    apiBaseUrl: config.apiBaseUrl,
    issuer: config.apiIssuer,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.jwksRefreshIntervalMs === undefined
      ? {}
      : { refreshIntervalMs: options.jwksRefreshIntervalMs }),
    ...(options.unknownKidRefreshMinIntervalMs === undefined
      ? {}
      : { unknownKidRefreshMinIntervalMs: options.unknownKidRefreshMinIntervalMs }),
    logger,
  });
  await verifier.initialize();

  const core = new RelayCore({
    verifier,
    maxPairs: config.maxPairs,
    highWaterBytes: config.highWaterBytes,
    ...(options.pendingTimeoutMs === undefined
      ? {}
      : { pendingTimeoutMs: options.pendingTimeoutMs }),
    ...(options.keepaliveIntervalMs === undefined
      ? {}
      : { keepaliveIntervalMs: options.keepaliveIntervalMs }),
    ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
    ...(options.backpressurePollMs === undefined
      ? {}
      : { backpressurePollMs: options.backpressurePollMs }),
    logger,
  });
  const revocations = new RevocationPoller({
    apiBaseUrl: config.apiBaseUrl,
    serviceToken: config.relayServiceToken,
    onEvents: (events) => core.deliverRevocations(events),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.revocationPollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.revocationPollIntervalMs }),
    ...(options.revocationInitialBackoffMs === undefined
      ? {}
      : { initialBackoffMs: options.revocationInitialBackoffMs }),
    ...(options.revocationMaxBackoffMs === undefined
      ? {}
      : { maxBackoffMs: options.revocationMaxBackoffMs }),
    logger,
  });
  await revocations.initialize();
  revocations.start();

  const app = new Hono();
  app.get("/healthz", (context) =>
    context.json({ status: "ok", hosts: core.hostCount, pairs: core.pairCount }),
  );
  for (const path of ["/host/control", "/client/session", "/host/data"] as const) {
    app.get(path, (context) => context.text("WebSocket upgrade required", 426));
  }
  app.notFound((context) => context.json({ error: "not_found" }, 404));

  const controlServer = new WebSocketServer({
    noServer: true,
    maxPayload: CONTROL_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  // Without an explicit cap `ws` allows 100 MiB messages. Since a whole
  // message is buffered before it is emitted — and bufferedAmount is only
  // consulted after send — one authorized pair could pin hundreds of
  // megabytes before backpressure ever engages, OOMing the relay long before
  // maxPairs bites. The cap bounds a single spliced frame.
  const clientServer = new WebSocketServer({
    noServer: true,
    maxPayload: SPLICE_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  const hostDataServer = new WebSocketServer({
    noServer: true,
    maxPayload: SPLICE_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  for (const server of [controlServer, clientServer, hostDataServer]) {
    server.on("error", (error) => logger.error("[relay] WebSocket server error", error));
  }

  let closed = false;
  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (closed) {
      rejectUpgrade(socket, 503);
      return;
    }
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    if (url.pathname === "/host/control") {
      controlServer.handleUpgrade(request, socket, head, (websocket) => {
        const relaySocket = new WsSpliceSocket(websocket);
        void core.admitHost(relaySocket, url.searchParams.get("ticket") ?? "").catch((error) => {
          logger.error("[relay] unexpected host control admission failure", error);
          relaySocket.close(1011, "relay admission failed");
        });
      });
      return;
    }
    if (url.pathname === "/client/session") {
      clientServer.handleUpgrade(request, socket, head, (websocket) => {
        const relaySocket = new WsSpliceSocket(websocket);
        void core.admitClient(relaySocket, url.searchParams.get("grant") ?? "").catch((error) => {
          logger.error("[relay] unexpected client admission failure", error);
          relaySocket.close(1011, "relay admission failed");
        });
      });
      return;
    }
    if (url.pathname === "/host/data") {
      hostDataServer.handleUpgrade(request, socket, head, (websocket) => {
        core.admitHostData(new WsSpliceSocket(websocket), url.searchParams.get("splice") ?? "");
      });
      return;
    }
    rejectUpgrade(socket, 404);
  }

  return {
    app,
    core,
    handleUpgrade,
    close() {
      if (closed) return;
      closed = true;
      revocations.stop();
      core.stop();
      verifier.stop();
      controlServer.close();
      clientServer.close();
      hostDataServer.close();
    },
  };
}
