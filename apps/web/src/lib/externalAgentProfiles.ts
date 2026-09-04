import type {
  AgentProfile,
  AgentProfileId,
  ExternalAgentProfileCreateInput,
  ExternalAgentProfileUpdateInput,
} from "@synara/contracts";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const externalAgentProfilesQueryKeys = {
  all: ["external-agent-profiles"] as const,
  list: () => ["external-agent-profiles", "list"] as const,
  detail: (profileId: AgentProfileId | null | undefined) =>
    ["external-agent-profiles", "detail", profileId ?? null] as const,
};

export function externalAgentProfilesQueryOptions() {
  return queryOptions({
    queryKey: externalAgentProfilesQueryKeys.list(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.listExternalAgentProfiles();
    },
    staleTime: 15_000,
  });
}

export function externalAgentProfileQueryOptions(profileId: AgentProfileId | null | undefined) {
  return queryOptions({
    queryKey: externalAgentProfilesQueryKeys.detail(profileId),
    enabled: profileId !== null && profileId !== undefined,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getExternalAgentProfile({ profileId: profileId! });
    },
    staleTime: 15_000,
  });
}

export function createExternalAgentProfileMutationOptions() {
  return mutationOptions({
    mutationKey: ["external-agent-profiles", "mutation", "create"],
    mutationFn: (input: ExternalAgentProfileCreateInput) => {
      const api = ensureNativeApi();
      return api.server.createExternalAgentProfile(input);
    },
  });
}

export function updateExternalAgentProfileMutationOptions() {
  return mutationOptions({
    mutationKey: ["external-agent-profiles", "mutation", "update"],
    mutationFn: (input: ExternalAgentProfileUpdateInput) => {
      const api = ensureNativeApi();
      return api.server.updateExternalAgentProfile(input);
    },
  });
}

export function tombstoneExternalAgentProfileMutationOptions() {
  return mutationOptions({
    mutationKey: ["external-agent-profiles", "mutation", "tombstone"],
    mutationFn: (profileId: AgentProfileId) => {
      const api = ensureNativeApi();
      return api.server.tombstoneExternalAgentProfile({ profileId });
    },
  });
}

/** Human-readable label for a profile: the display name of the current revision. */
export function externalAgentProfileDisplayName(
  profile: AgentProfile,
  currentRevisionDisplayName?: string | null | undefined,
): string {
  return currentRevisionDisplayName?.trim() || profile.name;
}

export function isExternalAgentProfileRemoved(profile: AgentProfile): boolean {
  return profile.status === "retired";
}
