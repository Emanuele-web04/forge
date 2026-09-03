// FILE: providerCredentials.ts
// Purpose: Owns server-only credentials used to connect to external provider servers.
// Layer: Server provider security boundary

import { Effect, Layer, ServiceMap } from "effect";

import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { ServerSecretStore, type SecretStoreError } from "./auth/Services/ServerSecretStore";

export type ExternalProviderServer = "opencode";

const secretName = (provider: ExternalProviderServer): string =>
  `provider-${provider}-server-password`;

export interface ProviderCredentialsShape {
  readonly getServerPassword: (
    provider: ExternalProviderServer,
  ) => Effect.Effect<string | null, SecretStoreError>;
  readonly replaceServerPassword: (
    provider: ExternalProviderServer,
    password: string | null,
  ) => Effect.Effect<void, SecretStoreError>;
  readonly isServerPasswordConfigured: (
    provider: ExternalProviderServer,
  ) => Effect.Effect<boolean, SecretStoreError>;
}

export class ProviderCredentials extends ServiceMap.Service<
  ProviderCredentials,
  ProviderCredentialsShape
>()("synara/providerCredentials/ProviderCredentials") {}

export const resolveProviderServerPassword = (provider: ExternalProviderServer) =>
  Effect.gen(function* () {
    const credentials = yield* ProviderCredentials;
    return (yield* credentials.getServerPassword(provider)) ?? undefined;
  }).pipe(Effect.orDie);

export const makeProviderServerPasswordResolver =
  (credentials: ProviderCredentialsShape) =>
  (provider: ExternalProviderServer): Effect.Effect<string | undefined> =>
    credentials.getServerPassword(provider).pipe(
      Effect.map((password) => password ?? undefined),
      Effect.orDie,
    );

const makeProviderCredentials = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const getServerPassword: ProviderCredentialsShape["getServerPassword"] = (provider) =>
    secrets.get(secretName(provider)).pipe(
      Effect.map((value) => {
        if (!value || value.byteLength === 0) return null;
        const password = decoder.decode(value);
        return password.length > 0 ? password : null;
      }),
    );

  const replaceServerPassword: ProviderCredentialsShape["replaceServerPassword"] = (
    provider,
    password,
  ) => {
    const normalized = password?.trim() ?? "";
    return normalized.length > 0
      ? secrets.set(secretName(provider), encoder.encode(normalized))
      : secrets.remove(secretName(provider));
  };

  const isServerPasswordConfigured: ProviderCredentialsShape["isServerPasswordConfigured"] = (
    provider,
  ) => getServerPassword(provider).pipe(Effect.map((password) => password !== null));

  return {
    getServerPassword,
    replaceServerPassword,
    isServerPasswordConfigured,
  } satisfies ProviderCredentialsShape;
});

export const ProviderCredentialsLive = Layer.effect(
  ProviderCredentials,
  makeProviderCredentials,
).pipe(Layer.provide(ServerSecretStoreLive));
