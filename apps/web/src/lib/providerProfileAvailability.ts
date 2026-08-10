import {
  DEFAULT_PROVIDER_PROFILE_ID,
  type ProviderTarget,
} from "@synara/contracts";

export function unsupportedProviderProfileIssue(target: ProviderTarget): string | null {
  return target.profileId === DEFAULT_PROVIDER_PROFILE_ID
    ? null
    : `Provider profile '${target.profileId}' is not configured for provider '${target.provider}'.`;
}
