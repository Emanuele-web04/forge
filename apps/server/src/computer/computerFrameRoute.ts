/** Still-image computer frame WebSocket route. */
import {
  COMPUTER_FRAME_RESYNC_MESSAGE,
  COMPUTER_FRAME_WS_COMPUTER_ID_PARAM,
  COMPUTER_FRAME_WS_PATH,
} from "@synara/shared/computerFrame";
import {
  decodeFrameResyncRequest,
  makeFrameSink,
  type FrameSink,
} from "@synara/shared/frameTransport";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ComputerService } from "./Services/ComputerService.ts";

const MAX_CLIENT_MESSAGE_BYTES = 1_024;

export function decodeResyncRequest(message: string | Uint8Array): "resync" | null {
  return decodeFrameResyncRequest(message, COMPUTER_FRAME_RESYNC_MESSAGE, MAX_CLIENT_MESSAGE_BYTES);
}

export function makeComputerFrameSink(options: {
  readonly send: (bytes: Uint8Array) => Promise<void> | void;
  readonly isOpen: () => boolean;
}): FrameSink {
  return makeFrameSink(options);
}

export function makeComputerFrameRouteLayer<R = never>(options: {
  readonly authorizeUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<boolean, never, R>;
}) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        COMPUTER_FRAME_WS_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const computerService = yield* Effect.serviceOption(ComputerService);
          if (computerService._tag === "None" || !computerService.value.supported) {
            return HttpServerResponse.text("Computer streaming is unavailable", { status: 404 });
          }
          const url = HttpServerRequest.toURL(request);
          const requestedComputerId = url?.searchParams
            .get(COMPUTER_FRAME_WS_COMPUTER_ID_PARAM)
            ?.trim();
          if (!requestedComputerId) {
            return HttpServerResponse.text("Missing computerId", { status: 400 });
          }
          if (requestedComputerId !== computerService.value.manager.computerId) {
            return HttpServerResponse.text("Unknown computer", { status: 404 });
          }
          if (!(yield* options.authorizeUpgrade(request))) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }

          const socket = yield* request.upgrade;
          const writer = yield* socket.writer;
          let open = true;
          const sink = makeComputerFrameSink({
            send: (bytes) => Effect.runPromise(writer(bytes)).catch(() => undefined),
            isOpen: () => open,
          });
          const unsubscribe = computerService.value.manager.subscribeFrames(sink);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              open = false;
              unsubscribe();
            }),
          );
          yield* socket.run((message) => {
            if (decodeResyncRequest(message) === null) return;
            Effect.runFork(
              Effect.promise(() =>
                computerService.value.manager.requestKeyframe().catch(() => undefined),
              ),
            );
          });
          return HttpServerResponse.empty();
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logDebug("computer frame socket closed", { cause: String(cause) }),
              HttpServerResponse.empty(),
            ),
          ),
        ),
      );
    }),
  );
}
