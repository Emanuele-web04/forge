// FILE: FloatingBrowserPanel.browser.tsx
// Purpose: Verify the floating browser shell's real DOM geometry and pointer interactions.
// Layer: Browser UI test

import "../../index.css";

import { ThreadId } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { BROWSER_PANEL_BOUNDS_SYNC_EVENT } from "../../lib/browserPanelBoundsSync";

vi.mock("../BrowserPanel", () => ({
  default: () => <div className="h-full min-h-0">Browser viewport</div>,
}));

import { FloatingBrowserPanel } from "./FloatingBrowserPanel";

function panelRect(): DOMRect {
  const panel = document.querySelector<HTMLElement>("[data-floating-browser-panel='true']");
  if (!panel) throw new Error("Floating browser panel is missing");
  return panel.getBoundingClientRect();
}

function contentRect(): DOMRect {
  const content = document.querySelector<HTMLElement>("[data-floating-browser-content='true']");
  if (!content) throw new Error("Floating browser content is missing");
  return content.getBoundingClientRect();
}

function dispatchPointer(target: Element, type: string, clientX: number, clientY: number): void {
  const pressed = type === "pointerdown" || type === "pointermove";
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: pressed ? 1 : 0,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: "mouse",
    }),
  );
}

function activePointerOverlay(): HTMLElement {
  const overlay = document.body.querySelector<HTMLElement>(
    ":scope > [data-panel-resize-overlay='true']",
  );
  if (!overlay) throw new Error("Pointer overlay is missing");
  return overlay;
}

it("drags, resizes, and exposes pop/close controls", async () => {
  const onClose = vi.fn();
  const onPopToSidebar = vi.fn();
  const mounted = await render(
    <div className="relative h-[600px] w-[900px] overflow-hidden">
      <FloatingBrowserPanel
        threadId={ThreadId.makeUnsafe("thread-floating-browser")}
        onClose={onClose}
        onPopToSidebar={onPopToSidebar}
      />
    </div>,
  );

  await vi.waitFor(() => {
    const rect = panelRect();
    expect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }).toEqual({
      left: 568,
      top: 388,
      width: 320,
      height: 200,
    });
  });

  await vi.waitFor(() => {
    const panel = panelRect();
    const content = contentRect();
    expect(content.top).toBe(panel.top + 1);
    expect(content.left).toBeLessThanOrEqual(panel.left + 1);
    expect(content.right).toBeGreaterThanOrEqual(panel.right - 1);
    expect(content.bottom).toBeGreaterThanOrEqual(panel.bottom - 1);
  });

  await expect
    .element(mounted.getByRole("button", { name: "Floating browser actions" }))
    .toBeVisible();
  const header = document.querySelector<HTMLElement>("[data-floating-browser-header='true']");
  if (!header) throw new Error("Floating browser drag handle is missing");
  const panel = panelRect();
  expect(header.getBoundingClientRect().top).toBeGreaterThanOrEqual(panel.top);
  expect(header.getBoundingClientRect().right).toBeLessThanOrEqual(panel.right + 1);
  expect(header.getBoundingClientRect().bottom).toBeLessThan(contentRect().bottom);
  dispatchPointer(header, "pointerdown", 700, 380);
  let overlay = activePointerOverlay();
  dispatchPointer(overlay, "pointermove", 600, 280);
  expect(panelRect().left).toBe(468);
  expect(contentRect().left).toBeLessThanOrEqual(469);
  expect(contentRect().top).toBe(panelRect().top + 1);
  dispatchPointer(overlay, "pointerup", 600, 280);

  await vi.waitFor(() => {
    const rect = panelRect();
    expect({ left: rect.left, top: rect.top }).toEqual({ left: 468, top: 288 });
  });

  const southEastHandle = document.querySelector<HTMLElement>("[data-floating-resize-edge='se']");
  if (!southEastHandle) throw new Error("Floating browser resize handle is missing");
  dispatchPointer(southEastHandle, "pointerdown", 784, 484);
  overlay = activePointerOverlay();
  dispatchPointer(overlay, "pointermove", 884, 534);
  dispatchPointer(overlay, "pointerup", 884, 534);

  await vi.waitFor(() => {
    const rect = panelRect();
    expect({ width: rect.width, height: rect.height }).toEqual({ width: 420, height: 263 });
    expect(contentRect().width).toBe(rect.width - 2);
    expect(contentRect().height).toBe(rect.height - 2);
  });

  const host = document.querySelector<HTMLElement>(
    "[data-floating-browser-host='true']",
  )?.parentElement;
  if (!host) throw new Error("Floating browser host is missing");
  const boundsSync = vi.fn();
  window.addEventListener(BROWSER_PANEL_BOUNDS_SYNC_EVENT, boundsSync);
  try {
    host.style.marginLeft = "80px";
    host.style.width = "1000px";
    await vi.waitFor(() => {
      expect(panelRect().left).toBe(548);
      expect(panelRect().width).toBe(420);
      expect(boundsSync).toHaveBeenCalled();
    });
  } finally {
    window.removeEventListener(BROWSER_PANEL_BOUNDS_SYNC_EVENT, boundsSync);
  }

  dispatchPointer(header, "pointerdown", 700, 380);
  overlay = activePointerOverlay();
  dispatchPointer(overlay, "pointerup", 700, 380);
  await expect
    .element(mounted.getByRole("button", { name: "Open browser in sidebar" }))
    .toBeVisible();
  await mounted.getByRole("button", { name: "Open browser in sidebar" }).click();
  dispatchPointer(header, "pointerdown", 700, 380);
  overlay = activePointerOverlay();
  dispatchPointer(overlay, "pointerup", 700, 380);
  await expect
    .element(mounted.getByRole("button", { name: "Close floating browser" }))
    .toBeVisible();
  await mounted.getByRole("button", { name: "Close floating browser" }).click();
  expect(onPopToSidebar).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
  await mounted.unmount();
});

it("drags from the preview without opening it, and expands only on a click", async () => {
  const onPopToSidebar = vi.fn();
  const mounted = await render(
    <div className="relative h-[600px] w-[900px] overflow-hidden">
      <FloatingBrowserPanel
        threadId={ThreadId.makeUnsafe("preview-gestures")}
        onClose={() => {}}
        onPopToSidebar={onPopToSidebar}
      />
    </div>,
  );
  const shield = document.querySelector("[data-floating-browser-preview-shield]")!;
  const sync = vi.fn();
  window.addEventListener(BROWSER_PANEL_BOUNDS_SYNC_EVENT, sync);
  try {
    const before = panelRect();
    dispatchPointer(shield, "pointerdown", 700, 450);
    const overlay = activePointerOverlay();
    dispatchPointer(overlay, "pointermove", 650, 420);
    expect(panelRect().left).toBe(before.left - 50);
    expect(sync).toHaveBeenCalled();
    expect(onPopToSidebar).not.toHaveBeenCalled();
    dispatchPointer(overlay, "pointerup", 650, 420);
    expect(onPopToSidebar).not.toHaveBeenCalled();
    dispatchPointer(shield, "pointerdown", 650, 420);
    dispatchPointer(activePointerOverlay(), "pointerup", 650, 420);
    expect(onPopToSidebar).toHaveBeenCalledOnce();
    dispatchPointer(shield, "pointerdown", 650, 420);
    dispatchPointer(activePointerOverlay(), "pointercancel", 650, 420);
    expect(onPopToSidebar).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener(BROWSER_PANEL_BOUNDS_SYNC_EVENT, sync);
    await mounted.unmount();
  }
});
