import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  HyprlandComputerBackend,
  type HyprlandComputerBackendOptions,
} from "./HyprlandComputerBackend.ts";
import { COMPUTER_SERVICE, type KWinComputerPluginApi } from "./kwinDbus.ts";
import type { HyprlandComputerDbus } from "./hyprlandPluginHost.ts";

const temp = () => mkdtemp(join(tmpdir(), "synara-hypr-backend-"));

/** Just enough plugin for the start-free health gate `availability()` runs. */
const fakePlugin = {
  healthJson: async () => JSON.stringify({ ok: true, running: false, capture: true }),
  stop: async () => true,
} as unknown as KWinComputerPluginApi;

function fakeDbus(
  overrides: Partial<HyprlandComputerDbus> = {},
): HyprlandComputerDbus & { readonly loads: string[] } {
  const loads: string[] = [];
  return {
    loads,
    // The service is owned once something loaded the plugin, the same shape as
    // the KWin fake: the owner check after a load has to find a unique name.
    nameOwner: async () => (loads.length > 0 ? ":1.42" : undefined),
    listLoadedPluginIds: async () => [],
    loadPlugin: async (pluginId: string) => {
      loads.push(pluginId);
      return true;
    },
    unloadPlugin: async () => false,
    connectPlugin: async () => fakePlugin,
    onDisconnect: () => () => undefined,
    close: async () => undefined,
    lastLoadRefusal: () => undefined,
    ...overrides,
  };
}

/** Every host probe stubbed inert, so no test asks the developer's machine. */
async function makeBackend(
  options: Partial<HyprlandComputerBackendOptions> = {},
): Promise<HyprlandComputerBackend> {
  const dir = await temp();
  return new HyprlandComputerBackend({
    platform: "linux",
    sessionPresent: () => true,
    pluginDirectory: join(dir, "plugins"),
    installStampPath: join(dir, "install.stamp"),
    runHyprctl: async (args) => {
      throw new Error(`no hyprctl in tests: ${args.join(" ")}`);
    },
    busNameHasOwner: async () => false,
    prebuiltRoot: () => undefined,
    buildToolingPresent: () => false,
    provisionPlugin: async () => {
      throw new Error("provisioning must not run in this test");
    },
    dbusFactory: async () => fakeDbus(),
    ...options,
  });
}

async function installedPluginDirectory(...names: readonly string[]): Promise<string> {
  const directory = join(await temp(), "plugins");
  await mkdir(directory, { recursive: true });
  for (const name of names) await writeFile(join(directory, name), "so bytes");
  return directory;
}

describe("HyprlandComputerBackend passive probe", () => {
  it("reports the platform and a missing session without asking further", async () => {
    const notLinux = await makeBackend({ platform: "darwin" });
    await expect(notLinux.probeAvailability()).resolves.toEqual({
      kind: "unsupported-platform",
      platform: "darwin",
    });

    const noSession = await makeBackend({
      sessionPresent: () => false,
      busNameHasOwner: async () => {
        throw new Error("the bus probe must not run without a session");
      },
    });
    await expect(noSession.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("No Hyprland session"),
    });

    await Promise.all([notLinux.dispose(), noSession.dispose()]);
  });

  it("is available when the plugin is already answering on the bus", async () => {
    const backend = await makeBackend({
      busNameHasOwner: async (name) => name === COMPUTER_SERVICE,
    });

    await expect(backend.probeAvailability()).resolves.toEqual({
      kind: "available",
      backend: "hyprland",
    });
    await backend.dispose();
  });

  it("is available from an installed plugin file alone", async () => {
    const backend = await makeBackend({
      pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV2.so"),
    });

    await expect(backend.probeAvailability()).resolves.toMatchObject({ kind: "available" });
    await backend.dispose();
  });

  it("is available when a shipped build matches the running Hyprland exactly", async () => {
    const root = await temp();
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({
        builds: [
          { hyprlandVersion: "0.56.2", arch: process.arch, file: "p.so", sha256: "0".repeat(64) },
        ],
      }),
    );
    const withVersion = (version: string) =>
      makeBackend({
        prebuiltRoot: () => root,
        runHyprctl: async (args) =>
          args.join(" ") === "-j version" ? JSON.stringify({ version }) : "",
      });

    const matching = await withVersion("0.56.2");
    await expect(matching.probeAvailability()).resolves.toMatchObject({ kind: "available" });

    // The plugin ABI churns per release, so a near miss must read unavailable.
    const mismatched = await withVersion("0.57.0");
    await expect(mismatched.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
    });

    await Promise.all([matching.dispose(), mismatched.dispose()]);
  });

  it("is available when this machine could build the plugin itself", async () => {
    const backend = await makeBackend({ buildToolingPresent: () => true });
    await expect(backend.probeAvailability()).resolves.toMatchObject({ kind: "available" });
    await backend.dispose();
  });

  it("refuses with the install pointer when no plugin exists and none could be made", async () => {
    const backend = await makeBackend();
    await expect(backend.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("install-and-load.sh"),
    });
    await backend.dispose();
  });
});

describe("HyprlandComputerBackend availability", () => {
  it("connects through the plugin host and names the backend hyprland", async () => {
    const dbus = fakeDbus();
    const backend = await makeBackend({
      pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV3.so"),
      dbusFactory: async () => dbus,
    });

    await expect(backend.availability()).resolves.toEqual({
      kind: "available",
      backend: "hyprland",
    });
    expect(dbus.loads).toEqual(["SynaraComputerUsePluginV3"]);
    await backend.dispose();
  });

  it("refuses without dialing anything when no Hyprland session is live", async () => {
    const backend = await makeBackend({
      sessionPresent: () => false,
      dbusFactory: async () => {
        throw new Error("must not connect without a session");
      },
    });

    await expect(backend.availability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("No Hyprland session"),
    });
    await backend.dispose();
  });

  it("passes Hyprland's own refusal words through to the failure message", async () => {
    const path = "/plugins/SynaraComputerUsePluginV3.so";
    const backend = await makeBackend({
      pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV3.so"),
      dbusFactory: async () =>
        fakeDbus({
          loadPlugin: async () => false,
          lastLoadRefusal: () => `Plugin ${path} could not be loaded: API version mismatch.`,
        }),
    });

    const availability = await backend.availability();
    expect(availability).toMatchObject({ kind: "backend-unavailable" });
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("Hyprland refused to load SynaraComputerUsePluginV3");
    // Hyprland's reason survives verbatim, minus its trailing period, so the
    // sentence reads as one and never as "mismatch.. If".
    expect(message).toContain("API version mismatch. If Hyprland was upgraded");
    expect(message).toContain("install-and-load.sh");
    await backend.dispose();
  });

  it("falls back to the generic version-mismatch cause when hyprctl gave no words", async () => {
    const backend = await makeBackend({
      pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV3.so"),
      dbusFactory: async () => fakeDbus({ loadPlugin: async () => false }),
    });

    const availability = await backend.availability();
    expect(availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining(
        "only loads into the exact Hyprland version it was built against",
      ),
    });
    await backend.dispose();
  });
});
