import { Schema } from "effect";
import {
  IsoDateTime,
  PositiveInt,
  ProcessEnvRecord,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const SupportedAccountProvider = Schema.Literals(["codex", "claudeAgent", "cursor", "grok"]);
export type SupportedAccountProvider = typeof SupportedAccountProvider.Type;

export const AccountSupportLevel = Schema.Literals([
  "supported",
  "beta",
  "experimental",
  "unsupported",
]);
export type AccountSupportLevel = typeof AccountSupportLevel.Type;

export const AccountBindingState = Schema.Literals([
  "not-configured",
  "connecting",
  "connected",
  "needs-auth",
  "needs-reverification",
  "unsupported",
]);
export type AccountBindingState = typeof AccountBindingState.Type;

export const BindingGeneration = PositiveInt;
export type BindingGeneration = typeof BindingGeneration.Type;

export const AccountOrdinal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export type AccountOrdinal = typeof AccountOrdinal.Type;

export const AccountSurface = Schema.Literals(["agent", "app"]);
export type AccountSurface = typeof AccountSurface.Type;

export const AgentAuthMethod = Schema.Literals(["oauth", "apiKey"]);
export type AgentAuthMethod = typeof AgentAuthMethod.Type;

export const IdentityVerification = Schema.Literals([
  "provider-verified",
  "user-confirmed",
  "unknown",
]);
export type IdentityVerification = typeof IdentityVerification.Type;

export const IdentitySummary = Schema.Struct({
  hint: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
});
export type IdentitySummary = typeof IdentitySummary.Type;

export const BindingIdentity = Schema.Struct({
  fingerprint: Schema.optional(TrimmedNonEmptyString),
  verification: IdentityVerification,
});
export type BindingIdentity = typeof BindingIdentity.Type;

export const AgentBinding = Schema.Struct({
  generation: BindingGeneration,
  state: AccountBindingState,
  authMethod: AgentAuthMethod,
  identityFingerprint: Schema.optional(TrimmedNonEmptyString),
});
export type AgentBinding = typeof AgentBinding.Type;

export const AppBinding = Schema.Struct({
  generation: BindingGeneration,
  state: AccountBindingState,
  authMethod: Schema.Literals(["oauth"]),
  supportLevel: AccountSupportLevel,
  identityFingerprint: Schema.optional(TrimmedNonEmptyString),
  lastVerifiedAppVersion: Schema.optional(TrimmedNonEmptyString),
  lastVerifiedAt: Schema.optional(IsoDateTime),
});
export type AppBinding = typeof AppBinding.Type;

export const ProviderAccountRecord = Schema.Struct({
  schemaVersion: Schema.Literals([1]),
  provider: SupportedAccountProvider,
  ordinal: AccountOrdinal,
  createdAt: IsoDateTime,
  identity: Schema.optional(
    Schema.Struct({
      hint: Schema.optional(TrimmedNonEmptyString),
      plan: Schema.optional(TrimmedNonEmptyString),
      verification: IdentityVerification,
    }),
  ),
  agent: Schema.optional(AgentBinding),
  app: Schema.optional(AppBinding),
});
export type ProviderAccountRecord = typeof ProviderAccountRecord.Type;

// Sanitized public view: no fingerprints, storage paths, or secrets.
export const ProviderAccountView = Schema.Struct({
  provider: SupportedAccountProvider,
  ordinal: AccountOrdinal,
  createdAt: IsoDateTime,
  identity: Schema.optional(IdentitySummary),
  agent: Schema.optional(
    Schema.Struct({
      generation: BindingGeneration,
      state: AccountBindingState,
      authMethod: AgentAuthMethod,
    }),
  ),
  app: Schema.optional(
    Schema.Struct({
      generation: BindingGeneration,
      state: AccountBindingState,
      supportLevel: AccountSupportLevel,
      lastVerifiedAppVersion: Schema.optional(TrimmedNonEmptyString),
      lastVerifiedAt: Schema.optional(IsoDateTime),
    }),
  ),
});
export type ProviderAccountView = typeof ProviderAccountView.Type;

export const ProviderAccountCapabilities = Schema.Struct({
  agent: Schema.Struct({
    oauth: AccountSupportLevel,
    apiKey: AccountSupportLevel,
  }),
  app: Schema.Struct({
    oauth: AccountSupportLevel,
    supportLevel: AccountSupportLevel,
  }),
});
export type ProviderAccountCapabilities = typeof ProviderAccountCapabilities.Type;

export const ResolveAccountLaunchInput = Schema.Struct({
  provider: SupportedAccountProvider,
  surface: AccountSurface,
  explicitOrdinal: Schema.optional(AccountOrdinal),
  threadBinding: Schema.optional(
    Schema.Struct({
      ordinal: AccountOrdinal,
      agentGeneration: BindingGeneration,
      principalFingerprint: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ResolveAccountLaunchInput = typeof ResolveAccountLaunchInput.Type;

export const ResolvedAccountLaunch = Schema.Struct({
  provider: SupportedAccountProvider,
  ordinal: AccountOrdinal,
  generation: BindingGeneration,
  surface: AccountSurface,
  environment: ProcessEnvRecord,
  profilePath: Schema.optional(TrimmedNonEmptyString),
  supportLevel: AccountSupportLevel,
});
export type ResolvedAccountLaunch = typeof ResolvedAccountLaunch.Type;

export const ProviderAccountLaunchContext = Schema.Struct({
  ordinal: AccountOrdinal,
  generation: BindingGeneration,
  profilePath: Schema.optional(TrimmedNonEmptyString),
  environment: ProcessEnvRecord,
});
export type ProviderAccountLaunchContext = typeof ProviderAccountLaunchContext.Type;

export const AppProcessLease = Schema.Struct({
  provider: SupportedAccountProvider,
  ordinal: AccountOrdinal,
  appGeneration: BindingGeneration,
  pid: PositiveInt,
  processStartedAt: IsoDateTime,
  appVersion: Schema.optional(TrimmedNonEmptyString),
});
export type AppProcessLease = typeof AppProcessLease.Type;

export const ProviderAppLaunchPlan = Schema.Struct({
  provider: SupportedAccountProvider,
  ordinal: AccountOrdinal,
  appGeneration: BindingGeneration,
  executable: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  environment: ProcessEnvRecord,
  supportLevel: AccountSupportLevel,
  expectedAppVersion: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAppLaunchPlan = typeof ProviderAppLaunchPlan.Type;

// RPC surface

export const PROVIDER_ACCOUNTS_WS_METHODS = {
  getSnapshot: "providerAccounts.getSnapshot",
  beginConnect: "providerAccounts.beginConnect",
  getConnectStatus: "providerAccounts.getConnectStatus",
  cancelConnect: "providerAccounts.cancelConnect",
  setActive: "providerAccounts.setActive",
  disconnectBinding: "providerAccounts.disconnectBinding",
  hide: "providerAccounts.hide",
  launch: "providerAccounts.launch",
  getIntegrationStatus: "providerAccounts.getIntegrationStatus",
  updateCliIntegration: "providerAccounts.updateCliIntegration",
  getDoctorReport: "providerAccounts.getDoctorReport",
  getThreadBinding: "providerAccounts.getThreadBinding",
} as const;

export const ProviderAccountsSnapshot = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      provider: SupportedAccountProvider,
      activeOrdinal: AccountOrdinal,
      accounts: Schema.Array(ProviderAccountView),
      capabilities: ProviderAccountCapabilities,
    }),
  ),
});
export type ProviderAccountsSnapshot = typeof ProviderAccountsSnapshot.Type;

// Discriminated union: only meaningful surface/auth combinations are
// representable. The server additionally validates provider capability
// support before creating an operation.
export const ProviderAccountsAgentOauthConnect = Schema.Struct({
  kind: Schema.Literals(["agent-oauth"]),
  provider: SupportedAccountProvider,
  ordinal: Schema.optional(AccountOrdinal),
});
export type ProviderAccountsAgentOauthConnect = typeof ProviderAccountsAgentOauthConnect.Type;

export const ProviderAccountsAgentApiKeyConnect = Schema.Struct({
  kind: Schema.Literals(["agent-api-key"]),
  provider: SupportedAccountProvider,
  ordinal: Schema.optional(AccountOrdinal),
  // Write-only input: the server must never echo this value back.
  apiKey: TrimmedNonEmptyString,
});
export type ProviderAccountsAgentApiKeyConnect = typeof ProviderAccountsAgentApiKeyConnect.Type;

export const ProviderAccountsAppOauthConnect = Schema.Struct({
  kind: Schema.Literals(["app-oauth"]),
  provider: SupportedAccountProvider,
  ordinal: Schema.optional(AccountOrdinal),
});
export type ProviderAccountsAppOauthConnect = typeof ProviderAccountsAppOauthConnect.Type;

export const ProviderAccountsBeginConnectInput = Schema.Union([
  ProviderAccountsAgentOauthConnect,
  ProviderAccountsAgentApiKeyConnect,
  ProviderAccountsAppOauthConnect,
]);
export type ProviderAccountsBeginConnectInput = typeof ProviderAccountsBeginConnectInput.Type;

export const ProviderAccountsBeginConnectResult = Schema.Struct({
  operationId: TrimmedNonEmptyString,
});
export type ProviderAccountsBeginConnectResult = typeof ProviderAccountsBeginConnectResult.Type;

export const ProviderAccountsConnectStatus = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  state: Schema.Literals(["pending", "waiting-for-user", "succeeded", "failed", "cancelled"]),
  provider: SupportedAccountProvider,
  surface: AccountSurface,
  ordinal: Schema.optional(AccountOrdinal),
  verificationUrl: Schema.optional(TrimmedNonEmptyString),
  userCode: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAccountsConnectStatus = typeof ProviderAccountsConnectStatus.Type;

export const ProviderAccountsOperationInput = Schema.Struct({
  operationId: TrimmedNonEmptyString,
});
export type ProviderAccountsOperationInput = typeof ProviderAccountsOperationInput.Type;

export const ProviderAccountsSetActiveInput = Schema.Struct({
  provider: SupportedAccountProvider,
  ordinal: AccountOrdinal,
});
export type ProviderAccountsSetActiveInput = typeof ProviderAccountsSetActiveInput.Type;

export const ProviderAccountsDisconnectBindingInput = Schema.Struct({
  provider: SupportedAccountProvider,
  ordinal: AccountOrdinal,
  surface: AccountSurface,
});
export type ProviderAccountsDisconnectBindingInput =
  typeof ProviderAccountsDisconnectBindingInput.Type;

export const ProviderAccountsHideInput = Schema.Struct({
  provider: SupportedAccountProvider,
  ordinal: AccountOrdinal,
});
export type ProviderAccountsHideInput = typeof ProviderAccountsHideInput.Type;

export const ProviderAccountsLaunchInput = Schema.Struct({
  provider: SupportedAccountProvider,
  surface: AccountSurface,
  ordinal: Schema.optional(AccountOrdinal),
});
export type ProviderAccountsLaunchInput = typeof ProviderAccountsLaunchInput.Type;

export const ProviderAccountsLaunchResult = Schema.Struct({
  launched: Schema.Boolean,
  ordinal: AccountOrdinal,
  supportLevel: AccountSupportLevel,
});
export type ProviderAccountsLaunchResult = typeof ProviderAccountsLaunchResult.Type;

export const ProviderAccountsIntegrationStatus = Schema.Struct({
  cliIntegrationEnabled: Schema.Boolean,
  launcherInstalled: Schema.Boolean,
  launcherVersion: Schema.optional(TrimmedNonEmptyString),
  shimDir: TrimmedNonEmptyString,
  shimDirOnPath: Schema.Boolean,
  launcherEntryExists: Schema.Boolean,
  platformSupported: Schema.Boolean,
});
export type ProviderAccountsIntegrationStatus = typeof ProviderAccountsIntegrationStatus.Type;

export const ProviderAccountsUpdateCliIntegrationInput = Schema.Struct({
  enabled: Schema.Boolean,
});
export type ProviderAccountsUpdateCliIntegrationInput =
  typeof ProviderAccountsUpdateCliIntegrationInput.Type;

export const ProviderAccountsDoctorReport = Schema.Struct({
  generatedAt: IsoDateTime,
  checks: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      label: TrimmedNonEmptyString,
      status: Schema.Literals(["ok", "warning", "error"]),
      detail: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ProviderAccountsDoctorReport = typeof ProviderAccountsDoctorReport.Type;

export const ProviderAccountsGetThreadBindingInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderAccountsGetThreadBindingInput =
  typeof ProviderAccountsGetThreadBindingInput.Type;

export const ProviderAccountsThreadBinding = Schema.Struct({
  binding: Schema.optional(
    Schema.Struct({
      provider: SupportedAccountProvider,
      ordinal: AccountOrdinal,
      agentGeneration: BindingGeneration,
    }),
  ),
});
export type ProviderAccountsThreadBinding = typeof ProviderAccountsThreadBinding.Type;
