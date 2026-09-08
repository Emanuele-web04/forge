import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { getSafariAccessInfo, registerSafariAccessIpc } from "./safariAccessIpc";

function setup(platform: NodeJS.Platform = "darwin", systemVersion = "26.0") {
  const options = {
    platform,
    systemVersion,
    execPath: "/Applications/Synara (Dev).app/Contents/MacOS/Synara",
    appName: "Synara",
    isTrustedRenderer: (id: number) => id === 1,
    openExternal: vi.fn(async (_url: string) => {}),
    showItemInFolder: vi.fn(),
  };
  type Handler = (event: IpcMainInvokeEvent) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: (name: string, handler: Handler) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name),
  };
  registerSafariAccessIpc(ipc as unknown as IpcMain, options);
  const mainFrame = {};
  const event = {
    sender: { id: 1, mainFrame },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
  const call = (method: keyof typeof DESKTOP_IPC_CHANNELS.safariAccess, input = event) =>
    handlers.get(DESKTOP_IPC_CHANNELS.safariAccess[method])!(input);
  return { options, call, event };
}

describe("Safari access setup IPC", () => {
  it("identifies the running bundle, not a hard-coded production app", async () => {
    const { options, call } = setup();
    await expect(call("getInfo")).resolves.toEqual({
      supported: true,
      appName: "Synara (Dev)",
      appPath: "/Applications/Synara (Dev).app",
    });
    expect(options.openExternal).not.toHaveBeenCalled();
    await expect(call("revealApp")).resolves.toBe(true);
    expect(options.showItemInFolder).toHaveBeenCalledExactlyOnceWith(
      "/Applications/Synara (Dev).app",
    );
    expect(getSafariAccessInfo({ ...options, execPath: "/usr/bin/synara" })).toEqual({
      supported: true,
      appName: "Synara",
      appPath: null,
    });
  });

  it.each([
    ["26.0", "com.apple.settings.PrivacySecurity.extension"],
    ["13.0", "com.apple.settings.PrivacySecurity.extension"],
    ["12.7", "com.apple.preference.security"],
  ])(
    "opens the supported settings URL on macOS %s without claiming permission",
    async (version, pane) => {
      const { options, call } = setup("darwin", version);
      await expect(call("openSettings")).resolves.toBe(true);
      expect(options.openExternal).toHaveBeenCalledExactlyOnceWith(
        `x-apple.systempreferences:${pane}?Privacy_AllFiles`,
      );
      expect(await call("getInfo")).not.toHaveProperty("granted");
      options.openExternal.mockRejectedValueOnce(new Error("private OS error"));
      await expect(call("openSettings")).resolves.toBe(false);
    },
  );

  it.each(["win32", "linux", "freebsd"] as const)("does nothing on %s", async (platform) => {
    const { options, call } = setup(platform);
    await expect(call("getInfo")).resolves.toEqual({ supported: false });
    await expect(call("openSettings")).resolves.toBe(false);
    await expect(call("revealApp")).resolves.toBe(false);
    expect(options.openExternal).not.toHaveBeenCalled();
    expect(options.showItemInFolder).not.toHaveBeenCalled();
  });

  it("rejects browser pages and subframes for every setup operation", async () => {
    const { options, call, event } = setup();
    for (const method of ["getInfo", "openSettings", "revealApp"] as const) {
      await expect(
        call(method, { ...event, senderFrame: {} } as IpcMainInvokeEvent),
      ).rejects.toThrow("access denied");
      await expect(
        call(method, { ...event, sender: { ...event.sender, id: 9 } } as IpcMainInvokeEvent),
      ).rejects.toThrow("access denied");
    }
    expect(options.openExternal).not.toHaveBeenCalled();
    expect(options.showItemInFolder).not.toHaveBeenCalled();
  });

  it("handles Finder failure without exposing OS details", async () => {
    const { options, call } = setup();
    options.showItemInFolder.mockImplementationOnce(() => {
      throw new Error("private OS error");
    });
    await expect(call("revealApp")).resolves.toBe(false);
  });
});
