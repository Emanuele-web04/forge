import "../index.css";

import type { ProviderAccountsConnectStatus } from "@synara/contracts";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  beginConnect: vi.fn(async (): Promise<{ operationId: string }> => ({ operationId: "op-1" })),
  cancelConnect: vi.fn(async () => undefined),
  setActive: vi.fn(async () => undefined),
  getSnapshot: vi.fn(async () => ({ providers: [] })),
  connectStatus: {
    operationId: "op-1",
    state: "succeeded",
    provider: "codex",
    surface: "agent",
    ordinal: 2,
  } as Record<string, unknown>,
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    providerAccounts: {
      beginConnect: harness.beginConnect,
      cancelConnect: harness.cancelConnect,
      setActive: harness.setActive,
      getSnapshot: harness.getSnapshot,
      getConnectStatus: async () =>
        harness.connectStatus as unknown as ProviderAccountsConnectStatus,
    },
  }),
}));

import { AccountConnectDialog, type AccountConnectRequest } from "./AccountConnectDialog";
import { providerAccountsSnapshotQueryOptions } from "~/lib/providerAccountsReactQuery";

const CODEX_CAPABILITIES = {
  agent: { oauth: "supported", apiKey: "supported" },
  app: { oauth: "unsupported", supportLevel: "unsupported" },
} as AccountConnectRequest["capabilities"];

const API_KEY_ONLY_CAPABILITIES = {
  agent: { oauth: "unsupported", apiKey: "supported" },
  app: { oauth: "unsupported", supportLevel: "unsupported" },
} as AccountConnectRequest["capabilities"];

const renderDialog = (request: AccountConnectRequest) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <SnapshotObserver />
      <AccountConnectDialog request={request} onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { result, onOpenChange, queryClient };
};

/** Stands in for the rest of the UI subscribed to the provider-account snapshot. */
function SnapshotObserver() {
  useQuery(providerAccountsSnapshotQueryOptions());
  return null;
}

describe("AccountConnectDialog", () => {
  afterEach(() => {
    harness.beginConnect.mockClear();
    harness.beginConnect.mockImplementation(async () => ({ operationId: "op-1" }));
    harness.cancelConnect.mockClear();
    harness.setActive.mockClear();
    harness.getSnapshot.mockClear();
    harness.connectStatus = {
      operationId: "op-1",
      state: "succeeded",
      provider: "codex",
      surface: "agent",
      ordinal: 2,
    };
  });

  it("offers an accessible method radio group and defaults to OAuth", async () => {
    renderDialog({ provider: "codex", capabilities: CODEX_CAPABILITIES });
    const dialog = page.getByRole("dialog");
    const group = dialog.getByRole("radiogroup", { name: "Connection method" });
    await expect.element(group.getByRole("radio", { name: "Browser sign-in" })).toBeVisible();
    expect(group.getByRole("radio", { name: "Browser sign-in" }).element().ariaChecked).toBe(
      "true",
    );
    expect(group.getByRole("radio", { name: "API key" }).element().ariaChecked).toBe("false");
  });

  it("hides the method toggle when only API key is supported", async () => {
    renderDialog({ provider: "claudeAgent", capabilities: API_KEY_ONLY_CAPABILITIES });
    const dialog = page.getByRole("dialog");
    expect(dialog.getByRole("radiogroup").query()).toBeNull();
    await expect.element(dialog.getByLabelText("Claude API key")).toBeVisible();
  });

  it("submits an API key and reports saved-not-verified success", async () => {
    renderDialog({ provider: "codex", capabilities: CODEX_CAPABILITIES, currentActiveOrdinal: 0 });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "API key" }).click();

    // Connect stays disabled until a key is entered.
    await expect
      .element(dialog.getByRole("button", { name: "Connect", exact: true }))
      .toBeDisabled();
    await dialog.getByLabelText("Codex API key").fill("sk-test-fake");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();

    await vi.waitFor(() =>
      expect(harness.beginConnect).toHaveBeenCalledWith({
        kind: "agent-api-key",
        provider: "codex",
        apiKey: "sk-test-fake",
      }),
    );
    await expect
      .element(dialog.getByText("API key saved for Codex 2. It will be verified on first use."))
      .toBeVisible();
    expect(dialog.element().textContent).toContain(
      "Codex 2 is now the active account for new threads.",
    );
    await expect.element(dialog.getByRole("button", { name: "Keep Codex 0 active" })).toBeVisible();
  });

  it("renders OAuth waiting state with verification link and user code", async () => {
    harness.connectStatus = {
      operationId: "op-1",
      state: "waiting-for-user",
      provider: "codex",
      surface: "agent",
      verificationUrl: "https://auth.example/verify",
      userCode: "ABCD-1234",
    };
    renderDialog({ provider: "codex", capabilities: CODEX_CAPABILITIES });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();

    await expect.element(dialog.getByText("Waiting for you to finish signing in…")).toBeVisible();
    await expect.element(dialog.getByRole("link", { name: "this sign-in link" })).toBeVisible();
    expect(dialog.element().textContent).toContain("ABCD-1234");
    // Footer flips to explicit cancel semantics while pending.
    await expect.element(dialog.getByRole("button", { name: "Cancel sign-in" })).toBeVisible();
  });

  it("returns to the method chooser after a failure so methods can be switched", async () => {
    harness.connectStatus = {
      operationId: "op-1",
      state: "failed",
      provider: "codex",
      surface: "agent",
      error: "Could not start 'codex login'.",
    };
    renderDialog({ provider: "codex", capabilities: CODEX_CAPABILITIES });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();

    await expect.element(dialog.getByText("Could not start 'codex login'.")).toBeVisible();
    // The method toggle is available again after the failure.
    const group = dialog.getByRole("radiogroup", { name: "Connection method" });
    await group.getByRole("radio", { name: "API key" }).click();
    await expect.element(dialog.getByLabelText("Codex API key")).toBeVisible();
  });

  it("refetches the account snapshot when delayed browser OAuth succeeds", async () => {
    harness.connectStatus = {
      operationId: "op-1",
      state: "pending",
      provider: "codex",
      surface: "agent",
    };
    renderDialog({ provider: "codex", capabilities: CODEX_CAPABILITIES });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.element(dialog.getByText("Starting sign-in…")).toBeVisible();

    const snapshotFetchesBeforeSuccess = harness.getSnapshot.mock.calls.length;
    harness.connectStatus = {
      operationId: "op-1",
      state: "succeeded",
      provider: "codex",
      surface: "agent",
      ordinal: 2,
    };

    await expect
      .element(dialog.getByText("Connected as Codex 2."), { timeout: 10_000 })
      .toBeVisible();
    await vi.waitFor(() =>
      expect(harness.getSnapshot.mock.calls.length).toBeGreaterThan(snapshotFetchesBeforeSuccess),
    );
  });

  it("surfaces begin-connect errors inline", async () => {
    harness.beginConnect.mockImplementation(async () => {
      throw new Error("capability rejected");
    });
    renderDialog({ provider: "codex", capabilities: CODEX_CAPABILITIES });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.element(dialog.getByText("capability rejected")).toBeVisible();
  });

  it("cancels an in-flight sign-in when closed", async () => {
    harness.connectStatus = {
      operationId: "op-1",
      state: "pending",
      provider: "codex",
      surface: "agent",
    };
    const { onOpenChange } = renderDialog({ provider: "codex", capabilities: CODEX_CAPABILITIES });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.element(dialog.getByText("Starting sign-in…")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel sign-in" }).click();
    await vi.waitFor(() =>
      expect(harness.cancelConnect).toHaveBeenCalledWith({ operationId: "op-1" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
