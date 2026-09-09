/**
 * Resolve a provider adapter only while the provider is enabled in server settings.
 *
 * Voice entry points live on different transports, so this gate stays shared to
 * prevent either the WebSocket fallback or the primary HTTP upload path from
 * bypassing provider disablement.
 */
import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";
import { Effect } from "effect";

import type { ServerSettingsShape } from "../serverSettings";
import type { ProviderAdapterRegistryShape } from "./Services/ProviderAdapterRegistry";

export class ProviderDisabledError extends Error {
  readonly status = 409;
}

export function providerDisabledSettingsMessage(provider: ProviderKind): string {
  return `${PROVIDER_DISPLAY_NAMES[provider]} is disabled in Settings > Providers.`;
}

export function ensureProviderEnabled(provider: ProviderKind, serverSettings: ServerSettingsShape) {
  return serverSettings.getSettings.pipe(
    Effect.flatMap((settings) =>
      settings.providers[provider].enabled
        ? Effect.void
        : Effect.fail(new ProviderDisabledError(providerDisabledSettingsMessage(provider))),
    ),
  );
}

export function getEnabledProviderAdapter(
  provider: ProviderKind,
  serverSettings: ServerSettingsShape,
  providerAdapterRegistry: ProviderAdapterRegistryShape,
) {
  return ensureProviderEnabled(provider, serverSettings).pipe(
    Effect.andThen(providerAdapterRegistry.getByProvider(provider)),
  );
}
