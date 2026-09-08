/**
 * Hyprland's side of the `KWinComputerDbus` contract.
 *
 * The whole KWin backend engine — connect, load-plan, replace, reconnect — is
 * written against that small interface, and the Synara Hyprland plugin speaks
 * the identical `org.synara.ComputerUse` D-Bus surface. What differs is plugin
 * management: KWin loads plugins by **id** over its own D-Bus plugin manager,
 * Hyprland loads them by **absolute path** through `hyprctl`, live and with no
 * relogin. This module translates between the two vocabularies so the engine
 * never learns the difference.
 *
 * The id language stays KWin's on purpose: installed builds are
 * `SynaraComputerUsePluginV<n>.so` files, so `resolveSynaraPluginLoad` and the
 * provisioning version counter work unchanged. The translation problems are:
 *
 * - id -> path: an id is a basename in the Hyprland plugin directory.
 * - loaded plugin -> id: `hyprctl plugin list` reports only the registered
 *   name (`synara-computer-use`), never the path it was loaded from. The
 *   plugin self-reports its module path in `healthJson` for exactly this
 *   reason; its basename is the id. A build too old or too broken to answer
 *   maps to the versionless `SynaraComputerUsePlugin`, which every installed
 *   `V<n>` outranks — so the engine plans a replace and the unknown build is
 *   swapped for the current one, which is the right recovery anyway.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  HYPRLAND_PLUGIN_NAME,
  listLoadedHyprlandPlugins,
  loadHyprlandPlugin,
  makeHyprctlRunner,
  unloadHyprlandPlugin,
  type HyprctlRunner,
} from "./hyprctl.ts";
import {
  openComputerSessionBus,
  type ComputerSessionBus,
  type KWinComputerDbus,
} from "./kwinDbus.ts";
import { unwrapDbusValue } from "./dbusPlumbing.ts";

/** The id a loaded build maps to when its actual generation cannot be read. */
export const HYPRLAND_FALLBACK_PLUGIN_ID = "SynaraComputerUsePlugin";

const INSTALLED_PLUGIN_FILE = /^SynaraComputerUsePluginV\d+\.so$/;

export interface HyprlandComputerDbusOptions {
  /** Where installed plugin generations live; ids are basenames here. */
  readonly pluginDirectory: string;
  /** An explicit compositor instance, for driving the dev-test nested one. */
  readonly signature?: string;
  readonly runHyprctl?: HyprctlRunner;
  readonly openBus?: () => Promise<ComputerSessionBus>;
  readonly fileExists?: (path: string) => boolean;
  readonly listPluginDirectory?: () => Promise<readonly string[]>;
}

export interface HyprlandComputerDbus extends KWinComputerDbus {
  /**
   * Hyprland's own words for the most recent load refusal. Unlike KWin's
   * wordless `false`, `hyprctl plugin load` names the reason (an ABI mismatch,
   * a missing symbol), and the backend's refusal message passes it on.
   */
  readonly lastLoadRefusal: () => string | undefined;
}

export async function createSessionHyprlandComputerDbus(
  options: HyprlandComputerDbusOptions,
): Promise<HyprlandComputerDbus> {
  const run =
    options.runHyprctl ??
    makeHyprctlRunner(options.signature ? { signature: options.signature } : {});
  const fileExists = options.fileExists ?? existsSync;
  const listDirectory =
    options.listPluginDirectory ??
    (() => readdir(options.pluginDirectory).catch(() => [] as string[]));
  const session = await (options.openBus?.() ?? openComputerSessionBus());
  /**
   * Where each id's `.so` was actually loaded from, learned from `healthJson`.
   * Unload must address that path even after provisioning pruned the file —
   * Hyprland matches the path string it loaded, not what is on disk now.
   */
  const loadedPaths = new Map<string, string>();
  let lastLoadRefusal: string | undefined;

  const pathForId = (pluginId: string) =>
    loadedPaths.get(pluginId) ?? join(options.pluginDirectory, `${pluginId}.so`);

  return {
    nameOwner: session.nameOwner,
    listLoadedPluginIds: async () => {
      const plugins = await listLoadedHyprlandPlugins(run);
      const ids: string[] = [];
      for (const plugin of plugins) {
        if (plugin.name !== HYPRLAND_PLUGIN_NAME) {
          ids.push(plugin.name);
          continue;
        }
        const modulePath = await readLoadedModulePath(session);
        const id = modulePath ? idForModulePath(modulePath) : HYPRLAND_FALLBACK_PLUGIN_ID;
        if (modulePath) loadedPaths.set(id, modulePath);
        ids.push(id);
      }
      return ids;
    },
    loadPlugin: async (pluginId) => {
      const path = join(options.pluginDirectory, `${pluginId}.so`);
      if (!fileExists(path)) {
        lastLoadRefusal = `${path} does not exist.`;
        return false;
      }
      const result = await loadHyprlandPlugin(run, path);
      if (result.ok) {
        loadedPaths.set(pluginId, path);
        return true;
      }
      lastLoadRefusal = result.message;
      return false;
    },
    unloadPlugin: async (pluginId) => {
      const known = loadedPaths.get(pluginId);
      if (known || fileExists(pathForId(pluginId))) {
        const unloaded = await unloadHyprlandPlugin(run, pathForId(pluginId));
        if (unloaded) loadedPaths.delete(pluginId);
        return unloaded;
      }
      // The id came from the fallback mapping and the loaded build never
      // answered with its path. Every installed generation is a candidate for
      // being the one that is actually loaded, so try them all.
      let any = false;
      for (const name of await listDirectory()) {
        if (!INSTALLED_PLUGIN_FILE.test(name)) continue;
        if (await unloadHyprlandPlugin(run, join(options.pluginDirectory, name))) any = true;
      }
      return any;
    },
    connectPlugin: session.connectPlugin,
    onDisconnect: session.onDisconnect,
    close: session.close,
    lastLoadRefusal: () => lastLoadRefusal,
  };
}

/** `/…/SynaraComputerUsePluginV7.so` -> `SynaraComputerUsePluginV7`. */
function idForModulePath(modulePath: string): string {
  const name = basename(modulePath);
  return INSTALLED_PLUGIN_FILE.test(name)
    ? name.slice(0, -".so".length)
    : HYPRLAND_FALLBACK_PLUGIN_ID;
}

/** The loaded build's `.so` path, from the plugin's own `healthJson`. */
async function readLoadedModulePath(session: ComputerSessionBus): Promise<string | undefined> {
  try {
    const api = await session.connectPlugin();
    const raw = unwrapDbusValue(await api.healthJson());
    const health: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    const modulePath = (health as { modulePath?: unknown } | null)?.modulePath;
    return typeof modulePath === "string" && modulePath ? modulePath : undefined;
  } catch {
    return undefined;
  }
}
