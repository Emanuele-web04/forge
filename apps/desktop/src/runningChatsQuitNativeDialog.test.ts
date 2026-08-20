import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { showMessageBoxMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: {
    showMessageBox: showMessageBoxMock,
  },
}));

import {
  nativeRunningChatsQuitDetail,
  nativeRunningChatsQuitMessage,
  showNativeRunningChatsQuitDialog,
} from "./runningChatsQuitNativeDialog";

describe("native running chats quit dialog", () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset();
  });

  it("builds ChatGPT-style warning copy", () => {
    expect(nativeRunningChatsQuitMessage("Synara")).toBe("Quit Synara?");
    expect(nativeRunningChatsQuitDetail([], "Synara")).toBe(
      "Work in progress will stop when Synara is closed.",
    );
    expect(nativeRunningChatsQuitDetail([{ title: "Fix the tray" }], "Synara")).toBe(
      '"Fix the tray" is still running. Work in progress will stop when Synara is closed.',
    );
    expect(
      nativeRunningChatsQuitDetail([{ title: "One" }, { title: "Two" }], "Synara Canary"),
    ).toBe("2 chats are still running. Work in progress will stop when Synara Canary is closed.");
  });

  it("shows a warning sheet on the owner window and quits on the default button", async () => {
    const ownerWindow = { id: 1 } as BrowserWindow;
    showMessageBoxMock.mockResolvedValue({ response: 1 });

    const allowed = await showNativeRunningChatsQuitDialog({
      ownerWindow,
      appName: "Synara",
      chats: [{ title: "Fix the tray" }],
    });

    expect(allowed).toBe(true);
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      ownerWindow,
      expect.objectContaining({
        type: "warning",
        buttons: ["Cancel", "Quit"],
        defaultId: 1,
        cancelId: 0,
        message: "Quit Synara?",
      }),
    );
  });

  it("stays when Cancel is chosen, including without an owner window", async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 });

    const allowed = await showNativeRunningChatsQuitDialog({
      ownerWindow: null,
      appName: "Synara",
      chats: [{ title: "One" }, { title: "Two" }],
    });

    expect(allowed).toBe(false);
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Quit Synara?",
        detail:
          "2 chats are still running. Work in progress will stop when Synara is closed.",
      }),
    );
  });
});
