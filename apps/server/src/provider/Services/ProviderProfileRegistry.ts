import type {
  CodexProviderProfileSummary,
  CodexProviderTarget,
  ProviderProfilesCreateInput,
  ProviderProfilesListInput,
  ProviderProfilesRenameInput,
  ProviderProfilesSetEnabledInput,
  ProviderProfilesSnapshot,
  ProviderProfilesTombstoneInput,
} from "@synara/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CodexProviderLaunchContext } from "../codexProviderLaunchContext";

export type ProviderProfileRegistryErrorCode =
  | "PROVIDER_PROFILE_DEFAULT_IMMUTABLE"
  | "PROVIDER_PROFILE_AUTHENTICATION_UNBOUND"
  | "PROVIDER_PROFILE_DISABLED"
  | "PROVIDER_PROFILE_NAME_CONFLICT"
  | "PROVIDER_PROFILE_NOT_FOUND"
  | "PROVIDER_PROFILE_REGISTRY_INVALID"
  | "PROVIDER_PROFILE_STORAGE_ERROR"
  | "PROVIDER_PROFILE_TOMBSTONED";

export class ProviderProfileRegistryError extends Data.TaggedError(
  "ProviderProfileRegistryError",
)<{
  readonly code: ProviderProfileRegistryErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ResolvedCodexProviderProfile {
  readonly summary: CodexProviderProfileSummary;
  readonly providerEnabled: boolean;
  readonly launchContext: CodexProviderLaunchContext;
}

export interface ProviderProfileRegistryShape {
  readonly list: (
    input: ProviderProfilesListInput,
  ) => Effect.Effect<ProviderProfilesSnapshot, ProviderProfileRegistryError>;
  readonly create: (
    input: ProviderProfilesCreateInput,
  ) => Effect.Effect<ProviderProfilesSnapshot, ProviderProfileRegistryError>;
  readonly rename: (
    input: ProviderProfilesRenameInput,
  ) => Effect.Effect<ProviderProfilesSnapshot, ProviderProfileRegistryError>;
  readonly setEnabled: (
    input: ProviderProfilesSetEnabledInput,
  ) => Effect.Effect<ProviderProfilesSnapshot, ProviderProfileRegistryError>;
  readonly tombstone: (
    input: ProviderProfilesTombstoneInput,
  ) => Effect.Effect<ProviderProfilesSnapshot, ProviderProfileRegistryError>;
  readonly sealManagedAuthentication: (
    target: CodexProviderTarget,
  ) => Effect.Effect<void, ProviderProfileRegistryError>;
  /** Resolves active profile storage for login and other control-plane work. */
  readonly resolveForManagement: (
    target: CodexProviderTarget,
  ) => Effect.Effect<ResolvedCodexProviderProfile, ProviderProfileRegistryError>;
  /** Resolves a profile only when both global and per-profile execution switches permit it. */
  readonly resolveForRuntime: (
    target: CodexProviderTarget,
  ) => Effect.Effect<ResolvedCodexProviderProfile, ProviderProfileRegistryError>;
}

export class ProviderProfileRegistry extends ServiceMap.Service<
  ProviderProfileRegistry,
  ProviderProfileRegistryShape
>()("synara/provider/Services/ProviderProfileRegistry") {}
