import type { ServerAuthDescriptor } from "@synara/contracts";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config";
import { isRemoteReachableDeployment } from "../../remoteAccessPolicy";
import { ServerAuthPolicy, type ServerAuthPolicyShape } from "../Services/ServerAuthPolicy";
import { resolveSessionCookieName } from "../utils";

export const makeServerAuthPolicy = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const remoteReachable = isRemoteReachableDeployment(config);

  const policy: ServerAuthDescriptor["policy"] =
    config.mode === "desktop"
      ? remoteReachable
        ? "remote-reachable"
        : "desktop-managed-local"
      : remoteReachable
        ? "remote-reachable"
        : "loopback-browser";

  const bootstrapMethods: ServerAuthDescriptor["bootstrapMethods"] =
    policy === "desktop-managed-local"
      ? ["desktop-bootstrap"]
      : config.mode === "desktop" && policy === "remote-reachable"
        ? ["desktop-bootstrap", "one-time-token"]
        : ["one-time-token"];

  const descriptor: ServerAuthDescriptor = {
    policy,
    bootstrapMethods,
    sessionMethods: ["browser-session-cookie", "bearer-session-token"],
    sessionCookieName: resolveSessionCookieName({
      mode: config.mode,
      port: config.port,
    }),
  };

  return {
    getDescriptor: () => Effect.succeed(descriptor),
  } satisfies ServerAuthPolicyShape;
});

export const ServerAuthPolicyLive = Layer.effect(ServerAuthPolicy, makeServerAuthPolicy);
