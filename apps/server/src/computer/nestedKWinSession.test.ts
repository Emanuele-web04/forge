import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { resolveSynaraPluginLoad } from "./KWinComputerBackend.ts";
import type { KWinComputerDbus, KWinComputerPluginApi } from "./kwinDbus.ts";
import {
  nestedAtspiMode,
  nestedKWinBackendOptions,
  nestedModeLabel,
  nestedSessionEnv,
  nestedSessionMode,
  parseNestedSizeEnv,
  startNestedKWinSession,
  unavailableAtspiReader,
  type NestedKWinSession,
  type NestedKWinSessionOptions,
} from "./nestedKWinSession.ts";

const BUS_ADDRESS = "unix:path=/tmp/synara-nested-test,guid=abc";

describe("nested session geometry", () => {
  it("reads WxH and rejects anything else", () => {
    expect(parseNestedSizeEnv("1280x800")).toEqual({ width: 1_280, height: 800 });
    expect(parseNestedSizeEnv("  1920X1080  ")).toEqual({ width: 1_920, height: 1_080 });
    expect(parseNestedSizeEnv(undefined)).toBeUndefined();
    expect(parseNestedSizeEnv("")).toBeUndefined();
    expect(parseNestedSizeEnv("1280*800")).toBeUndefined();
    expect(parseNestedSizeEnv("1280x")).toBeUndefined();
    expect(parseNestedSizeEnv("-1280x800")).toBeUndefined();
    expect(parseNestedSizeEnv("1280.5x800")).toBeUndefined();
  });

  it("drops a size outside the supported range rather than booting one", () => {
    expect(parseNestedSizeEnv("32x32")).toBeUndefined();
    expect(parseNestedSizeEnv("40000x1080")).toBeUndefined();
    expect(parseNestedSizeEnv("64x64")).toEqual({ width: 64, height: 64 });
  });
});

describe("nested session environment", () => {
  it("points a child at the nested compositor and bus", () => {
    expect(
      nestedSessionEnv({ busAddress: BUS_ADDRESS, waylandDisplay: "synara-nested-1" }),
    ).toEqual({
      WAYLAND_DISPLAY: "synara-nested-1",
      DBUS_SESSION_BUS_ADDRESS: BUS_ADDRESS,
      DISPLAY: "",
      QT_QPA_PLATFORM: "wayland",
    });
  });

  it("points an X11 child at the nested Xwayland rather than the human's display", () => {
    expect(
      nestedSessionEnv({
        busAddress: BUS_ADDRESS,
        waylandDisplay: "synara-nested-1",
        xDisplay: ":9",
      }),
    ).toMatchObject({ DISPLAY: ":9" });
    // Emptied rather than left out: the child inherits the server's environment
    // underneath this one, so omitting the key would leave the human's display
    // in place and open an X11 client on their screen.
    expect(
      nestedSessionEnv({ busAddress: BUS_ADDRESS, waylandDisplay: "synara-nested-1" }),
    ).toMatchObject({ DISPLAY: "" });
  });

  it("is opt-in through the environment, which also names the mode", () => {
    expect(nestedSessionMode({})).toBeUndefined();
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "" })).toBeUndefined();
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "0" })).toBeUndefined();
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "true" })).toBeUndefined();
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "windowed" })).toBeUndefined();
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "1" })).toBe("virtual");
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "window" })).toBe("window");
    expect(nestedModeLabel("virtual")).toBe("virtual");
    expect(nestedModeLabel("window")).toBe("windowed");
    expect(nestedAtspiMode({})).toBe("off");
    expect(nestedAtspiMode({ SYNARA_COMPUTER_NESTED_ATSPI: "1" })).toBe("session");
  });

  it("binds a backend to the nested bus without semantic perception by default", async () => {
    const session: NestedKWinSession = {
      busAddress: BUS_ADDRESS,
      waylandDisplay: "synara-nested-1",
      size: { width: 1_920, height: 1_080 },
      pluginId: "SynaraComputerUsePluginV3",
      xDisplay: undefined,
      exited: () => undefined,
      dispose: async () => undefined,
    };
    const options = nestedKWinBackendOptions(session);
    expect(options.busAddress).toBe(BUS_ADDRESS);
    expect(options.sessionType).toBe("wayland");
    expect(options.visibleDesktop).toBe(false);
    await expect(options.atspi?.readTrees([])).resolves.toEqual([]);
    await expect(unavailableAtspiReader().setText({} as never)).resolves.toBe(false);
  });
});

describe("nested plugin shadowing", () => {
  it("unloads every loaded Synara plugin, the newest included, then loads the newest installed", () => {
    expect(
      resolveSynaraPluginLoad({
        loaded: [
          "kwin4_effect_something",
          "SynaraComputerUsePlugin",
          "SynaraComputerUsePluginV2",
          "SynaraComputerUsePluginV3",
        ],
        installed: ["SynaraComputerUsePluginV2", "SynaraComputerUsePluginV3"],
      }),
    ).toEqual({
      kind: "replace",
      unload: ["SynaraComputerUsePlugin", "SynaraComputerUsePluginV2", "SynaraComputerUsePluginV3"],
      pluginId: "SynaraComputerUsePluginV3",
    });
  });

  it("unloads nothing when the compositor auto-loaded nothing", () => {
    expect(
      resolveSynaraPluginLoad({ loaded: [], installed: ["SynaraComputerUsePluginV10"] }),
    ).toEqual({ kind: "replace", unload: [], pluginId: "SynaraComputerUsePluginV10" });
  });

  it("keeps a sole loaded plugin even when the disk scan finds nothing", () => {
    // A long-lived compositor can outlive the .so files it loaded from; the
    // loaded plugin is still serving and is strictly better than erroring.
    expect(
      resolveSynaraPluginLoad({ loaded: ["SynaraComputerUsePluginV3"], installed: [] }),
    ).toEqual({ kind: "keep", pluginId: "SynaraComputerUsePluginV3" });
  });

  it("has no plan when no Synara plugin exists anywhere", () => {
    expect(resolveSynaraPluginLoad({ loaded: ["kwin4_effect_something"], installed: [] })).toBe(
      undefined,
    );
  });
});

describe("startNestedKWinSession", () => {
  it("boots the bus and compositor, leaves one plugin loaded, and kills both on dispose", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(harness.options({ socketName: "synara-test-1" }));

    expect(session.busAddress).toBe(BUS_ADDRESS);
    expect(session.waylandDisplay).toBe("synara-test-1");
    expect(session.pluginId).toBe("SynaraComputerUsePluginV3");
    expect(harness.spawns[0]?.command).toBe("dbus-daemon");
    expect(harness.spawns[0]?.args).toEqual(["--session", "--print-address=1", "--nofork"]);
    expect(harness.spawns[1]?.command).toBe("kwin_wayland");
    expect(harness.spawns[1]?.args).toEqual([
      "--virtual",
      "--xwayland",
      "--no-global-shortcuts",
      "--socket",
      "synara-test-1",
      "--width",
      "1920",
      "--height",
      "1080",
    ]);
    expect(harness.spawns[1]?.env.DBUS_SESSION_BUS_ADDRESS).toBe(BUS_ADDRESS);
    expect(harness.spawns[1]?.env.WAYLAND_DISPLAY).toBeUndefined();
    expect(harness.dbus.calls).toEqual([
      // The service owner is pinned across the LoadPlugin boundary, before and
      // after the load.
      "nameOwner:org.synara.ComputerUse",
      "listLoadedPluginIds",
      "unloadPlugin:SynaraComputerUsePlugin",
      "unloadPlugin:SynaraComputerUsePluginV3",
      "loadPlugin:SynaraComputerUsePluginV3",
      "nameOwner:org.synara.ComputerUse",
      "connectPlugin",
      "close",
    ]);
    // Only the plugin inside the compositor knows which display KWin gave the
    // Xwayland it started, and an X11 client cannot be launched here without it.
    expect(session.xDisplay).toBe(":9");

    await session.dispose();
    expect(harness.spawns.map((spawn) => spawn.child.signal)).toEqual(["SIGTERM", "SIGTERM"]);
  });

  it("reports through exited() when either of its processes ends", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(harness.options());
    expect(session.exited()).toBeUndefined();

    // The compositor is the process a human can end by closing the nested
    // window, and a clean exit is exactly what that looks like.
    harness.spawns[1]?.child.emit("exit", 0, null);
    expect(session.exited()).toBe("exit code 0, signal null");
    await session.dispose();

    const busHarness = new NestedHarness();
    const busSession = await startNestedKWinSession(busHarness.options());
    busHarness.spawns[0]?.child.emit("exit", 1, null);
    expect(busSession.exited()).toBe("exit code 1, signal null");
    await busSession.dispose();
  });

  it("keeps a virtual compositor off the host display", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(
      harness.options({ hostEnv: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" } }),
    );
    expect(harness.spawns[1]?.args[0]).toBe("--virtual");
    expect(harness.spawns[1]?.env.WAYLAND_DISPLAY).toBeUndefined();
    expect(harness.spawns[1]?.env.DISPLAY).toBeUndefined();
    await session.dispose();
  });

  it("nests a windowed compositor into the host display and drops --virtual", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(
      harness.options({
        mode: "window",
        socketName: "synara-test-2",
        hostEnv: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      }),
    );

    expect(harness.spawns[1]?.args).toEqual([
      "--xwayland",
      "--no-global-shortcuts",
      "--socket",
      "synara-test-2",
      "--width",
      "1920",
      "--height",
      "1080",
    ]);
    expect(harness.spawns[1]?.env.WAYLAND_DISPLAY).toBe("wayland-0");
    expect(harness.spawns[1]?.env.DISPLAY).toBeUndefined();
    expect(harness.spawns[1]?.env.DBUS_SESSION_BUS_ADDRESS).toBe(BUS_ADDRESS);

    await session.dispose();
  });

  it("refuses a windowed session with no host display rather than going virtual", async () => {
    const harness = new NestedHarness();
    await expect(
      startNestedKWinSession(harness.options({ mode: "window", hostEnv: {} })),
    ).rejects.toThrow(/windowed nested session needs a running Wayland session/);
    expect(harness.spawns).toEqual([]);
  });

  it("names the mode that was booting when the compositor never appeared", async () => {
    const harness = new NestedHarness({ nameAppears: false });
    await expect(
      startNestedKWinSession(
        harness.options({
          mode: "window",
          hostEnv: { WAYLAND_DISPLAY: "wayland-0" },
          readyTimeoutMs: 25,
        }),
      ),
    ).rejects.toThrow(/kwin_wayland \(windowed mode\) did not take org\.kde\.KWin/);
  });

  it("passes the requested geometry to the compositor", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(
      harness.options({ size: { width: 1_280, height: 800 } }),
    );
    expect(harness.spawns[1]?.args.slice(-4)).toEqual(["--width", "1280", "--height", "800"]);
    await session.dispose();
  });

  it("names a missing binary and kills what did start", async () => {
    const harness = new NestedHarness({
      spawnFailure: { command: "kwin_wayland", message: "spawn kwin_wayland ENOENT" },
    });
    await expect(startNestedKWinSession(harness.options())).rejects.toThrow(
      /kwin_wayland could not be started: spawn kwin_wayland ENOENT/,
    );
    expect(harness.spawns.map((spawn) => spawn.child.signal)).toEqual(["SIGTERM"]);
  });

  it("reports a compositor that exits before it is ready, with its own output", async () => {
    const harness = new NestedHarness({ kwinFailure: "could not open drm device\n" });
    await expect(startNestedKWinSession(harness.options())).rejects.toThrow(
      /exited before it was ready \(exit code 1, signal null\)\. Last kwin_wayland output: could not open drm device/,
    );
  });

  it("reports a compositor that never takes the KWin name", async () => {
    const harness = new NestedHarness({ nameAppears: false });
    await expect(startNestedKWinSession(harness.options({ readyTimeoutMs: 25 }))).rejects.toThrow(
      /did not take org\.kde\.KWin within 25 ms/,
    );
    expect(harness.spawns.map((spawn) => spawn.child.signal)).toEqual(["SIGTERM", "SIGTERM"]);
  });

  it("reports an uninstalled plugin as the reason and tears the session down", async () => {
    // A compositor with nothing on disk auto-loads nothing either; a loaded
    // plugin with no file behind it would now be kept rather than refused.
    const harness = new NestedHarness({ installed: [], loaded: [] });
    await expect(startNestedKWinSession(harness.options())).rejects.toBeInstanceOf(
      ComputerBackendError,
    );
    await expect(startNestedKWinSession(harness.options())).rejects.toThrow(
      /No installed SynaraComputerUsePluginVn was found for the nested KWin session/,
    );
    expect(harness.dbus.closed).toBe(true);
  });

  it("reports a refused plugin load", async () => {
    const harness = new NestedHarness({ loadAccepted: false });
    await expect(startNestedKWinSession(harness.options())).rejects.toThrow(
      /refused to load SynaraComputerUsePluginV3/,
    );
  });
});

interface FakeSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly child: FakeChild;
}

/** A child process that records the signal it was sent instead of dying. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** As a real child has it: the same streams, indexed by fd, with stdin ignored. */
  readonly stdio = [null, this.stdout, this.stderr];
  signal: string | undefined;
  killed = false;

  kill(signal?: NodeJS.Signals): boolean {
    this.signal ??= signal ?? "SIGTERM";
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, this.signal));
    return true;
  }

  unref(): void {}
}

class FakeDbus implements KWinComputerDbus {
  readonly calls: string[] = [];
  closed = false;
  /** The unique name owning the Synara service once a load is accepted. */
  serviceOwner: string | undefined;

  constructor(
    private readonly loaded: readonly string[],
    private readonly loadAccepted: boolean,
  ) {}

  nameOwner = async (name: string) => {
    this.calls.push(`nameOwner:${name}`);
    if (this.serviceOwner !== undefined) return this.serviceOwner;
    return this.loaded.some((id) => id.startsWith("SynaraComputerUsePlugin")) ? ":1.42" : undefined;
  };
  listLoadedPluginIds = async () => {
    this.calls.push("listLoadedPluginIds");
    return this.loaded;
  };
  loadPlugin = async (pluginId: string) => {
    this.calls.push(`loadPlugin:${pluginId}`);
    if (this.loadAccepted && pluginId.startsWith("SynaraComputerUsePlugin")) {
      this.serviceOwner = ":1.43";
    }
    return this.loadAccepted;
  };
  unloadPlugin = async (pluginId: string) => {
    this.calls.push(`unloadPlugin:${pluginId}`);
    return true;
  };
  xDisplay: string | undefined = ":9";
  connectPlugin = async () => {
    this.calls.push("connectPlugin");
    return {
      healthJson: async () =>
        JSON.stringify({ ok: true, ...(this.xDisplay ? { xDisplay: this.xDisplay } : {}) }),
    } as KWinComputerPluginApi;
  };
  onDisconnect = () => () => undefined;
  close = async () => {
    this.calls.push("close");
    this.closed = true;
  };
}

interface NestedHarnessOptions {
  readonly installed?: readonly string[];
  readonly loaded?: readonly string[];
  readonly loadAccepted?: boolean;
  readonly nameAppears?: boolean;
  /** Compositor stderr, followed by a non-zero exit. */
  readonly kwinFailure?: string;
  readonly spawnFailure?: { readonly command: string; readonly message: string };
}

/** Drives startNestedKWinSession with no processes and no bus. */
class NestedHarness {
  readonly spawns: FakeSpawn[] = [];
  readonly dbus: FakeDbus;

  constructor(private readonly harnessOptions: NestedHarnessOptions = {}) {
    this.dbus = new FakeDbus(
      harnessOptions.loaded ?? ["SynaraComputerUsePlugin", "SynaraComputerUsePluginV3"],
      harnessOptions.loadAccepted ?? true,
    );
  }

  options(overrides: NestedKWinSessionOptions = {}): NestedKWinSessionOptions {
    return {
      spawnProcess: (command, args, env) => this.spawn(command, args, env),
      installedPluginIds: async () =>
        this.harnessOptions.installed ?? ["SynaraComputerUsePluginV2", "SynaraComputerUsePluginV3"],
      connectDbus: async () => this.dbus,
      waitForBusName: async (waitOptions) => {
        // The real wait polls, so it always gives a compositor that is dying a
        // chance to be noticed before it reports the name.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (waitOptions.abort?.() === true) return false;
        return this.harnessOptions.nameAppears ?? true;
      },
      ...overrides,
    };
  }

  private spawn(command: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
    if (this.harnessOptions.spawnFailure?.command === command) {
      throw new Error(this.harnessOptions.spawnFailure.message);
    }
    const child = new FakeChild();
    this.spawns.push({ command, args, env, child });
    if (command === "dbus-daemon") {
      queueMicrotask(() => child.stdout.write(`${BUS_ADDRESS}\n`));
    } else if (this.harnessOptions.kwinFailure !== undefined) {
      queueMicrotask(() => {
        child.stderr.write(this.harnessOptions.kwinFailure!);
        queueMicrotask(() => child.emit("exit", 1, null));
      });
    }
    return child as unknown as ChildProcess;
  }
}
