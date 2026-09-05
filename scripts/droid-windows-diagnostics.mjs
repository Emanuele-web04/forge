import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

// Temporary CI diagnosis. Every command below replaces credential access with a literal.
const execFile = childProcess.execFile;
let invocation;
childProcess.execFile = (file, args, options, callback) => {
  invocation = { file, args, options };
  callback(null, "fixture", "");
  return { stdin: { end() {} } };
};
syncBuiltinESMExports();
const { readDroidSecureKey } =
  await import("../apps/server/src/providerUsage/providers/droidSecureStorage.ts");
await readDroidSecureKey({ platform: "win32", homeDir: "/fixture-home", env: {} }, "keyring");
childProcess.execFile = execFile;
syncBuiltinESMExports();
if (!invocation) throw new Error("Missing invocation");
const { file, args, options } = invocation;
const original = args.at(-1);
if (!original.includes("[Console]::Write([FactoryKeyReader]::Get())"))
  throw new Error("Unexpected script");
const script =
  "[Console]::Error.WriteLine('script-start');\n" +
  original.replace("[Console]::Write([FactoryKeyReader]::Get())", "[Console]::Write('compiled')");
const windowsEnv = { ...options.env };
for (const key of [
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramData",
  "SystemDrive",
]) {
  if (process.env[key]) windowsEnv[key] = process.env[key];
}
windowsEnv.windir = process.env.SystemRoot;
windowsEnv.ComSpec = path.win32.join(process.env.SystemRoot, "System32", "cmd.exe");
windowsEnv.PSModulePath = path.win32.join(
  process.env.SystemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "Modules",
);
for (const [label, commandArgs, env] of [
  [
    "simple-type",
    [
      ...args.slice(0, -1),
      "[Console]::Error.WriteLine('before-type'); Add-Type 'public class Empty {}'; [Console]::Write('compiled')",
    ],
    options.env,
  ],
  ["compile-clean", [...args.slice(0, -1), script], options.env],
  [
    "compile-explicit-module",
    [
      ...args.slice(0, -1),
      "$PSModuleAutoLoadingPreference = 'None'; Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'); [Console]::Error.WriteLine('module-imported');\n" +
        script,
    ],
    windowsEnv,
  ],
]) {
  const started = Date.now();
  await new Promise((resolve) => {
    const child = execFile(
      file,
      commandArgs,
      { ...options, env, timeout: 30_000 },
      (error, stdout, stderr) => {
        console.log(
          JSON.stringify({
            label,
            elapsedMs: Date.now() - started,
            code: error?.code,
            killed: error?.killed,
            stdout,
            stderr,
          }),
        );
        resolve();
      },
    );
    child.stdin.end();
  });
}
// Stop this diagnostic-only lane immediately so its logs are available for the real repair.
process.exitCode = 1;
