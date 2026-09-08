// FILE: appSnapIpc.ts
// Purpose: Centralizes the desktop AppSnap IPC contract and renderer push events.
// Layer: Desktop IPC adapter
// Depends on: Electron IPC and DesktopAppSnapManager.

import type { IpcMain, WebContents } from "electron";
import type {
  DesktopAppSnapCapture,
  DesktopAppSnapErrorEvent,
  DesktopAppSnapPermissionGuideState,
  DesktopAppSnapSettingsPane,
  DesktopAppSnapState,
} from "@synara/contracts";

import type { DesktopAppSnapManager } from "./appSnapManager";
import { APPSNAP_IPC_CHANNELS } from "./ipcChannels";

export const APP_SNAP_SETTINGS_PANE_URLS: Record<DesktopAppSnapSettingsPane, string> = {
  "input-monitoring": "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

export interface AppSnapIpcHandlerOptions {
  openPermissionSettingsPane: (pane: DesktopAppSnapSettingsPane) => Promise<boolean>;
  restartApp: () => void;
}

function parseSettingsPane(value: unknown): DesktopAppSnapSettingsPane | null {
  return value === "input-monitoring" || value === "screen-recording" ? value : null;
}

export function sendAppSnapState(
  webContents: WebContents | null | undefined,
  state: DesktopAppSnapState,
): void {
  webContents?.send(APPSNAP_IPC_CHANNELS.state, state);
}

export function sendAppSnapCaptured(
  webContents: WebContents | null | undefined,
  capture: DesktopAppSnapCapture,
): void {
  webContents?.send(APPSNAP_IPC_CHANNELS.captured, capture);
}

export function sendAppSnapError(
  webContents: WebContents | null | undefined,
  error: DesktopAppSnapErrorEvent,
): void {
  webContents?.send(APPSNAP_IPC_CHANNELS.error, error);
}

export function sendAppSnapPermissionGuideState(
  webContents: WebContents | null | undefined,
  state: DesktopAppSnapPermissionGuideState,
): void {
  webContents?.send(APPSNAP_IPC_CHANNELS.permissionGuideState, state);
}

export function registerAppSnapIpcHandlers(
  ipcMain: IpcMain,
  manager: DesktopAppSnapManager,
  options: AppSnapIpcHandlerOptions,
): void {
  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.getState);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.getState, async () => manager.refreshState());

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.setEnabled);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.setEnabled, async (_event, enabled: unknown) =>
    manager.setEnabled(enabled === true),
  );

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.checkShortcut);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.checkShortcut, async (_event, shortcut: unknown) =>
    manager.checkShortcut(shortcut),
  );

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.setShortcut);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.setShortcut, async (_event, shortcut: unknown) =>
    manager.setShortcut(shortcut),
  );

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.requestPermissions);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.requestPermissions, async () => manager.requestPermissions());

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.listPendingCaptures);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.listPendingCaptures, async () =>
    manager.listPendingCaptures(),
  );

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.acknowledgeCapture);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.acknowledgeCapture, async (_event, captureId: unknown) => {
    if (typeof captureId === "string") await manager.acknowledgeCapture(captureId);
  });

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.listWindows);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.listWindows, async () => manager.listWindows());

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.captureWindow);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.captureWindow, async (_event, input: unknown) => {
    const windowId =
      typeof input === "object" && input !== null
        ? (input as { windowId?: unknown }).windowId
        : undefined;
    if (typeof windowId !== "number" || !Number.isInteger(windowId) || windowId <= 0) {
      throw new Error("captureWindow requires a positive integer window id.");
    }
    return manager.captureWindow(windowId);
  });

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.openPermissionSettings);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.openPermissionSettings, async (_event, pane: unknown) => {
    const settingsPane = parseSettingsPane(pane);
    if (!settingsPane) return false;
    return options.openPermissionSettingsPane(settingsPane);
  });

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.restartApp);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.restartApp, async () => {
    options.restartApp();
  });

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.showPermissionGuide);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.showPermissionGuide, async (_event, pane: unknown) => {
    const settingsPane = parseSettingsPane(pane);
    if (!settingsPane) return;
    manager.showPermissionGuide(settingsPane);
  });

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.hidePermissionGuide);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.hidePermissionGuide, async () => {
    manager.hidePermissionGuide();
  });
}
