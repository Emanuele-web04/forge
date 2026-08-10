import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderProfileId } from "./providerProfile";

const PROVIDER_PROFILE_DISPLAY_NAME_MAX_LENGTH = 80;

export const ProviderProfileDisplayName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_PROFILE_DISPLAY_NAME_MAX_LENGTH),
);
export type ProviderProfileDisplayName = typeof ProviderProfileDisplayName.Type;

export const CodexProviderTarget = Schema.Struct({
  provider: Schema.Literal("codex"),
  profileId: ProviderProfileId,
});
export type CodexProviderTarget = typeof CodexProviderTarget.Type;

export const CodexProviderProfileLifecycle = Schema.Literals(["active", "tombstoned"]);
export type CodexProviderProfileLifecycle = typeof CodexProviderProfileLifecycle.Type;

export const CodexProviderProfileStorageKind = Schema.Literals(["legacy-default", "managed"]);
export type CodexProviderProfileStorageKind = typeof CodexProviderProfileStorageKind.Type;

/** Browser-safe profile metadata. Internal storage keys and filesystem paths never cross RPC. */
export const CodexProviderProfileSummary = Schema.Struct({
  target: CodexProviderTarget,
  displayName: ProviderProfileDisplayName,
  // Administrative profile switch. Effective availability also requires the
  // snapshot's providerEnabled flag and an active lifecycle.
  enabled: Schema.Boolean,
  lifecycle: CodexProviderProfileLifecycle,
  storageKind: CodexProviderProfileStorageKind,
});
export type CodexProviderProfileSummary = typeof CodexProviderProfileSummary.Type;

export const ProviderProfilesSnapshot = Schema.Struct({
  // Global Codex switch from server settings, kept separate from each profile switch.
  providerEnabled: Schema.Boolean,
  profiles: Schema.Array(CodexProviderProfileSummary),
});
export type ProviderProfilesSnapshot = typeof ProviderProfilesSnapshot.Type;

export const ProviderProfilesListInput = Schema.Struct({
  provider: Schema.Literal("codex"),
});
export type ProviderProfilesListInput = typeof ProviderProfilesListInput.Type;

export const ProviderProfilesCreateInput = Schema.Struct({
  provider: Schema.Literal("codex"),
  displayName: ProviderProfileDisplayName,
});
export type ProviderProfilesCreateInput = typeof ProviderProfilesCreateInput.Type;

export const ProviderProfilesRenameInput = Schema.Struct({
  target: CodexProviderTarget,
  displayName: ProviderProfileDisplayName,
});
export type ProviderProfilesRenameInput = typeof ProviderProfilesRenameInput.Type;

export const ProviderProfilesSetEnabledInput = Schema.Struct({
  target: CodexProviderTarget,
  enabled: Schema.Boolean,
});
export type ProviderProfilesSetEnabledInput = typeof ProviderProfilesSetEnabledInput.Type;

export const ProviderProfilesTombstoneInput = Schema.Struct({
  target: CodexProviderTarget,
});
export type ProviderProfilesTombstoneInput = typeof ProviderProfilesTombstoneInput.Type;
