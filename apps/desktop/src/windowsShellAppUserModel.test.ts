import { describe, expect, it } from "vitest";

import {
  nativeWindowHandleToHwnd,
  windowsShellAppUserModelHelperName,
  windowsShellIconResource,
  WINDOWS_SHELL_APPUSERMODEL_SOURCE,
  WINDOWS_SHELL_HELPER_TIMEOUT_MS,
} from "./windowsShellAppUserModel";

describe("windowsShellAppUserModel", () => {
  it("formats a shell icon resource with an explicit index", () => {
    expect(windowsShellIconResource("C:\\icons\\app.ico", 0)).toBe("C:\\icons\\app.ico,0");
  });

  it("reads a 64-bit HWND from Electron's native handle buffer", () => {
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(0x00000000ffff1234n, 0);
    expect(nativeWindowHandleToHwnd(handle)).toBe(0x00000000ffff1234n);
  });

  it("writes relaunch icon, command, and display name before AppUserModelID", () => {
    const iconIndex = WINDOWS_SHELL_APPUSERMODEL_SOURCE.indexOf("uint[] { 3, 2, 4, 5 }");
    const idComment = WINDOWS_SHELL_APPUSERMODEL_SOURCE.indexOf(
      "set relaunch properties BEFORE AppUserModelID",
    );
    expect(iconIndex).toBeGreaterThan(0);
    expect(idComment).toBeGreaterThan(0);
    expect(idComment).toBeLessThan(iconIndex);
    expect(WINDOWS_SHELL_APPUSERMODEL_SOURCE).toContain("[PreserveSig]");
    expect(WINDOWS_SHELL_APPUSERMODEL_SOURCE).toContain("[STAThread]");
    expect(WINDOWS_SHELL_APPUSERMODEL_SOURCE).toContain("ItemChangeNotify");
    expect(WINDOWS_SHELL_APPUSERMODEL_SOURCE).toContain("ApplyAll");
    expect(WINDOWS_SHELL_APPUSERMODEL_SOURCE).toMatch(/if \(next < 0\) return next;\s+return 0;/);
    expect(WINDOWS_SHELL_APPUSERMODEL_SOURCE).not.toContain(
      "modify(list, pidl, pidl, PLMC_EXPLORER)",
    );
    expect(WINDOWS_SHELL_APPUSERMODEL_SOURCE).not.toContain("WM_SETICON");
    expect(WINDOWS_SHELL_APPUSERMODEL_SOURCE).not.toContain("PostMessage");
    expect(WINDOWS_SHELL_APPUSERMODEL_SOURCE).not.toContain("SendMessage");
    expect(WINDOWS_SHELL_APPUSERMODEL_SOURCE).not.toContain("DeleteTab");
    expect(WINDOWS_SHELL_APPUSERMODEL_SOURCE).not.toContain("FileIconInit");
  });

  it("names the helper from the source hash so a source change rebuilds it", () => {
    expect(windowsShellAppUserModelHelperName()).toMatch(
      /^windows-shell-appusermodel-[0-9a-f]{12}\.exe$/,
    );
  });

  it("bounds helper execution so Explorer COM cannot freeze Electron main", () => {
    expect(WINDOWS_SHELL_HELPER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(WINDOWS_SHELL_HELPER_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});
