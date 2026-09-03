// FILE: AppIconPicker.browser.tsx
// Purpose: Verify the visual app-icon picker exposes and applies platform-supported choices.
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
  const mounted = await render(
    <AppIconPicker platform="MacIntel" value="default" onValueChange={onValueChange} />,
  );

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

it("shows a loading state and ignores extra clicks while an apply is in flight", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const onValueChange = vi.fn(() => pending);
  const mounted = await render(
    <AppIconPicker platform="Win32" value="default" onValueChange={onValueChange} />,
  );

  const iconButton = mounted.getByRole("button", { name: "Icon", exact: true });
  const defaultIconButton = mounted.getByRole("button", { name: "Default icon" });
  await iconButton.click();
  await expect.element(mounted.getByRole("status", { name: "Updating app icon" })).toBeVisible();
  await expect.element(defaultIconButton).toBeDisabled();
  await expect.element(iconButton).toBeDisabled();
  expect(onValueChange).toHaveBeenCalledTimes(1);

  release?.();
  await vi.waitFor(() => expect.element(defaultIconButton).toBeEnabled());
  expect(onValueChange).toHaveBeenCalledTimes(1);
});

it("clears the loading state without leaking a rejected apply", async () => {
  const applyError = new Error("native icon apply failed");
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    unhandledRejections.push(event.reason);
  };
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  try {
    const mounted = await render(
      <AppIconPicker
        platform="Win32"
        value="default"
        onValueChange={() => Promise.reject(applyError)}
      />,
    );
    const iconButton = mounted.getByRole("button", { name: "Icon", exact: true });

    await iconButton.click();
    await vi.waitFor(() => expect.element(iconButton).toBeEnabled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandledRejections).toEqual([]);
  } finally {
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  }
});

it("offers the dark icon on macOS", async () => {
  const onValueChange = vi.fn();
  const mounted = await render(
    <AppIconPicker platform="MacIntel" value="default" onValueChange={onValueChange} />,
  );

  const darkIconButton = mounted.getByRole("button", { name: "Dark icon" });
  await expect.element(darkIconButton).toBeVisible();
  await darkIconButton.click();

  expect(onValueChange).toHaveBeenCalledWith("dark");
});

it("hides the unsupported dark icon off macOS", async () => {
  const mounted = await render(
    <AppIconPicker platform="Win32" value="default" onValueChange={vi.fn()} />,
  );

  await expect.element(mounted.getByRole("button", { name: "Dark icon" })).not.toBeInTheDocument();
});
