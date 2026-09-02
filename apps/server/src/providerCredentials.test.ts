import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderCredentials,
  resolveProviderServerPassword,
  type ProviderCredentialsShape,
} from "./providerCredentials";

describe("resolveProviderServerPassword", () => {
  it("reads ProviderCredentials from the Effect service context", async () => {
    const credentials: ProviderCredentialsShape = {
      getServerPassword: () => Effect.succeed("secret"),
      replaceServerPassword: () => Effect.void,
      isServerPasswordConfigured: () => Effect.succeed(true),
    };

    const password = await Effect.runPromise(
      resolveProviderServerPassword("opencode").pipe(
        Effect.provide(Layer.succeed(ProviderCredentials, credentials)),
      ),
    );

    expect(password).toBe("secret");
  });
});
