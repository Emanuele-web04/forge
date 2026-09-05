// FILE: ThreadFolderRemovalDialog.browser.tsx
// Purpose: Verifies the explicit folder-removal consequences shown to users.
// Layer: Browser UI test

import "../index.css";

import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadFolderRemovalDialog } from "./ThreadFolderRemovalDialog";

describe("ThreadFolderRemovalDialog", () => {
  it("offers moving threads to the project or archiving them with the folder", async () => {
    const onConfirm = vi.fn(async () => undefined);
    const screen = await render(
      <ThreadFolderRemovalDialog
        open
        folderName="Sidebar changes"
        threadCount={3}
        mode="archive"
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    await expect.element(screen.getByText("Archive folder “Sidebar changes”?")).toBeVisible();
    await expect.element(screen.getByText("Move threads to project")).toBeVisible();
    await expect.element(screen.getByText("Archive folder and threads")).toBeVisible();

    await screen.getByText("Move threads to project").click();
    expect(onConfirm).toHaveBeenCalledWith("move-to-project");
  });

  it("uses destructive copy when deleting the folder and its threads", async () => {
    const screen = await render(
      <ThreadFolderRemovalDialog
        open
        folderName="UI"
        threadCount={2}
        mode="delete"
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    await expect.element(screen.getByText("Delete folder and threads")).toBeVisible();
    expect(document.body.textContent).toContain("permanently delete their conversation history");
  });
});
