import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { BrowserVault } from "./browserAutomation/browserVault";
import type { DesktopBrowserManager } from "./browserManager";
import { registerBrowserVaultIpc } from "./browserVaultIpc";
import { BROWSER_IPC_CHANNELS } from "./ipcChannels";

describe("browser vault IPC", () => {
  it("requires the trusted shell's main frame before invoking owner operations", async () => {
    type Handler = (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>;
    const handlers = new Map<string, Handler>();
    const ipc = {
      handle: (name: string, handler: Handler) => handlers.set(name, handler),
      removeHandler: (name: string) => handlers.delete(name),
    };
    const vault = {
      snapshot: vi.fn(async () => ({ logins: [] })),
      configure: vi.fn(),
      remove: vi.fn(),
      respond: vi.fn(),
      setupMaster: vi.fn(),
      unlock: vi.fn(),
      lock: vi.fn(),
      reveal: vi.fn(),
      onChanged: () => () => {},
    };
    const manager = { isTrustedRenderer: (id: number) => id === 1 };
    const dispose = registerBrowserVaultIpc(
      ipc as unknown as IpcMain,
      manager as unknown as DesktopBrowserManager,
      vault as unknown as BrowserVault,
      vi.fn(),
    );
    const mainFrame = {};
    const trusted = {
      sender: { id: 1, mainFrame },
      senderFrame: mainFrame,
    } as unknown as IpcMainInvokeEvent;
    const get = handlers.get(BROWSER_IPC_CHANNELS.vault.snapshot)!;
    await expect(get({ ...trusted, senderFrame: {} } as IpcMainInvokeEvent)).rejects.toThrow(
      "denied",
    );
    await expect(
      get({
        sender: { id: 9, mainFrame },
        senderFrame: mainFrame,
      } as unknown as IpcMainInvokeEvent),
    ).rejects.toThrow("denied");
    expect(vault.snapshot).not.toHaveBeenCalled();
    for (const channel of [
      BROWSER_IPC_CHANNELS.vault.setupMaster,
      BROWSER_IPC_CHANNELS.vault.unlock,
      BROWSER_IPC_CHANNELS.vault.reveal,
      BROWSER_IPC_CHANNELS.vault.importCookies,
    ]) {
      await expect(
        handlers.get(channel)!({ ...trusted, senderFrame: {} } as IpcMainInvokeEvent, {
          id: "record",
          password: "synthetic-secret",
        }),
      ).rejects.toThrow("denied");
      await expect(
        handlers.get(channel)!(
          { sender: { id: 9, mainFrame }, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent,
          "synthetic-secret",
        ),
      ).rejects.toThrow("denied");
    }
    expect(vault.reveal).not.toHaveBeenCalled();
    expect(vault.setupMaster).not.toHaveBeenCalled();
    expect(vault.unlock).not.toHaveBeenCalled();
    await expect(get(trusted)).resolves.toEqual({ logins: [] });
    await expect(
      handlers.get(BROWSER_IPC_CHANNELS.vault.configure)!(trusted, { agentUse: "yes" }),
    ).rejects.toThrow("could not be completed");
    expect(vault.configure).not.toHaveBeenCalled();
    vault.snapshot.mockRejectedValueOnce(new Error("synthetic-private-secret"));
    const error = await get(trusted).catch((error: Error) => error);
    expect(String(error)).not.toContain("synthetic-private-secret");
    dispose();
    expect(handlers.size).toBe(0);
  });
});
