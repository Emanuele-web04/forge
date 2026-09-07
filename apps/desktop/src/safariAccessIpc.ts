import { basename, dirname } from "node:path";
import type { DesktopSafariAccessInfo } from "@synara/contracts";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

interface SafariAccessOptions {
  platform: NodeJS.Platform;
  systemVersion: string;
  execPath: string;
  appName: string;
  isTrustedRenderer: (id: number) => boolean;
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (path: string) => void;
}

export function getSafariAccessInfo(options: SafariAccessOptions): DesktopSafariAccessInfo {
  if (options.platform !== "darwin") return { supported: false };
  const bundle = dirname(dirname(dirname(options.execPath)));
  const appPath = bundle.endsWith(".app") ? bundle : null;
  return {
    supported: true,
    appName: appPath ? basename(appPath, ".app") : options.appName,
    appPath,
  };
}

export function registerSafariAccessIpc(ipcMain: IpcMain, options: SafariAccessOptions): void {
  const handle = (channel: string, action: () => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent) => {
      if (!options.isTrustedRenderer(event.sender.id) || event.senderFrame !== event.sender.mainFrame) {
        throw new Error("Safari setup access denied.");
      }
      return action();
    });
  };
  const info = getSafariAccessInfo(options);
  handle(DESKTOP_IPC_CHANNELS.safariAccess.getInfo, () => info);
  handle(DESKTOP_IPC_CHANNELS.safariAccess.openSettings, async () => {
    if (!info.supported) return false;
    const pane = Number.parseInt(options.systemVersion, 10) >= 13
      ? "com.apple.settings.PrivacySecurity.extension"
      : "com.apple.preference.security";
    try {
      // A successful URL open says nothing about the app's TCC authorization.
      await options.openExternal(`x-apple.systempreferences:${pane}?Privacy_AllFiles`);
      return true;
    } catch {
      return false;
    }
  });
  handle(DESKTOP_IPC_CHANNELS.safariAccess.revealApp, () => {
    if (!info.supported || !info.appPath) return false;
    try {
      options.showItemInFolder(info.appPath);
      return true;
    } catch {
      return false;
    }
  });
}
