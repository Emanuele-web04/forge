import { EventEmitter } from "node:events";

import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { CloseEvent } from "effect/unstable/socket/Socket";
import type { RawData } from "ws";

import type { RelaySocket } from "../relayDial";

export const HOST_REMOTE_WS_PATH = "/ws/host";

type SocketAcceptor = (socket: RelaySocket) => Promise<void>;
let currentAcceptor: SocketAcceptor | undefined;

export function registerHostRemoteSocketAcceptor(acceptor: SocketAcceptor): () => void {
  currentAcceptor = acceptor;
  return () => {
    if (currentAcceptor === acceptor) currentAcceptor = undefined;
  };
}

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
    this.emit("message", data as RawData);
  }

  closed(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }
}

export const hostRemoteWebSocketRouteLayer = HttpRouter.add(
  "GET",
  HOST_REMOTE_WS_PATH,
  Effect.gen(function* () {
    const acceptor = currentAcceptor;
    if (!acceptor) return HttpServerResponse.text("Host is not linked", { status: 503 });
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    const writer = yield* socket.writer;
    const adapter = new EffectSocketAdapter(writer);
    // Calling the acceptor attaches the gateway's message listener
    // synchronously, but its Promise may settle on a later microtask. Start
    // the underlying read pump without awaiting that settlement: a peer may
    // send its first handshake frame as soon as the upgrade opens.
    const accepting = yield* Effect.try({
      try: () => acceptor(adapter),
      catch: (cause) => cause,
    });
    yield* Effect.raceFirst(
      socket.runRaw((message) => adapter.receive(message)),
      Effect.tryPromise(() => accepting).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.ensuring(Effect.sync(() => adapter.closed())));
    return HttpServerResponse.empty();
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty()))),
);
