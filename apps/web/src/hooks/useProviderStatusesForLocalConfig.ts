// FILE: useProviderStatusesForLocalConfig.ts
// Purpose: Normalize server provider health against local binary overrides for composer-like sends.
// Layer: Web hook
// Depends on: server config query, app settings, and provider availability normalization.

import type { ServerProviderStatus } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import { getCustomBinaryPathForProvider, useAppSettings } from "../appSettings";
import { normalizeProviderStatusForLocalConfig } from "../lib/providerAvailability";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";

const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];

export function useProviderStatusesForLocalConfig(): readonly ServerProviderStatus[] {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const disabledProviders = new Set(settings.disabledProviders);

  return (serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES)
    .map((status) =>
      normalizeProviderStatusForLocalConfig({
        provider: status.provider,
        status,
        customBinaryPath: getCustomBinaryPathForProvider(settings, status.provider),
        disabled: disabledProviders.has(status.provider),
      }),
    )
    .flatMap((status) => (status ? [status] : []));
}
