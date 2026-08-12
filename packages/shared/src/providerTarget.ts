import {
  DEFAULT_PROVIDER_PROFILE_ID,
  type ModelSelection,
  type ProviderKind,
  type ProviderProfileId,
  type ProviderTarget,
} from "@synara/contracts";

interface ProviderTargetSource {
  readonly provider: ProviderKind;
  readonly profileId?: ProviderProfileId | undefined;
}

export function defaultProviderTarget(provider: ProviderKind): ProviderTarget {
  return {
    provider,
    profileId: DEFAULT_PROVIDER_PROFILE_ID,
  };
}

export function providerTargetFromModelSelection(
  modelSelection: ModelSelection,
): ProviderTarget {
  return providerTargetFromSource(modelSelection);
}

export function providerTargetFromSource(source: ProviderTargetSource): ProviderTarget {
  return {
    provider: source.provider,
    profileId: source.profileId ?? DEFAULT_PROVIDER_PROFILE_ID,
  };
}

export function providerTargetsEqual(left: ProviderTarget, right: ProviderTarget): boolean {
  return left.provider === right.provider && left.profileId === right.profileId;
}
