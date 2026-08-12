// FILE: fileReferenceContextMenu.test.ts
// Purpose: Verifies file-reference menu labels and desktop reveal/copy actions.
// Layer: Web UI helper tests

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  clicked: null as string | null,
  copyText: vi.fn(),
  showContextMenu: vi.fn(),
  showInFolder: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  copyTextToClipboard: harness.copyText,
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    contextMenu: { show: harness.showContextMenu },
    shell: { showInFolder: harness.showInFolder },
  }),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

import { getRevealInFolderLabel, showFileReferenceContextMenu } from "./fileReferenceContextMenu";

beforeEach(() => {
  vi.stubGlobal("window", { desktopBridge: {} });
  vi.stubGlobal("navigator", { platform: "Win32" });
  harness.clicked = null;
  harness.copyText.mockReset();
  harness.showContextMenu.mockReset();
  harness.showInFolder.mockReset();
  harness.toast.mockReset();
  harness.showContextMenu.mockImplementation(async () => harness.clicked);
  harness.copyText.mockResolvedValue(undefined);
  harness.showInFolder.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getRevealInFolderLabel", () => {
  it("uses the native file-manager name on supported desktop platforms", () => {
    expect(getRevealInFolderLabel("Win32")).toBe("Open in Explorer");
    expect(getRevealInFolderLabel("MacIntel")).toBe("Reveal in Finder");
    expect(getRevealInFolderLabel("Linux x86_64")).toBe("Show in folder");
  });
});

describe("showFileReferenceContextMenu", () => {
  it("offers reveal before copy when an absolute reveal path is available", async () => {
    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [
        { id: "reveal-in-folder", label: "Open in Explorer" },
        { id: "copy-path", label: "Copy path" },
      ],
      { x: 12, y: 34 },
    );
  });

  it("hides the desktop-only reveal action in the browser", async () => {
    vi.stubGlobal("window", {});

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [{ id: "copy-path", label: "Copy path" }],
      { x: 12, y: 34 },
    );
  });

  it("reveals the requested file through the desktop shell", async () => {
    harness.clicked = "reveal-in-folder";

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showInFolder).toHaveBeenCalledWith("/repo/output/video.mp4");
    expect(harness.copyText).not.toHaveBeenCalled();
  });

  it("reports a stale file without leaking the shell rejection", async () => {
    harness.clicked = "reveal-in-folder";
    harness.showInFolder.mockRejectedValue(new Error("Folder not found: /repo/output/video.mp4"));

    await expect(
      showFileReferenceContextMenu({
        path: "/repo/output/video.mp4",
        revealPath: "/repo/output/video.mp4",
        position: { x: 12, y: 34 },
        onReferenceInChat: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(harness.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Unable to reveal file",
      description: "Folder not found: /repo/output/video.mp4",
    });
  });

  it("copies the displayed filesystem path with the shared clipboard fallback", async () => {
    harness.clicked = "copy-path";

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.copyText).toHaveBeenCalledWith("/repo/output/video.mp4");
    expect(harness.showInFolder).not.toHaveBeenCalled();
  });
});
