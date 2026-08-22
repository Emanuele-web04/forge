// FILE: windowsShellAppUserModel.ts
// Purpose: Set AppUserModel relaunch properties on Windows shortcuts and windows
//          in Microsoft's required order, bypassing Electron's AppId-first write.
// Layer: Desktop-native Windows shell integration

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

const APPUSERMODEL_FMTID = "9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3";

export const WINDOWS_SHELL_APPUSERMODEL_SOURCE = `
using System;
using System.Runtime.InteropServices;

namespace Synara {
  public static class ShellAppUserModel {
    const ushort VT_LPWSTR = 31;
    const int GPS_READWRITE = 2;
    const uint SHCNE_UPDATEITEM = 0x00002000;
    const uint SHCNF_PATHW = 0x0005;

    [StructLayout(LayoutKind.Explicit)]
    struct PROPVARIANT {
      [FieldOffset(0)] public ushort vt;
      [FieldOffset(8)] public IntPtr pointerValue;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PROPERTYKEY {
      public Guid fmtid;
      public UInt32 pid;
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    interface IPropertyStore {
      [PreserveSig] int GetCount(out uint cProps);
      [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
      [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
      [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
      [PreserveSig] int Commit();
    }

    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid clsid, IntPtr unkOuter, uint clsContext, ref Guid iid, out IntPtr ppv);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHGetPropertyStoreFromParsingName(
      string pszPath, IntPtr pbc, int flags, ref Guid riid, out IPropertyStore ppv);
    [DllImport("shell32.dll")]
    static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid, out IPropertyStore ppv);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr ILCreateFromPathW(string pszPath);
    [DllImport("shell32.dll")]
    static extern void ILFree(IntPtr pidl);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHParseDisplayName(string name, IntPtr bindCtx, out IntPtr pidl, uint sfgaoIn, IntPtr psfgaoOut);

    delegate int NotifyDelegate(IntPtr self, IntPtr a, IntPtr b);
    delegate uint ReleaseDelegate(IntPtr self);

    static readonly Guid FmtId = new Guid("${APPUSERMODEL_FMTID}");
    static readonly Guid IidPropertyStore = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    static readonly Guid CLSID_TaskbandPin = new Guid("90AA3A4E-1CBA-4233-B8BB-535773D48449");
    static readonly Guid IID_IPinnedList3 = new Guid("0DD79AE2-D156-45D4-9EEB-3B549769E940");

    // pid 2 = RelaunchCommand, 3 = RelaunchIconResource, 4 = RelaunchDisplayNameResource, 5 = ID.
    // Microsoft: set relaunch properties BEFORE AppUserModelID so the taskbar snapshot includes the icon.
    static readonly uint[] WriteOrder = new uint[] { 3, 2, 4, 5 };

    public static int ApplyToShortcut(string lnkPath, string appId, string iconResource, string relaunchCommand, string displayName) {
      IPropertyStore store;
      Guid iid = IidPropertyStore;
      int hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, GPS_READWRITE, ref iid, out store);
      if (hr < 0) return hr;
      hr = WriteOrdered(store, appId, iconResource, relaunchCommand, displayName);
      if (hr < 0) return hr;
      hr = store.Commit();
      if (hr < 0) return hr;
      NotifyPath(lnkPath);
      NotifyTaskbarPin(lnkPath);
      return 0;
    }

    public static int ApplyToWindow(long hwndValue, string appId, string iconResource, string relaunchCommand, string displayName) {
      IntPtr hwnd = new IntPtr(hwndValue);
      IPropertyStore store;
      Guid iid = IidPropertyStore;
      int hr = SHGetPropertyStoreForWindow(hwnd, ref iid, out store);
      if (hr < 0) return hr;
      hr = WriteOrdered(store, appId, iconResource, relaunchCommand, displayName);
      if (hr < 0) return hr;
      return store.Commit();
    }

    public static int ApplyAll(string appId, string iconResource, string relaunchCommand, string displayName, string hwndText, string[] lnkPaths) {
      int hr = 0;
      foreach (string lnkPath in lnkPaths) {
        int next = ApplyToShortcut(lnkPath, appId, iconResource, relaunchCommand, displayName);
        if (next < 0) hr = next;
      }
      NotifyIconResource(iconResource);
      NotifyAppsFolder(appId);
      if (hwndText.Length > 0 && hwndText != "-") {
        int next = ApplyToWindow(long.Parse(hwndText), appId, iconResource, relaunchCommand, displayName);
        // A Start Menu/Desktop .lnk failure must not discard a successful
        // window + taskbar pin stamp — that is the live Explorer snapshot.
        if (next < 0) return next;
        return 0;
      }
      return hr;
    }

    static int WriteOrdered(IPropertyStore store, string appId, string iconResource, string relaunchCommand, string displayName) {
      foreach (uint pid in WriteOrder) {
        string value = pid == 3 ? iconResource : pid == 2 ? relaunchCommand : pid == 4 ? displayName : appId;
        int hr = SetString(store, pid, value);
        if (hr < 0) return hr;
      }
      return 0;
    }

    static int SetString(IPropertyStore store, uint pid, string value) {
      var key = new PROPERTYKEY { fmtid = FmtId, pid = pid };
      var pv = new PROPVARIANT { vt = VT_LPWSTR, pointerValue = Marshal.StringToCoTaskMemUni(value) };
      try {
        return store.SetValue(ref key, ref pv);
      } finally {
        Marshal.FreeCoTaskMem(pv.pointerValue);
      }
    }

    static void NotifyPath(string path) {
      IntPtr pathPtr = Marshal.StringToCoTaskMemUni(path);
      try {
        SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW, pathPtr, IntPtr.Zero);
      } finally {
        Marshal.FreeCoTaskMem(pathPtr);
      }
    }

    static void NotifyIconResource(string iconResource) {
      int comma = iconResource.LastIndexOf(',');
      string iconPath = comma > 0 ? iconResource.Substring(0, comma) : iconResource;
      if (iconPath.Length > 0) NotifyPath(iconPath);
    }

    static void NotifyTaskbarPin(string lnkPath) {
      if (lnkPath.IndexOf("User Pinned", StringComparison.OrdinalIgnoreCase) < 0) return;
      if (lnkPath.IndexOf("TaskBar", StringComparison.OrdinalIgnoreCase) < 0) return;
      NotifyPidlFromPath(lnkPath);
    }

    static void NotifyAppsFolder(string appId) {
      IntPtr appsFolder;
      if (SHParseDisplayName("shell:AppsFolder\\\\" + appId, IntPtr.Zero, out appsFolder, 0, IntPtr.Zero) >= 0 && appsFolder != IntPtr.Zero) {
        try { NotifyPidl(appsFolder); }
        finally { ILFree(appsFolder); }
      }
    }

    static void NotifyPidlFromPath(string path) {
      IntPtr pidl = ILCreateFromPathW(path);
      if (pidl == IntPtr.Zero) return;
      try { NotifyPidl(pidl); }
      finally { ILFree(pidl); }
    }

    static void NotifyPidl(IntPtr pidl) {
      TryPinnedListNotify(pidl);
    }

    static void TryPinnedListNotify(IntPtr pidl) {
      Guid clsid = CLSID_TaskbandPin;
      Guid iid = IID_IPinnedList3;
      IntPtr list;
      if (CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out list) < 0 || list == IntPtr.Zero) return;
      try {
        IntPtr vtbl = Marshal.ReadIntPtr(list);
        IntPtr notifyPtr = Marshal.ReadIntPtr(vtbl, IntPtr.Size * 12); // ItemChangeNotify
        NotifyDelegate notify = (NotifyDelegate)Marshal.GetDelegateForFunctionPointer(notifyPtr, typeof(NotifyDelegate));
        notify(list, pidl, pidl);
      } catch {
      } finally {
        IntPtr vtbl = Marshal.ReadIntPtr(list);
        IntPtr releasePtr = Marshal.ReadIntPtr(vtbl, IntPtr.Size * 2);
        ReleaseDelegate release = (ReleaseDelegate)Marshal.GetDelegateForFunctionPointer(releasePtr, typeof(ReleaseDelegate));
        release(list);
      }
    }

    [STAThread]
    public static int Main(string[] args) {
      if (args.Length >= 1 && args[0] == "flush") return 0;
      if (args.Length >= 6 && args[0] == "apply") {
        string[] lnkPaths = new string[Math.Max(0, args.Length - 6)];
        if (lnkPaths.Length > 0) Array.Copy(args, 6, lnkPaths, 0, lnkPaths.Length);
        int applyHr = ApplyAll(args[1], args[2], args[3], args[4], args[5], lnkPaths);
        if (applyHr < 0) {
          Console.Error.WriteLine("0x" + applyHr.ToString("X8"));
          return 1;
        }
        return 0;
      }
      if (args.Length < 6) {
        Console.Error.WriteLine("usage: apply <appId> <iconResource> <relaunchCommand> <displayName> <hwnd|-> [lnk...]");
        return 2;
      }
      string mode = args[0];
      string appId = args[2];
      string iconResource = args[3];
      string relaunchCommand = args[4];
      string displayName = args[5];
      int hr = 2;
      if (mode == "shortcut") hr = ApplyToShortcut(args[1], appId, iconResource, relaunchCommand, displayName);
      else if (mode == "window") hr = ApplyToWindow(long.Parse(args[1]), appId, iconResource, relaunchCommand, displayName);
      if (hr < 0) {
        Console.Error.WriteLine("0x" + hr.ToString("X8"));
        return 1;
      }
      return 0;
    }
  }
}
`.trim();

export interface WindowsShellAppUserModelInput {
  readonly appId: string;
  readonly iconPath: string;
  readonly relaunchCommand: string;
  readonly displayName: string;
  readonly shortcutPaths: readonly string[];
  readonly hwnd?: bigint | number | null;
}

export interface ApplyWindowsShellAppUserModelOptions {
  readonly flush?: boolean;
}

export const WINDOWS_SHELL_HELPER_TIMEOUT_MS = 2500;

export function windowsShellIconResource(iconPath: string, iconIndex = 0): string {
  return `${iconPath},${iconIndex}`;
}

export function nativeWindowHandleToHwnd(handle: Buffer): bigint {
  if (handle.length >= 8) return handle.readBigUInt64LE(0);
  return BigInt(handle.readUInt32LE(0));
}

export function windowsShellAppUserModelHelperName(): string {
  const hash = Crypto.createHash("sha1")
    .update(WINDOWS_SHELL_APPUSERMODEL_SOURCE)
    .digest("hex")
    .slice(0, 12);
  return `windows-shell-appusermodel-${hash}.exe`;
}

export function cscCompilerCandidates(): string[] {
  const root = process.env.WINDIR?.trim() || "C:\\Windows";
  return [
    Path.join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    Path.join(root, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
}

export function resolveCscCompiler(
  exists: (path: string) => boolean = FS.existsSync,
): string | null {
  for (const candidate of cscCompilerCandidates()) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function ensureWindowsShellAppUserModelHelper(cacheDirectory: string): string {
  FS.mkdirSync(cacheDirectory, { recursive: true });
  const exePath = Path.join(cacheDirectory, windowsShellAppUserModelHelperName());
  if (FS.existsSync(exePath)) return exePath;
  const csc = resolveCscCompiler();
  if (!csc) throw new Error("csc.exe not found");
  const csPath = Path.join(cacheDirectory, "windows-shell-appusermodel.cs");
  FS.writeFileSync(csPath, WINDOWS_SHELL_APPUSERMODEL_SOURCE, "utf8");
  const compiled = ChildProcess.spawnSync(
    csc,
    [
      "/nologo",
      "/target:exe",
      "/platform:x64",
      `/main:Synara.ShellAppUserModel`,
      `/out:${exePath}`,
      csPath,
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  if (compiled.status !== 0 || !FS.existsSync(exePath)) {
    throw new Error(compiled.stderr?.toString().trim() || "Failed to compile Windows shell helper");
  }
  return exePath;
}

export function applyWindowsShellAppUserModel(
  input: WindowsShellAppUserModelInput,
  cacheDirectory: string,
  _options?: ApplyWindowsShellAppUserModelOptions,
): void {
  const helper = ensureWindowsShellAppUserModelHelper(cacheDirectory);
  const iconResource = windowsShellIconResource(input.iconPath);
  const hwnd = input.hwnd === undefined || input.hwnd === null ? "-" : String(input.hwnd);
  runHelper(helper, [
    "apply",
    input.appId,
    iconResource,
    input.relaunchCommand,
    input.displayName,
    hwnd,
    ...input.shortcutPaths,
  ]);
}

function runHelper(helper: string, args: string[]): void {
  const result = ChildProcess.spawnSync(helper, args, {
    windowsHide: true,
    encoding: "utf8",
    timeout: WINDOWS_SHELL_HELPER_TIMEOUT_MS,
    killSignal: "SIGTERM",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || result.stdout?.trim() || `helper exited ${result.status}`,
    );
  }
}
