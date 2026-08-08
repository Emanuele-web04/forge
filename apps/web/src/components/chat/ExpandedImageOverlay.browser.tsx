import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { NATIVE_SURFACE_OCCLUSION_SYNC_EVENT } from "~/lib/nativeSurfaceOcclusion";
import { ExpandedImageOverlay } from "./ExpandedImageOverlay";

describe("ExpandedImageOverlay", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders nothing without an expanded image", async () => {
    const screen = await render(
      <ExpandedImageOverlay expandedImage={null} onClose={vi.fn()} onNavigate={vi.fn()} />,
    );

    try {
      await expect
        .element(page.getByRole("dialog", { name: "Expanded image preview" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("renders the selected image and dispatches previous, next, and close", async () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const screen = await render(
      <ExpandedImageOverlay
        expandedImage={{
          images: [
            { src: "data:image/png;base64,first", name: "First image" },
            { src: "data:image/png;base64,second", name: "Second image" },
            { src: "data:image/png;base64,third", name: "Third image" },
          ],
          index: 1,
        }}
        onClose={onClose}
        onNavigate={onNavigate}
      />,
    );

    try {
      await expect.element(page.getByRole("img", { name: "Second image" })).toBeInTheDocument();
      await expect.element(page.getByText("Second image (2/3)")).toBeInTheDocument();

      await page.getByRole("button", { name: "Previous image" }).click();
      await page.getByRole("button", { name: "Next image" }).click();
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close image preview"]')
        ?.click();

      expect(onNavigate).toHaveBeenNthCalledWith(1, -1);
      expect(onNavigate).toHaveBeenNthCalledWith(2, 1);
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("signals native surfaces when the overlay opens and closes", async () => {
    const onOcclusionChange = vi.fn();
    window.addEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, onOcclusionChange);
    const screen = await render(
      <ExpandedImageOverlay expandedImage={null} onClose={vi.fn()} onNavigate={vi.fn()} />,
    );

    try {
      expect(onOcclusionChange).not.toHaveBeenCalled();

      await screen.rerender(
        <ExpandedImageOverlay
          expandedImage={{
            images: [{ src: "data:image/png;base64,preview", name: "Preview image" }],
            index: 0,
          }}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      expect(onOcclusionChange).toHaveBeenCalledTimes(1);

      await screen.rerender(
        <ExpandedImageOverlay expandedImage={null} onClose={vi.fn()} onNavigate={vi.fn()} />,
      );
      expect(onOcclusionChange).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, onOcclusionChange);
      await screen.unmount();
    }
  });
});
