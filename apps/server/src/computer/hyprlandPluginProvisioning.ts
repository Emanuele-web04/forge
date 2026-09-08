/**
 * Getting the Hyprland plugin onto a machine that has never seen it.
 *
 * Structurally the KWin story (`kwinPluginProvisioning.ts`) minus its two
 * hardest parts. There is no env script and no relogin: Hyprland loads a
 * plugin by absolute path through `hyprctl plugin load`, live, from anywhere
 * on disk — so the install directory needs no compositor-visible search path,
 * and the very first install works in the session it happened in. What remains
 * shared — the `V<n>` generation numbering, the copy-install, the pruning of
 * superseded builds, the checksum gate on shipped binaries — is imported from
 * the KWin module rather than restated, because "how a versioned binary lands
 * in the user's home" should have one definition.
 *
 * The `V<n>` naming still matters here even without KWin's plugin pinning:
 * overwriting a `.so` that a live compositor has dlopened corrupts the mapped
 * image, so every install must be a new file. Pruning old ones is safe — the
 * inode stays alive while Hyprland has it mapped.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  installPluginBinary,
  nextPluginId,
  pruneSupersededPlugins,
  verifyPrebuilt,
  type ProvisionAction,
  type ProvisionResult,
} from "./kwinPluginProvisioning.ts";

export const HYPRLAND_INSTALL_SCRIPT_PATH =
  "apps/server/native/computer-use-hyprland/scripts/install-and-load.sh";

/**
 * Where the marker for Hyprland's development headers lives. The pkg-config
 * file is what the plugin Makefile resolves everything through, so its
 * presence is the honest "could a source build proceed" signal. Arch installs
 * it under /usr/share/pkgconfig; the lib spellings cover other packagings.
 */
const HYPRLAND_PKGCONFIG_PATHS = [
  "/usr/share/pkgconfig/hyprland.pc",
  "/usr/lib/pkgconfig/hyprland.pc",
  "/usr/lib64/pkgconfig/hyprland.pc",
  "/usr/local/share/pkgconfig/hyprland.pc",
] as const;

/** Where installed plugin generations live; user-owned, no sudo anywhere. */
export function hyprlandPluginDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.SYNARA_HYPRLAND_PLUGIN_DIR;
  if (configured) return resolve(configured);
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataHome, "synara", "hyprland-computer-use", "plugins");
}

/** Mirrors the KWin stamp's role: what was installed, for refusal messages. */
export function hyprlandInstallStampPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const stateRoot =
    env.SYNARA_HYPRLAND_STATE_ROOT ??
    join(
      env.XDG_STATE_HOME || join(home, ".local", "state"),
      "synara",
      "hyprland-computer-use-plugin",
    );
  return join(stateRoot, "install.stamp");
}

/**
 * Whether this machine could compile the plugin: Hyprland's headers (via their
 * pkg-config marker), and the compiler driver the Makefile invokes. The same
 * deliberate non-exhaustiveness as the KWin probe — sdbus-c++, cairo and
 * pixman headers are needed too, and the install script reports each missing
 * package by name when it actually runs.
 */
export function hyprlandBuildToolingPresent(
  exists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!HYPRLAND_PKGCONFIG_PATHS.some((path) => exists(path))) return false;
  const pathDirectories = (env.PATH ?? "").split(":").filter(Boolean);
  const onPath = (command: string) =>
    pathDirectories.some((directory) => exists(join(directory, command)));
  return onPath("g++") && onPath("make") && onPath("pkg-config");
}

/** Shipped binaries, absent on a checkout that was never packaged. */
export function hyprlandPrebuiltRoot(
  moduleDirectory: string = import.meta.dirname,
  configuredDirectory: string | undefined = process.env.SYNARA_HYPRLAND_PREBUILT_DIR,
  hasManifest: (candidate: string) => boolean = (candidate) =>
    existsSync(join(candidate, "manifest.json")),
): string | undefined {
  const candidates = [
    ...(configuredDirectory ? [resolve(configuredDirectory)] : []),
    join(moduleDirectory, "computer-use-hyprland", "prebuilt"),
    join(moduleDirectory, "..", "..", "native", "computer-use-hyprland", "prebuilt"),
  ];
  return candidates.find(hasManifest);
}

/** The installer script on disk, bundled beside this module or up in native/. */
export function resolveHyprlandInstallScriptPath(
  moduleDirectory: string = import.meta.dirname,
  configuredDirectory: string | undefined = process.env.SYNARA_HYPRLAND_SOURCE_DIR,
  sourceExists: (candidate: string) => boolean = existsSync,
): string {
  const relative = join("scripts", "install-and-load.sh");
  const candidates = [
    ...(configuredDirectory ? [join(resolve(configuredDirectory), relative)] : []),
    join(moduleDirectory, "computer-use-hyprland", relative),
  ];
  return (
    candidates.find(sourceExists) ??
    join(moduleDirectory, "..", "..", "native", "computer-use-hyprland", relative)
  );
}

export interface HyprlandPrebuiltBuild {
  /** The exact Hyprland version this was compiled against; the ABI churns per release. */
  readonly hyprlandVersion: string;
  readonly arch: string;
  /** Path relative to the prebuilt root. */
  readonly file: string;
  readonly sha256: string;
}

export interface HyprlandPrebuiltManifest {
  readonly builds: readonly HyprlandPrebuiltBuild[];
}

export async function readHyprlandPrebuiltManifest(
  path: string,
): Promise<HyprlandPrebuiltManifest | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const builds = (JSON.parse(raw) as { builds?: unknown }).builds;
    return Array.isArray(builds)
      ? { builds: builds as readonly HyprlandPrebuiltBuild[] }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Exact match on version and arch, never nearest — same reasoning as KWin's. */
export function selectHyprlandPrebuilt(
  manifest: HyprlandPrebuiltManifest,
  hyprlandVersion: string,
  arch: string,
): HyprlandPrebuiltBuild | undefined {
  return manifest.builds.find(
    (build) => build.hyprlandVersion === hyprlandVersion && build.arch === arch,
  );
}

export interface HyprlandProvisionDependencies {
  readonly pluginDirectory: string;
  /** Files already in the plugin directory, for the version suffix. */
  readonly listInstalled: () => Promise<readonly string[]>;
  /** The Hyprland actually running, or undefined if it cannot be read. */
  readonly hyprlandVersion: () => Promise<string | undefined>;
  readonly arch: string;
  readonly prebuiltRoot?: string | undefined;
  /** Builds against the local headers and resolves the built `.so`. */
  readonly buildFromSource: () => Promise<string>;
  readonly stampPath: string;
  readonly writeStamp?: (
    path: string,
    record: {
      readonly pluginId: string;
      readonly pluginPath: string;
      readonly hyprlandVersion: string | undefined;
      readonly installedAt: string;
    },
  ) => Promise<void>;
  readonly now?: () => Date;
}

/**
 * Install the plugin, preferring a shipped binary and falling back to building
 * one. Deliberately does not load it — loading is the backend's job, exactly
 * as in the KWin flow, and it also never asks "is this current": provisioning
 * only runs once connecting has established that nothing installed will load.
 */
export async function provisionHyprlandPlugin(
  deps: HyprlandProvisionDependencies,
): Promise<ProvisionResult> {
  const version = await deps.hyprlandVersion();
  const manifest = deps.prebuiltRoot
    ? await readHyprlandPrebuiltManifest(join(deps.prebuiltRoot, "manifest.json"))
    : undefined;
  const prebuilt =
    manifest && version ? selectHyprlandPrebuilt(manifest, version, deps.arch) : undefined;

  let source: string;
  let action: ProvisionAction;
  if (prebuilt && deps.prebuiltRoot) {
    const path = join(deps.prebuiltRoot, prebuilt.file);
    if (!(await verifyPrebuilt(path, prebuilt.sha256))) {
      throw new Error(
        `The bundled computer-use plugin for Hyprland ${prebuilt.hyprlandVersion} failed its ` +
          "checksum, so it was not installed. Reinstalling Synara replaces it.",
      );
    }
    source = path;
    action = "installed-prebuilt";
  } else {
    source = await deps.buildFromSource();
    action = "installed-from-source";
  }

  const pluginId = nextPluginId(await deps.listInstalled());
  const pluginPath = await installPluginBinary(source, deps.pluginDirectory, pluginId);
  await pruneSupersededPlugins(deps.pluginDirectory, pluginId);
  await (deps.writeStamp ?? writeHyprlandInstallStamp)(deps.stampPath, {
    pluginId,
    pluginPath,
    hyprlandVersion: version,
    installedAt: (deps.now?.() ?? new Date()).toISOString(),
  });

  return {
    action,
    pluginId,
    // hyprctl loads by absolute path into the live compositor; there is no
    // session-start search path, so no install ever needs a relogin.
    requiresRelogin: false,
    summary: "The computer-use plugin is installed and ready.",
  };
}

/** Bounded like the KWin build: generous, because a false timeout throws away
 * minutes of compilation that was about to succeed. */
const PLUGIN_BUILD_TIMEOUT_MS = 10 * 60 * 1_000;
const execFileAsync = promisify(execFile);

/**
 * Builds the plugin against the local Hyprland headers and resolves the built
 * `.so`. The build itself lives in the installer script so there is exactly
 * one of it; `--build-only` prints the path as its last line.
 */
export async function buildHyprlandPluginFromSource(): Promise<string> {
  const script = resolveHyprlandInstallScriptPath();
  const { stdout } = await execFileAsync("bash", [script, "--build-only"], {
    timeout: PLUGIN_BUILD_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  const path = stdout.trimEnd().split("\n").at(-1)?.trim();
  if (!path) {
    throw new Error(`${HYPRLAND_INSTALL_SCRIPT_PATH} --build-only printed no path.`);
  }
  return path;
}

/** The stamp the install script also writes, keyed by Hyprland version. */
export async function writeHyprlandInstallStamp(
  path: string,
  record: {
    readonly pluginId: string;
    readonly pluginPath: string;
    readonly hyprlandVersion: string | undefined;
    readonly installedAt: string;
  },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      `plugin_id=${record.pluginId}`,
      `installed_at=${record.installedAt}`,
      `plugin_path=${record.pluginPath}`,
      `hyprland_version=${record.hyprlandVersion ?? ""}`,
      "",
    ].join("\n"),
  );
}
