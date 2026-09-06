import type {
  AccountBindingState,
  AccountOrdinal,
  AccountSupportLevel,
  ProviderAccountsBeginConnectInput,
  ProviderAccountsDisconnectBindingInput,
  ProviderAccountsHideInput,
  ProviderAccountsLaunchInput,
  ProviderAccountsSetActiveInput,
  ProviderAccountsSnapshot,
  ProviderAccountView,
  SupportedAccountProvider,
  ThreadId,
} from "@synara/contracts";
import {
  PROVIDER_DISPLAY_NAMES,
  SupportedAccountProvider as SupportedAccountProviderSchema,
} from "@synara/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi } from "~/nativeApi";

function accountMutationErrorToast(title: string) {
  return (error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : undefined,
    });
  };
}

export const providerAccountsQueryKeys = {
  all: ["provider-accounts"] as const,
  snapshot: () => ["provider-accounts", "snapshot"] as const,
  connectStatus: (operationId: string) =>
    ["provider-accounts", "connect-status", operationId] as const,
  integrationStatus: () => ["provider-accounts", "integration-status"] as const,
  doctorReport: () => ["provider-accounts", "doctor-report"] as const,
  threadBinding: (threadId: ThreadId) => ["provider-accounts", "thread-binding", threadId] as const,
};

export function providerAccountsSnapshotQueryOptions(input?: { enabled?: boolean }) {
  return queryOptions({
    queryKey: providerAccountsQueryKeys.snapshot(),
    queryFn: async () => ensureNativeApi().providerAccounts.getSnapshot(),
    enabled: input?.enabled ?? true,
    staleTime: 15_000,
    placeholderData: (previous) => previous,
  });
}

export function providerAccountsConnectStatusQueryOptions(input: {
  operationId: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerAccountsQueryKeys.connectStatus(input.operationId ?? "none"),
    queryFn: async () => {
      if (!input.operationId) {
        throw new Error("No connect operation in progress.");
      }
      return ensureNativeApi().providerAccounts.getConnectStatus({
        operationId: input.operationId,
      });
    },
    enabled: (input.enabled ?? true) && input.operationId !== null,
    // Poll while the operation is unresolved; stop once it reaches a terminal state.
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "pending" || state === "waiting-for-user" ? 2_000 : false;
    },
  });
}

export function providerAccountsIntegrationStatusQueryOptions(input?: { enabled?: boolean }) {
  return queryOptions({
    queryKey: providerAccountsQueryKeys.integrationStatus(),
    queryFn: async () => ensureNativeApi().providerAccounts.getIntegrationStatus(),
    enabled: input?.enabled ?? true,
    staleTime: 30_000,
  });
}

export function providerAccountsDoctorReportQueryOptions(input?: { enabled?: boolean }) {
  return queryOptions({
    queryKey: providerAccountsQueryKeys.doctorReport(),
    queryFn: async () => ensureNativeApi().providerAccounts.getDoctorReport(),
    enabled: input?.enabled ?? true,
    staleTime: 30_000,
  });
}

export function providerAccountsThreadBindingQueryOptions(input: {
  threadId: ThreadId | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerAccountsQueryKeys.threadBinding(input.threadId ?? ("" as ThreadId)),
    queryFn: async () => {
      if (!input.threadId) {
        throw new Error("Thread binding lookup requires a thread.");
      }
      return ensureNativeApi().providerAccounts.getThreadBinding({ threadId: input.threadId });
    },
    enabled: (input.enabled ?? true) && input.threadId !== null,
    staleTime: 30_000,
  });
}

function useInvalidateProviderAccounts() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: providerAccountsQueryKeys.all });
}

export function useProviderAccountsBeginConnect() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: ProviderAccountsBeginConnectInput) =>
      ensureNativeApi().providerAccounts.beginConnect(input),
    onSuccess: () => void invalidate(),
  });
}

export function useProviderAccountsCancelConnect() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: { operationId: string }) =>
      ensureNativeApi().providerAccounts.cancelConnect(input),
    onSettled: () => void invalidate(),
  });
}

export function useProviderAccountsSetActive() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: ProviderAccountsSetActiveInput) =>
      ensureNativeApi().providerAccounts.setActive(input),
    onSuccess: () => void invalidate(),
    onError: accountMutationErrorToast("Couldn't switch account"),
  });
}

export function useProviderAccountsDisconnectBinding() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: ProviderAccountsDisconnectBindingInput) =>
      ensureNativeApi().providerAccounts.disconnectBinding(input),
    onSuccess: () => void invalidate(),
    onError: accountMutationErrorToast("Couldn't disconnect account"),
  });
}

export function useProviderAccountsHide() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: ProviderAccountsHideInput) =>
      ensureNativeApi().providerAccounts.hide(input),
    onSuccess: () => void invalidate(),
    onError: accountMutationErrorToast("Couldn't hide account"),
  });
}

export function useProviderAccountsLaunch() {
  return useMutation({
    mutationFn: (input: ProviderAccountsLaunchInput) =>
      ensureNativeApi().providerAccounts.launch(input),
    onError: accountMutationErrorToast("Couldn't launch"),
  });
}

export function useProviderAccountsUpdateCliIntegration() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: { enabled: boolean }) =>
      ensureNativeApi().providerAccounts.updateCliIntegration(input),
    onSuccess: () => void invalidate(),
    onError: accountMutationErrorToast("Couldn't update CLI integration"),
  });
}

// ── Shared presentation helpers ─────────────────────────────────────────────

export const SUPPORTED_ACCOUNT_PROVIDERS: ReadonlyArray<SupportedAccountProvider> =
  SupportedAccountProviderSchema.literals;

export function accountProviderLabel(provider: SupportedAccountProvider): string {
  return PROVIDER_DISPLAY_NAMES[provider];
}

const CONNECT_PARAM_ALIASES: Record<string, SupportedAccountProvider> = {
  claude: "claudeAgent",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
};

/**
 * Resolves a `?connect=` deep-link value to a supported provider. Accepts the
 * raw provider kind (`claudeAgent`) plus friendly aliases with or without a
 * hyphenated agent suffix (`claude`, `claude-agent`, `cursor-agent`).
 */
export function normalizeConnectProviderParam(raw: string): SupportedAccountProvider | null {
  const direct = SUPPORTED_ACCOUNT_PROVIDERS.find((provider) => provider === raw);
  if (direct !== undefined) return direct;
  const compact = raw.toLowerCase().replace(/-/g, "");
  const base = compact.endsWith("agent") ? compact.slice(0, -"agent".length) : compact;
  return CONNECT_PARAM_ALIASES[base] ?? null;
}

/** Numbered slot label, e.g. "Codex 3"; ordinal 0 is your own unmanaged login. */
export function accountSlotLabel(
  provider: SupportedAccountProvider,
  ordinal: AccountOrdinal,
): string {
  return ordinal === 0
    ? `${accountProviderLabel(provider)} 0 (your login)`
    : `${accountProviderLabel(provider)} ${ordinal}`;
}

/** Where to create an API key for each provider, linked from the connect dialog. */
export const ACCOUNT_PROVIDER_API_KEY_DOCS: Record<SupportedAccountProvider, string> = {
  codex: "https://platform.openai.com/api-keys",
  claudeAgent: "https://console.anthropic.com/settings/keys",
  cursor: "https://cursor.com/settings",
  grok: "https://console.x.ai",
};

/** Short identity suffix distinguishing managed accounts, e.g. "API key ending -123" or "OAuth". */
export function accountIdentitySuffix(account: ProviderAccountView): string | null {
  if (account.ordinal === 0) return null;
  const identity = accountIdentityLabel(account.identity);
  if (identity !== null) return identity;
  if (account.agent?.authMethod === "apiKey") return "API key";
  if (account.agent?.authMethod === "oauth") return "OAuth";
  return null;
}

export const ACCOUNT_BINDING_STATE_LABELS: Record<AccountBindingState, string> = {
  "not-configured": "Not configured",
  connecting: "Connecting…",
  connected: "Connected",
  "needs-auth": "Needs sign-in",
  "needs-reverification": "Needs reverification",
  unsupported: "Unsupported",
};

export const ACCOUNT_SUPPORT_LEVEL_LABELS: Record<AccountSupportLevel, string> = {
  supported: "Supported",
  beta: "Beta",
  experimental: "Experimental",
  unsupported: "Unsupported",
};

/** "k••••@example.com · ChatGPT Plus" style identity line. */
export function accountIdentityLabel(identity?: {
  readonly hint?: string | undefined;
  readonly plan?: string | undefined;
}): string | null {
  if (!identity) return null;
  const parts = [identity.hint, identity.plan].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}
