// FILE: useAccount.ts
// Purpose: The account session as the web app consumes it — status query plus
// sign-in/out and profile mutations, each of which settles the status cache.
// Layer: Web account feature hook.

import type {
  AccountMe,
  AccountPasswordSignInInput,
  AccountStatus,
  AccountUpdateProfileInput,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accountQueryKeys, accountStatusQueryOptions } from "~/lib/accountReactQuery";
import { ensureNativeApi } from "~/nativeApi";

export function useAccount() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery(accountStatusQueryOptions());

  const setStatus = (status: AccountStatus) => {
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), status);
  };

  const signInWithPassword = useMutation({
    mutationFn: async (input: AccountPasswordSignInInput) => {
      const api = ensureNativeApi();
      return api.account.signInWithPassword(input);
    },
    onSuccess: setStatus,
  });

  const signUpWithPassword = useMutation({
    mutationFn: async (input: AccountPasswordSignInInput) => {
      const api = ensureNativeApi();
      return api.account.signUpWithPassword(input);
    },
    onSuccess: setStatus,
  });

  const beginSignIn = useMutation({
    mutationFn: async () => {
      const api = ensureNativeApi();
      return api.account.beginSignIn();
    },
  });

  // No RPC timeout: the server waits on the hosted page for as long as the
  // device code lives (the transport already binds `timeoutMs: null`, same as
  // provisionFromGitHub). If the socket drops mid-flight the credentials are
  // persisted server-side and the status query's refetch-on-reconnect recovers
  // the signed-in state.
  const completeSignIn = useMutation({
    mutationFn: async (input: { deviceCode: string; signal?: AbortSignal }) => {
      const api = ensureNativeApi();
      return api.account.completeSignIn(
        { deviceCode: input.deviceCode },
        input.signal ? { signal: input.signal } : undefined,
      );
    },
    onSuccess: setStatus,
  });

  const updateProfile = useMutation({
    mutationFn: async (input: AccountUpdateProfileInput) => {
      const api = ensureNativeApi();
      return api.account.updateProfile(input);
    },
    onSuccess: (me: AccountMe) => {
      setStatus({ state: "signed-in", me });
    },
  });

  const signOut = useMutation({
    mutationFn: async () => {
      const api = ensureNativeApi();
      await api.account.signOut();
    },
    onSuccess: () => {
      setStatus({ state: "signed-out" });
    },
  });

  const openVerificationUrl = (url: string) => {
    const api = ensureNativeApi();
    return api.account.openVerificationUrl({ url });
  };

  const status = statusQuery.data ?? null;

  return {
    status,
    me: status?.state === "signed-in" ? status.me : null,
    statusQuery,
    signInWithPassword,
    signUpWithPassword,
    beginSignIn,
    completeSignIn,
    updateProfile,
    signOut,
    openVerificationUrl,
  } as const;
}
