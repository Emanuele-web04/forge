import { expect, test } from "@playwright/test";
import { prepareRoute } from "../test-helpers";

test.describe("documentation chrome", () => {
  test("keeps theme and sidebar controls together while giving Download deliberate width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await prepareRoute(page, "/docs", "light");

    const sidebar = page.locator("#nd-sidebar");
    const theme = sidebar.getByRole("button", { name: "Switch to dark mode" });
    const collapse = sidebar.getByRole("button", { name: "Collapse Sidebar" });
    const download = sidebar.getByRole("link", {
      name: "Download",
      exact: true,
    });
    const changelog = sidebar.getByRole("link", {
      name: "Changelog",
      exact: true,
    });

    await expect(theme).toBeVisible();
    await expect(collapse).toBeVisible();
    await expect(download).toHaveAttribute("href", "/install");

    const [sidebarBox, themeBox, collapseBox, downloadBox, changelogBox] = await Promise.all([
      sidebar.boundingBox(),
      theme.boundingBox(),
      collapse.boundingBox(),
      download.boundingBox(),
      changelog.boundingBox(),
    ]);

    expect(sidebarBox).not.toBeNull();
    expect(themeBox).not.toBeNull();
    expect(collapseBox).not.toBeNull();
    expect(downloadBox).not.toBeNull();
    expect(changelogBox).not.toBeNull();

    expect(Math.abs(themeBox!.y - collapseBox!.y)).toBeLessThanOrEqual(2);
    expect(themeBox!.x + themeBox!.width).toBeLessThanOrEqual(collapseBox!.x + 1);
    expect(themeBox!.y).toBeLessThan(64);
    expect(downloadBox!.width).toBeGreaterThanOrEqual(sidebarBox!.width * 0.75);
    expect(downloadBox!.y).toBeGreaterThan(changelogBox!.y);

    await theme.focus();
    await expect(theme).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(sidebar.getByRole("button", { name: "Switch to light mode" })).toBeVisible();
  });

  test("keeps the theme toggle in the mobile top bar and Download wide in the drawer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await prepareRoute(page, "/docs", "light");

    const header = page.locator("#nd-subnav");
    const theme = header.getByRole("button", { name: "Switch to dark mode" });
    const sidebarTrigger = header.getByRole("button", { name: "Open Sidebar" });

    await expect(theme).toBeVisible();
    await expect(sidebarTrigger).toBeVisible();

    const [headerBox, themeBox, triggerBox] = await Promise.all([
      header.boundingBox(),
      theme.boundingBox(),
      sidebarTrigger.boundingBox(),
    ]);
    expect(headerBox).not.toBeNull();
    expect(themeBox).not.toBeNull();
    expect(triggerBox).not.toBeNull();
    expect(themeBox!.y).toBeGreaterThanOrEqual(headerBox!.y);
    expect(themeBox!.y + themeBox!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height);
    expect(themeBox!.x + themeBox!.width).toBeLessThanOrEqual(triggerBox!.x);

    await theme.click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    await sidebarTrigger.click();
    const drawer = page.locator("#nd-sidebar-mobile");
    const download = drawer.getByRole("link", {
      name: "Download",
      exact: true,
    });
    await expect(drawer).toBeVisible();
    await expect(download).toBeVisible();
    await expect(download).toHaveAttribute("href", "/install");

    const [drawerBox, downloadBox] = await Promise.all([
      drawer.boundingBox(),
      download.boundingBox(),
    ]);
    expect(drawerBox).not.toBeNull();
    expect(downloadBox).not.toBeNull();
    expect(downloadBox!.width).toBeGreaterThanOrEqual(drawerBox!.width * 0.75);
    expect(downloadBox!.x).toBeGreaterThanOrEqual(drawerBox!.x);
    expect(downloadBox!.x + downloadBox!.width).toBeLessThanOrEqual(
      drawerBox!.x + drawerBox!.width,
    );
  });
});
