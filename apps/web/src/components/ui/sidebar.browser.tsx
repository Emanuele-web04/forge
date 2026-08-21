// FILE: sidebar.browser.tsx
// Purpose: Browser regressions for responsive sidebar presentation.
// Layer: Sidebar UI primitive test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Sidebar, SidebarProvider } from "./sidebar";

describe("responsive sidebar", () => {
  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1_280, 800);
  });

  it("opens an opted-in mobile home without changing the desktop sidebar", async () => {
    await page.viewport(430, 932);
    const mobile = await render(
      <SidebarProvider defaultOpenMobile>
        <Sidebar>
          <div>Activity home</div>
        </Sidebar>
      </SidebarProvider>,
    );

    await expect.element(page.getByText("Activity home")).toBeVisible();
    expect(document.querySelector('[data-mobile="true"]')).not.toBeNull();
    await mobile.unmount();

    await page.viewport(1_280, 800);
    const desktop = await render(
      <SidebarProvider defaultOpenMobile>
        <Sidebar>
          <div>Desktop sidebar</div>
        </Sidebar>
      </SidebarProvider>,
    );

    await expect.element(page.getByText("Desktop sidebar")).toBeVisible();
    expect(document.querySelector('[data-mobile="true"]')).toBeNull();
    expect(document.querySelector('[data-slot="sidebar-container"]')).not.toBeNull();
    await desktop.unmount();
  });
});
