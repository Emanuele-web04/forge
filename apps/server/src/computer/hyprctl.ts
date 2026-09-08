/**
 * The `hyprctl` surface the Hyprland backend depends on, isolated because the
 * tool's contract is easy to misread: **hyprctl always exits 0**, success and
 * failure alike, so every answer here is parsed out of the reply text rather
 * than the exit code. `plugin load /path.so` answers `ok` on success and
 * `Plugin <path> could not be loaded: <reason>` on failure — same exit code
 * both ways. This module owns that parsing so nothing else in the tree ever
 * looks at an exit status and draws the wrong conclusion.
 *
 * Verified against Hyprland 0.56 (`src/debug/HyprCtl.cpp`): `plugin list -j`
 * reports `{name, author, handle, version, description}` per plugin — no path —
 * while `plugin load`/`plugin unload` address plugins **by absolute path**
 * (unload matches via `getPluginByPath`). That asymmetry is why the Synara
 * plugin self-reports its module path in `healthJson`: the name in the list
 * cannot tell the server which installed `.so` is the one answering the bus.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Set by Hyprland in every process of the session; names the instance. */
export const HYPRLAND_SIGNATURE_ENV = "HYPRLAND_INSTANCE_SIGNATURE";

/** The name the Synara plugin registers with Hyprland's plugin system. */
export const HYPRLAND_PLUGIN_NAME = "synara-computer-use";

const HYPRCTL_TIMEOUT_MS = 10_000;

/**
 * Whether this process is inside a live Hyprland session.
 *
 * The signature alone is not enough: it survives into terminals spawned before
 * a compositor crash, and into nested sessions this process started itself. The
 * instance's runtime directory is the liveness check — Hyprland creates
 * `$XDG_RUNTIME_DIR/hypr/<signature>/` at startup and its `.socket.sock` is how
 * `hyprctl` itself reaches the compositor.
 */
export function hyprlandSessionPresent(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const signature = env[HYPRLAND_SIGNATURE_ENV]?.trim();
  if (!signature) return false;
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (!runtimeDir) return false;
  return exists(join(runtimeDir, "hypr", signature, ".socket.sock"));
}

/** Runs `hyprctl` with the given arguments and resolves its stdout. */
export type HyprctlRunner = (args: readonly string[]) => Promise<string>;

export interface HyprctlOptions {
  /**
   * An explicit instance signature (`hyprctl -i`), for driving a compositor
   * other than the one this process inherited — the dev-test nested instance.
   * Absent, hyprctl resolves the instance from the environment.
   */
  readonly signature?: string;
}

export function makeHyprctlRunner(options: HyprctlOptions = {}): HyprctlRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      const fullArgs = options.signature ? ["-i", options.signature, ...args] : [...args];
      execFile(
        "hyprctl",
        fullArgs,
        { timeout: HYPRCTL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          // hyprctl itself never exits non-zero; an error here means the binary
          // is missing, was killed by the timeout, or the socket write failed.
          if (error) reject(new Error(`hyprctl ${args.join(" ")} failed: ${error.message}`));
          else resolve(stdout);
        },
      );
    });
}

export interface LoadedHyprlandPlugin {
  readonly name: string;
}

/** The plugins the compositor has loaded right now, by registered name. */
export async function listLoadedHyprlandPlugins(
  run: HyprctlRunner,
): Promise<readonly LoadedHyprlandPlugin[]> {
  const raw = await run(["-j", "plugin", "list"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Older Hyprland answers `plugin list -j` requests with plain text; treat
    // an unparseable reply as "none visible" and let the load path decide.
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const name = (entry as { name?: unknown }).name;
    return typeof name === "string" ? [{ name }] : [];
  });
}

export interface HyprlandPluginLoadResult {
  readonly ok: boolean;
  /** Hyprland's own reason on refusal — it names ABI mismatches precisely. */
  readonly message: string;
}

export async function loadHyprlandPlugin(
  run: HyprctlRunner,
  pluginPath: string,
): Promise<HyprlandPluginLoadResult> {
  const reply = (await run(["plugin", "load", pluginPath])).trim();
  return { ok: reply === "ok", message: reply };
}

/** `false` only when Hyprland reports the path was not loaded to begin with. */
export async function unloadHyprlandPlugin(
  run: HyprctlRunner,
  pluginPath: string,
): Promise<boolean> {
  const reply = (await run(["plugin", "unload", pluginPath])).trim();
  if (reply === "ok") return true;
  if (reply.includes("not loaded")) return false;
  throw new Error(`hyprctl plugin unload ${pluginPath}: ${reply}`);
}

/** The running compositor's version (`0.56.2`), or undefined if unreadable. */
export async function detectRunningHyprlandVersion(
  run: HyprctlRunner,
): Promise<string | undefined> {
  try {
    const raw = await run(["-j", "version"]);
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version ? version : undefined;
  } catch {
    return undefined;
  }
}
