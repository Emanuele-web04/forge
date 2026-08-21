import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../../config";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy";

const makeLayer = (overrides: Partial<ServerConfigShape>) =>
  ServerAuthPolicyLive.pipe(
    Layer.provide(
      Layer.effect(
        ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          return { ...config, ...overrides } satisfies ServerConfigShape;
        }),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "synara-auth-policy-test-",
          }),
        ),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const getDescriptor = Effect.gen(function* () {
  const policy = yield* ServerAuthPolicy;
  return yield* policy.getDescriptor();
});

describe("ServerAuthPolicyLive", () => {
  it("uses desktop-managed-local policy for loopback desktop mode", async () => {
    const descriptor = await getDescriptor.pipe(
      Effect.provide(makeLayer({ mode: "desktop", host: "127.0.0.1", port: 3773 })),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(descriptor.policy).toBe("desktop-managed-local");
    expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap"]);
    expect(descriptor.sessionCookieName).toBe("synara_session_3773");
  });

  it("uses remote-reachable policy for wildcard desktop mode", async () => {
    const descriptor = await getDescriptor.pipe(
      Effect.provide(makeLayer({ mode: "desktop", host: "0.0.0.0" })),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(descriptor.policy).toBe("remote-reachable");
    expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap", "one-time-token"]);
  });

  it("uses remote-reachable policy for a loopback desktop behind a public URL", async () => {
    const descriptor = await getDescriptor.pipe(
      Effect.provide(
        makeLayer({
          mode: "desktop",
          host: "127.0.0.1",
          publicUrl: new URL("https://synara.example.ts.net"),
        }),
      ),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(descriptor.policy).toBe("remote-reachable");
    expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap", "one-time-token"]);
  });

  it("uses loopback-browser policy for loopback web mode", async () => {
    const descriptor = await getDescriptor.pipe(
      Effect.provide(makeLayer({ mode: "web", host: "localhost" })),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(descriptor.policy).toBe("loopback-browser");
    expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
    expect(descriptor.sessionCookieName).toBe("synara_session");
  });

  it("uses remote-reachable policy for non-loopback web mode", async () => {
    const descriptor = await getDescriptor.pipe(
      Effect.provide(makeLayer({ mode: "web", host: "192.168.1.50" })),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(descriptor.policy).toBe("remote-reachable");
    expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
  });
});
