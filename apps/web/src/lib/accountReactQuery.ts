// FILE: accountReactQuery.ts
// Purpose: React Query options and invalidation for the Synara account session.
// Layer: Web data-fetching (see serverReactQuery.ts for the conventions).

import type { AccountStatus } from "@synara/contracts";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const accountQueryKeys = {
  all: ["account"] as const,
  status: () => ["account", "status"] as const,
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
 * Re-reads the session after anything that could have changed it: a finished
 * sign-in/out, an onboarding write, or a WebSocket reopen (a completeSso cut
 * off by a dropped socket still persisted credentials server-side, and this is
 * how the UI recovers that result).
 */
export async function invalidateAccountStatus(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: accountQueryKeys.status() });
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
