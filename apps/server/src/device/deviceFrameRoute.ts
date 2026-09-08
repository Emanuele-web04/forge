/**
 * Device frame WebSocket route.
 *
 * Encoded video gets its own upgrade path rather than sharing the JSON RPC
 * socket. Two reasons, both about not hurting the rest of the app:
 *
 * - Send-queue isolation. On one socket a video backlog sits ahead of RPC
 *   responses in the same queue; on its own connection it cannot.
 * - Compression. The RPC path negotiates per-message deflate; H.264 is already
 *   compressed, so running it through zlib would burn CPU for nothing. This
 *   path lands on the uncompressed WebSocket server (see
 *   `upgradePathAllowsCompression`).
 *
 * Backpressure lives in `DeviceFrameTransport`; this module only adapts an
 * Effect `Socket` into the transport's sink, tracking in-flight bytes itself
 * because the Effect socket exposes no `bufferedAmount`.
 *
 * @module device/deviceFrameRoute
 */
import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
} from "@synara/shared/deviceFrame";
import {
  decodeFrameResyncRequest,
  makeFrameSink,
  type FrameSink,
} from "@synara/shared/frameTransport";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { DeviceService } from "./Services/DeviceService.ts";
import type { DeviceFrameSink } from "./deviceFrameTransport.ts";

/** A resync request is a few dozen bytes; anything larger is not one. */
const MAX_CLIENT_MESSAGE_BYTES = 1_024;

/**
 * Parse a client message on the frame socket. Returns the request kind, or
 * null for anything unrecognized, which the caller ignores rather than
 * treating as a protocol error.
 */
export function decodeResyncRequest(message: string | Uint8Array): "resync" | null {
  return decodeFrameResyncRequest(message, DEVICE_FRAME_RESYNC_MESSAGE, MAX_CLIENT_MESSAGE_BYTES);
}

export interface DeviceFrameSocketWriter {
  readonly write: (bytes: Uint8Array) => void;
  readonly sink: FrameSink;
}

/**
 * Wrap a raw write function as a transport sink, accounting for bytes handed
 * to the socket but not yet acknowledged as flushed. The transport reads that
 * number to decide whether the client is keeping up.
 */
export function makeDeviceFrameSink(options: {
  readonly send: (bytes: Uint8Array) => Promise<void> | void;
  readonly isOpen: () => boolean;
}): DeviceFrameSink {
  return makeFrameSink(options);
}

/**
 * Mount `GET /ws/device-frames?udid=...`. Requests without a device, or on a
 * host with no device engine, are refused before the upgrade.
 */
export function makeDeviceFrameRouteLayer<R = never>(options: {
  /**
   * Same admission decision as the RPC upgrade. Passed in rather than imported
   * so this module does not depend on the auth stack, and so tests can mount
   * the route without one.
   */
  readonly authorizeUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<boolean, never, R>;
}) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        DEVICE_FRAME_WS_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const deviceService = yield* Effect.serviceOption(DeviceService);
          if (deviceService._tag === "None" || !deviceService.value.supported) {
            return HttpServerResponse.text("Device streaming is unavailable", { status: 404 });
          }
          const url = HttpServerRequest.toURL(request);
          const udid = url?.searchParams.get(DEVICE_FRAME_WS_UDID_PARAM)?.trim();
          if (!udid) {
            return HttpServerResponse.text("Missing udid", { status: 400 });
          }
          if (!(yield* options.authorizeUpgrade(request))) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }

          const socket = yield* request.upgrade;
          const writer = yield* socket.writer;
          let open = true;
          const sink = makeDeviceFrameSink({
            send: (bytes) => Effect.runPromise(writer(bytes)).catch(() => undefined),
            isOpen: () => open,
          });
          const unsubscribe = deviceService.value.manager.subscribeFrames(udid, sink);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              open = false;
              unsubscribe();
            }),
          );
          // The only thing a client may send is a resync request, when its
          // decoder hits a sequence gap or an error. Handled here rather than
          // as an RPC because it is a property of this stream, and because a
          // frozen canvas should not depend on a second socket being healthy.
          // Anything unrecognized is ignored: a stray message must not kill a
          // stream.
          yield* socket.run((message) => {
            if (decodeResyncRequest(message) === null) return;
            Effect.runFork(
              Effect.promise(() =>
                deviceService.value.manager.requestKeyframe(udid).catch(() => undefined),
              ),
            );
          });
          return HttpServerResponse.empty();
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logDebug("device frame socket closed", { cause: String(cause) }),
              HttpServerResponse.empty(),
            ),
          ),
        ),
      );
    }),
  );
}
