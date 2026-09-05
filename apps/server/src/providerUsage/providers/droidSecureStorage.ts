// Read only the Factory encryption key through OS utilities, never a module from Factory's home.
import { execFile } from "node:child_process";
import nodePath from "node:path";
import { tmpdir } from "node:os";

import type { ProviderUsageContext } from "../types";

// keytar stores a generic credential named service/account with a UTF-8 blob on Windows.
// This fixed script imports only the OS CredReadW/CredFree API; no profile or third-party module.
const WINDOWS_KEY_READER = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FactoryKeyReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredFree")]
  public static extern void Free(IntPtr credential);
  public static string Get() {
    IntPtr pointer;
    if (!Read("Factory CLI/auth-encryption-key", 1, 0, out pointer)) return null;
    try {
      var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (credential.CredentialBlobSize != 44) return null;
      var bytes = new byte[44];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      return System.Text.Encoding.UTF8.GetString(bytes);
    } finally { Free(pointer); }
  }
}
'@
[Console]::Write([FactoryKeyReader]::Get())
`;

export function readDroidSecureKey(
  ctx: Pick<ProviderUsageContext, "platform" | "homeDir" | "env">,
  source: "keyring" | "login-keychain",
): Promise<string | null> {
  let executable: string;
  let args: string[];
  // Do not inherit loader injection variables, shell profiles, API keys, or a user PATH.
  const env: NodeJS.ProcessEnv = { HOME: ctx.homeDir, PATH: "/usr/bin:/bin" };
  if (ctx.platform === "darwin") {
    executable = "/usr/bin/security";
    args = [
      "find-generic-password",
      "-s",
      "Factory CLI",
      "-a",
      source === "login-keychain" ? "auth-encryption-key-security-cli" : "auth-encryption-key",
      "-w",
    ];
  } else if (ctx.platform === "linux" && source === "keyring") {
    executable = "/usr/bin/secret-tool";
    args = ["lookup", "service", "Factory CLI", "account", "auth-encryption-key"];
    for (const key of ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const) {
      if (ctx.env[key]) env[key] = ctx.env[key];
    }
  } else if (ctx.platform === "win32" && source === "keyring") {
    // SystemRoot comes from the server's OS environment, never provider settings or credential data.
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !nodePath.win32.isAbsolute(systemRoot)) return Promise.resolve(null);
    executable = nodePath.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_KEY_READER];
    env.SystemRoot = systemRoot;
    env.TEMP = tmpdir();
    env.TMP = tmpdir();
    env.PATH = nodePath.win32.join(systemRoot, "System32");
  } else {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      args,
      {
        env,
        cwd: nodePath.parse(executable).root || undefined,
        encoding: "utf8",
        // Windows must start PowerShell and compile the fixed interop declaration on a cold run.
        timeout: ctx.platform === "win32" ? 10_000 : 3_000,
        killSignal: "SIGKILL",
        maxBuffer: 4_096,
        windowsHide: true,
      },
      (error, stdout) => {
        // Never propagate child errors: they can contain stdout/stderr and therefore the key.
        resolve(error ? null : stdout.trim());
      },
    );
    child.stdin?.end();
  });
}
