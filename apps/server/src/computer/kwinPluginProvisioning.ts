/**
 * Getting the KWin plugin onto a machine that has never seen it.
 *
 * The bar is that a user installs the update, turns computer use on, and it
 * works. Two things stood between us and that, and this module is the answer to
 * both.
 *
 * The first was `sudo`. A KWin plugin does not have to live in `/usr`: KWin
 * finds plugins through Qt's library paths, and Qt reads `QT_PLUGIN_PATH` from
 * the environment. So the plugin goes under the user's own `~/.local`, and one
 * small script in the Plasma session's env directory puts that root on the path.
 * Nothing outside the home directory is touched, and uninstalling is deleting
 * two paths.
 *
 * The second was the compiler. A KWin plugin is a binary module tied to the
 * exact KWin it was built against, so the old flow needed cmake, ninja, and the
 * KWin development headers on the user's machine - which almost nobody has.
 * Prebuilt binaries shipped with the app cover the KWin versions we build for,
 * and building from source stays as the fallback for everything else.
 *
 * The one cost that cannot be engineered away: Qt reads `QT_PLUGIN_PATH` when
 * KWin starts, so the very first install lands in a directory the running
 * compositor was never told about. That session cannot see it, and there is no
 * way to add a library path to a process from outside it. The user logs out once
 * and never thinks about it again - every later update loads live, because the
 * path is already there.
 */
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { verifyPrebuilt } from "./provisioning/prebuiltVerification.ts";

/**
 * The env script's name, which is also the uninstall instruction: this file and
 * the plugin directory are the only two things provisioning creates.
 */
export const ENV_SCRIPT_NAME = "synara-computer-use.sh";

/** The Qt plugin subpath KWin scans, relative to a Qt plugin root. */
const KWIN_PLUGIN_SUBPATH = join("kwin", "plugins");

export interface InstallTarget {
  /** Where the `.so` goes. */
  readonly pluginDirectory: string;
  /** What `QT_PLUGIN_PATH` has to contain for KWin to scan the directory above. */
  readonly qtPluginRoot: string;
}

/**
 * Where a user-owned plugin goes on this machine.
 *
 * The lib64/lib split is read off the system Qt rather than guessed from the
 * architecture: it is a distro packaging choice (Fedora and openSUSE use lib64,
 * Debian and Arch use lib), and the answer is already sitting on disk in the
 * form of whichever system plugin root exists.
 *
 * Which is why the candidate roots are probed on disk rather than pattern
 * matched: the caller passes both spellings, so testing the list's text would
 * answer "lib64" on every machine in existence, including the Debian and Arch
 * ones that have no /usr/lib64 at all. scripts/install-and-load.sh makes the
 * same decision with `[[ -d /usr/lib64/qt6/plugins ]]`, and the two have to
 * agree or a script install and an app install put the plugin in different
 * directories — only one of which is on the QT_PLUGIN_PATH the env script wrote.
 */
export function resolveInstallTarget(
  systemQtRoots: readonly string[],
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): InstallTarget {
  const present = systemQtRoots.find((root) => exists(root));
  const lib = present?.includes("/lib64/") ? "lib64" : "lib";
  const qtPluginRoot = join(home, ".local", lib, "qt6", "plugins");
  return { qtPluginRoot, pluginDirectory: join(qtPluginRoot, KWIN_PLUGIN_SUBPATH) };
}

/** The Plasma session sources every `*.sh` here before it starts the compositor. */
export function envScriptPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configHome, "plasma-workspace", "env", ENV_SCRIPT_NAME);
}

/**
 * Prepends, and only when absent, so the script is safe to source twice and
 * never grows the variable without bound. It also stays correct if the user
 * later sets `QT_PLUGIN_PATH` themselves for unrelated reasons.
 */
export function renderEnvScript(qtPluginRoot: string): string {
  return [
    "#!/bin/sh",
    "# Written by Synara so KWin can find the computer-use plugin in your home",
    "# directory instead of /usr. Delete this file and the directory below to",
    "# undo it; nothing else on the system was changed.",
    `synara_plugin_root="${qtPluginRoot}"`,
    'case ":${QT_PLUGIN_PATH}:" in',
    '  *":${synara_plugin_root}:"*) ;;',
    '  *) QT_PLUGIN_PATH="${synara_plugin_root}${QT_PLUGIN_PATH:+:${QT_PLUGIN_PATH}}" ;;',
    "esac",
    "export QT_PLUGIN_PATH",
    "unset synara_plugin_root",
    "",
  ].join("\n");
}

export type EnvScriptOutcome = "unchanged" | "written";

/**
 * Idempotent: rewrites only when the content differs, so mtime means something.
 *
 * The write is temp-plus-rename, matching install-and-load.sh: Plasma sources
 * every script in this directory at login, and a crash mid-`writeFile` would
 * leave a truncated one sourced by every future session.
 */
export async function ensureEnvScript(path: string, contents: string): Promise<EnvScriptOutcome> {
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing === contents) return "unchanged";
  await mkdir(dirname(path), { recursive: true });
  const staged = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(staged, contents, { mode: 0o755 });
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
  return "written";
}

/**
 * Whether the compositor that is running right now can see the plugin root.
 *
 * The server inherits the session environment, so its own `QT_PLUGIN_PATH` is
 * the same one KWin was started with. That makes this the honest test for "will
 * a load work today, or does this user have to log out first" - far better than
 * assuming the env script took effect the moment it was written.
 */
export function sessionSeesPluginRoot(
  qtPluginRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const entries = (env.QT_PLUGIN_PATH ?? "").split(":").filter(Boolean);
  return entries.includes(qtPluginRoot);
}

export interface PrebuiltBuild {
  /** The exact KWin version this was compiled against. */
  readonly kwinVersion: string;
  readonly arch: string;
  /** Path relative to the prebuilt root. */
  readonly file: string;
  readonly sha256: string;
}

export interface PrebuiltManifest {
  readonly builds: readonly PrebuiltBuild[];
}

/**
 * Exact match on both fields, never nearest.
 *
 * A KWin plugin loads into the version it was built against and no other, and
 * KWin's refusal carries no reason at all - it answers `false` and logs
 * "mismatching plugin version" to its own journal. Shipping a near-miss would
 * turn a clean "no prebuilt for KWin 6.8.1, building from source" into an
 * unexplained failure, so a miss here is a miss.
 */
export function selectPrebuilt(
  manifest: PrebuiltManifest,
  kwinVersion: string,
  arch: string,
): PrebuiltBuild | undefined {
  return manifest.builds.find((build) => build.kwinVersion === kwinVersion && build.arch === arch);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Reads a manifest, dropping any entry that could not be acted on anyway.
 *
 * A `file` is a name inside the prebuilt root and nothing else, so a path escape or an empty checksum is a
 * malformed entry rather than something to resolve or install.
 */
export async function readPrebuiltManifest(path: string): Promise<PrebuiltManifest | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const builds = (parsed as { builds?: unknown }).builds;
  if (!Array.isArray(builds)) return undefined;
  const accepted = builds.flatMap((entry) => {
    const build = entry as Partial<PrebuiltBuild> | null;
    if (!build || typeof build !== "object") return [];
    const { kwinVersion, arch, file, sha256 } = build;
    if (!isText(kwinVersion) || !isText(arch) || !isText(file) || !isText(sha256)) return [];
    if (file.includes("/") || file.includes("\\") || file === "." || file === "..") return [];
    if (!SHA256_HEX.test(sha256)) return [];
    return [{ kwinVersion, arch, file, sha256 } satisfies PrebuiltBuild];
  });
  return accepted.length > 0 ? { builds: accepted } : undefined;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Re-exported rather than reimplemented: the check is identical for every
 * shipped native binary, and one definition of "is this the binary that was
 * built" is the point. See `provisioning/prebuiltVerification.ts`.
 */
export { verifyPrebuilt };

/** `SynaraComputerUsePluginV7.so` -> 7, so the next install can outrank it. */
const INSTALLED_PLUGIN_FILE = /^SynaraComputerUsePluginV(\d+)\.so$/;

/**
 * KWin pins a plugin library once it loads it, so an update cannot overwrite the
 * file it is already running. Every install therefore gets its own version
 * suffix, and the old ones are unloaded and removed by the caller.
 */
export function nextPluginId(existingFiles: readonly string[]): string {
  const highest = existingFiles.reduce((max, name) => {
    const match = INSTALLED_PLUGIN_FILE.exec(name);
    return match?.[1] ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `SynaraComputerUsePluginV${highest + 1}`;
}

export async function installPluginBinary(
  sourcePath: string,
  pluginDirectory: string,
  pluginId: string,
): Promise<string> {
  await mkdir(pluginDirectory, { recursive: true });
  const destination = join(pluginDirectory, `${pluginId}.so`);
  await copyFile(sourcePath, destination);
  await chmod(destination, 0o755);
  return destination;
}

/**
 * Superseded builds are deleted, not merely left behind.
 *
 * KWin auto-loads any plugin in this directory whose metadata does not opt out,
 * so an old build comes back on the next compositor start and races the current
 * one for the `org.synara.ComputerUse` bus name - and the first registrant wins,
 * which shadows the build that was just installed. Unloading the running one is
 * the caller's job; deleting the file is safe either way, because Linux keeps
 * the inode alive for as long as KWin has it mapped.
 */
export async function pruneSupersededPlugins(
  pluginDirectory: string,
  keepPluginId: string,
): Promise<readonly string[]> {
  const entries = await readdir(pluginDirectory).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const name of entries) {
    if (!INSTALLED_PLUGIN_FILE.test(name) || name === `${keepPluginId}.so`) continue;
    await rm(join(pluginDirectory, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * The record scripts/install-and-load.sh also writes, so a later load refusal
 * can name the KWin version this plugin was built for.
 *
 * The `signature=` line that script uses to skip redundant rebuilds is
 * deliberately absent: it describes a source tree this install may never have
 * compiled, and a missing signature makes the script rebuild rather than trust a
 * stamp it did not write.
 */
export async function writeInstallStamp(
  path: string,
  record: {
    readonly pluginId: string;
    readonly pluginPath: string;
    readonly kwinVersion: string | undefined;
    readonly installedAt: string;
  },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Temp-plus-rename for the same reason the env script is: a crash mid-write
  // would leave a half-read stamp answering version questions wrongly.
  const staged = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(
      staged,
      [
        `plugin_id=${record.pluginId}`,
        `installed_at=${record.installedAt}`,
        `plugin_path=${record.pluginPath}`,
        `kwin_version=${record.kwinVersion ?? ""}`,
        "",
      ].join("\n"),
    );
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
}

export type ProvisionAction = "already-current" | "installed-prebuilt" | "installed-from-source";

const LOGIN_NEEDED =
  "Log out and back in once to finish enabling it — " +
  "KWin only reads the plugin path when your session starts.";

export interface ProvisionResult {
  readonly action: ProvisionAction;
  /** The id that was installed, absent when nothing was. */
  readonly pluginId?: string;
  /**
   * The compositor running right now cannot see the plugin directory, so this
   * install takes effect at the user's next login. Only ever true for the very
   * first install on a machine.
   */
  readonly requiresRelogin: boolean;
  /** One sentence for the availability card, in the user's terms. */
  readonly summary: string;
}

export interface ProvisionDependencies {
  readonly target: InstallTarget;
  readonly env?: NodeJS.ProcessEnv;
  /** Files already in the plugin directory, for the version suffix. */
  readonly listInstalled: () => Promise<readonly string[]>;
  /** The KWin the user is actually running, or undefined if it cannot be read. */
  readonly kwinVersion: () => Promise<string | undefined>;
  readonly arch: string;
  /** Where the shipped binaries live, or undefined when the app ships none. */
  readonly prebuiltRoot?: string | undefined;
  /**
   * Builds the plugin against the local KWin headers and resolves the built
   * `.so`. Rejects with a message the user can act on when the toolchain or the
   * KWin development headers are missing.
   */
  readonly buildFromSource: () => Promise<string>;
  /** Whether an install for this exact KWin version is already in place. */
  readonly isCurrent: () => Promise<boolean>;
  /**
   * Reinstall even when `isCurrent` says nothing needs doing. The backend asks
   * for this after KWin refused the very install the stamp describes as
   * current: the stamp is right that it is in place, and wrong that it works.
   */
  readonly force?: boolean;
  /** Where to record what was installed, for a later load refusal to read back. */
  readonly stampPath: string;
  readonly now?: () => Date;
}

/**
 * Install the plugin if it is not already installed, preferring a shipped
 * binary and falling back to building one.
 *
 * Deliberately does not load it. Loading is the backend's job and it already
 * knows how to unload stale ids first; doing it here would split that logic in
 * two and give the two halves different ideas about which id is newest.
 */
export async function provisionKWinPlugin(deps: ProvisionDependencies): Promise<ProvisionResult> {
  const env = deps.env ?? process.env;
  // Written before anything else, and on every run. It is the piece that makes
  // the install visible to KWin at all, and it is cheap and idempotent, so there
  // is no case where skipping it is worth the risk of it having been deleted.
  await ensureEnvScript(envScriptPath(env), renderEnvScript(deps.target.qtPluginRoot));
  const visible = sessionSeesPluginRoot(deps.target.qtPluginRoot, env);

  if (!deps.force && (await deps.isCurrent())) {
    // Current is not the same as loadable: until the session has been
    // restarted once, an install the compositor cannot see stays invisible no
    // matter how current it is, and the remedy is the same login as on the
    // day it was installed.
    return {
      action: "already-current",
      requiresRelogin: !visible,
      summary: visible
        ? "The computer-use plugin is installed and current."
        : `The computer-use plugin is installed and current. ${LOGIN_NEEDED}`,
    };
  }

  const version = await deps.kwinVersion();
  const manifest = deps.prebuiltRoot
    ? await readPrebuiltManifest(join(deps.prebuiltRoot, "manifest.json"))
    : undefined;
  const prebuilt = manifest && version ? selectPrebuilt(manifest, version, deps.arch) : undefined;

  let source: string;
  let action: ProvisionAction;
  if (prebuilt && deps.prebuiltRoot) {
    const path = join(deps.prebuiltRoot, prebuilt.file);
    if (!(await verifyPrebuilt(path, prebuilt.sha256))) {
      throw new Error(
        `The bundled computer-use plugin for KWin ${prebuilt.kwinVersion} failed its checksum, ` +
          "so it was not installed. Reinstalling Synara replaces it.",
      );
    }
    source = path;
    action = "installed-prebuilt";
  } else {
    source = await deps.buildFromSource();
    action = "installed-from-source";
  }

  const pluginId = nextPluginId(await deps.listInstalled());
  const pluginPath = await installPluginBinary(source, deps.target.pluginDirectory, pluginId);
  await pruneSupersededPlugins(deps.target.pluginDirectory, pluginId);
  await writeInstallStamp(deps.stampPath, {
    pluginId,
    pluginPath,
    kwinVersion: version,
    installedAt: (deps.now?.() ?? new Date()).toISOString(),
  });

  return {
    action,
    pluginId,
    requiresRelogin: !visible,
    summary: visible
      ? "The computer-use plugin is installed and ready."
      : `The computer-use plugin is installed. ${LOGIN_NEEDED}`,
  };
}
