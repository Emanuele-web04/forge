// FILE: accountReactQuery.test.ts
// Purpose: Verifies the identity fences around account-scoped query caching —
// the per-user usage-summary key, and the status watcher that evicts
// account-scoped data when a status refetch reveals a different identity
// (an account switch performed by another client against the shared server).

import type { AccountStatus } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  accountQueryKeys,
  accountUsageSummaryQueryOptions,
  watchAccountIdentityChanges,
} from "./accountReactQuery";

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => {
    throw new Error("no RPC expected in these tests");
  },
}));

const signedIn = (userId: string): AccountStatus => ({
  state: "signed-in",
  me: {
    id: userId,
    name: "Ada Lovelace",
    email: "ada@example.com",
    organization: { id: "org_1", name: "Ada's Workspace" },
    profile: null,
  },
});

describe("accountUsageSummaryQueryOptions", () => {
  it("keys the usage summary by the authenticated user id", () => {
    const forA = accountUsageSummaryQueryOptions({ userId: "user_a" });
    const forB = accountUsageSummaryQueryOptions({ userId: "user_b" });

    expect(forA.queryKey).not.toEqual(forB.queryKey);
    expect(forA.queryKey).toContain("user_a");
    expect(forB.queryKey).toContain("user_b");
  });

  it("disables the query while signed out", () => {
    expect(accountUsageSummaryQueryOptions({ userId: null }).enabled).toBe(false);
    expect(accountUsageSummaryQueryOptions({ userId: "user_a" }).enabled).toBe(true);
    expect(accountUsageSummaryQueryOptions({ userId: "user_a", enabled: false }).enabled).toBe(
      false,
    );
  });
});

describe("watchAccountIdentityChanges", () => {
  const utcOffsetMinutes = 120;

  it("evicts account-scoped queries when a status write reveals a new identity", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));
    queryClient.setQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes), {
      lifetimeTokens: 42,
    });
    const unsubscribe = watchAccountIdentityChanges(queryClient);

    // Another client signed out A and signed in B; this client only sees the
    // result of its own status refetch landing in the cache.
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_b"));

    expect(
      queryClient.getQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes)),
    ).toBeUndefined();
    unsubscribe();
  });

  it("evicts account-scoped queries when a status refetch reveals a sign-out", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));
    queryClient.setQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes), {
      lifetimeTokens: 42,
    });
    const unsubscribe = watchAccountIdentityChanges(queryClient);

    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), { state: "signed-out" });

    expect(
      queryClient.getQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes)),
    ).toBeUndefined();
    unsubscribe();
  });

  it("keeps account-scoped queries across same-identity status refreshes", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));
    queryClient.setQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes), {
      lifetimeTokens: 42,
    });
    const unsubscribe = watchAccountIdentityChanges(queryClient);

    // Routine refetches (token refresh, window focus) answer the same user.
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));

    expect(
      queryClient.getQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes)),
    ).toEqual({ lifetimeTokens: 42 });
    unsubscribe();
  });

  it("ignores writes to unrelated query keys", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));
    queryClient.setQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes), {
      lifetimeTokens: 42,
    });
    const unsubscribe = watchAccountIdentityChanges(queryClient);

    queryClient.setQueryData(["something", "else"], { whatever: true });

    expect(
      queryClient.getQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes)),
    ).toEqual({ lifetimeTokens: 42 });
    unsubscribe();
  });

  it("seeds from the cached identity so an unchanged status does not evict", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));
    const unsubscribe = watchAccountIdentityChanges(queryClient);
    queryClient.setQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes), {
      lifetimeTokens: 42,
    });

    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));

    expect(
      queryClient.getQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes)),
    ).toEqual({ lifetimeTokens: 42 });
    unsubscribe();
  });
});
