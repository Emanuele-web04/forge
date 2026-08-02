// FILE: environmentProxy.ts
// Purpose: The single-origin `/env/:envId/*` proxy. Forwards HTTP requests and
//          WebSocket frames to an environment's own Synara server BYTE FOR BYTE.
// Layer: Server / environment proxy
// Exports: makeEnvironmentProxyDispatch, proxyEnvironmentHttpRequest,
//          proxyEnvironmentWebSocket, serializeUpgradeRequest, writeCloseFrame,
//          EnvironmentProxyDeps, EnvironmentProxyDispatch
//
// ---------------------------------------------------------------------------
// Why byte-for-byte, and not a method-aware RPC relay
// ---------------------------------------------------------------------------
// The WS surface is ONE flat RpcGroup with no environment routing key, and
// orchestration event sequences are per-server SQLite autoincrement values. A
// relay that understood the protocol would therefore have to (a) track every
// method the RpcGroup gains or loses — breaking on every release — and (b)
// merge two independent, colliding sequence spaces. Phase 1 deliberately kept
// environment routing OUT of the wire protocol precisely so this layer could
// stay ignorant of it. Nothing in this file parses an RPC message.
//
// ---------------------------------------------------------------------------
// What this file DOES look at
// ---------------------------------------------------------------------------
//  - The request TARGET, to pick an upstream from a registry (never from the
//    request itself). See environmentProxyTargets.ts.
//  - HTTP headers, to strip hop-by-hop ones and scope cookies per environment.
//  - WebSocket frame HEADERS — opcode and length only — so a Pong can overtake
//    a queued multi-megabyte snapshot. Payloads are never decoded, so
//    permessage-deflate negotiates END TO END: the extension handshake passes
//    through untouched and only the two endpoints ever inflate anything.

import * as Http from "node:http";
import * as Net from "node:net";
import type { Duplex } from "node:stream";

import {
  WS_CLOSE_PROXY_RESYNC_REASON,
  WS_CLOSE_PROXY_RESYNC_REQUIRED,
  WS_CLOSE_PROXY_TUNNEL_LOST,
  WS_CLOSE_PROXY_TUNNEL_LOST_REASON,
} from "@synara/contracts";
import { forwardableRequestHeaders, forwardableResponseHeaders } from "@synara/shared/proxyHeaders";
import { makeProxyFrameQueue, type ProxyFrameQueueOptions } from "@synara/shared/proxyFrameQueue";
import { makeWsFrameSplitter, WsFrameSplitError } from "@synara/shared/wsFrameSplit";

import { isEnvironmentProxyRequestTarget } from "@synara/shared/environmentProxyPath";

import type { EnvironmentProxyAuthorizer } from "./environmentProxyAuthorization";
import {
  resolveEnvironmentProxyUpstream,
  type EnvironmentProxyRegistry,
  type EnvironmentProxyUpstream,
} from "./environmentProxyTargets";

/**
 * Header carrying the environment's provisioned credential upstream.
 *
 * Bearer, not a cookie: cookies are the browser's namespace and this credential
 * must never be reachable from one. The client's own `authorization` header is
 * dropped before this is set (see CLIENT_CONTROLLED_REQUEST_HEADERS), so a
 * browser can never choose which credential the local server presents.
 */
const UPSTREAM_AUTHORIZATION_HEADER = "authorization";

/**
 * Frame ceiling for the splitter.
 *
 * Matches the local WS server's `maxPayload` plus header and masking slack, so
 * a frame the local server would refuse cannot be buffered here on its way to a
 * remote one either. Defined here rather than imported from nodeHttpServer to
 * keep the proxy free of a cycle through the server construction module; the
 * two are pinned equal by a test.
 */
export const MAX_WEBSOCKET_MESSAGE_BYTES_FOR_PROXY = 2 * 1024 * 1024;
const MAX_PROXIED_FRAME_BYTES = MAX_WEBSOCKET_MESSAGE_BYTES_FOR_PROXY + 1024;

/**
 * How long a proxied HTTP request may wait for the upstream to begin
 * responding.
 *
 * Unbounded waiting is the failure mode of a WAN tunnel: a remote host that
 * stops answering without closing leaves every request hanging, and each one
 * pins a browser connection and a tunnel socket until something else gives out.
 * Generous enough for a slow remote turn to start streaming; the timer covers
 * time-to-first-byte, not the length of the response.
 */
export const ENVIRONMENT_PROXY_UPSTREAM_TIMEOUT_MS = 30_000;

export interface EnvironmentProxyDeps {
  readonly registry: EnvironmentProxyRegistry;
  /**
   * Local authorization gate. Runs BEFORE any upstream is resolved or
   * contacted, so an unauthenticated caller cannot even prove an environment
   * exists. Optional only so tests can exercise transport behaviour in
   * isolation; production always passes one (see effectServer.ts).
   */
  readonly authorize?: EnvironmentProxyAuthorizer;
  /** Test seam: opens the TCP connection to the upstream. */
  readonly connect?: (options: { host: string; port: number }) => Duplex;
  /** Test seam: issues the upstream HTTP request. */
  readonly request?: typeof Http.request;
  readonly queueOptions?: ProxyFrameQueueOptions;
  readonly upstreamTimeoutMs?: number;
  readonly onError?: (message: string, cause: unknown) => void;
}

function respondPlain(response: Http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

/**
 * Forwards one HTTP request to the environment's server.
 *
 * The body is piped, never buffered: a 2 GiB attachment upload through the
 * proxy must cost a socket, not a heap allocation. Backpressure therefore comes
 * from Node's own pipe, which pauses the reader when the writer is saturated.
 */
export function proxyEnvironmentHttpRequest(
  deps: EnvironmentProxyDeps,
  request: Http.IncomingMessage,
  response: Http.ServerResponse,
): void {
  const resolution = resolveEnvironmentProxyUpstream({
    registry: deps.registry,
    requestTarget: request.url ?? "",
  });
  if (!resolution.ok) {
    // Both rejection reasons answer 404. Distinguishing them to the caller
    // would let anyone enumerate which environment ids are registered.
    respondPlain(response, 404, "Unknown environment");
    return;
  }
  const { upstream, target } = resolution;
  const issue = deps.request ?? Http.request;
  const upstreamRequest = issue(
    {
      host: upstream.host,
      port: upstream.port,
      method: request.method ?? "GET",
      path: target,
      headers: {
        ...forwardableRequestHeaders(request.headers, upstream.environmentId),
        host: `${upstream.host}:${upstream.port}`,
        [UPSTREAM_AUTHORIZATION_HEADER]: `Bearer ${upstream.credential}`,
      },
    },
    (upstreamResponse) => {
      // The response has begun; the rest is the upstream's own streaming pace,
      // which a time-to-first-byte bound must not cut short.
      upstreamRequest.setTimeout(0);
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        forwardableResponseHeaders(upstreamResponse.headers, upstream.environmentId),
      );
      // `pipe` does NOT forward source errors to the destination, and the
      // status line is already spent, so 502 is no longer available. A tunnel
      // that dies mid-body must therefore truncate the client's response
      // rather than leave it waiting: a graceful FIN short of the declared
      // Content-Length raises nothing on `upstreamRequest` at all, so without
      // this the browser hangs until it gives up on its own.
      const truncate = (message: string, cause: unknown) => {
        deps.onError?.(message, cause);
        // destroy(), not end(): ending would look like a COMPLETE body of the
        // wrong length, and the browser would treat a truncated response as
        // the whole thing.
        if (!response.destroyed) response.destroy();
        if (!upstreamResponse.destroyed) upstreamResponse.destroy();
      };
      // Both listeners, deliberately, and NOT because they cover different
      // failures — measured, they do not. A premature FIN and an ECONNRESET
      // both emit `aborted` and then `error`, in that order, so on today's Node
      // either listener alone would suffice and the mid-response test only
      // fails when BOTH are removed. `truncate` is idempotent (it checks
      // `destroyed`), so the double call is free.
      //
      // Keep both anyway: which of the two an errored `IncomingMessage` emits
      // is a Node implementation detail, not a documented contract, and an
      // unhandled `error` on a stream with no listener is a process-level
      // throw. Relying on `aborted` always preceding it would make this file's
      // safety depend on undocumented ordering. If you delete one because CI
      // stays green, that is the test's blind spot, not evidence it is dead.
      upstreamResponse.on("error", (error) =>
        truncate("environment proxy upstream response failed", error),
      );
      upstreamResponse.on("aborted", () =>
        truncate(
          "environment proxy upstream response aborted",
          new Error(`environment ${upstream.environmentId}`),
        ),
      );
      upstreamResponse.pipe(response);
    },
  );
  // An upstream that accepts the connection and then never answers must not
  // hold a browser connection open forever; over a WAN tunnel those accumulate
  // until the socket budget is gone.
  let timedOut = false;
  upstreamRequest.setTimeout(
    deps.upstreamTimeoutMs ?? ENVIRONMENT_PROXY_UPSTREAM_TIMEOUT_MS,
    () => {
      timedOut = true;
      deps.onError?.(
        "environment proxy HTTP request timed out",
        new Error(`environment ${upstream.environmentId}`),
      );
      upstreamRequest.destroy(new Error("Environment did not respond in time."));
    },
  );
  upstreamRequest.on("error", (error) => {
    deps.onError?.("environment proxy HTTP request failed", error);
    // 504 for "answered nothing in time", 502 for "could not be reached at
    // all". They are different operational problems and the distinction is
    // about the tunnel, not about the caller, so it is safe to report.
    if (!response.headersSent) {
      if (timedOut) respondPlain(response, 504, "Environment did not respond");
      else respondPlain(response, 502, "Environment unreachable");
    } else response.destroy();
  });
  // A client that disappears must not leave the upstream request open: the
  // tunnel has a finite number of sockets and this is the leak that exhausts
  // it.
  //
  // `aborted` covers only a request cut off mid-BODY. The commoner shape is a
  // COMPLETED GET whose response streams for a long time: the browser goes
  // away, and because the request itself finished, `aborted` never fires —
  // Node merely unpipes, and the remote keeps producing into a socket nobody
  // reads, forever. `response`'s `close` fires in BOTH cases, so it is the one
  // that actually bounds the lifetime.
  request.on("aborted", () => upstreamRequest.destroy());
  response.on("close", () => {
    // Only when the exchange did not finish normally. `close` fires on every
    // response, successful ones included, and Node has already released the
    // upstream request by then — so this condition is defensive rather than
    // load-bearing, and no test pins it (destroying a finished request is
    // observably a no-op). It stays because "tear down the upstream" should
    // never read as something this code does on the success path.
    if (!response.writableFinished) upstreamRequest.destroy();
  });
  request.pipe(upstreamRequest);
}

export class UpgradeRequestSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpgradeRequestSerializationError";
  }
}

/**
 * Characters that terminate a line or a string in the HTTP wire format.
 *
 * This function builds a request by CONCATENATION, so any of these inside a
 * name, value, method or target does not escape — it is structure. One `\r\n`
 * in a header value appends whatever follows as ITS OWN header, including a
 * second `Authorization` ahead of the proxy's real one.
 */
const HTTP_STRUCTURAL_CHARACTERS = ["\r", "\n", "\0"];

function assertNoStructuralCharacters(label: string, value: string): void {
  if (HTTP_STRUCTURAL_CHARACTERS.some((character) => value.includes(character))) {
    // THROW rather than strip. Sanitizing would forward a request that is not
    // the one the caller described, and the difference between those two is
    // precisely what an injection attempt is trying to create. Today Node's
    // own parser rejects these spellings before they reach here, but that is
    // an incidental guard belonging to another layer — this function is
    // exported and must hold on its own.
    throw new UpgradeRequestSerializationError(
      `Refusing to serialize an upgrade request: ${label} contains a CR, LF or NUL.`,
    );
  }
}

/**
 * Serialises a WebSocket upgrade request for the upstream.
 *
 * Written by hand rather than through `http.request` because the extension
 * handshake must survive VERBATIM: `Sec-WebSocket-Extensions`,
 * `Sec-WebSocket-Key`, `Sec-WebSocket-Protocol` and `Sec-WebSocket-Version` are
 * forwarded exactly as the browser spelled them, and the upstream's answer goes
 * back the same way. That — not any code here — is what makes permessage-deflate
 * negotiate end to end: the proxy has no opinion about it and cannot get it
 * wrong.
 *
 * Hand-built means hand-validated: throws rather than emit a request whose
 * structure differs from the one described (see
 * `assertNoStructuralCharacters`).
 */
export function serializeUpgradeRequest(input: {
  readonly method: string;
  readonly target: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly upstream: Pick<
    EnvironmentProxyUpstream,
    "host" | "port" | "credential" | "environmentId"
  >;
}): string {
  const headers = {
    ...forwardableRequestHeaders(input.headers, input.upstream.environmentId),
    host: `${input.upstream.host}:${input.upstream.port}`,
    connection: "Upgrade",
    upgrade: "websocket",
    [UPSTREAM_AUTHORIZATION_HEADER]: `Bearer ${input.upstream.credential}`,
  };
  assertNoStructuralCharacters("the method", input.method);
  assertNoStructuralCharacters("the request target", input.target);
  const lines = [`${input.method} ${input.target} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    assertNoStructuralCharacters(`header name '${name}'`, name);
    for (const single of Array.isArray(value) ? value : [value]) {
      assertNoStructuralCharacters(`the value of header '${name}'`, String(single));
      lines.push(`${name}: ${single}`);
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/**
 * Sends a WebSocket Close frame with `code`/`reason` and destroys the socket.
 *
 * The proxy speaks a Close frame here rather than just cutting the TCP
 * connection because a bare disconnect is indistinguishable from a network
 * blip: the client would retry as if nothing were wrong and keep applying a
 * stream it is now missing frames from. The close CODE is the explicit resync
 * signal.
 */
export function writeCloseFrame(socket: Duplex, code: number, reason: string): void {
  const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
  const frame = Buffer.alloc(4 + reasonBytes.byteLength);
  frame[0] = 0x88; // FIN + Close opcode.
  frame[1] = 2 + reasonBytes.byteLength; // Server-to-client frames are unmasked.
  frame.writeUInt16BE(code, 2);
  reasonBytes.copy(frame, 4);
  socket.write(frame);
  socket.end();
}

interface RelayOptions {
  readonly from: Duplex;
  readonly to: Duplex;
  readonly queueOptions?: ProxyFrameQueueOptions;
  /**
   * Bytes already read from `from` before the relay was attached (Node's
   * `head`). Replayed through the same path as live bytes; discarding them
   * silently loses the first frames a fast client sent.
   */
  readonly initialBytes?: Buffer;
  /**
   * When true, this direction begins with an HTTP response head (the upstream's
   * 101) that is NOT a WebSocket frame. It is copied through verbatim — the
   * `Sec-WebSocket-Extensions` answer included, which is exactly what makes
   * permessage-deflate negotiate end to end — and frame splitting begins at the
   * first byte after the blank line.
   */
  readonly expectHandshakeResponse?: boolean;
  /** Called once when this direction overflows its bound. */
  readonly onOverflow: () => void;
  /**
   * Called when a Close frame is relayed in this direction.
   *
   * The endpoints' own Close is authoritative. Once one has crossed, the proxy
   * must not add a synthetic one on top of it — the peer would receive two
   * contradictory terminal frames and act on whichever it read last.
   */
  readonly onTerminalFrame?: () => void;
  readonly onError: (error: unknown) => void;
}

/**
 * Largest HTTP response head the proxy will buffer while looking for the blank
 * line. An upstream that never sends one must not be able to grow this without
 * bound; 64 KiB is far beyond any real handshake response.
 */
const MAX_HANDSHAKE_HEAD_BYTES = 64 * 1024;
const HEADER_TERMINATOR = Buffer.from("\r\n\r\n");

/**
 * Relays one direction with a bounded queue and control-frame priority.
 *
 * The two properties that matter:
 *
 *  - A frame is only ever WRITTEN as the exact bytes that were read. Nothing is
 *    unmasked, inflated, re-framed or re-encoded, so the peer receives the
 *    stream its counterpart produced.
 *  - Control frames are drained ahead of queued data frames. Without this, a
 *    Pong sits behind a multi-MB snapshot, the peer's heartbeat times out, and
 *    a healthy connection churns through a reconnect.
 */
function relayDirection(options: RelayOptions): void {
  const queue = makeProxyFrameQueue<Uint8Array>(options.queueOptions);
  const splitter = makeWsFrameSplitter({ maxFrameBytes: MAX_PROXIED_FRAME_BYTES });
  let draining = false;
  /** The destination refused a write and has not emitted `drain` since. */
  let saturated = false;
  let overflowSignalled = false;
  let awaitingHandshake = options.expectHandshakeResponse === true;
  let handshakeBuffer = Buffer.alloc(0);

  const signalOverflow = () => {
    if (overflowSignalled) return;
    overflowSignalled = true;
    // Stop reading immediately. Without this the source keeps producing while
    // we tear down, and the "bounded" queue would still grow during teardown.
    options.from.pause();
    options.onOverflow();
  };

  const drain = () => {
    if (draining || saturated) return;
    draining = true;
    for (;;) {
      const frame = queue.dequeue();
      if (!frame) break;
      // `write` returning false means the destination's buffer is full. Latch
      // that state until its `drain` event: without the latch, the next
      // incoming chunk would call drain() again and push one more frame — so
      // the backlog would migrate frame by frame out of our BOUNDED queue and
      // into Node's writable buffer, which has no ceiling at all. The queue
      // would then never overflow, no resync would ever be signalled, and the
      // memory leak this whole mechanism exists to prevent would be back.
      if (!options.to.write(frame.payload)) {
        saturated = true;
        break;
      }
    }
    draining = false;
  };

  const consume = (chunk: Buffer): void => {
    if (overflowSignalled) return;
    let payload = chunk;
    if (awaitingHandshake) {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const terminator = handshakeBuffer.indexOf(HEADER_TERMINATOR);
      if (terminator === -1) {
        if (handshakeBuffer.byteLength > MAX_HANDSHAKE_HEAD_BYTES) {
          options.onError(
            new Error("Upstream handshake response exceeded the proxy header limit."),
          );
        }
        return;
      }
      const headEnd = terminator + HEADER_TERMINATOR.byteLength;
      // Verbatim. The status line and every header — including the upstream's
      // `Sec-WebSocket-Extensions` answer and its `Sec-WebSocket-Accept` — reach
      // the browser exactly as sent, so the two endpoints negotiate directly.
      options.to.write(handshakeBuffer.subarray(0, headEnd));
      payload = handshakeBuffer.subarray(headEnd);
      handshakeBuffer = Buffer.alloc(0);
      awaitingHandshake = false;
      if (payload.byteLength === 0) return;
    }
    let frames;
    try {
      frames = splitter.push(payload);
    } catch (error) {
      if (error instanceof WsFrameSplitError) {
        // A frame we cannot delimit means we can no longer find frame
        // boundaries in this stream. Relaying further bytes would emit garbage
        // both endpoints would try to parse, so treat it as a resync.
        signalOverflow();
        return;
      }
      options.onError(error);
      return;
    }
    for (const frame of frames) {
      const result = queue.enqueue({
        // Only `expedited` (Ping/Pong) jumps the queue. A Close is `terminal`
        // and rides in the data lane: the peer stops processing the moment it
        // sees one, so a Close that overtook queued data would silently discard
        // it — on every slow-client disconnect, which is exactly when the queue
        // is deep. `isControl` deliberately does NOT decide this.
        priority: frame.relayIntent === "expedited" ? "control" : "data",
        payload: frame.bytes,
        byteLength: frame.bytes.byteLength,
      });
      if (!result.accepted) {
        signalOverflow();
        return;
      }
      // Report it as ENQUEUED, not as written: from here on the endpoints have
      // agreed on how this connection ends, and the proxy must not append a
      // terminal frame of its own even while this one is still draining.
      if (frame.relayIntent === "terminal") options.onTerminalFrame?.();
    }
    drain();
  };

  options.from.on("data", consume);
  options.to.on("drain", () => {
    saturated = false;
    drain();
  });
  options.from.on("error", options.onError);
  if (options.initialBytes && options.initialBytes.byteLength > 0) {
    consume(options.initialBytes);
  }
}

/**
 * Proxies a WebSocket upgrade to the environment's server.
 *
 * `head` is the bytes Node already read past the request headers. They are
 * replayed into the relay rather than discarded — dropping them silently loses
 * the first frames of a fast client.
 */
export function proxyEnvironmentWebSocket(
  deps: EnvironmentProxyDeps,
  request: Http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
): void {
  const resolution = resolveEnvironmentProxyUpstream({
    registry: deps.registry,
    requestTarget: request.url ?? "",
  });
  if (!resolution.ok) {
    clientSocket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const { upstream, target } = resolution;
  // Serialize BEFORE connecting. A request we cannot render faithfully is not
  // one to forward approximately, and refusing here costs the upstream not even
  // a TCP connection.
  let upgradeRequest: string;
  try {
    upgradeRequest = serializeUpgradeRequest({
      method: request.method ?? "GET",
      target,
      headers: request.headers,
      upstream,
    });
  } catch (error) {
    deps.onError?.("environment proxy refused a malformed upgrade request", error);
    clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const open = deps.connect ?? ((options) => Net.connect(options));
  const upstreamSocket = open({ host: upstream.host, port: upstream.port });

  /**
   * True once the upstream has relayed a Close of its own.
   *
   * A Close the remote sent carries meaning the proxy must not overwrite: 1000
   * says the session ended deliberately, and replacing it with the synthetic
   * "tunnel lost" code would send the client reattaching to a session that
   * finished normally. Destroying the upstream after relaying its Close fires
   * the `close` listener below, which is exactly where that overwrite happened.
   */
  let upstreamClosedGracefully = false;

  /**
   * True once a terminal frame has been written to the browser.
   *
   * Teardown is reachable from several directions at once — overflow destroys
   * the upstream, whose `close` then re-enters here — and a WebSocket peer must
   * see exactly ONE Close. A second frame contradicts the first, and the client
   * acts on whichever it happens to read last.
   */
  let terminated = false;

  const teardown = (code: number, reason: string) => {
    // Closing the browser side does NOT disturb the remote session: the remote
    // server owns the turn and its journal, and the client reattaches by
    // cursor. That durability is the reason for this architecture, so the proxy
    // must never interpret its own failure as a reason to stop the turn.
    if (!terminated && !upstreamClosedGracefully && !clientSocket.destroyed) {
      terminated = true;
      writeCloseFrame(clientSocket, code, reason);
    }
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };

  const fail = (message: string, cause: unknown) => {
    deps.onError?.(message, cause);
    teardown(WS_CLOSE_PROXY_TUNNEL_LOST, WS_CLOSE_PROXY_TUNNEL_LOST_REASON);
  };

  upstreamSocket.on("error", (error) => fail("environment proxy upstream socket failed", error));
  clientSocket.on("error", (error) => {
    deps.onError?.("environment proxy client socket failed", error);
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  });
  // Tunnel teardown from either end tears down only THIS proxy connection.
  upstreamSocket.on("close", () =>
    teardown(WS_CLOSE_PROXY_TUNNEL_LOST, WS_CLOSE_PROXY_TUNNEL_LOST_REASON),
  );
  clientSocket.on("close", () => {
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  });

  upstreamSocket.write(upgradeRequest);

  const onOverflow = () => {
    deps.onError?.(
      "environment proxy queue overflow; signalling resync",
      new Error(`environment ${upstream.environmentId}`),
    );
    teardown(WS_CLOSE_PROXY_RESYNC_REQUIRED, WS_CLOSE_PROXY_RESYNC_REASON);
  };

  // Frame-level flow control applies to the two directions independently: a
  // stalled browser must not throttle what the remote server is allowed to
  // produce, and vice versa.
  relayDirection({
    from: clientSocket,
    to: upstreamSocket,
    ...(deps.queueOptions ? { queueOptions: deps.queueOptions } : {}),
    // Node hands us any bytes it read past the upgrade request headers. A fast
    // client's first frames live here, so they go through the same relay rather
    // than being dropped.
    ...(head.byteLength > 0 ? { initialBytes: head } : {}),
    onOverflow,
    onError: (error) => fail("environment proxy client relay failed", error),
  });
  relayDirection({
    from: upstreamSocket,
    to: clientSocket,
    ...(deps.queueOptions ? { queueOptions: deps.queueOptions } : {}),
    // This direction opens with the upstream's 101 response, which is HTTP, not
    // a WebSocket frame. It is copied through verbatim — the
    // `Sec-WebSocket-Extensions` answer included — which is precisely what makes
    // permessage-deflate negotiate end to end through the proxy.
    expectHandshakeResponse: true,
    onOverflow,
    // The remote's own Close is authoritative and reaches the browser verbatim.
    // Recording it here stops the upstream `close` that follows from writing a
    // synthetic "tunnel lost" on top of a session that ended normally.
    onTerminalFrame: () => {
      upstreamClosedGracefully = true;
    },
    onError: (error) => fail("environment proxy upstream relay failed", error),
  });
}

/**
 * Wraps the local server's request/upgrade handlers so `/env/:envId/*` is
 * diverted to the proxy and everything else is passed through untouched.
 *
 * A WRAPPER rather than an extra listener on the server. Node calls every
 * registered listener, so adding one alongside the Effect handler would have
 * BOTH answer a proxied request — the local router would try to route
 * `/env/<id>/threads/...` as a local path (the SPA fallback happily serves
 * index.html for it) and race the proxy's response on the same socket. One
 * dispatch point makes "proxied or local, never both" structural.
 */
export type NodeRequestHandler = (
  request: Http.IncomingMessage,
  response: Http.ServerResponse,
) => void;
export type NodeUpgradeHandler = (
  request: Http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

export interface EnvironmentProxyDispatch {
  readonly handlesTarget: (requestTarget: string | undefined) => boolean;
  readonly wrapRequestHandler: (next: NodeRequestHandler) => NodeRequestHandler;
  readonly wrapUpgradeHandler: (next: NodeUpgradeHandler) => NodeUpgradeHandler;
}

const UPGRADE_REASON_PHRASES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  500: "Internal Server Error",
};

export function makeEnvironmentProxyDispatch(deps: EnvironmentProxyDeps): EnvironmentProxyDispatch {
  const handlesTarget = (requestTarget: string | undefined): boolean =>
    typeof requestTarget === "string" && isEnvironmentProxyRequestTarget(requestTarget);

  /**
   * Runs the LOCAL authorization gate before anything else happens.
   *
   * Diverting to the proxy skips the Effect router, and with it the auth and
   * trusted-origin checks every local route runs — while the proxy goes on to
   * attach the environment's provisioned credential. Without this call an
   * unauthenticated local caller is upgraded into an authenticated remote one.
   * It runs before the registry is consulted, so a denial reveals nothing about
   * which environments exist and reaches no upstream.
   *
   * Fail closed on a rejected promise: an authorizer that throws denies.
   */
  const authorized = async (
    request: Http.IncomingMessage,
    kind: "http" | "upgrade",
  ): Promise<
    { readonly allowed: true } | { readonly status: number; readonly message: string }
  > => {
    if (!deps.authorize) return { allowed: true };
    try {
      const decision = await deps.authorize({ request, kind });
      return decision.allowed
        ? { allowed: true }
        : { status: decision.status, message: decision.message };
    } catch (error) {
      deps.onError?.("environment proxy authorization failed", error);
      return { status: 500, message: "Internal Server Error" };
    }
  };

  return {
    handlesTarget,
    wrapRequestHandler: (next) => (request, response) => {
      if (!handlesTarget(request.url)) {
        next(request, response);
        return;
      }
      void authorized(request, "http").then((decision) => {
        // Authorization is async, so the client may have gone away in the
        // meantime. Writing to a destroyed response throws, and there is
        // nothing left to proxy for either.
        if (response.destroyed || response.writableEnded) return;
        if ("allowed" in decision) {
          proxyEnvironmentHttpRequest(deps, request, response);
          return;
        }
        respondPlain(response, decision.status, decision.message);
      });
    },
    wrapUpgradeHandler: (next) => (request, socket, head) => {
      if (!handlesTarget(request.url)) {
        next(request, socket, head);
        return;
      }
      // Pause first: bytes the client sends while authorization is in flight
      // must not be lost, and must not be relayed if it is denied. The relay
      // resumes the socket when it attaches its own `data` listener.
      socket.pause();
      void authorized(request, "upgrade").then((decision) => {
        if (socket.destroyed) return;
        if ("allowed" in decision) {
          socket.resume();
          proxyEnvironmentWebSocket(deps, request, socket, head);
          return;
        }
        // A fixed reason phrase, not the message: an upgrade has no body to
        // carry a detail, and the message may contain characters a status line
        // cannot (it is a sentence, not a token).
        socket.end(
          `HTTP/1.1 ${decision.status} ${UPGRADE_REASON_PHRASES[decision.status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      });
    },
  };
}
