import { describe, expect, it } from "vitest";

import { createSessionHyprlandComputerDbus } from "./hyprlandPluginHost.ts";
import type { ComputerSessionBus, KWinComputerPluginApi } from "./kwinDbus.ts";
import type { HyprctlRunner } from "./hyprctl.ts";

const PLUGIN_DIR = "/home/user/.local/share/synara/hyprland-computer-use/plugins";

function fakeBus(healthJson?: () => Promise<unknown>): ComputerSessionBus {
  const api = { healthJson: healthJson ?? (() => Promise.reject(new Error("no plugin"))) };
  return {
    getProxyObject: () => Promise.reject(new Error("unused")),
    nameOwner: () => Promise.resolve(undefined),
    connectPlugin: () => Promise.resolve(api as unknown as KWinComputerPluginApi),
    onDisconnect: () => () => undefined,
    close: () => Promise.resolve(),
  };
}

function recordingRunner(replies: Record<string, string>) {
  const calls: string[] = [];
  const run: HyprctlRunner = (args) => {
    const key = args.join(" ");
    calls.push(key);
    const reply = replies[key];
    if (reply === undefined) return Promise.reject(new Error(`unexpected hyprctl ${key}`));
    return Promise.resolve(reply);
  };
  return { run, calls };
}

const LOADED_LIST = JSON.stringify([{ name: "synara-computer-use" }, { name: "hyprbars" }]);

describe("createSessionHyprlandComputerDbus", () => {
  it("maps the loaded plugin name onto its generation id via healthJson's modulePath", async () => {
    const { run } = recordingRunner({ "-j plugin list": LOADED_LIST });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () =>
        Promise.resolve(
          fakeBus(() =>
            Promise.resolve(
              JSON.stringify({
                ok: true,
                modulePath: `${PLUGIN_DIR}/SynaraComputerUsePluginV7.so`,
              }),
            ),
          ),
        ),
      fileExists: () => true,
    });

    // The foreign plugin passes through untouched; the base engine's id filter
    // ignores it.
    await expect(dbus.listLoadedPluginIds()).resolves.toEqual([
      "SynaraComputerUsePluginV7",
      "hyprbars",
    ]);
  });

  it("falls back to the versionless id when the loaded build cannot say what it is", async () => {
    // A bare id is generation 0, which every installed V<n> outranks — so the
    // engine plans a replace and the unknown build gets swapped for a current
    // one, which is the right recovery for a build too old or broken to answer.
    const { run } = recordingRunner({ "-j plugin list": LOADED_LIST });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () => Promise.resolve(fakeBus()),
      fileExists: () => false,
    });

    await expect(dbus.listLoadedPluginIds()).resolves.toEqual([
      "SynaraComputerUsePlugin",
      "hyprbars",
    ]);
  });

  it("also maps a dev build loaded from outside the plugin directory to the fallback id", async () => {
    const { run } = recordingRunner({ "-j plugin list": LOADED_LIST });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () =>
        Promise.resolve(
          fakeBus(() =>
            Promise.resolve(
              JSON.stringify({ modulePath: "/home/user/repo/SynaraComputerUseHyprland.so" }),
            ),
          ),
        ),
      fileExists: () => false,
    });

    await expect(dbus.listLoadedPluginIds()).resolves.toEqual([
      "SynaraComputerUsePlugin",
      "hyprbars",
    ]);
  });

  it("loads by path, keeps Hyprland's refusal text, and refuses a missing file locally", async () => {
    const target = `${PLUGIN_DIR}/SynaraComputerUsePluginV3.so`;
    const { run } = recordingRunner({
      [`plugin load ${target}`]: `Plugin ${target} could not be loaded: API version mismatch`,
    });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () => Promise.resolve(fakeBus()),
      fileExists: (path) => path === target,
    });

    await expect(dbus.loadPlugin("SynaraComputerUsePluginV3")).resolves.toBe(false);
    expect(dbus.lastLoadRefusal()).toContain("API version mismatch");

    await expect(dbus.loadPlugin("SynaraComputerUsePluginV4")).resolves.toBe(false);
    expect(dbus.lastLoadRefusal()).toContain("does not exist");
  });

  it("unloads by the path the loaded build reported, not by what is on disk now", async () => {
    // Provisioning prunes superseded .so files while Hyprland still has them
    // mapped; unload must address the loaded path string regardless.
    const stalePath = `${PLUGIN_DIR}/SynaraComputerUsePluginV2.so`;
    const { run, calls } = recordingRunner({
      "-j plugin list": JSON.stringify([{ name: "synara-computer-use" }]),
      [`plugin unload ${stalePath}`]: "ok",
    });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () =>
        Promise.resolve(fakeBus(() => Promise.resolve(JSON.stringify({ modulePath: stalePath })))),
      fileExists: () => false,
    });

    await dbus.listLoadedPluginIds();
    await expect(dbus.unloadPlugin("SynaraComputerUsePluginV2")).resolves.toBe(true);
    expect(calls).toContain(`plugin unload ${stalePath}`);
  });

  it("sweeps every installed generation when a fallback id has no known path", async () => {
    const { run, calls } = recordingRunner({
      [`plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV1.so`]: "plugin not loaded",
      [`plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV2.so`]: "ok",
    });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () => Promise.resolve(fakeBus()),
      fileExists: () => false,
      listPluginDirectory: () =>
        Promise.resolve([
          "SynaraComputerUsePluginV1.so",
          "SynaraComputerUsePluginV2.so",
          "README.txt",
        ]),
    });

    await expect(dbus.unloadPlugin("SynaraComputerUsePlugin")).resolves.toBe(true);
    expect(calls).toEqual([
      `plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV1.so`,
      `plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV2.so`,
    ]);
  });
});
