import { Effect } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import type { Socket } from "effect/unstable/socket/Socket";
import { describe, expect, it } from "vitest";

import { hostRemoteWebSocketRouteLayer, registerHostRemoteSocketAcceptor } from "./httpRoute";

describe("host remote WebSocket route", () => {
  it("starts reading before an asynchronous acceptor settles", async () => {
    const received: string[] = [];
    let receiveInbound: (message: string | Uint8Array) => void = () => undefined;
    const socket = {
      run: () => Effect.void,
      runRaw: (handler: (message: string | Uint8Array) => unknown) =>
        Effect.sync(() => {
          receiveInbound = (message) => {
            handler(message);
          };
        }).pipe(Effect.andThen(Effect.sleep("10 millis"))),
      writer: Effect.succeed(() => Effect.void),
    } as unknown as Socket;
    const baseRequest = HttpServerRequest.fromWeb(new Request("http://localhost/ws/host"));
    const request = Object.create(baseRequest) as HttpServerRequest.HttpServerRequest;
    Object.defineProperty(request, "upgrade", { value: Effect.succeed(socket) });
    const unregister = registerHostRemoteSocketAcceptor((accepted) => {
      accepted.on("message", (message) => received.push(message.toString()));
      return new Promise<void>((resolve) => {
        queueMicrotask(() => {
          receiveInbound("first-frame");
          resolve();
        });
      });
    });

    try {
      const response = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* HttpRouter.toHttpEffect(hostRemoteWebSocketRouteLayer);
            return yield* app.pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            );
          }),
        ),
      );

      expect(response.status).toBe(204);
      expect(received).toEqual(["first-frame"]);
    } finally {
      unregister();
    }
  });
});
