// FILE: desktopWindowClosePolicy.ts
// Purpose: Decides whether an opted-in packaged desktop close should hide the window.
// Layer: Desktop main process
// Depends on: Electron lifecycle state supplied by the caller.

export function shouldKeepDesktopRunningAfterWindowClose(input: {
  readonly configuredValue: string | undefined;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly shutdownComplete: boolean;
  readonly appQuitRequested: boolean;
  readonly updaterHandoffActive: boolean;
}): boolean {
  return (
    input.configuredValue === "1" &&
    input.isPackaged &&
    (input.platform === "win32" || input.platform === "linux") &&
    !input.shutdownComplete &&
    !input.appQuitRequested &&
    !input.updaterHandoffActive
  );
}
