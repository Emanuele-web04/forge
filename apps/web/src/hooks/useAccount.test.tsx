// FILE: useAccount.test.tsx
// Purpose: Verifies the account hook's cache behavior — status projection, and
// that each mutation settles the status cache without a refetch round trip.
// Layer: Web account feature tests.

import type { AccountMe, AccountStatus, NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accountQueryKeys } from "~/lib/accountReactQuery";
import { useAccount } from "./useAccount";

const accountApiMock = {
  status: vi.fn<() => Promise<AccountStatus>>(),
  sendOtp: vi.fn(),
  authenticateOtp: vi.fn(),
  verifyEmail: vi.fn(),
  resendVerificationEmail: vi.fn(),
  beginSignIn: vi.fn(),
  completeSignIn: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
  openVerificationUrl: vi.fn(),
};

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ account: accountApiMock }) as unknown as NativeApi,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makeMe(profile: AccountMe["profile"] = null): AccountMe {
  return {
    id: "user_1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    organization: { id: "org_1", name: "Ada's Workspace" },
    profile,
  };
}

function renderUseAccount(queryClient: QueryClient) {
  // Held in an object so TypeScript doesn't narrow the closure write away.
  const holder: { current: ReturnType<typeof useAccount> | null } = { current: null };
  function Probe() {
    holder.current = useAccount();
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{(<Probe />) as ReactNode}</QueryClientProvider>,
  );
  const captured = holder.current;
  if (!captured) throw new Error("useAccount did not render");
  return captured;
}

describe("useAccount", () => {
  it("projects a cached signed-in status into `me`", () => {
    const queryClient = new QueryClient();
    const me = makeMe();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), {
      state: "signed-in",
      me,
    });

    const account = renderUseAccount(queryClient);

    expect(account.me).toEqual(me);
    expect(account.status).toEqual({ state: "signed-in", me });
  });

  it("reports null `me` while signed out", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), { state: "signed-out" });

    const account = renderUseAccount(queryClient);

    expect(account.me).toBeNull();
  });

  it("passes a code send through without touching the status cache", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), { state: "signed-out" });
    accountApiMock.sendOtp.mockResolvedValue({
      email: "ada@example.com",
      expiresAt: "2026-08-10T12:10:00.000Z",
    });

    const account = renderUseAccount(queryClient);
    const sent = await account.sendOtp.mutateAsync({ email: "ada@example.com" });

    expect(accountApiMock.sendOtp).toHaveBeenCalledWith({ email: "ada@example.com" });
    expect(sent).toEqual({ email: "ada@example.com", expiresAt: "2026-08-10T12:10:00.000Z" });
    expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
      state: "signed-out",
    });
  });

  it("writes the fresh status into the cache after OTP sign-in", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), { state: "signed-out" });
    const me = makeMe();
    accountApiMock.authenticateOtp.mockResolvedValue({ state: "signed-in", me });

    const account = renderUseAccount(queryClient);
    await account.authenticateOtp.mutateAsync({
      email: "ada@example.com",
      code: "654321",
    });

    expect(accountApiMock.authenticateOtp).toHaveBeenCalledWith({
      email: "ada@example.com",
      code: "654321",
    });
    expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
      state: "signed-in",
      me,
    });
  });

  // Verification is a sign-in: its success must settle the status cache the
  // same way the OTP grant's does.
  it("writes the fresh status into the cache after verifyEmail", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), { state: "signed-out" });
    const me = makeMe();
    accountApiMock.verifyEmail.mockResolvedValue({ state: "signed-in", me });

    const account = renderUseAccount(queryClient);
    await account.verifyEmail.mutateAsync({
      code: "123456",
      pendingAuthenticationToken: "pat_123",
    });

    expect(accountApiMock.verifyEmail).toHaveBeenCalledWith({
      code: "123456",
      pendingAuthenticationToken: "pat_123",
    });
    expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
      state: "signed-in",
      me,
    });
  });

  it("passes a resend through without touching the status cache", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), { state: "signed-out" });
    accountApiMock.resendVerificationEmail.mockResolvedValue(undefined);

    const account = renderUseAccount(queryClient);
    await account.resendVerificationEmail.mutateAsync({
      emailVerificationId: "email_verification_123",
    });

    expect(accountApiMock.resendVerificationEmail).toHaveBeenCalledWith({
      emailVerificationId: "email_verification_123",
    });
    expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
      state: "signed-out",
    });
  });

  it("writes the updated `me` into the cache after updateProfile", async () => {
    const queryClient = new QueryClient();
    const before = makeMe();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), {
      state: "signed-in",
      me: before,
    });
    const after = makeMe({ handle: "ada-l", displayName: "Ada", avatarColor: "#22c55e" });
    accountApiMock.updateProfile.mockResolvedValue(after);

    const account = renderUseAccount(queryClient);
    await account.updateProfile.mutateAsync({
      handle: "ada-l",
      displayName: "Ada",
      avatarColor: "#22c55e",
    });

    expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
      state: "signed-in",
      me: after,
    });
  });

  it("clears the cache to signed-out after signOut", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), {
      state: "signed-in",
      me: makeMe(),
    });
    accountApiMock.signOut.mockResolvedValue(undefined);

    const account = renderUseAccount(queryClient);
    await account.signOut.mutateAsync();

    expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
      state: "signed-out",
    });
  });

  it("forwards the abort signal to completeSignIn", async () => {
    const queryClient = new QueryClient();
    const me = makeMe();
    accountApiMock.completeSignIn.mockResolvedValue({ state: "signed-in", me });

    const account = renderUseAccount(queryClient);
    const controller = new AbortController();
    await account.completeSignIn.mutateAsync({
      deviceCode: "device-code",
      signal: controller.signal,
    });

    expect(accountApiMock.completeSignIn).toHaveBeenCalledWith(
      { deviceCode: "device-code" },
      { signal: controller.signal },
    );
  });
});
