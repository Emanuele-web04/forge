// FILE: useAccount.ts
// Purpose: The account session as the web app consumes it — status query plus
// sign-in/out and profile mutations, each of which settles the status cache.
// Layer: Web account feature hook.

import type {
  AccountAuthenticateOtpInput,
  AccountMe,
  AccountResendVerificationEmailInput,
  AccountSendOtpInput,
  AccountStatus,
  AccountUpdateProfileInput,
  AccountVerifyEmailInput,
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

  const sendOtp = useMutation({
    mutationFn: async (input: AccountSendOtpInput) => {
      const api = ensureNativeApi();
      return api.account.sendOtp(input);
    },
  });

  // The input carries the emailed code — a credential with the same handling
  // rules as a password: pass it straight through and keep it nowhere past
  // the call.
  const authenticateOtp = useMutation({
    mutationFn: async (input: AccountAuthenticateOtpInput) => {
      const api = ensureNativeApi();
      return api.account.authenticateOtp(input);
    },
    onSuccess: setStatus,
  });

  // The input pairs the emailed code with the pending authentication token —
  // bearer-ish secrets with the same handling rules as a password: pass them
  // straight through and keep them nowhere past the call.
  const verifyEmail = useMutation({
    mutationFn: async (input: AccountVerifyEmailInput) => {
      const api = ensureNativeApi();
      return api.account.verifyEmail(input);
    },
    onSuccess: setStatus,
  });

  const resendVerificationEmail = useMutation({
    mutationFn: async (input: AccountResendVerificationEmailInput) => {
      const api = ensureNativeApi();
      await api.account.resendVerificationEmail(input);
    },
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
    sendOtp,
    authenticateOtp,
    verifyEmail,
    resendVerificationEmail,
    beginSignIn,
    completeSignIn,
    updateProfile,
    signOut,
    openVerificationUrl,
  } as const;
}
