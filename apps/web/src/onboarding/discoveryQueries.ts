import type { ExternalSessionProvider } from "@synara/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";

const DISCOVERY_STALE_TIME_MS = 30_000;
const EXTERNAL_SESSIONS_PAGE_SIZE = 200;

export const onboardingQueryKeys = {
  externalSessions: (provider: ExternalSessionProvider) =>
    ["onboarding", "external-sessions", provider] as const,
  projectCandidates: () => ["onboarding", "project-candidates"] as const,
};

export function externalSessionsQueryOptions(provider: ExternalSessionProvider) {
  return queryOptions({
    queryKey: onboardingQueryKeys.externalSessions(provider),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.listExternalSessions({
        provider,
        limit: EXTERNAL_SESSIONS_PAGE_SIZE,
      });
    },
    staleTime: DISCOVERY_STALE_TIME_MS,
  });
}

export function projectCandidatesQueryOptions() {
  return queryOptions({
    queryKey: onboardingQueryKeys.projectCandidates(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.listExternalProjectCandidates({});
    },
    staleTime: DISCOVERY_STALE_TIME_MS,
  });
}

export function isExternalSessionDiscoveryProvider(
  provider: string,
): provider is ExternalSessionProvider {
  return provider === "claudeAgent" || provider === "codex";
}
