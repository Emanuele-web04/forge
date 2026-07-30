import { createHash, timingSafeEqual } from "node:crypto";

import { Deferred, Effect } from "effect";

import type { ServerConfigShape } from "./config";
import { isLocalOnlyDeployment } from "./remoteAccessPolicy";

export const DESKTOP_SHUTDOWN_ROUTE_PATH = "/api/desktop/shutdown";

export interface ServerShutdownController {
  /** Completes the stop signal once. `true` identifies the first request. */
  readonly requestStop: Effect.Effect<boolean, never>;
  /** Completes when the server should leave its scoped runtime. */
  readonly stopSignal: Effect.Effect<void, never>;
}

export const makeServerShutdownController = Effect.fn(function* () {
  const stopRequested = yield* Deferred.make<void>();

  return {
    requestStop: Deferred.succeed(stopRequested, undefined),
    stopSignal: Deferred.await(stopRequested),
  } satisfies ServerShutdownController;
});

export type DesktopShutdownAuthorization =
  | { readonly authorized: true }
  | {
      readonly authorized: false;
      readonly reason: "unavailable" | "unauthorized";
      readonly status: 404 | 401;
    };

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Hash both values before comparing them so `timingSafeEqual` always receives
 * fixed-length buffers, even for malformed or attacker-controlled input.
 */
export function matchesDesktopShutdownToken(expected: string, presented: string): boolean {
  return timingSafeEqual(digestToken(expected), digestToken(presented));
}

export function isDesktopShutdownLoopbackPeer(remoteAddress: string | null | undefined): boolean {
  const normalized = remoteAddress?.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function readBearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization ?? "");
  return match?.[1];
}

/**
 * Keeps desktop shutdown authority separate from browser authentication. The
 * route is hidden unless both the configured deployment and the actual peer
 * are local-only; only then do credential failures return an authentication
 * response.
 */
export function authorizeDesktopShutdown(input: {
  readonly config: Pick<
    ServerConfigShape,
    "mode" | "host" | "publicUrl" | "allowInsecureRemote" | "desktopShutdownToken"
  >;
  readonly remoteAddress: string | null | undefined;
  readonly authorization: string | undefined;
}): DesktopShutdownAuthorization {
  const expectedToken = input.config.desktopShutdownToken;
  if (
    input.config.mode !== "desktop" ||
    !isLocalOnlyDeployment(input.config) ||
    !isDesktopShutdownLoopbackPeer(input.remoteAddress) ||
    !expectedToken?.trim()
  ) {
    return { authorized: false, reason: "unavailable", status: 404 };
  }

  const presentedToken = readBearerToken(input.authorization);
  if (!presentedToken || !matchesDesktopShutdownToken(expectedToken, presentedToken)) {
    return { authorized: false, reason: "unauthorized", status: 401 };
  }

  return { authorized: true };
}
