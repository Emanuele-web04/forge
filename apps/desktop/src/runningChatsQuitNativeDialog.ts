// FILE: runningChatsQuitNativeDialog.ts
// Purpose: macOS system sheet for quitting while chats are still running.
// Layer: Desktop quit policy
// Depends on: Electron dialog; app display name from desktop identity.

import { type BrowserWindow, dialog } from "electron";

import type { DesktopQuitConfirmationChat } from "@synara/contracts";

const QUIT_BUTTON_INDEX = 1;

export function nativeRunningChatsQuitMessage(appName: string): string {
  return `Quit ${appName}?`;
}

export function nativeRunningChatsQuitDetail(
  chats: ReadonlyArray<Pick<DesktopQuitConfirmationChat, "title">>,
  appName: string,
): string {
  const stopLine = `Work in progress will stop when ${appName} is closed.`;
  if (chats.length === 1) {
    return `"${chats[0]?.title ?? "Untitled thread"}" is still running. ${stopLine}`;
  }
  if (chats.length > 1) {
    return `${chats.length} chats are still running. ${stopLine}`;
  }
  return stopLine;
}

export async function showNativeRunningChatsQuitDialog(input: {
  readonly ownerWindow: BrowserWindow | null;
  readonly appName: string;
  readonly chats: ReadonlyArray<Pick<DesktopQuitConfirmationChat, "title">>;
}): Promise<boolean> {
  const options = {
    type: "warning" as const,
    buttons: ["Cancel", "Quit"],
    defaultId: QUIT_BUTTON_INDEX,
    cancelId: 0,
    noLink: true,
    message: nativeRunningChatsQuitMessage(input.appName),
    detail: nativeRunningChatsQuitDetail(input.chats, input.appName),
  };
  const result = input.ownerWindow
    ? await dialog.showMessageBox(input.ownerWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === QUIT_BUTTON_INDEX;
}
