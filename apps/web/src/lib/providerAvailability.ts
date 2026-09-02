import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";

export interface ProviderSendAvailability {
  readonly provider: ProviderKind;
  readonly status: ServerProviderStatus | null;
  readonly usable: boolean;
  readonly unavailableReason: string;
}

export type ProviderStatusRefresh = () => Promise<
  readonly ServerProviderStatus[] | null | undefined
>;

export function normalizeCustomBinaryPath(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeProviderStatusForLocalConfig(input: {
  provider: ProviderKind;
  status: ServerProviderStatus | null | undefined;
  customBinaryPath?: string | null | undefined;
  confirmedCustomBinaryPath?: string | null | undefined;
  disabled?: boolean | undefined;
}): ServerProviderStatus | null {
  const status = input.status ?? null;
  if (!status) {
    return null;
  }
  if (input.disabled) {
    return {
      provider: input.provider,
      status: "warning",
      available: false,
      authStatus: "unknown",
      checkedAt: status.checkedAt,
      message: "Provider is disabled in Synara settings.",
    };
  }

  const customBinaryPath = normalizeCustomBinaryPath(input.customBinaryPath);
  if (!customBinaryPath) {
    return status;
  }

  if (normalizeCustomBinaryPath(status.autoRuntimeModeBinaryPath) === customBinaryPath) {
    return status;
  }

  const {
    supportsAutoRuntimeMode: _staleAutoSupport,
    autoRuntimeModeBinaryPath: _staleAutoBinaryPath,
    ...statusWithoutStaleAutoCapability
  } = status;

  if (status.available || status.authStatus !== "unknown") {
    return statusWithoutStaleAutoCapability;
  }

  if (normalizeCustomBinaryPath(input.confirmedCustomBinaryPath) === customBinaryPath) {
    // Only the exact path used by a successful session can suppress the warning.
    return {
      provider: status.provider,
      available: true,
      status: "ready",
      authStatus: status.authStatus,
      checkedAt: status.checkedAt,
      ...(status.authType ? { authType: status.authType } : {}),
      ...(status.authLabel ? { authLabel: status.authLabel } : {}),
      ...(status.voiceTranscriptionAvailable !== undefined
        ? { voiceTranscriptionAvailable: status.voiceTranscriptionAvailable }
        : {}),
    };
  }

  return {
    ...statusWithoutStaleAutoCapability,
    available: true,
    status: "warning",
    message: `${PROVIDER_DISPLAY_NAMES[input.provider]} uses a custom local binary path in this app. Availability will be confirmed when you start a session.`,
  };
}

export function isProviderUsable(status: ServerProviderStatus | null | undefined): boolean {
  if (!status) {
    // Missing status means the health check has not confirmed an installed provider yet.
    return false;
  }
  return status.available && status.authStatus !== "unauthenticated";
}

export function providerUnavailableReason(status: ServerProviderStatus | null | undefined): string {
  if (!status) {
    return "Provider status is still loading.";
  }
  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  if (status.authStatus === "unauthenticated") {
    return `${providerLabel} is not authenticated yet.`;
  }
  if (!status.available) {
    return status.message ?? `${providerLabel} is unavailable right now.`;
  }
  return status.message ?? `${providerLabel} has limited availability right now.`;
}

export function findProviderStatus(
  statuses: readonly ServerProviderStatus[],
  provider: ProviderKind,
): ServerProviderStatus | null {
  return statuses.find((status) => status.provider === provider) ?? null;
}

export function resolveAvailableProviderPreference(input: {
  readonly preferredProvider: ProviderKind;
  readonly statuses: readonly ServerProviderStatus[];
  readonly providerOrder?: readonly ProviderKind[];
  readonly hiddenProviders?: readonly ProviderKind[];
}): ProviderKind {
  if (input.statuses.length === 0) {
    return input.preferredProvider;
  }

  const preferredStatus = findProviderStatus(input.statuses, input.preferredProvider);
  if (preferredStatus?.available) {
    return input.preferredProvider;
  }

  const hiddenProviders = new Set(input.hiddenProviders ?? []);
  const providerOrder = input.providerOrder ?? [];
  const orderedStatuses = input.statuses.toSorted((left, right) => {
    const leftIndex = providerOrder.indexOf(left.provider);
    const rightIndex = providerOrder.indexOf(right.provider);
    const normalizedLeft = leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER;
    const normalizedRight = rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER;
    return normalizedLeft - normalizedRight;
  });
  const visibleInstalled = orderedStatuses.filter(
    (status) => status.available && !hiddenProviders.has(status.provider),
  );
  const installed =
    visibleInstalled.length > 0
      ? visibleInstalled
      : orderedStatuses.filter((status) => status.available);

  return (
    installed.find((status) => status.authStatus !== "unauthenticated")?.provider ??
    installed[0]?.provider ??
    input.preferredProvider
  );
}

// Shared send gate used by chat, Kanban, shortcuts, and handoff flows.
export function resolveProviderSendAvailability(input: {
  readonly provider: ProviderKind;
  readonly statuses: readonly ServerProviderStatus[];
}): ProviderSendAvailability {
  const status = findProviderStatus(input.statuses, input.provider);
  return {
    provider: input.provider,
    status,
    usable: isProviderUsable(status),
    unavailableReason: providerUnavailableReason(status),
  };
}

function shouldRefreshBeforeBlocking(status: ServerProviderStatus | null): boolean {
  return !status || !status.available || status.authStatus === "unauthenticated";
}

// Re-check a blocked provider once before surfacing stale install/auth state to the user.
export async function resolveProviderSendAvailabilityWithRefresh(input: {
  readonly provider: ProviderKind;
  readonly statuses: readonly ServerProviderStatus[];
  readonly refreshStatuses: ProviderStatusRefresh;
}): Promise<ProviderSendAvailability> {
  const initial = resolveProviderSendAvailability(input);
  if (initial.usable || !shouldRefreshBeforeBlocking(initial.status)) {
    return initial;
  }

  let refreshedStatuses: readonly ServerProviderStatus[] | null | undefined;
  try {
    refreshedStatuses = await input.refreshStatuses();
  } catch {
    refreshedStatuses = null;
  }
  if (!refreshedStatuses) {
    return initial;
  }

  return resolveProviderSendAvailability({
    provider: input.provider,
    statuses: refreshedStatuses,
  });
}
