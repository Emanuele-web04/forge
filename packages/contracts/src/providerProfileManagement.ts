import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderProfileId } from "./providerProfile";

const PROVIDER_PROFILE_DISPLAY_NAME_MAX_LENGTH = 80;
const PROVIDER_ACCOUNT_EMAIL_MAX_LENGTH = 320;
const PROVIDER_ACCOUNT_PLAN_MAX_LENGTH = 80;
const PROVIDER_LOGIN_URL_MAX_LENGTH = 4_096;
const PROVIDER_LOGIN_USER_CODE_MAX_LENGTH = 256;
const ProviderAccountIsoInstant = Schema.String.check(
  Schema.makeFilter((value: string) => {
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  }),
);

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

export const CodexProviderAccountAuthMode = Schema.Literals([
  "api-key",
  "chatgpt",
  "amazon-bedrock",
  "other",
]);
export type CodexProviderAccountAuthMode = typeof CodexProviderAccountAuthMode.Type;

export const CodexProviderAccountStatus = Schema.Struct({
  target: CodexProviderTarget,
  authentication: Schema.Literals(["signed-in", "signed-out"]),
  requiresOpenaiAuth: Schema.Boolean,
  authMode: Schema.NullOr(CodexProviderAccountAuthMode),
  email: Schema.NullOr(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_ACCOUNT_EMAIL_MAX_LENGTH)),
  ),
  planType: Schema.NullOr(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_ACCOUNT_PLAN_MAX_LENGTH)),
  ),
  pendingLogin: Schema.NullOr(
    Schema.Struct({
      method: Schema.Literals(["browser", "device-code"]),
      expiresAt: ProviderAccountIsoInstant,
    }),
  ),
});
export type CodexProviderAccountStatus = typeof CodexProviderAccountStatus.Type;

const ProviderLoginHttpUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_LOGIN_URL_MAX_LENGTH),
).check(
  Schema.makeFilter((value: string) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }),
);

export const CodexProviderLoginMethod = Schema.Literals(["browser", "device-code"]);
export type CodexProviderLoginMethod = typeof CodexProviderLoginMethod.Type;

export const CodexProviderLoginChallenge = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("browser"),
    authUrl: ProviderLoginHttpUrl,
  }),
  Schema.Struct({
    method: Schema.Literal("device-code"),
    verificationUrl: ProviderLoginHttpUrl,
    userCode: TrimmedNonEmptyString.check(
      Schema.isMaxLength(PROVIDER_LOGIN_USER_CODE_MAX_LENGTH),
    ),
  }),
]);
export type CodexProviderLoginChallenge = typeof CodexProviderLoginChallenge.Type;

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

export const ProviderProfileAccountReadInput = Schema.Struct({
  target: CodexProviderTarget,
});
export type ProviderProfileAccountReadInput = typeof ProviderProfileAccountReadInput.Type;

export const ProviderProfileLoginStartInput = Schema.Struct({
  target: CodexProviderTarget,
  method: CodexProviderLoginMethod,
});
export type ProviderProfileLoginStartInput = typeof ProviderProfileLoginStartInput.Type;

export const ProviderProfileLoginStartResult = Schema.Struct({
  target: CodexProviderTarget,
  challenge: CodexProviderLoginChallenge,
  expiresAt: ProviderAccountIsoInstant,
});
export type ProviderProfileLoginStartResult = typeof ProviderProfileLoginStartResult.Type;

export const ProviderProfileLoginCancelInput = Schema.Struct({
  target: CodexProviderTarget,
});
export type ProviderProfileLoginCancelInput = typeof ProviderProfileLoginCancelInput.Type;

export const ProviderProfileLoginCancelResult = Schema.Struct({
  target: CodexProviderTarget,
  status: Schema.Literals(["canceled", "not-pending"]),
});
export type ProviderProfileLoginCancelResult = typeof ProviderProfileLoginCancelResult.Type;

export const ProviderProfileLogoutInput = Schema.Struct({
  target: CodexProviderTarget,
});
export type ProviderProfileLogoutInput = typeof ProviderProfileLogoutInput.Type;

export const ProviderProfileLogoutResult = Schema.Struct({
  target: CodexProviderTarget,
  account: CodexProviderAccountStatus,
});
export type ProviderProfileLogoutResult = typeof ProviderProfileLogoutResult.Type;
