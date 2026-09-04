import type { CapabilityEvidenceBadge, CapabilityEvidenceBadgeResult } from "@synara/contracts";
import { queryOptions } from "@tanstack/react-query";
import { externalAgentEvidenceNamespace } from "@synara/shared/capabilityEvidence";
import { ensureNativeApi } from "~/nativeApi";

export const capabilityEvidenceBadgeQueryKeys = {
  all: ["capability-evidence", "badge"] as const,
  profile: (profileId: string | null | undefined) =>
    ["capability-evidence", "badge", profileId ?? null] as const,
};

function queryBadge(input: CapabilityEvidenceBadge): Promise<CapabilityEvidenceBadgeResult> {
  return ensureNativeApi().server.queryCapabilityEvidenceBadge(input);
}

export function capabilityEvidenceBadgeQueryOptions(profileId: string | null | undefined) {
  return queryOptions({
    queryKey: capabilityEvidenceBadgeQueryKeys.profile(profileId),
    enabled: profileId !== null && profileId !== undefined,
    queryFn: async () => {
      if (profileId === null || profileId === undefined) {
        throw new Error("capability evidence badge requires a profile id");
      }
      return queryBadge({ namespace: externalAgentEvidenceNamespace(profileId) });
    },
    staleTime: 30_000,
  });
}
