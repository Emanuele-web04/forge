// FILE: AppIconPicker.browser.tsx
// Purpose: Verify the visual app-icon picker exposes and applies the two supported choices.
// Layer: Browser UI test

import "../../index.css";

import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppIconPicker } from "./AppIconPicker";

function readTopLeftAlpha(image: HTMLImageElement): number {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  context?.drawImage(image, 0, 0);
  return context?.getImageData(0, 0, 1, 1).data[3] ?? -1;
}

it("uses inset transparent artwork and selects it", async () => {
  const onValueChange = vi.fn();
  const mounted = await render(<AppIconPicker value="default" onValueChange={onValueChange} />);

  await expect.element(mounted.getByRole("button", { name: "Default icon" })).toBeVisible();
  const iconButton = mounted.getByRole("button", { name: "Icon", exact: true });
  const artwork = iconButton.element().querySelector("img");
  if (!(artwork instanceof HTMLImageElement)) throw new Error("Icon artwork is missing");
  await vi.waitFor(() => expect(artwork.complete).toBe(true));
  const buttonRect = iconButton.element().getBoundingClientRect();
  const artworkRect = artwork.getBoundingClientRect();

  expect(buttonRect.width).toBe(50);
  expect(artworkRect.width).toBe(40);
  expect(artworkRect.left).toBe(buttonRect.left + 5);
  expect(artworkRect.top).toBe(buttonRect.top + 5);
  expect(readTopLeftAlpha(artwork)).toBe(0);

  await iconButton.click();

  expect(onValueChange).toHaveBeenCalledWith("icon");
});
