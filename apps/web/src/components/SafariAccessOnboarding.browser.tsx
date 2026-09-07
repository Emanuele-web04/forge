import "../index.css";
import type { DesktopBridge } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { SafariAccessOnboarding, SafariAccessSetupButton, SAFARI_ACCESS_STORAGE_KEY } from "./SafariAccessOnboarding";

const originalBridge = window.desktopBridge;
const api = {
  getInfo: vi.fn(async () => ({ supported: true as const, appName: "Synara (Dev)", appPath: "/Applications/Synara (Dev).app" })),
  openSettings: vi.fn(async () => true),
  revealApp: vi.fn(async () => true),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem(SAFARI_ACCESS_STORAGE_KEY);
  window.desktopBridge = { safariAccess: api } as unknown as DesktopBridge;
});
afterEach(() => { window.desktopBridge = originalBridge; localStorage.removeItem(SAFARI_ACCESS_STORAGE_KEY); });

function Harness() {
  return <><SafariAccessOnboarding><p>Next welcome</p></SafariAccessOnboarding><SafariAccessSetupButton /></>;
}

describe("Safari access onboarding", () => {
  it("shows optional first-launch guidance and serializes other welcome dialogs", async () => {
    await render(<Harness />);
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByText("Next welcome")).not.toBeInTheDocument();
    await expect.element(page.getByRole("dialog")).toHaveTextContent("This is optional");
    await expect.element(page.getByRole("dialog")).toHaveTextContent("broad macOS permission");
    await expect.element(page.getByRole("dialog")).toHaveTextContent("/Applications/Synara (Dev).app");
    expect(api.openSettings).not.toHaveBeenCalled();
    expect(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)).toBeNull();
  });

  it.each(["Set up later", "Continue to Synara"])("persists %s across remounts and allows revisiting", async (name) => {
    const mounted = await render(<Harness />);
    await page.getByRole("button", { name, exact: true }).click();
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    expect(JSON.parse(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)!)).toBe(name === "Set up later" ? "later" : "continued");
    await mounted.unmount();
    await render(<Harness />);
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Safari import setup" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
  });

  it("opening Settings is not permission approval or an acknowledged intro", async () => {
    await render(<Harness />);
    await page.getByRole("button", { name: "Open System Settings" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("Access is not verified");
    expect(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)).toBeNull();
    await page.getByRole("button", { name: "Show app in Finder" }).click();
    expect(api.revealApp).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("status")).toHaveTextContent("running app");
  });

  it.each([false, "reject"])("leaves manual settings and skip available after open failure %s", async (failure) => {
    if (failure === false) api.openSettings.mockResolvedValueOnce(false);
    else api.openSettings.mockRejectedValueOnce(new Error("private failure"));
    await render(<Harness />);
    await page.getByRole("button", { name: "Open System Settings" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("manually");
    await expect.element(page.getByRole("status")).not.toHaveTextContent("private failure");
    await page.getByRole("button", { name: "Set up later" }).click();
    await expect.element(page.getByText("Next welcome")).toBeVisible();
  });

  it.each(["web", "unsupported", "unavailable"])("does not show macOS onboarding on %s", async (mode) => {
    if (mode === "web") window.desktopBridge = undefined;
    else window.desktopBridge = { safariAccess: { ...api, getInfo: mode === "unsupported" ? async () => ({ supported: false }) : async () => { throw new Error("unavailable"); } } } as unknown as DesktopBridge;
    await render(<Harness />);
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Safari import setup" })).not.toBeInTheDocument();
    expect(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)).toBeNull();
  });

  it("does not reopen for a late Settings response after skipping", async () => {
    let resolve!: (opened: boolean) => void;
    api.openSettings.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render(<Harness />);
    await page.getByRole("button", { name: "Open System Settings" }).click();
    await page.getByRole("button", { name: "Set up later" }).click();
    resolve(true);
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });
});
