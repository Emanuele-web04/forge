// FILE: useProviderUsageSummary.ts
// Purpose: Merge usage signals from thread activities, server-side local archives,
// and provider-specific snapshots into one UI-friendly summary.

import type {
  OrchestrationThread,
  ProviderKind,
  ServerGetProviderUsageSnapshotResult,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import {
  normalizeOpenUsageSnapshot,
  normalizeOpenUsageUsageLines,
  type OpenUsageUsageLine,
} from "~/lib/openUsageRateLimits";
import { openUsageProviderSnapshotQueryOptions } from "~/lib/openUsageReactQuery";
import {
  isProviderUsageSnapshotNonOk,
  normalizeServerProviderUsageLines,
  normalizeServerProviderUsageRateLimit,
} from "~/lib/providerUsageSnapshot";
import {
  deriveProviderUsageLearnMoreHref,
  deriveRateLimitLearnMoreHref,
  deriveAccountRateLimits,
  mergeProviderRateLimits,
  type ProviderRateLimit,
} from "~/lib/rateLimits";
import {
  serverAllProviderUsageQueryOptions,
  serverProviderUsageSnapshotQueryOptions,
} from "~/lib/serverReactQuery";

export interface ProviderUsageSummaryData {
  readonly learnMoreHref: string | null;
  readonly rateLimits: ReadonlyArray<ProviderRateLimit>;
  readonly usageLines: ReadonlyArray<OpenUsageUsageLine>;
  readonly usageNotice: string | undefined;
}

export function resolveProviderUsageSummary(input: {
  provider: ProviderKind | null;
  accountRateLimits: ReadonlyArray<ProviderRateLimit>;
  authoritativeLiveSnapshot: ServerGetProviderUsageSnapshotResult;
  localUsageSnapshot?: ServerGetProviderUsageSnapshotResult | undefined;
  openUsageSnapshot?: unknown;
}): ProviderUsageSummaryData {
  const blocksFallback = isProviderUsageSnapshotNonOk(input.authoritativeLiveSnapshot);
  if (blocksFallback) {
    return {
      learnMoreHref: deriveProviderUsageLearnMoreHref(input.provider),
      rateLimits: [],
      usageLines: [],
      usageNotice: undefined,
    };
  }

  const derivedRateLimits = input.accountRateLimits.filter((rateLimit) =>
    input.provider ? rateLimit.provider === input.provider : true,
  );
  const liveUsageRateLimit = normalizeServerProviderUsageRateLimit(input.authoritativeLiveSnapshot);
  const localUsageRateLimit = normalizeServerProviderUsageRateLimit(input.localUsageSnapshot);
  const openUsageRateLimit = normalizeOpenUsageSnapshot(input.openUsageSnapshot, input.provider);
  const rateLimits = mergeProviderRateLimits(
    derivedRateLimits,
    mergeProviderRateLimits(
      liveUsageRateLimit ? [liveUsageRateLimit] : [],
      mergeProviderRateLimits(
        localUsageRateLimit ? [localUsageRateLimit] : [],
        openUsageRateLimit ? [openUsageRateLimit] : [],
      ),
    ),
  );

  const liveUsageLines = normalizeServerProviderUsageLines(input.authoritativeLiveSnapshot);
  const localUsageLines = normalizeServerProviderUsageLines(input.localUsageSnapshot);
  const usageLines =
    liveUsageLines.length > 0
      ? liveUsageLines
      : localUsageLines.length > 0
        ? localUsageLines
        : normalizeOpenUsageUsageLines(input.openUsageSnapshot);
  const detail = input.authoritativeLiveSnapshot?.detail?.trim();

  return {
    learnMoreHref:
      deriveRateLimitLearnMoreHref(rateLimits) ?? deriveProviderUsageLearnMoreHref(input.provider),
    rateLimits,
    usageLines,
    usageNotice: detail ? detail : undefined,
  };
}

export function useProviderUsageSummary(input: {
  provider: ProviderKind | null | undefined;
  threads?: ReadonlyArray<Pick<OrchestrationThread, "activities">>;
  threadRateLimits?: ReadonlyArray<ProviderRateLimit> | undefined;
  codexHomePath?: string | null;
  providerSnapshot?: ServerGetProviderUsageSnapshotResult | undefined;
  fetchOpenUsageData?: boolean | undefined;
}) {
  const provider = input.provider ?? null;
  const shouldFetchLiveProviderUsage = provider !== null && input.providerSnapshot === undefined;
  const shouldFetchLocalProviderUsage = shouldFetchLiveProviderUsage;
  const allProviderUsageQuery = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled: shouldFetchLiveProviderUsage,
    }),
  );
  const localUsageSnapshotQuery = useQuery(
    serverProviderUsageSnapshotQueryOptions({
      provider,
      homePath: provider === "codex" ? input.codexHomePath || null : null,
      enabled: shouldFetchLocalProviderUsage,
    }),
  );
  const openUsageSnapshotQuery = useQuery(
    openUsageProviderSnapshotQueryOptions(provider, {
      enabled: input.fetchOpenUsageData ?? true,
    }),
  );
  const liveProviderSnapshot = (allProviderUsageQuery.data ?? []).find(
    (snapshot) => snapshot.provider === provider,
  );
  const authoritativeLiveSnapshot = liveProviderSnapshot ?? input.providerSnapshot ?? null;
  const accountRateLimits = input.threadRateLimits ?? deriveAccountRateLimits(input.threads ?? []);
  const summary = resolveProviderUsageSummary({
    provider,
    accountRateLimits,
    authoritativeLiveSnapshot,
    localUsageSnapshot: localUsageSnapshotQuery.data ?? null,
    openUsageSnapshot: openUsageSnapshotQuery.data,
  });

  const isLoading =
    shouldFetchLiveProviderUsage &&
    allProviderUsageQuery.isPending &&
    localUsageSnapshotQuery.isPending &&
    summary.rateLimits.length === 0 &&
    summary.usageLines.length === 0;

  return {
    isLoading,
    ...summary,
  } as const;
}
