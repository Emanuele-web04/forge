// FILE: accountReactQuery.ts
// Purpose: React Query options and invalidation for the Synara account session.
// Layer: Web data-fetching (see serverReactQuery.ts for the conventions).

import type { AccountStatus, UsageSummary } from "@synara/contracts";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const accountQueryKeys = {
  all: ["account"] as const,
  status: () => ["account", "status"] as const,
  /** Prefix of every usageSummary key, whatever the caller's UTC offset. */
  usageSummaryAll: () => ["account", "usageSummary"] as const,
  usageSummary: (utcOffsetMinutes: number) =>
    ["account", "usageSummary", utcOffsetMinutes] as const,
};

/**
 * The account session for this machine. The server refreshes tokens as part of
 * answering, so the result is authoritative; it changes only through the
 * mutations in useAccount (which invalidate) or a sign-in finishing in another
 * client, which `refetchOnReconnect`/window focus picks up.
 */
export function accountStatusQueryOptions() {
  return queryOptions({
    queryKey: accountQueryKeys.status(),
    queryFn: async (): Promise<AccountStatus> => {
      const api = ensureNativeApi();
      return api.account.status();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 1,
  });
}

/**
 * The account-wide usage summary — the "Account" side of the profile panel's
 * device/account toggle. The client passes its own fixed UTC offset so the
 * service buckets days/hours to the caller's LOCAL day, exactly like the
 * local profile-stats RPCs (see serverProfileStatsQueryOptions).
 */
export function accountUsageSummaryQueryOptions(input: { enabled?: boolean } = {}) {
  const utcOffsetMinutes = -new Date().getTimezoneOffset();
  return queryOptions({
    queryKey: accountQueryKeys.usageSummary(utcOffsetMinutes),
    enabled: input.enabled ?? true,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async (): Promise<UsageSummary> => {
      const api = ensureNativeApi();
      return api.account.usageSummary({ utcOffsetMinutes });
    },
  });
}

/**
 * Re-reads the session after anything that could have changed it: a finished
 * sign-in/out, an onboarding write, or a WebSocket reopen (a completeSso cut
 * off by a dropped socket still persisted credentials server-side, and this is
 * how the UI recovers that result).
 */
export async function invalidateAccountStatus(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: accountQueryKeys.status() });
}

/**
 * Removes every cached account-scoped answer (the usage summary today). The
 * cache key carries no user identity — only the UTC offset — so data cached
 * for one signed-in user would otherwise render for the NEXT one: a fresh
 * sign-in (or the signed-out state after sign-out) must never show the
 * previous user's usage, which includes private skill names. Removal, not
 * invalidation: invalidation keeps the stale data renderable and merely
 * refetches, and while signed out there is nothing to refetch at all.
 */
export function removeAccountScopedQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: accountQueryKeys.usageSummaryAll() });
}

/**
 * Fences a status-changing account mutation against the status query. An
 * `account.status` fetch already in flight when the mutation starts would
 * otherwise resolve afterwards and overwrite the mutation's newer cache write
 * with pre-mutation state — so the in-flight query is cancelled up front
 * (its late result is discarded), and after settlement the status is
 * invalidated so the next active read refetches the authoritative answer.
 */
export async function cancelAccountStatusFetches(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ queryKey: accountQueryKeys.status() });
}
