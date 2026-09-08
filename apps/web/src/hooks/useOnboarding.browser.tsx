import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { useOnboarding } from "../onboarding/useOnboarding";

const mocks = vi.hoisted(() => ({ getConfig: vi.fn(), save: vi.fn() }));
vi.mock("../appSettings", () => ({
  useAppSettings: () => ({ updateSettingsAndWait: mocks.save }),
}));
vi.mock("../lib/serverReactQuery", () => ({
  serverConfigQueryOptions: () => ({ queryKey: ["server", "config"], queryFn: mocks.getConfig }),
  serverSettingsQueryOptions: () => ({
    queryKey: ["server", "settings"],
    queryFn: async () => ({ onboardingCompletedAt: null }),
  }),
}));
vi.mock("../store", () => ({
  useStore: (select: (state: { threadsHydrated: boolean; projects: never[] }) => unknown) =>
    select({ threadsHydrated: true, projects: [] }),
}));
vi.mock("../workspacePathsStore", () => ({
  useWorkspacePathsStore: (select: (state: Record<string, null>) => unknown) =>
    select({ homeDir: null, chatWorkspaceRoot: null, studioWorkspaceRoot: null }),
}));

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.removeItem("synara:onboarding:v2");
  mocks.getConfig.mockReset().mockResolvedValue({ worktreesDir: "/a/worktrees" });
  // Keep the server marker absent to exercise the failed-write fallback.
  mocks.save.mockReset().mockResolvedValue(false);
  useOnboardingDialogStore.setState({
    isOpen: false,
    openReason: null,
    engaged: false,
    startupGateSettled: false,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const client of clients.splice(0)) client.clear();
  localStorage.removeItem("synara:onboarding:v2");
});

async function renderOnboarding() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const hook = await renderHook(() => useOnboarding(), {
    wrapper: ({ children }: { children?: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { client, hook };
}

describe("onboarding installation identity", () => {
  it("keeps the intro open when a config refetch fails with a cached identity", async () => {
    const { client, hook } = await renderOnboarding();
    await vi.waitFor(() => expect(hook.result.current.isOpen).toBe(true));
    mocks.getConfig.mockRejectedValue(new Error("temporary config failure"));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["server", "config"] });
    });
    await vi.waitFor(() =>
      expect(client.getQueryState(["server", "config"])?.status).toBe("error"),
    );
    await hook.rerender();
    expect(hook.result.current.isOpen).toBe(true);
    await hook.unmount();
  });

  it("keeps a completed replay dismissed as config arrives, but not on another installation", async () => {
    let resolveConfig!: (config: { worktreesDir: string }) => void;
    mocks.getConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
    );
    const { client, hook } = await renderOnboarding();
    await act(async () => {
      useOnboardingDialogStore.getState().openDialog();
    });
    await vi.waitFor(() => expect(hook.result.current.isOpen).toBe(true));
    await act(async () => {
      hook.result.current.complete();
    });
    await act(async () => {
      resolveConfig({ worktreesDir: "/a/worktrees" });
    });
    await vi.waitFor(() =>
      expect(client.getQueryState(["server", "config"])?.status).toBe("success"),
    );
    await hook.rerender();
    expect(hook.result.current.isOpen).toBe(false);
    expect(
      JSON.parse(localStorage.getItem("synara:onboarding:v2") ?? "null")?.completedAt ?? null,
    ).toBeNull();
    await act(async () => {
      client.setQueryData(["server", "config"], { worktreesDir: "/b/worktrees" });
    });
    await vi.waitFor(() => expect(hook.result.current.isOpen).toBe(true));
    await hook.unmount();
  });
});
