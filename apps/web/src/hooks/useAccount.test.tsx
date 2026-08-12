// FILE: useAccount.test.tsx
// Purpose: Verifies the account hook's cache behavior — status projection, and
// that each mutation settles the status cache without a refetch round trip.
// Layer: Web account feature tests.

import type { AccountMe, AccountStatus, NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accountQueryKeys, accountStatusQueryOptions } from "~/lib/accountReactQuery";
import { useAccount } from "./useAccount";

const accountApiMock = {
  status: vi.fn<() => Promise<AccountStatus>>(),
  sendOtp: vi.fn(),
  authenticateOtp: vi.fn(),
  beginSso: vi.fn(),
  completeSso: vi.fn(),
  cancelSso: vi.fn(),
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
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

  it("writes the updated `me` into the cache after an avatar upload", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), {
      state: "signed-in",
      me: makeMe(),
    });
    const after = makeMe({
      handle: "ada-l",
      displayName: "Ada",
      avatarColor: "#22c55e",
      avatarSource: "uploaded",
      avatarUrl: "https://cdn.example.com/avatars/user_1/abc.webp",
    });
    accountApiMock.uploadAvatar.mockResolvedValue(after);

    const account = renderUseAccount(queryClient);
    await account.uploadAvatar.mutateAsync({ bytes: "aGVsbG8=", contentType: "image/webp" });

    expect(accountApiMock.uploadAvatar).toHaveBeenCalledWith({
      bytes: "aGVsbG8=",
      contentType: "image/webp",
    });
    expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
      state: "signed-in",
      me: after,
    });
  });

  it("writes the updated `me` into the cache after an avatar delete", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), {
      state: "signed-in",
      me: makeMe({
        handle: "ada-l",
        displayName: "Ada",
        avatarColor: "#22c55e",
        avatarSource: "uploaded",
        avatarUrl: "https://cdn.example.com/avatars/user_1/abc.webp",
      }),
    });
    const after = makeMe({
      handle: "ada-l",
      displayName: "Ada",
      avatarColor: "#22c55e",
      avatarSource: "sso",
      avatarUrl: null,
    });
    accountApiMock.deleteAvatar.mockResolvedValue(after);

    const account = renderUseAccount(queryClient);
    await account.deleteAvatar.mutateAsync();

    expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
      state: "signed-in",
      me: after,
    });
  });

  // The usage-summary cache key carries no user identity, so an identity
  // change (sign-out, or a fresh sign-in) must REMOVE it — not merely
  // invalidate — or the next user would render the previous user's usage.
  it("removes cached account usage after signOut", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), {
      state: "signed-in",
      me: makeMe(),
    });
    queryClient.setQueryData(accountQueryKeys.usageSummary(120), { lifetimeTokens: 42 });
    accountApiMock.signOut.mockResolvedValue(undefined);

    const account = renderUseAccount(queryClient);
    await account.signOut.mutateAsync();

    expect(queryClient.getQueryData(accountQueryKeys.usageSummary(120))).toBeUndefined();
  });

  it("removes cached account usage before a fresh OTP sign-in renders", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), { state: "signed-out" });
    // Left behind by a previous identity (sign-out via another client, say).
    queryClient.setQueryData(accountQueryKeys.usageSummary(120), { lifetimeTokens: 42 });
    const me = makeMe();
    accountApiMock.authenticateOtp.mockResolvedValue({ state: "signed-in", me });

    const account = renderUseAccount(queryClient);
    await account.authenticateOtp.mutateAsync({ email: "ada@example.com", code: "654321" });

    expect(queryClient.getQueryData(accountQueryKeys.usageSummary(120))).toBeUndefined();
    expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
      state: "signed-in",
      me,
    });
  });

  it("removes cached account usage before a fresh SSO sign-in renders", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(accountQueryKeys.usageSummary(-330), { lifetimeTokens: 42 });
    const me = makeMe();
    accountApiMock.completeSso.mockResolvedValue({ state: "signed-in", me });

    const account = renderUseAccount(queryClient);
    await account.completeSso.mutateAsync({ ssoId: "sso_1" });

    expect(queryClient.getQueryData(accountQueryKeys.usageSummary(-330))).toBeUndefined();
    expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
      state: "signed-in",
      me,
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

  // M7: an `account.status` fetch in flight when a mutation runs must not
  // resolve afterwards and overwrite the mutation's newer cache state. The
  // mutations cancel the in-flight query up front and invalidate after
  // settlement, so the stale answer is discarded in both orderings.
  describe("status-query vs mutation races", () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    it("a slow signed-out status resolving after sign-in does not overwrite it", async () => {
      const queryClient = new QueryClient();
      const me = makeMe();
      const slowStatus = deferred<AccountStatus>();
      accountApiMock.status.mockReturnValue(slowStatus.promise);
      accountApiMock.authenticateOtp.mockResolvedValue({ state: "signed-in", me });

      // A status fetch starts while signed out and hangs.
      const statusFetch = queryClient
        .fetchQuery(accountStatusQueryOptions())
        .catch(() => undefined);

      const account = renderUseAccount(queryClient);
      await account.authenticateOtp.mutateAsync({ email: "ada@example.com", code: "654321" });

      // The pre-mutation fetch resolves late, with the pre-mutation answer.
      slowStatus.resolve({ state: "signed-out" });
      await statusFetch;
      await new Promise((res) => setTimeout(res, 0));

      expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
        state: "signed-in",
        me,
      });
    });

    it("a slow signed-in status resolving after sign-out does not resurrect it", async () => {
      const queryClient = new QueryClient();
      const me = makeMe();
      queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), {
        state: "signed-in",
        me,
      });
      const slowStatus = deferred<AccountStatus>();
      accountApiMock.status.mockReturnValue(slowStatus.promise);
      accountApiMock.signOut.mockResolvedValue(undefined);

      const statusFetch = queryClient
        .fetchQuery({ ...accountStatusQueryOptions(), staleTime: 0 })
        .catch(() => undefined);

      const account = renderUseAccount(queryClient);
      await account.signOut.mutateAsync();

      slowStatus.resolve({ state: "signed-in", me });
      await statusFetch;
      await new Promise((res) => setTimeout(res, 0));

      expect(queryClient.getQueryData<AccountStatus>(accountQueryKeys.status())).toEqual({
        state: "signed-out",
      });
    });
  });

  it("forwards the abort signal to completeSso", async () => {
    const queryClient = new QueryClient();
    const me = makeMe();
    accountApiMock.completeSso.mockResolvedValue({ state: "signed-in", me });

    const account = renderUseAccount(queryClient);
    const controller = new AbortController();
    await account.completeSso.mutateAsync({
      ssoId: "sso_1",
      signal: controller.signal,
    });

    expect(accountApiMock.completeSso).toHaveBeenCalledWith(
      { ssoId: "sso_1" },
      { signal: controller.signal },
    );
  });
});
