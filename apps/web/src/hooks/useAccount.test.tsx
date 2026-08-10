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
  signInWithPassword: vi.fn(),
  signUpWithPassword: vi.fn(),
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
    name: "Dylan Verbreyt",
    email: "dylan@example.com",
    organization: { id: "org_1", name: "Dylan's Workspace" },
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

  it("writes the fresh status into the cache after password sign-in", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), { state: "signed-out" });
    const me = makeMe();
    accountApiMock.signInWithPassword.mockResolvedValue({ state: "signed-in", me });

    const account = renderUseAccount(queryClient);
    await account.signInWithPassword.mutateAsync({
      email: "dylan@example.com",
      password: "secret",
    });

    expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
      state: "signed-in",
      me,
    });
  });

  it("writes the updated `me` into the cache after updateProfile", async () => {
    const queryClient = new QueryClient();
    const before = makeMe();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), {
      state: "signed-in",
      me: before,
    });
    const after = makeMe({ handle: "dylan", displayName: "Dylan", avatarColor: "#22c55e" });
    accountApiMock.updateProfile.mockResolvedValue(after);

    const account = renderUseAccount(queryClient);
    await account.updateProfile.mutateAsync({
      handle: "dylan",
      displayName: "Dylan",
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
