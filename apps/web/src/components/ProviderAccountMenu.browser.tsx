import "../index.css";

import type { ProviderAccountsSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  setActive: vi.fn(async () => undefined),
  snapshot: {
    providers: [
      {
        provider: "codex",
        activeOrdinal: 0,
        accounts: [
          { provider: "codex", ordinal: 0, createdAt: "2026-01-01T00:00:00.000Z" },
          {
            provider: "codex",
            ordinal: 1,
            createdAt: "2026-01-02T00:00:00.000Z",
            identity: { hint: "API key ending -123" },
            agent: { generation: 1, state: "connected", authMethod: "apiKey" },
          },
          {
            provider: "codex",
            ordinal: 2,
            createdAt: "2026-01-03T00:00:00.000Z",
            agent: { generation: 1, state: "connected", authMethod: "oauth" },
          },
        ],
        capabilities: {
          agent: { oauth: "supported", apiKey: "supported" },
          app: { oauth: "unsupported", supportLevel: "unsupported" },
        },
      },
    ],
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNavigate: () => harness.navigate,
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    providerAccounts: {
      getSnapshot: async () => harness.snapshot as unknown as ProviderAccountsSnapshot,
      setActive: harness.setActive,
    },
  }),
}));

import { ProviderAccountMenu } from "./ProviderAccountMenu";

const renderMenu = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProviderAccountMenu>Accounts</ProviderAccountMenu>
    </QueryClientProvider>,
  );
};

describe("ProviderAccountMenu", () => {
  afterEach(() => {
    harness.navigate.mockClear();
    harness.setActive.mockClear();
  });

  it("renders provider submenus with identity suffixes and switches accounts", async () => {
    await renderMenu();
    await page.getByRole("button", { name: "Accounts" }).click();

    // The provider trigger shows the active slot label.
    const codexTrigger = page.getByRole("menuitem", { name: /Codex/ });
    await expect.element(codexTrigger).toBeVisible();
    expect(codexTrigger.element().textContent).toContain("Codex 0 (your login)");

    await codexTrigger.hover();
    // Managed accounts are distinguishable via identity/auth-method suffixes.
    const apiKeyItem = page.getByRole("menuitemradio", { name: /Codex 1/ });
    await expect.element(apiKeyItem).toBeVisible();
    expect(apiKeyItem.element().textContent).toContain("API key ending -123");
    const oauthItem = page.getByRole("menuitemradio", { name: /Codex 2/ });
    expect(oauthItem.element().textContent).toContain("OAuth");
    // Account zero has no suffix.
    const zeroItem = page.getByRole("menuitemradio", { name: /Codex 0/ });
    expect(zeroItem.element().textContent).toContain("Codex 0 (your login)");
    expect(zeroItem.element().textContent).not.toContain("API key");
    expect(zeroItem.element().textContent).not.toContain("OAuth");

    await apiKeyItem.click();
    await vi.waitFor(() =>
      expect(harness.setActive).toHaveBeenCalledWith({ provider: "codex", ordinal: 1 }),
    );
  });

  it("navigates to accounts settings with the provider preselected from Add account", async () => {
    await renderMenu();
    await page.getByRole("button", { name: "Accounts" }).click();
    await page.getByRole("menuitem", { name: /Codex/ }).hover();
    await page.getByRole("menuitem", { name: "Add account" }).click();
    await vi.waitFor(() =>
      expect(harness.navigate).toHaveBeenCalledWith({
        to: "/settings",
        search: { section: "accounts", connect: "codex" },
      }),
    );
  });

  it("navigates to accounts settings from Manage accounts", async () => {
    await renderMenu();
    await page.getByRole("button", { name: "Accounts" }).click();
    await page.getByRole("menuitem", { name: "Manage accounts" }).click();
    await vi.waitFor(() =>
      expect(harness.navigate).toHaveBeenCalledWith({
        to: "/settings",
        search: { section: "accounts" },
      }),
    );
  });
});
