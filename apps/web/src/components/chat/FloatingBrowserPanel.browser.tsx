// FILE: FloatingBrowserPanel.browser.tsx
// Purpose: Verify the floating browser shell's real DOM geometry and pointer interactions.
// Layer: Browser UI test

import "../../index.css";

import { ThreadId } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

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
    expect(content.top).toBeLessThanOrEqual(panel.top + 1);
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
  dispatchPointer(header, "pointerdown", 700, 380);
  let overlay = activePointerOverlay();
  dispatchPointer(overlay, "pointermove", 600, 280);
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
  });

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
});
