import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

export const ManagedProviderAccountProvider = Schema.Literals(["codex", "claudeAgent"]);
export type ManagedProviderAccountProvider = typeof ManagedProviderAccountProvider.Type;

export const ProviderAccountAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "authenticating",
  "unknown",
  "error",
]);
export type ProviderAccountAuthStatus = typeof ProviderAccountAuthStatus.Type;

export const ProviderAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: ManagedProviderAccountProvider,
  kind: Schema.Literals(["system", "managed"]),
  label: TrimmedNonEmptyString,
  active: Schema.Boolean,
  authStatus: ProviderAccountAuthStatus,
  authLabel: Schema.optional(TrimmedNonEmptyString),
  createdAt: Schema.optional(IsoDateTime),
  lastAuthenticatedAt: Schema.optional(IsoDateTime),
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAccount = typeof ProviderAccount.Type;

export const ProviderAccountCollection = Schema.Struct({
  provider: ManagedProviderAccountProvider,
  accounts: Schema.Array(ProviderAccount),
});
export type ProviderAccountCollection = typeof ProviderAccountCollection.Type;

export const ServerListProviderAccountsResult = Schema.Struct({
  providers: Schema.Array(ProviderAccountCollection),
});
export type ServerListProviderAccountsResult = typeof ServerListProviderAccountsResult.Type;

export const ServerCreateProviderAccountInput = Schema.Struct({
  provider: ManagedProviderAccountProvider,
  label: Schema.optional(TrimmedNonEmptyString),
});
export type ServerCreateProviderAccountInput = typeof ServerCreateProviderAccountInput.Type;

export const ServerProviderAccountMutationResult = ProviderAccountCollection;
export type ServerProviderAccountMutationResult = typeof ServerProviderAccountMutationResult.Type;

export const ServerSetActiveProviderAccountInput = Schema.Struct({
  provider: ManagedProviderAccountProvider,
  accountId: TrimmedNonEmptyString,
});
export type ServerSetActiveProviderAccountInput = typeof ServerSetActiveProviderAccountInput.Type;

export const ServerProviderAccountInput = Schema.Struct({
  provider: ManagedProviderAccountProvider,
  accountId: TrimmedNonEmptyString,
});
export type ServerProviderAccountInput = typeof ServerProviderAccountInput.Type;
