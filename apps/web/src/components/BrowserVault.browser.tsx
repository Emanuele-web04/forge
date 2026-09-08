import "../index.css";
import type { BrowserVaultMethods, BrowserVaultSnapshot } from "@synara/contracts";
import { ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({ api: undefined as BrowserVaultMethods | undefined }));
vi.mock("~/nativeApi", () => ({ readNativeApi: () => ({ browser: { vault: harness.api } }) }));
import { BrowserVaultButton, BrowserVaultDialog } from "./BrowserVault";
import { BrowserCookieImport } from "./BrowserCookieImport";
import { SafariAccessOnboarding, SAFARI_ACCESS_STORAGE_KEY } from "./SafariAccessOnboarding";

let state: BrowserVaultSnapshot;
let changed: () => void;
beforeEach(() => {
  changed = () => {};
  state = {
    protection: { configured: true, locked: false, osProtected: true },
    settings: { agentUse: true, offerSave: false, autosave: false },
    logins: [],
    pending: [],
    error: null,
  };
  harness.api = {
    snapshot: vi.fn(async () => state),
    setupMaster: vi.fn(async () => {}),
    unlock: vi.fn(async () => {}),
    lock: vi.fn(async () => {}),
    reveal: vi.fn(async () => ({ password: "synthetic-revealed", expiresAt: Date.now() + 20_000 })),
    cookieSources: vi.fn(async () => []),
    cookieProfiles: vi.fn(async () => []),
    importCookies: vi.fn(async () => ({
      ok: true as const,
      imported: 0,
      skipped: 0,
      warnings: [],
    })),
    configure: vi.fn(async (settings) => {
      state = { ...state, settings };
      changed();
      return state;
    }),
    remove: vi.fn(async (id) => {
      state = { ...state, logins: state.logins.filter((login) => login.id !== id) };
      changed();
      return state;
    }),
    respond: vi.fn(async ({ id }) => {
      state = { ...state, pending: state.pending.filter((prompt) => prompt.id !== id) };
      changed();
    }),
    onChanged: (listener) => {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
  };
});

describe("browser saved logins", () => {
  it("still reports actual permission denial after continuing past Safari setup", async () => {
    const previous = window.desktopBridge;
    const previousDecision = localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY);
    const api = harness.api!;
    try {
      localStorage.removeItem(SAFARI_ACCESS_STORAGE_KEY);
      window.desktopBridge = {
        ...previous,
        safariAccess: {
          getInfo: async () => ({
            supported: true,
            appName: "Synara",
            appPath: "/Applications/Synara.app",
          }),
          openSettings: async () => true,
          revealApp: async () => true,
        },
      } as NonNullable<typeof previous>;
      vi.mocked(api.cookieSources).mockResolvedValue([{ id: "safari", name: "Safari" }]);
      vi.mocked(api.cookieProfiles).mockResolvedValue([{ id: "default", name: "default" }]);
      vi.mocked(api.importCookies).mockResolvedValue({
        ok: false,
        code: "permission_denied",
        platform: "macos",
      });
      await render(
        <SafariAccessOnboarding>
          <BrowserCookieImport
            api={api}
            destination={{
              threadId: ThreadId.makeUnsafe("cookie-test"),
              tabId: "tab",
              origin: "https://example.test",
            }}
          />
        </SafariAccessOnboarding>,
      );
      await page.getByRole("button", { name: "Open System Settings" }).click();
      await expect.element(page.getByRole("status")).toHaveTextContent("Access is not verified");
      await page.getByRole("button", { name: "Continue to Synara" }).click();
      await page.getByRole("button", { name: "Import browser cookies" }).click();
      await page.getByRole("button", { name: "Import for this site" }).click();
      await expect.element(page.getByRole("status")).toHaveTextContent("macOS denied access");
      await expect.element(page.getByRole("status")).toHaveTextContent("Settings > General");
    } finally {
      if (previous) window.desktopBridge = previous;
      else delete window.desktopBridge;
      if (previousDecision === null) localStorage.removeItem(SAFARI_ACCESS_STORAGE_KEY);
      else localStorage.setItem(SAFARI_ACCESS_STORAGE_KEY, previousDecision);
    }
  });

  it("requires fresh explicit all-profile consent and shows Safari-specific native denial", async () => {
    const api = harness.api!;
    vi.mocked(api.cookieSources).mockResolvedValue([{ id: "safari", name: "Safari" }]);
    vi.mocked(api.cookieProfiles).mockResolvedValue([{ id: "default", name: "default" }]);
    vi.mocked(api.importCookies).mockResolvedValue({
      ok: false,
      code: "permission_denied",
      platform: "macos",
    });
    const destination = {
      threadId: ThreadId.makeUnsafe("cookie-test"),
      tabId: "tab",
      origin: "https://accounts.google.com",
    };
    await render(<BrowserCookieImport api={api} destination={destination} />);
    await page.getByRole("button", { name: "Import browser cookies" }).click();
    await expect.element(page.getByRole("button", { name: "Import for this site" })).toBeEnabled();
    const scope = document.querySelector<HTMLSelectElement>('[aria-label="Cookie import scope"]')!;
    scope.value = "profile";
    scope.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.element(page.getByRole("button", { name: "Import all sites" })).toBeDisabled();
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Import all sites" }).click();
    expect(api.importCookies).toHaveBeenCalledExactlyOnceWith({
      threadId: destination.threadId,
      tabId: "tab",
      browser: "safari",
      profile: "default",
      scope: "profile",
      confirmed: true,
    });
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("macOS denied access to Safari's cookie files");
    await expect.element(page.getByRole("status")).not.toHaveTextContent("Windows");
    await expect.element(page.getByRole("button", { name: "Import all sites" })).toBeDisabled();
  });

  it("offers confirmed whole-profile import without a current website", async () => {
    const api = harness.api!;
    vi.mocked(api.cookieSources).mockResolvedValue([{ id: "safari", name: "Safari" }]);
    vi.mocked(api.cookieProfiles).mockResolvedValue([{ id: "default", name: "default" }]);
    await render(
      <BrowserCookieImport
        api={api}
        destination={{
          threadId: ThreadId.makeUnsafe("cookie-test"),
          tabId: "blank-tab",
          origin: null,
        }}
      />,
    );
    await page.getByRole("button", { name: "Import browser cookies" }).click();
    await expect.element(page.getByRole("button", { name: "Import all sites" })).toBeDisabled();
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Import all sites" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("0 cookies imported");
  });

  it.each([
    [{ code: "reader_failed", stage: "acquisition" }, "could not open or acquire"],
    [{ code: "reader_failed", stage: "parse" }, "cookie-format failure"],
    [{ code: "reader_failed", stage: "decrypt" }, "could not decrypt"],
    [{ code: "persistence_failed" }, "could not save their session state"],
  ] as const)("distinguishes reader stages and persistence failure", async (failure, message) => {
    const api = harness.api!;
    vi.mocked(api.cookieSources).mockResolvedValue([{ id: "safari", name: "Safari" }]);
    vi.mocked(api.cookieProfiles).mockResolvedValue([{ id: "default", name: "default" }]);
    vi.mocked(api.importCookies).mockResolvedValue({ ok: false, platform: "macos", ...failure });
    await render(
      <BrowserCookieImport
        api={api}
        destination={{
          threadId: ThreadId.makeUnsafe("cookie-test"),
          tabId: "tab",
          origin: "https://example.test",
        }}
      />,
    );
    await page.getByRole("button", { name: "Import browser cookies" }).click();
    await page.getByRole("button", { name: "Import for this site" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent(message);
    await expect.element(page.getByRole("status")).not.toHaveTextContent("Windows");
  });
  it("requires the master password for reveal and hides the secret on blur", async () => {
    state = {
      ...state,
      logins: [
        {
          id: "agent-1",
          origin: "https://example.test",
          username: "signup",
          label: null,
          source: "agent",
          status: "pending",
          updatedAt: "2026-09-07T00:00:00Z",
        },
      ],
    };
    await render(
      <>
        <BrowserVaultButton />
        <BrowserVaultDialog />
      </>,
    );
    await page.getByRole("button", { name: "Saved logins", exact: true }).click();
    await page.getByRole("button", { name: "Reveal password for signup" }).click();
    expect(harness.api?.reveal).not.toHaveBeenCalled();
    await page.getByLabelText("Master password", { exact: true }).fill("synthetic-master");
    await page.getByRole("button", { name: "Reveal password", exact: true }).click();
    expect(harness.api?.reveal).toHaveBeenCalledWith({
      id: "agent-1",
      password: "synthetic-master",
    });
    await expect
      .element(page.getByLabelText("Revealed password"))
      .toHaveValue("synthetic-revealed");
    window.dispatchEvent(new Event("blur"));
    await expect.element(page.getByLabelText("Revealed password")).not.toBeInTheDocument();
  });

  it("does not display a late reveal after the authentication panel is cancelled", async () => {
    let resolve!: (result: { password: string; expiresAt: number }) => void;
    harness.api!.reveal = vi.fn(
      () =>
        new Promise<{ password: string; expiresAt: number }>((done) => {
          resolve = done;
        }),
    );
    state = {
      ...state,
      logins: [
        {
          id: "agent-1",
          origin: "https://example.test",
          username: "signup",
          label: null,
          source: "agent",
          status: "saved",
          updatedAt: "2026-09-07T00:00:00Z",
        },
      ],
    };
    await render(
      <>
        <BrowserVaultButton />
        <BrowserVaultDialog />
      </>,
    );
    await page.getByRole("button", { name: "Saved logins", exact: true }).click();
    await page.getByRole("button", { name: "Reveal password for signup" }).click();
    await page.getByLabelText("Master password", { exact: true }).fill("synthetic-master");
    await page.getByRole("button", { name: "Reveal password", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    resolve({ password: "late-synthetic-secret", expiresAt: Date.now() + 20_000 });
    await expect.element(page.getByLabelText("Revealed password")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("late-synthetic-secret");
  });

  it("requires saving consent before enabling autosave", async () => {
    await render(
      <>
        <BrowserVaultButton />
        <BrowserVaultDialog />
      </>,
    );
    await page.getByRole("button", { name: "Saved logins", exact: true }).click();
    await expect
      .element(page.getByRole("switch", { name: "Autosave accepted logins" }))
      .toBeDisabled();
    await page.getByRole("switch", { name: "Offer to save passwords" }).click();
    expect(harness.api?.configure).toHaveBeenCalledWith({
      agentUse: true,
      offerSave: true,
      autosave: false,
    });
    await expect
      .element(page.getByRole("switch", { name: "Autosave accepted logins" }))
      .toBeEnabled();
  });

  it("limits agent consent to account discovery and states that autofill is unavailable", async () => {
    await render(
      <>
        <BrowserVaultButton />
        <BrowserVaultDialog />
      </>,
    );
    await page.getByRole("button", { name: "Saved logins", exact: true }).click();
    await expect
      .element(page.getByText("Agent password filling and generation are unavailable."))
      .toBeVisible();
    await page.getByRole("switch", { name: "Allow agents to find saved accounts" }).click();
    expect(harness.api?.configure).toHaveBeenCalledWith({
      agentUse: false,
      offerSave: false,
      autosave: false,
    });
    await expect
      .element(page.getByRole("switch", { name: "Allow agents to use saved logins" }))
      .not.toBeInTheDocument();
  });

  it("shows a metadata-only save prompt and never a credential-entry form", async () => {
    state = {
      ...state,
      settings: { ...state.settings, offerSave: true },
      pending: [
        { id: "prompt-1", origin: "https://example.test", username: "alice", mode: "save" },
      ],
    };
    await render(<BrowserVaultDialog />);
    await expect.element(page.getByRole("heading", { name: "Save password?" })).toBeVisible();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(harness.api?.respond).toHaveBeenCalledWith({ id: "prompt-1", save: true });
  });

  it("requires confirmation before deleting a saved login", async () => {
    state = {
      ...state,
      logins: [
        {
          id: "credential-1",
          origin: "https://example.test",
          username: "alice",
          label: null,
          source: "agent",
          status: "saved",
          updatedAt: "2026-09-07T00:00:00Z",
        },
      ],
    };
    await render(
      <>
        <BrowserVaultButton />
        <BrowserVaultDialog />
      </>,
    );
    await page.getByRole("button", { name: "Saved logins", exact: true }).click();
    await page.getByRole("button", { name: "Delete login for alice" }).click();
    expect(harness.api?.remove).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    expect(harness.api?.remove).toHaveBeenCalledWith("credential-1");
    await expect.element(page.getByText("No saved logins.")).toBeVisible();
  });
});
