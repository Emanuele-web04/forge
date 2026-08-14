#!/usr/bin/env node
// FILE: verify-packaged-desktop-startup.ts
// Purpose: Launches a packaged desktop payload from an isolated temporary tree before upload.
// Layer: Release verification script

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PackagedDesktopPlatform = "linux" | "mac" | "win";

export interface PackagedDesktopStartupOptions {
  readonly assetsDirectory: string;
  readonly platform: PackagedDesktopPlatform;
  readonly arch: string;
  readonly version: string;
  readonly timeoutMs: number;
}

export function parsePackagedDesktopStartupArgs(
  argv: ReadonlyArray<string>,
): PackagedDesktopStartupOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid packaged startup argument near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }
  const known = new Set(["--assets-dir", "--platform", "--arch", "--version", "--timeout-ms"]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown packaged startup argument: ${name}.`);
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`Missing packaged startup argument: ${name}.`);
    return value;
  };
  const platform = required("--platform");
  if (platform !== "linux" && platform !== "mac" && platform !== "win") {
    throw new Error(`Unsupported packaged startup platform: ${platform}.`);
  }
  const timeoutMs = Number(values.get("--timeout-ms") ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) {
    throw new Error("--timeout-ms must be an integer between 5000 and 180000.");
  }
  return {
    assetsDirectory: resolve(required("--assets-dir")),
    platform,
    arch: required("--arch"),
    version: required("--version"),
    timeoutMs,
  };
}

function runCommand(command: string, args: ReadonlyArray<string>, cwd?: string): void {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}.`);
  }
}

function findFiles(root: string, predicate: (path: string) => boolean): string[] {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && predicate(candidate)) {
        matches.push(candidate);
      }
    }
  }
  return matches.sort((left, right) => left.localeCompare(right));
}

function requireSingleAsset(directory: string, suffix: string): string {
  const matches = readdirSync(directory)
    .map((entry) => join(directory, entry))
    .filter((candidate) => statSync(candidate).isFile() && candidate.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${suffix} release asset, found ${matches.length}.`);
  }
  return matches[0]!;
}

interface LaunchCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

function prepareMacLaunch(assetsDirectory: string, extractionRoot: string): LaunchCommand {
  const archive = requireSingleAsset(assetsDirectory, ".zip");
  runCommand("ditto", ["-x", "-k", archive, extractionRoot]);
  const appBundles = readdirSync(extractionRoot).filter((entry) => entry.endsWith(".app"));
  if (appBundles.length !== 1) {
    throw new Error(`Expected one packaged macOS app in ${basename(archive)}.`);
  }
  const appBundle = join(extractionRoot, appBundles[0]!);
  const executables = findFiles(join(appBundle, "Contents", "MacOS"), (candidate) =>
    statSync(candidate).isFile(),
  );
  if (executables.length !== 1) {
    throw new Error(`Expected one macOS main executable, found ${executables.length}.`);
  }
  return { command: executables[0]!, args: [], cwd: appBundle };
}

function prepareLinuxLaunch(assetsDirectory: string, extractionRoot: string): LaunchCommand {
  const collectedAppImage = requireSingleAsset(assetsDirectory, ".AppImage");
  const appImage = join(extractionRoot, basename(collectedAppImage));
  copyFileSync(collectedAppImage, appImage);
  chmodSync(appImage, 0o755);
  runCommand(appImage, ["--appimage-extract"], extractionRoot);
  const appRun = join(extractionRoot, "squashfs-root", "AppRun");
  if (!existsSync(appRun)) {
    throw new Error(`${basename(appImage)} did not extract a runnable AppRun payload.`);
  }
  chmodSync(appRun, 0o755);
  return {
    command: "xvfb-run",
    args: ["-a", appRun, "--no-sandbox", "--disable-gpu"],
    cwd: join(extractionRoot, "squashfs-root"),
  };
}

function prepareWindowsLaunch(assetsDirectory: string, extractionRoot: string): LaunchCommand {
  const installer = requireSingleAsset(assetsDirectory, ".exe");
  const installerRoot = join(extractionRoot, "installer");
  const applicationRoot = join(extractionRoot, "application");
  mkdirSync(installerRoot, { recursive: true });
  mkdirSync(applicationRoot, { recursive: true });
  runCommand("7z", ["x", "-y", `-o${installerRoot}`, installer]);
  const applicationArchives = findFiles(installerRoot, (candidate) =>
    /[/\\]app-(?:32|64|arm64)\.7z$/i.test(candidate),
  );
  if (applicationArchives.length !== 1) {
    throw new Error(
      `Expected one embedded NSIS application archive, found ${applicationArchives.length}.`,
    );
  }
  runCommand("7z", ["x", "-y", `-o${applicationRoot}`, applicationArchives[0]!]);
  const executables = findFiles(applicationRoot, (candidate) =>
    /[/\\]Synara\.exe$/i.test(candidate),
  );
  if (executables.length !== 1) {
    throw new Error(`Expected one extracted Synara.exe, found ${executables.length}.`);
  }
  return { command: executables[0]!, args: [], cwd: dirname(executables[0]!) };
}

function prepareLaunch(
  options: PackagedDesktopStartupOptions,
  extractionRoot: string,
): LaunchCommand {
  if (options.platform === "mac") {
    return prepareMacLaunch(options.assetsDirectory, extractionRoot);
  }
  if (options.platform === "linux") {
    return prepareLinuxLaunch(options.assetsDirectory, extractionRoot);
  }
  return prepareWindowsLaunch(options.assetsDirectory, extractionRoot);
}

export function createPackagedDesktopSmokeEnvironment(
  root: string,
  options: Pick<PackagedDesktopStartupOptions, "platform" | "version">,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    SYNARA_HOME: join(root, "synara-home"),
    SYNARA_DISABLE_AUTO_UPDATE: "1",
    ELECTRON_ENABLE_LOGGING: "1",
  };
  delete env.SYNARA_AUTH_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;
  for (const path of [
    env.HOME,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
    env.SYNARA_HOME,
  ]) {
    if (path) mkdirSync(path, { recursive: true });
  }
  if (options.platform === "mac") {
    const userDataPath = join(env.HOME!, "Library", "Application Support", "synara");
    mkdirSync(userDataPath, { recursive: true });
    // Prevent the packaged app's update-only icon repair from registering this
    // temporary bundle in the runner's normal Launch Services database.
    const launchVersionPath = join(userDataPath, "last-launch-version.json");
    writeFileSync(launchVersionPath, `${JSON.stringify({ version: options.version }, null, 2)}\n`);
  }
  return env;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await waitForExit(child, 5_000);
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (await waitForExit(child, 5_000)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await waitForExit(child, 2_000);
}

function hasStartupProof(logPath: string): boolean {
  try {
    const log = readFileSync(logPath, "utf8");
    return (
      log.includes("app ready") &&
      log.includes("bootstrap main window created") &&
      log.includes("bootstrap backend ready source=")
    );
  } catch {
    return false;
  }
}

export function resolveNativePackagedDesktopPlatform(
  platform: NodeJS.Platform,
): PackagedDesktopPlatform {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  return "linux";
}

export async function verifyPackagedDesktopStartup(
  options: PackagedDesktopStartupOptions,
): Promise<void> {
  const nativePlatform = resolveNativePackagedDesktopPlatform(process.platform);
  if (nativePlatform !== options.platform) {
    throw new Error(
      `Packaged ${options.platform} startup smoke must run on its native host, not ${process.platform}.`,
    );
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), `synara-packaged-smoke-${options.platform}-`));
  const extractionRoot = join(temporaryRoot, "payload");
  mkdirSync(extractionRoot, { recursive: true });

  let child: ChildProcess | null = null;
  try {
    const launch = prepareLaunch(options, extractionRoot);
    const env = createPackagedDesktopSmokeEnvironment(join(temporaryRoot, "state"), options);
    const logPath = join(env.SYNARA_HOME!, "userdata", "logs", "desktop-main.log");
    child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const childOutcome: {
      exited: { code: number | null; signal: NodeJS.Signals | null } | null;
      launchError: Error | null;
    } = { exited: null, launchError: null };
    child.once("exit", (code, signal) => {
      childOutcome.exited = { code, signal };
    });
    child.once("error", (error) => {
      childOutcome.launchError = error;
    });
    child.stdout?.resume();
    child.stderr?.resume();

    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      if (hasStartupProof(logPath)) {
        console.log(
          `Packaged ${options.platform}/${options.arch} startup smoke passed from isolated state.`,
        );
        return;
      }
      if (childOutcome.launchError) {
        throw new Error(`Packaged app could not start: ${childOutcome.launchError.message}`);
      }
      if (childOutcome.exited) {
        throw new Error(
          `Packaged app exited before startup proof (code=${childOutcome.exited.code ?? "null"}, signal=${childOutcome.exited.signal ?? "null"}).`,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    throw new Error(`Packaged startup proof timed out after ${options.timeoutMs}ms.`);
  } finally {
    if (child) {
      await terminateProcessTree(child);
    }
    try {
      rmSync(temporaryRoot, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 20 : 0,
        retryDelay: process.platform === "win32" ? 250 : 100,
      });
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !(error instanceof Error && "code" in error && error.code === "EPERM")
      ) {
        throw error;
      }
      console.warn(
        `Could not remove Windows smoke temp directory; leaving it for runner cleanup: ${temporaryRoot}`,
      );
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await verifyPackagedDesktopStartup(parsePackagedDesktopStartupArgs(process.argv.slice(2)));
}
