import {
  DEFAULT_PROVIDER_PROFILE_ID,
  type ProviderTarget,
} from "@synara/contracts";
import { Effect } from "effect";

import { ProviderValidationError } from "./Errors.ts";

export interface ProviderProfileResolutionInput {
  readonly operation: string;
  readonly target: ProviderTarget;
}

export type ResolveProviderProfile = (
  input: ProviderProfileResolutionInput,
) => Effect.Effect<ProviderTarget, ProviderValidationError>;

export const resolveDefaultProviderProfile: ResolveProviderProfile = ({ operation, target }) =>
  target.profileId === DEFAULT_PROVIDER_PROFILE_ID
    ? Effect.succeed(target)
    : Effect.fail(
        new ProviderValidationError({
          operation,
          issue: `Provider profile '${target.profileId}' is not configured for provider '${target.provider}'.`,
        }),
      );
