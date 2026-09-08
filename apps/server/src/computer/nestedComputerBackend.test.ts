import { describe, expect, it, vi } from "vitest";

import type { AtspiTreeReader } from "./atspiClient.ts";
import type { ComputerBackendEvent } from "./ComputerBackend.ts";
import type { KWinComputerDbus } from "./kwinDbus.ts";
import {
  NestedComputerBackend,
  type NestedComputerBackendOptions,
} from "./nestedComputerBackend.ts";
import type {
  NestedAtspiMode,
  NestedKWinSession,
  NestedKWinSessionOptions,
} from "./nestedKWinSession.ts";
import type { SystemPackagePlan } from "./provisioning/systemPackages.ts";

const PLUGIN_ID = "SynaraComputerUsePluginV3";

const PACMAN_PLAN: SystemPackagePlan = {
  manager: "pacman",
  args: ["-S", "--needed", "--noconfirm"],
  packages: ["kwin", "cmake"],
};

/** The narrow slice of the D-Bus surface the connect path exercises. */
function fakeDbusHandle(loaded: readonly string[] = [PLUGIN_ID]): {
  readonly dbus: KWinComputerDbus;
  readonly fireDisconnect: () => void;
} {
  const plugin = {
    healthJson: async () =>
      JSON.stringify({ ok: true, running: false, capture: true, kwinVersion: "6.7.3" }),
    // An empty desktop, enough for a state read to reach the AT-SPI reader.
    stateJson: async () => JSON.stringify({ position: { x: 0, y: 0 }, targetWindowId: null }),
    windowsJson: async () => "[]",
    stop: async () => true,
  };
  let disconnectListener: (() => void) | undefined;
  const dbus = {
    loaded: [...loaded],
    // Owned once a plugin is loaded, with a stable unique name: the connect
    // path pins its proxy to the owner and refuses a service nobody owns.
    nameOwner: async () => (dbus.loaded.length > 0 ? ":1.42" : undefined),
    listLoadedPluginIds: async () => dbus.loaded,
    loadPlugin: async (id: string) => {
      dbus.loaded = [id];
      return true;
    },
    unloadPlugin: async (id: string) => {
      dbus.loaded = dbus.loaded.filter((candidate) => candidate !== id);
      return true;
    },
    connectPlugin: async () => plugin,
    onDisconnect: (listener: () => void) => {
      disconnectListener = listener;
      return () => undefined;
    },
    close: async () => undefined,
  };
  return {
    dbus: dbus as unknown as KWinComputerDbus,
    fireDisconnect: () => disconnectListener?.(),
  };
}

function fakeDbus(loaded: readonly string[] = [PLUGIN_ID]): KWinComputerDbus {
  return fakeDbusHandle(loaded).dbus;
}

interface Harness {
  readonly backend: NestedComputerBackend;
  readonly sessionStarts: NestedKWinSessionOptions[];
  /** One entry per default-fixture session, with a way to end its processes. */
  readonly startedSessions: Array<{ readonly busAddress: string; kill: (reason?: string) => void }>;
  readonly disposedSessions: string[];
  /** One entry per connectDbus call, with a way to drop that connection. */
  readonly dbusHandles: Array<ReturnType<typeof fakeDbusHandle>>;
  readonly installedPlans: SystemPackagePlan[];
  readonly pluginProvisions: number[];
  readonly events: ComputerBackendEvent[];
  installedPlugins: string[];
}

function makeHarness(
  options: {
    readonly mode?: "window" | "virtual";
    readonly platform?: string;
    readonly hostEnv?: NodeJS.ProcessEnv;
    readonly kwinInstalled?: boolean;
    readonly pluginInstalled?: boolean;
    readonly buildToolingPresent?: boolean;
    readonly prebuiltRoot?: string | undefined;
    readonly plan?: SystemPackagePlan | undefined;
    readonly startSession?: (
      sessionOptions: NestedKWinSessionOptions,
    ) => Promise<NestedKWinSession>;
    readonly installPackages?: (plan: SystemPackagePlan) => Promise<string>;
    readonly onPluginProvision?: () => void;
    readonly atspiMode?: NestedAtspiMode;
    readonly createAtspiClient?: (env: NodeJS.ProcessEnv) => AtspiTreeReader;
  } = {},
): Harness {
  const sessionStarts: NestedKWinSessionOptions[] = [];
  const startedSessions: Harness["startedSessions"] = [];
  const disposedSessions: string[] = [];
  const dbusHandles: Harness["dbusHandles"] = [];
  const installedPlans: SystemPackagePlan[] = [];
  const pluginProvisions: number[] = [];
  const events: ComputerBackendEvent[] = [];
  const state = { installedPlugins: options.pluginInstalled === false ? [] : [PLUGIN_ID] };

  const startSession =
    options.startSession ??
    (async (sessionOptions: NestedKWinSessionOptions): Promise<NestedKWinSession> => {
      sessionStarts.push(sessionOptions);
      const busAddress = `unix:abstract=fake-${sessionStarts.length}`;
      let exitReason: string | undefined;
      startedSessions.push({
        busAddress,
        kill: (reason = "exit code 0, signal null") => {
          exitReason = reason;
        },
      });
      return {
        busAddress,
        waylandDisplay: "synara-nested-test",
        size: { width: 1920, height: 1080 },
        pluginId: PLUGIN_ID,
        xDisplay: ":7",
        exited: () => exitReason,
        dispose: async () => {
          disposedSessions.push(busAddress);
        },
      };
    });

  const backendOptions: NestedComputerBackendOptions = {
    // Left unset unless a test names it, so the suite exercises the real
    // default (headless) rather than baking its own into every test.
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.atspiMode !== undefined ? { atspiMode: options.atspiMode } : {}),
    ...(options.createAtspiClient ? { createAtspiClient: options.createAtspiClient } : {}),
    platform: options.platform ?? "linux",
    hostEnv: options.hostEnv ?? { WAYLAND_DISPLAY: "wayland-0", PATH: "/usr/bin" },
    startSession,
    connectDbus: async () => {
      const handle = fakeDbusHandle([PLUGIN_ID]);
      dbusHandles.push(handle);
      return handle.dbus;
    },
    hasCommand: (command) => (command === "kwin_wayland" ? (options.kwinInstalled ?? true) : false),
    installedPluginPresent: () => state.installedPlugins.length > 0,
    installedPluginIds: async () => state.installedPlugins,
    buildToolingPresent: () => options.buildToolingPresent ?? true,
    prebuiltRoot: () => options.prebuiltRoot,
    planPackages: () => ("plan" in options ? options.plan : PACMAN_PLAN),
    installPackages:
      options.installPackages ??
      (async (plan) => {
        installedPlans.push(plan);
        return `Installed ${plan.packages.join(", ")} with ${plan.manager}.`;
      }),
    provisionPlugin: async () => {
      options.onPluginProvision?.();
      pluginProvisions.push(1);
      state.installedPlugins = [PLUGIN_ID];
      return {
        action: "installed-from-source",
        pluginId: PLUGIN_ID,
        requiresRelogin: false,
        summary: "Compiled and installed the Synara KWin plugin.",
      };
    },
  };
  const backend = new NestedComputerBackend(backendOptions);
  backend.onEvent?.((event) => events.push(event));
  const harness: Harness = {
    backend,
    sessionStarts,
    startedSessions,
    disposedSessions,
    dbusHandles,
    installedPlans,
    pluginProvisions,
    events,
    get installedPlugins() {
      return state.installedPlugins;
    },
    set installedPlugins(value: string[]) {
      state.installedPlugins = value;
    },
  };
  return harness;
}

describe("probeAvailability", () => {
  it("is passive and optimistic: available without booting anything", async () => {
    const harness = makeHarness({ kwinInstalled: false, pluginInstalled: false });
    await expect(harness.backend.probeAvailability()).resolves.toEqual({
      kind: "available",
      backend: "nested-kwin",
    });
    expect(harness.sessionStarts).toHaveLength(0);
    expect(harness.installedPlans).toHaveLength(0);
  });

  it("refuses a windowed session with no Wayland host to nest into", async () => {
    const harness = makeHarness({ mode: "window", hostEnv: { PATH: "/usr/bin" } });
    const availability = await harness.backend.probeAvailability();
    expect(availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("WAYLAND_DISPLAY"),
    });
    expect(harness.sessionStarts).toHaveLength(0);
  });

  it("keeps the default headless mode independent of the host display", async () => {
    const harness = makeHarness({ hostEnv: { PATH: "/usr/bin" } });
    await expect(harness.backend.probeAvailability()).resolves.toMatchObject({
      kind: "available",
    });
  });

  it("refuses a non-Linux platform", async () => {
    const harness = makeHarness({ platform: "darwin" });
    await expect(harness.backend.probeAvailability()).resolves.toEqual({
      kind: "unsupported-platform",
      platform: "darwin",
    });
  });
});

describe("capabilities", () => {
  it("reports nothing before setup, so the settings card offers Set up", () => {
    const harness = makeHarness({ kwinInstalled: false, pluginInstalled: false });
    const capabilities = harness.backend.capabilities();
    expect(capabilities.input).toBe(false);
    expect(capabilities.capture).toBe(false);
  });

  it("reports the full set once the compositor and plugin are installed", () => {
    const harness = makeHarness();
    const capabilities = harness.backend.capabilities();
    expect(capabilities.input).toBe(true);
    expect(capabilities.capture).toBe(true);
    expect(capabilities.visibleDesktop).toBe(false);
  });

  it("needs both artifacts, not either", () => {
    expect(makeHarness({ kwinInstalled: false }).backend.capabilities().input).toBe(false);
    expect(makeHarness({ pluginInstalled: false }).backend.capabilities().input).toBe(false);
  });
});

describe("lazy session boot", () => {
  it("boots the nested session on the first establishing read, not before", async () => {
    const harness = makeHarness();
    expect(harness.sessionStarts).toHaveLength(0);
    await expect(harness.backend.availability()).resolves.toEqual({
      kind: "available",
      backend: "nested-kwin",
    });
    expect(harness.sessionStarts).toHaveLength(1);
    // The default session is headless: real use must never pop a window
    // onto the host desktop.
    expect(harness.sessionStarts[0]?.mode).toBe("virtual");
  });

  it("boots once and reuses the session across reads", async () => {
    const harness = makeHarness();
    await harness.backend.availability();
    await harness.backend.availability();
    expect(harness.sessionStarts).toHaveLength(1);
  });

  it("announces the capability change the boot causes", async () => {
    const harness = makeHarness({ kwinInstalled: false, pluginInstalled: false });
    // Pre-boot the panel was told "nothing"; the running session must push the
    // correction rather than waiting to be asked.
    harness.installedPlugins = [PLUGIN_ID];
    await harness.backend.availability();
    const change = harness.events.find((event) => event.type === "capabilities-changed");
    expect(change).toBeDefined();
    expect(change?.type === "capabilities-changed" && change.capabilities.input).toBe(true);
  });

  it("installs the plugin in user space before booting when it is missing", async () => {
    const harness = makeHarness({ pluginInstalled: false });
    await harness.backend.availability();
    expect(harness.pluginProvisions).toHaveLength(1);
    expect(harness.sessionStarts).toHaveLength(1);
    // Never the polkit path: booting must not raise an authorization dialog.
    expect(harness.installedPlans).toHaveLength(0);
  });

  it("points a failed silent install at the Set up button", async () => {
    const failing = new NestedComputerBackend({
      mode: "window",
      platform: "linux",
      hostEnv: { WAYLAND_DISPLAY: "wayland-0", PATH: "/usr/bin" },
      startSession: async () => {
        throw new Error("must not boot");
      },
      connectDbus: async () => fakeDbus(),
      installedPluginIds: async () => [],
      provisionPlugin: async () => {
        throw new Error("cmake is not installed");
      },
    });
    const availability = await failing.availability();
    expect(availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringMatching(/cmake is not installed.*Set up/s),
    });
    await failing.dispose();
  });
});

describe("provision", () => {
  it("installs packages, provisions the plugin, and boots, in that order", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      kwinInstalled: false,
      pluginInstalled: false,
      installPackages: async (plan) => {
        order.push("packages");
        return `Installed ${plan.packages.join(", ")} with ${plan.manager}.`;
      },
      onPluginProvision: () => order.push("plugin"),
      startSession: async () => {
        order.push("boot");
        return {
          busAddress: "unix:abstract=fake",
          waylandDisplay: "synara-nested-test",
          size: { width: 1920, height: 1080 },
          pluginId: PLUGIN_ID,
          xDisplay: undefined,
          exited: () => undefined,
          dispose: async () => undefined,
        };
      },
    });
    const summary = await harness.backend.provision();
    expect(order).toEqual(["packages", "plugin", "boot"]);
    expect(summary).toContain("Installed kwin, cmake with pacman.");
    expect(summary).toContain("Compiled and installed the Synara KWin plugin.");
    expect(summary).toContain("The agent's isolated desktop is running.");
  });

  it("skips the privileged step when nothing privileged is missing", async () => {
    const harness = makeHarness();
    const summary = await harness.backend.provision();
    expect(harness.installedPlans).toHaveLength(0);
    expect(harness.pluginProvisions).toHaveLength(0);
    expect(summary).toBe("The agent's isolated desktop is running.");
  });

  it("asks for packages when the plugin must be built and nothing can build it", async () => {
    const harness = makeHarness({
      kwinInstalled: true,
      pluginInstalled: false,
      buildToolingPresent: false,
      prebuiltRoot: undefined,
    });
    await harness.backend.provision();
    expect(harness.installedPlans).toHaveLength(1);
  });

  it("trusts a shipped prebuilt instead of installing a toolchain", async () => {
    const harness = makeHarness({
      kwinInstalled: true,
      pluginInstalled: false,
      buildToolingPresent: false,
      prebuiltRoot: "/opt/synara/prebuilt",
    });
    await harness.backend.provision();
    expect(harness.installedPlans).toHaveLength(0);
    expect(harness.pluginProvisions).toHaveLength(1);
  });

  it("names the gap on a distribution with no known package manager", async () => {
    const harness = makeHarness({ kwinInstalled: false, plan: undefined });
    await expect(harness.backend.provision()).rejects.toThrow(
      /No supported package manager.*kwin/s,
    );
  });

  it("is single-flight while running and retryable after a failure", async () => {
    let installs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeHarness({
      kwinInstalled: false,
      pluginInstalled: false,
      installPackages: async () => {
        installs += 1;
        await gate;
        throw new Error("the authorization dialog was dismissed");
      },
    });
    const first = harness.backend.provision();
    const second = harness.backend.provision();
    release?.();
    await expect(first).rejects.toThrow("dismissed");
    await expect(second).rejects.toThrow("dismissed");
    expect(installs).toBe(1);
    // The failed run cleared the flight, so the user's retry actually retries.
    await expect(harness.backend.provision()).rejects.toThrow("dismissed");
    expect(installs).toBe(2);
  });

  it("replaces a session that is alive but broken only on another explicit Set up", async () => {
    const sessions: string[] = [];
    const disposed: string[] = [];
    const deadBuses = new Set<string>();
    const handles = new Map<string, ReturnType<typeof fakeDbusHandle>>();
    const backend = new NestedComputerBackend({
      mode: "window",
      platform: "linux",
      hostEnv: { WAYLAND_DISPLAY: "wayland-0", PATH: "/usr/bin" },
      hasCommand: () => true,
      installedPluginPresent: () => true,
      installedPluginIds: async () => [PLUGIN_ID],
      startSession: async () => {
        const busAddress = `unix:abstract=fake-${sessions.length + 1}`;
        sessions.push(busAddress);
        return {
          busAddress,
          waylandDisplay: "synara-nested-test",
          size: { width: 1920, height: 1080 },
          pluginId: PLUGIN_ID,
          xDisplay: undefined,
          // Alive the whole time: this is the wedged compositor, not the
          // closed window, so the exit check must not reap it.
          exited: () => undefined,
          dispose: async () => {
            disposed.push(busAddress);
          },
        };
      },
      connectDbus: async (busAddress) => {
        if (deadBuses.has(busAddress)) throw new Error("dbus connection refused");
        const handle = fakeDbusHandle();
        handles.set(busAddress, handle);
        return handle.dbus;
      },
    });
    await backend.availability();
    expect(sessions).toHaveLength(1);

    // The session wedges: its processes still run, but its bus stops
    // answering and the live connection reports the disconnect. A second
    // compositor must not be booted next to a live one — the establishing
    // read stays failed.
    deadBuses.add(sessions[0]!);
    handles.get(sessions[0]!)?.fireDisconnect();
    const failed = await backend.availability();
    expect(failed.kind).toBe("backend-unavailable");
    expect(sessions).toHaveLength(1);

    // Set up is the explicit request that may replace it.
    const summary = await backend.provision();
    expect(sessions).toHaveLength(2);
    expect(disposed).toContain(sessions[0]);
    expect(summary).toContain("The agent's isolated desktop is running.");
    await backend.dispose();
  });

  it("disposes the session with the backend", async () => {
    const harness = makeHarness();
    await harness.backend.availability();
    await harness.backend.dispose();
    expect(harness.disposedSessions).toHaveLength(1);
  });

  it("reaps a session whose processes exited and boots a fresh one on the next real use", async () => {
    const harness = makeHarness();
    await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(harness.sessionStarts).toHaveLength(1);

    // The human closes the nested window: the compositor exits and the live
    // connection drops. The next real use must get a working desktop, not an
    // eternity of reconnects to a bus address that can never answer again.
    harness.startedSessions[0]?.kill();
    harness.dbusHandles[0]?.fireDisconnect();

    await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(harness.sessionStarts).toHaveLength(2);
    expect(harness.disposedSessions).toEqual(["unix:abstract=fake-1"]);
    await harness.backend.dispose();
  });

  it("recreates the AT-SPI client for the replacement session after the desktop dies", async () => {
    const clients: Array<{ readonly env: NodeJS.ProcessEnv; disposed: boolean }> = [];
    const harness = makeHarness({
      atspiMode: "session",
      createAtspiClient: (env) => {
        const record = { env, disposed: false };
        clients.push(record);
        return {
          readTrees: async () => [],
          setText: async () => false,
          dispose: async () => {
            record.disposed = true;
          },
        };
      },
    });
    await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
    await harness.backend.getState({ includeText: true });
    expect(clients).toHaveLength(1);
    expect(clients[0]?.env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:abstract=fake-1");

    // The compositor dies and the next real use boots a replacement with a
    // bus of its own; a client still bound to the old address would answer
    // every semantic read from a bus nothing listens on.
    harness.startedSessions[0]?.kill();
    harness.dbusHandles[0]?.fireDisconnect();
    await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
    await harness.backend.getState({ includeText: true });
    expect(harness.sessionStarts).toHaveLength(2);
    expect(clients).toHaveLength(2);
    expect(clients[0]?.disposed).toBe(true);
    expect(clients[1]?.env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:abstract=fake-2");

    await harness.backend.dispose();
    expect(clients[1]?.disposed).toBe(true);
  });

  it("never lets the reconnect loop reopen a window the human closed", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness({ mode: "window" });
      await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });

      harness.startedSessions[0]?.kill();
      harness.dbusHandles[0]?.fireDisconnect();
      // Give the reconnect loop every chance it would ever take: it must reap
      // the dead session, report the desktop dormant, and stand down.
      await vi.advanceTimersByTimeAsync(120_000);

      expect(harness.sessionStarts).toHaveLength(1);
      expect(harness.disposedSessions).toEqual(["unix:abstract=fake-1"]);
      expect(harness.backend.health()).toMatchObject({
        status: "unavailable",
        lastFailure: { message: expect.stringContaining("its window may have been closed") },
      });

      // Dormant, not dead: the next real use still boots a fresh desktop.
      await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
      expect(harness.sessionStarts).toHaveLength(2);
      await harness.backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not blame a closed window when the headless desktop dies", async () => {
    // The headless desktop has no window anyone could have closed; sending the
    // user hunting for one would be worse than saying nothing.
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });

      harness.startedSessions[0]?.kill();
      harness.dbusHandles[0]?.fireDisconnect();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(harness.sessionStarts).toHaveLength(1);
      const health = harness.backend.health();
      expect(health).toMatchObject({
        status: "unavailable",
        lastFailure: { message: expect.stringContaining("is not running") },
      });
      expect(health.lastFailure?.message).not.toContain("window");
      await harness.backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
