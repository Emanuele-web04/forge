import "../../index.css";

import type { ProviderAccountsConnectStatus, ProviderAccountsSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => {
  const snapshot = {
    providers: [
      {
        provider: "codex",
        activeOrdinal: 1,
        accounts: [
          { provider: "codex", ordinal: 0, createdAt: "2026-01-01T00:00:00.000Z" },
          {
            provider: "codex",
            ordinal: 1,
            createdAt: "2026-01-02T00:00:00.000Z",
            identity: { hint: "API key ending e2e1" },
            agent: { generation: 1, state: "connected", authMethod: "apiKey" },
          },
        ],
        capabilities: {
          agent: { oauth: "supported", apiKey: "supported" },
          app: { oauth: "unsupported", supportLevel: "unsupported" },
        },
      },
    ],
  };
  return {
    snapshot,
    getSnapshot: vi.fn(async () => snapshot as unknown as ProviderAccountsSnapshot),
    beginConnect: vi.fn(async () => ({ operationId: "op-e2e-1" })),
    setActive: vi.fn(async () => undefined),
    disconnectBinding: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
    updateCliIntegration: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    integrationStatus: {
      cliIntegrationEnabled: false,
      launcherInstalled: false,
      shimDir: "/tmp/synara-e2e/bin",
      shimDirOnPath: false,
      launcherEntryExists: true,
      platformSupported: true,
    },
    connectStatus: {
      operationId: "op-e2e-1",
      state: "succeeded",
      provider: "codex",
      surface: "agent",
      ordinal: 2,
    },
  };
});

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    dialogs: { confirm: harness.confirm },
    providerAccounts: {
      getSnapshot: harness.getSnapshot,
      getIntegrationStatus: async () => harness.integrationStatus,
      beginConnect: harness.beginConnect,
      getConnectStatus: async () =>
        harness.connectStatus as unknown as ProviderAccountsConnectStatus,
      cancelConnect: async () => harness.connectStatus,
      setActive: harness.setActive,
      disconnectBinding: harness.disconnectBinding,
      hide: harness.hide,
      updateCliIntegration: harness.updateCliIntegration,
    },
  }),
}));

import { AccountsSettingsPanel } from "./AccountsSettingsPanel";

const renderPanel = (props?: { connectProvider?: string | null }) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccountsSettingsPanel active connectProvider={props?.connectProvider ?? null} />
    </QueryClientProvider>,
  );
};

describe("AccountsSettingsPanel", () => {
  afterEach(() => {
    harness.getSnapshot.mockClear();
    harness.getSnapshot.mockImplementation(
      async () => harness.snapshot as unknown as ProviderAccountsSnapshot,
    );
    harness.beginConnect.mockClear();
    harness.setActive.mockClear();
    harness.disconnectBinding.mockClear();
    harness.hide.mockClear();
    harness.updateCliIntegration.mockClear();
    harness.confirm.mockClear();
    harness.confirm.mockImplementation(async () => true);
    harness.integrationStatus = { ...harness.integrationStatus, launcherInstalled: false };
    document.body.innerHTML = "";
  });

  it("lists account-zero and managed rows and drives the connect dialog", async () => {
    await renderPanel();

    // Account zero (your login) row and the managed active account row.
    await vi.waitFor(() => expect(document.body.textContent).toContain("Codex 0 (your login)"));
    expect(document.body.textContent).toContain("Your own Codex login, unmanaged.");
    expect(document.body.textContent).toContain("Codex 1");
    expect(document.body.textContent).toContain("Active");
    expect(document.body.textContent).toContain("API key ending e2e1");
    expect(document.body.textContent).toContain("Agent: Connected");
    // CLI integration section renders with the install action.
    expect(document.body.textContent).toContain("Terminal launcher");
    await expect.element(page.getByRole("button", { name: "Install" })).toBeVisible();

    // Open the connect dialog from the add-account row.
    expect(document.body.textContent).toContain("Add Codex account");
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("Connect Codex account")).toBeVisible();
    // Both supported auth methods are offered as an accessible radio group.
    const methodGroup = dialog.getByRole("radiogroup", { name: "Connection method" });
    await expect.element(methodGroup.getByRole("radio", { name: "Browser sign-in" })).toBeVisible();
    await expect.element(methodGroup.getByRole("radio", { name: "API key" })).toBeVisible();
    expect(methodGroup.getByRole("radio", { name: "Browser sign-in" }).element().ariaChecked).toBe(
      "true",
    );
    expect(dialog.element().textContent).toContain(
      "Sign in with your browser to add a managed Codex account.",
    );

    // Switch to the API-key method: labelled input plus key-creation helper link.
    await methodGroup.getByRole("radio", { name: "API key" }).click();
    expect(dialog.element().textContent).toContain("Store an API key for a managed Codex account.");
    await expect.element(dialog.getByLabelText("Codex API key")).toBeVisible();
    expect(dialog.element().textContent).toContain("Create a key in");
    await dialog.getByLabelText("Codex API key").fill("sk-browser-e2e");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();

    await vi.waitFor(() =>
      expect(harness.beginConnect).toHaveBeenCalledWith({
        kind: "agent-api-key",
        provider: "codex",
        apiKey: "sk-browser-e2e",
      }),
    );
    // Success copy: saved-not-verified plus explicit active-slot handover.
    await expect
      .element(dialog.getByText("API key saved for Codex 2. It will be verified on first use."))
      .toBeVisible();
    expect(dialog.element().textContent).toContain(
      "Codex 2 is now the active account for new threads.",
    );
    // The previous active slot can be kept without leaving the dialog.
    await dialog.getByRole("button", { name: "Keep Codex 1 active" }).click();
    await vi.waitFor(() =>
      expect(harness.setActive).toHaveBeenCalledWith({ provider: "codex", ordinal: 1 }),
    );
    await dialog.getByRole("button", { name: "Done" }).click();
    await vi.waitFor(() => expect(page.getByRole("dialog").query()).toBeNull());
  });

  it("switches the active account from a managed row", async () => {
    await renderPanel();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Codex 0 (your login)"));

    // Account zero is inactive here, so its row exposes Make active.
    await page.getByRole("button", { name: "Codex 0 (your login)" }).click();
    await page.getByRole("button", { name: "Make active" }).click();
    await vi.waitFor(() =>
      expect(harness.setActive).toHaveBeenCalledWith({ provider: "codex", ordinal: 0 }),
    );
  });

  it("renders the active account-zero row as plain text when it has no actions", async () => {
    harness.getSnapshot.mockImplementation(
      async () =>
        ({
          providers: [
            {
              provider: "codex",
              activeOrdinal: 0,
              accounts: [{ provider: "codex", ordinal: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
              capabilities: {
                agent: { oauth: "supported", apiKey: "supported" },
                app: { oauth: "unsupported", supportLevel: "unsupported" },
              },
            },
          ],
        }) as unknown as ProviderAccountsSnapshot,
    );
    await renderPanel();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Codex 0 (your login)"));
    // No disclosure button (and thus no aria-expanded) for a row with zero actions.
    expect(page.getByRole("button", { name: "Codex 0 (your login)" }).query()).toBeNull();
  });

  it("confirms destructive actions before mutating", async () => {
    await renderPanel();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Codex 1"));

    await page.getByRole("button", { name: "Codex 1 Active" }).click();
    expect(document.body.textContent).toContain(
      "Hide only removes the account from menus. Its credentials stay on this machine and the account can be unhidden later.",
    );

    // Declined confirmation leaves the account untouched.
    harness.confirm.mockImplementation(async () => false);
    await page.getByRole("button", { name: "Hide" }).click();
    await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalled());
    expect(harness.hide).not.toHaveBeenCalled();

    // Accepted confirmation performs the disconnect.
    harness.confirm.mockImplementation(async () => true);
    await page.getByRole("button", { name: "Disconnect agent" }).click();
    await vi.waitFor(() =>
      expect(harness.disconnectBinding).toHaveBeenCalledWith({
        provider: "codex",
        ordinal: 1,
        surface: "agent",
      }),
    );
  });

  it("installs and uninstalls the terminal launcher", async () => {
    await renderPanel();
    await expect.element(page.getByRole("button", { name: "Install" })).toBeVisible();
    await page.getByRole("button", { name: "Install" }).click();
    await vi.waitFor(() =>
      expect(harness.updateCliIntegration).toHaveBeenCalledWith({ enabled: true }),
    );

    harness.integrationStatus = { ...harness.integrationStatus, launcherInstalled: true };
    document.body.innerHTML = "";
    await renderPanel();
    // Installed-but-not-on-PATH state offers a ready-made copyable export line.
    await expect.element(page.getByRole("button", { name: "Uninstall" })).toBeVisible();
    expect(document.body.textContent).toContain('export PATH="/tmp/synara-e2e/bin:$PATH"');
    await expect.element(page.getByRole("button", { name: "Copy" })).toBeVisible();
    await page.getByRole("button", { name: "Uninstall" }).click();
    await vi.waitFor(() =>
      expect(harness.updateCliIntegration).toHaveBeenCalledWith({ enabled: false }),
    );
  });

  it("shows an error banner with retry when the snapshot fails", async () => {
    harness.getSnapshot.mockImplementation(async () => {
      throw new Error("server down");
    });
    await renderPanel();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Couldn't load accounts"));

    harness.getSnapshot.mockImplementation(
      async () => harness.snapshot as unknown as ProviderAccountsSnapshot,
    );
    await page.getByRole("button", { name: "Retry" }).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Codex 0 (your login)"));
    expect(document.body.textContent).not.toContain("Couldn't load accounts");
  });

  it("opens the connect dialog for a deep-linked provider", async () => {
    const screen = await renderPanel({ connectProvider: "codex" });
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("Connect Codex account")).toBeVisible();
    // Unmount before afterEach clears the body so the dialog portal detaches cleanly.
    screen.unmount();
  });

  it("opens the connect dialog for a hyphenated provider-name alias", async () => {
    const screen = await renderPanel({ connectProvider: "codex-agent" });
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("Connect Codex account")).toBeVisible();
    screen.unmount();
  });

  it("refetches the snapshot after a disconnect so the row label refreshes", async () => {
    await renderPanel();
    await vi.waitFor(() => expect(document.body.textContent).toContain("API key ending e2e1"));

    // After the disconnect succeeds, the server reports the slot as needing
    // sign-in with no stored identity.
    harness.getSnapshot.mockImplementation(
      async () =>
        ({
          providers: [
            {
              provider: "codex",
              activeOrdinal: 1,
              accounts: [
                { provider: "codex", ordinal: 0, createdAt: "2026-01-01T00:00:00.000Z" },
                {
                  provider: "codex",
                  ordinal: 1,
                  createdAt: "2026-01-02T00:00:00.000Z",
                  agent: { generation: 1, state: "needs-auth", authMethod: "apiKey" },
                },
              ],
              capabilities: {
                agent: { oauth: "supported", apiKey: "supported" },
                app: { oauth: "unsupported", supportLevel: "unsupported" },
              },
            },
          ],
        }) as unknown as ProviderAccountsSnapshot,
    );

    await page.getByRole("button", { name: "Codex 1 Active" }).click();
    await page.getByRole("button", { name: "Disconnect agent" }).click();
    await vi.waitFor(() => expect(harness.disconnectBinding).toHaveBeenCalled());
    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain("API key ending e2e1");
      expect(document.body.textContent).toContain("Agent: Needs sign-in");
    });
  });
});
