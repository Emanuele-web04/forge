import { describe, expect, it } from "vitest";

import { shouldKeepDesktopRunningAfterWindowClose } from "./desktopWindowClosePolicy";

const enabledPackagedWindows = {
  configuredValue: "1",
  isPackaged: true,
  platform: "win32",
  shutdownComplete: false,
  appQuitRequested: false,
  updaterHandoffActive: false,
} as const;

describe("desktop window close policy", () => {
  it("keeps an opted-in packaged Windows or Linux runtime alive", () => {
    expect(shouldKeepDesktopRunningAfterWindowClose(enabledPackagedWindows)).toBe(true);
    expect(
      shouldKeepDesktopRunningAfterWindowClose({
        ...enabledPackagedWindows,
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("leaves the default and development close behavior unchanged", () => {
    expect(
      shouldKeepDesktopRunningAfterWindowClose({
        ...enabledPackagedWindows,
        configuredValue: undefined,
      }),
    ).toBe(false);
    expect(
      shouldKeepDesktopRunningAfterWindowClose({
        ...enabledPackagedWindows,
        isPackaged: false,
      }),
    ).toBe(false);
  });

  it("never hides the window from an explicit app or updater quit", () => {
    expect(
      shouldKeepDesktopRunningAfterWindowClose({
        ...enabledPackagedWindows,
        appQuitRequested: true,
      }),
    ).toBe(false);
    expect(
      shouldKeepDesktopRunningAfterWindowClose({
        ...enabledPackagedWindows,
        updaterHandoffActive: true,
      }),
    ).toBe(false);
    expect(
      shouldKeepDesktopRunningAfterWindowClose({
        ...enabledPackagedWindows,
        shutdownComplete: true,
      }),
    ).toBe(false);
  });

  it("does not change macOS close behavior", () => {
    expect(
      shouldKeepDesktopRunningAfterWindowClose({
        ...enabledPackagedWindows,
        platform: "darwin",
      }),
    ).toBe(false);
  });
});
