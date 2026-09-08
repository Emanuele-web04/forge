import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComputerHealth, ComputerWindow } from "@synara/contracts";

import {
  installStampIsCurrent,
  KWinComputerBackend,
  localBuildToolingPresent,
  newestPluginId,
  prebuiltPluginRoot,
  resolveInstallScriptPath,
  type KWinComputerBackendOptions,
} from "./KWinComputerBackend.ts";
import {
  ComputerBackendError,
  MAX_COMPUTER_CLIPBOARD_BYTES,
  type ComputerResolvedTarget,
} from "./ComputerBackend.ts";
import type { ClipboardCommandResult, ClipboardCommandSpec } from "./wlClipboard.ts";
import type { AtspiTextWrite, AtspiTreeReader } from "./atspiClient.ts";
import {
  COMPUTER_SERVICE,
  KWIN_SERVICE,
  type KWinComputerDbus,
  type KWinComputerPluginApi,
} from "./kwinDbus.ts";
import { GLIDE_FRAME_INTERVAL_MS } from "./pointerSequencing.ts";
import { resolveInstallTarget } from "./kwinPluginProvisioning.ts";

/** The same roots KWinComputerBackend feeds resolveInstallTarget. */
const SYSTEM_QT_PLUGIN_ROOTS_FOR_TEST = ["/usr/lib64/qt6/plugins", "/usr/lib/qt6/plugins"] as const;

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

/**
 * A PNG header carrying the requested dimensions. Only the IHDR size fields are
 * read back, which is what the region/scale mapping is derived from.
 */
function pngOfSize(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(PNG_1X1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

class FakePlugin implements KWinComputerPluginApi {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  capture = true;
  captureBytes: Uint8Array = PNG_1X1;
  running = false;
  workspace:
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
  captureFailure: Error | undefined;
  releasedByUser = false;
  idleTimeoutMs: number | undefined;
  idleTimeoutFailure: Error | undefined;
  position: { readonly x: number; readonly y: number } = { x: 0, y: 0 };
  /** Mirrors KWin clamping a pointer move to the nearest output. */
  clampPointer: ((x: number, y: number) => { readonly x: number; readonly y: number }) | undefined;
  windows: readonly ComputerWindow[] = [
    {
      id: "window-1",
      title: "Terminal",
      appName: "org.kde.konsole",
      pid: 123,
      bounds: { x: 956, y: 1519, width: 648, height: 518 },
      focused: true,
      minimized: false,
      visible: true,
    },
  ];

  healthJson = async () =>
    JSON.stringify({
      ok: true,
      running: this.running,
      capture: this.capture,
      releasedByUser: this.releasedByUser,
      idleTimeoutMs: this.idleTimeoutMs ?? 300_000,
      kwinVersion: "6.7.3",
      ...(this.workspace ? { workspaceGeometry: this.workspace } : {}),
    });
  /** The plugin's human-active introspection, absent until a test sets it. */
  humanState:
    | {
        readonly humanFocusWindowId?: string;
        readonly msSinceHumanInput?: number;
        readonly ownsCompositor?: boolean;
      }
    | undefined;
  /** Which window the plugin says the agent seat is aimed at. */
  targetWindowId: string | null = "window-1";
  stateJson = async () =>
    JSON.stringify({
      position: this.position,
      targetWindowId: this.targetWindowId,
      ...this.humanState,
    });
  windowsJson = async () => JSON.stringify(this.windows);
  start = async () => {
    this.calls.push({ method: "start", args: [] });
    if (this.releasedByUser) {
      throw dbusError(
        "org.synara.ComputerUse.Error.ControlReleased",
        "computer control was released with Meta+Shift+Esc",
      );
    }
    this.running = true;
    return true;
  };
  stop = async () => {
    this.running = false;
    this.releasedByUser = false;
    return this.recordResult("stop");
  };
  setIdleTimeout = async (milliseconds: number) => {
    this.calls.push({ method: "setIdleTimeout", args: [milliseconds] });
    if (this.idleTimeoutFailure) throw this.idleTimeoutFailure;
    this.idleTimeoutMs = milliseconds;
    return true;
  };
  humanActiveGuardMs: number | undefined;
  humanActiveGuardFailure: Error | undefined;
  setHumanActiveGuardMs = async (milliseconds: number) => {
    this.calls.push({ method: "setHumanActiveGuardMs", args: [milliseconds] });
    if (this.humanActiveGuardFailure) throw this.humanActiveGuardFailure;
    this.humanActiveGuardMs = milliseconds;
    return true;
  };
  agentName: string | undefined;
  agentNameFailure: Error | undefined;
  setAgentName = async (name: string) => {
    this.calls.push({ method: "setAgentName", args: [name] });
    if (this.agentNameFailure) throw this.agentNameFailure;
    this.agentName = name;
    return true;
  };
  focusWindow = async (windowId: string) => this.recordInput("focusWindow", windowId);
  raiseWindowFailure: Error | undefined;
  raiseWindow = async (windowId: string) => {
    if (this.raiseWindowFailure) {
      this.calls.push({ method: "raiseWindow", args: [windowId] });
      throw this.raiseWindowFailure;
    }
    return this.recordInput("raiseWindow", windowId);
  };
  clearFocusWindow = async () => this.recordInput("clearFocusWindow");
  movePointer = async (x: number, y: number) => {
    if (this.running) this.position = this.clampPointer?.(x, y) ?? { x, y };
    return this.recordInput("movePointer", x, y);
  };
  /** Fails one input method, the way the plugin refuses an unreachable client. */
  inputFailure: { readonly method: string; readonly error: Error } | undefined;
  button = async (code: number, pressed: boolean) => this.recordInput("button", code, pressed);
  axis = async (horizontal: number, vertical: number) =>
    this.recordInput("axis", horizontal, vertical);
  key = async (code: number, pressed: boolean) => this.recordInput("key", code, pressed);
  captureWindow = async (windowId: string, maxDimension: number) => {
    this.calls.push({ method: "captureWindow", args: [windowId, maxDimension] });
    if (this.captureFailure) throw this.captureFailure;
    return this.capture ? this.captureBytes : Uint8Array.of();
  };
  captureRegion = async (
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension: number,
  ) => {
    this.calls.push({ method: "captureRegion", args: [x, y, width, height, maxDimension] });
    if (this.captureFailure) throw this.captureFailure;
    return this.capture ? this.captureBytes : Uint8Array.of();
  };

  private recordResult(method: string, ...args: readonly unknown[]): true {
    this.calls.push({ method, args });
    return true;
  }

  /** Mirrors the plugin refusing every input while the session is stopped. */
  private recordInput(method: string, ...args: readonly unknown[]): boolean {
    this.calls.push({ method, args });
    if (this.inputFailure?.method === method) throw this.inputFailure.error;
    return this.running;
  }
}

class FakeDbus implements KWinComputerDbus {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  readonly plugin: FakePlugin;
  loaded: readonly string[] = [];
  /**
   * The unique bus name currently owning org.synara.ComputerUse, mimicking how
   * every freshly loaded generation registers under a new unique name.
   */
  serviceOwner: string | undefined;
  private ownerCounter = 42;
  private disconnectListener: (() => void) | undefined;

  constructor(plugin = new FakePlugin()) {
    this.plugin = plugin;
  }

  nameOwner = async (name: string) => {
    this.calls.push({ method: "GetNameOwner", args: [name] });
    if (this.serviceOwner !== undefined) return this.serviceOwner;
    return this.loaded.some((id) => id.startsWith("SynaraComputerUsePlugin")) ? ":1.42" : undefined;
  };
  listLoadedPluginIds = async () => {
    this.calls.push({ method: "loadedPlugins", args: [] });
    return this.loaded;
  };
  loadPlugin = async (pluginId: string) => {
    this.calls.push({ method: "LoadPlugin", args: [pluginId] });
    this.loaded = [pluginId];
    if (pluginId.startsWith("SynaraComputerUsePlugin")) {
      // A new registration takes a new unique name; that change across the
      // LoadPlugin boundary is exactly what the backend asserts on.
      this.serviceOwner = `:1.${(this.ownerCounter += 1)}`;
    }
    return true;
  };
  unloadPlugin = async (pluginId: string) => {
    this.calls.push({ method: "UnloadPlugin", args: [pluginId] });
    const wasLoaded = this.loaded.includes(pluginId);
    this.loaded = this.loaded.filter((id) => id !== pluginId);
    return wasLoaded;
  };
  connectPlugin = async () => {
    this.calls.push({ method: "connectPlugin", args: [] });
    return this.plugin;
  };
  onDisconnect = (listener: () => void) => {
    this.disconnectListener = listener;
    return () => {
      if (this.disconnectListener === listener) this.disconnectListener = undefined;
    };
  };
  close = async () => {
    this.calls.push({ method: "close", args: [] });
  };
  disconnect = () => this.disconnectListener?.();
}

const atspi: AtspiTreeReader = {
  readTrees: async () => [],
  setText: async () => false,
  dispose: async () => undefined,
};

function makeBackend(
  dbus: FakeDbus,
  options: Omit<KWinComputerBackendOptions, "dbus"> = {},
): KWinComputerBackend {
  return new KWinComputerBackend({
    ...options,
    dbus,
    atspi: options.atspi ?? atspi,
    // Linux and Wayland unless a test is specifically about the platform gate,
    // so the suite runs identically on a developer's machine and in CI.
    platform: options.platform ?? "linux",
    sessionType: options.sessionType ?? "wayland",
    installedPluginIds:
      options.installedPluginIds ??
      (async () => ["SynaraComputerUsePluginV2", "SynaraComputerUsePluginV10"]),
    sleep: options.sleep ?? (async () => undefined),
    // Tests must never resolve names against the host's PATH or flatpak dirs.
    resolveApp:
      options.resolveApp ?? ((app, args) => ({ command: app, args: [...args], via: "path" })),
    // Never let a test read the real installer stamp or spawn kwin_wayland.
    installStampPath: options.installStampPath ?? join(tmpdir(), "synara-absent-install.stamp"),
    runningKwinVersion: options.runningKwinVersion ?? (async () => undefined),
    // The passive probe's three host reads, all stubbed by default: a test must
    // never ask the developer's own session bus, find the repository's shipped
    // binaries, or answer differently on a machine that has cmake installed.
    busNameHasOwner: options.busNameHasOwner ?? (async () => false),
    prebuiltRoot: options.prebuiltRoot ?? (() => undefined),
    buildToolingPresent: options.buildToolingPresent ?? (() => false),
    // Provisioning compiles a KWin plugin and writes it into the developer's own
    // home directory, so no test gets the real one by omission.
    provisionPlugin:
      options.provisionPlugin ??
      (async () => {
        throw new Error("provisionPlugin was not stubbed in this test");
      }),
  });
}

/**
 * Redirects every path the real provisioning wiring derives from the
 * environment into a temp home, restores the old ones afterwards. Used by the
 * tests that exercise the backend's own `provisionKWinPlugin` wiring rather
 * than a stub: without this they would write an env script and plugin into
 * the developer's actual home directory.
 */
async function withProvisionHome(body: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "synara-kwin-home-"));
  const saved = new Map<string, string | undefined>();
  const keys = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "SYNARA_KWIN_PLUGIN_DIR",
    "SYNARA_KWIN_STATE_ROOT",
    "SYNARA_KWIN_PREBUILT_DIR",
    "SYNARA_KWIN_SOURCE_DIR",
  ] as const;
  for (const key of keys) saved.set(key, process.env[key]);
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.XDG_STATE_HOME = join(home, "state");
  for (const key of keys.slice(3)) delete process.env[key];
  try {
    await body(home);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

/** A shipped-binary bundle whose single build matches `kwinVersion`. */
async function writePrebuiltBundle(
  home: string,
  kwinVersion: string,
  bytes: string,
): Promise<string> {
  const prebuiltRoot = join(home, "prebuilt");
  await mkdir(prebuiltRoot, { recursive: true });
  await writeFile(join(prebuiltRoot, "p.so"), bytes);
  await writeFile(
    join(prebuiltRoot, "manifest.json"),
    JSON.stringify({
      builds: [
        {
          kwinVersion,
          arch: process.arch,
          file: "p.so",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    }),
  );
  return prebuiltRoot;
}

/**
 * A backend running the real default provisioning wiring — no provisionPlugin
 * stub — against temp directories, mirroring makeBackend's other stand-ins.
 * `pluginDirectories` is pinned to the resolved user-owned target so version
 * numbering never reads the developer's real system plugin directories.
 */
function provisionWiringBackend(options: {
  readonly dbus: FakeDbus;
  readonly pluginDirectory: string;
  readonly prebuiltRoot: string;
  readonly runningKwinVersion: () => Promise<string | undefined>;
  readonly installedPluginIds?: () => Promise<readonly string[]>;
}): KWinComputerBackend {
  return new KWinComputerBackend({
    dbus: options.dbus,
    atspi,
    platform: "linux",
    sessionType: "wayland",
    sleep: async () => undefined,
    resolveApp: (app, args) => ({ command: app, args: [...args], via: "path" }),
    pluginDirectories: [options.pluginDirectory],
    installStampPath: join(
      process.env.XDG_STATE_HOME ?? join(tmpdir(), "state"),
      "synara",
      "kwin-computer-use-plugin",
      "install.stamp",
    ),
    runningKwinVersion: options.runningKwinVersion,
    busNameHasOwner: async () => false,
    prebuiltRoot: () => options.prebuiltRoot,
    buildToolingPresent: () => false,
    ...(options.installedPluginIds ? { installedPluginIds: options.installedPluginIds } : {}),
  });
}

/** Counts window enumerations from here on; the plugin does not record them. */
function countWindowReads(plugin: FakePlugin): () => number {
  let reads = 0;
  const original = plugin.windowsJson;
  plugin.windowsJson = async () => {
    reads += 1;
    return await original();
  };
  return () => reads;
}

/** A semantic target resolved against the fake plugin's only window. */
function resolvedTarget(options: { readonly editable: boolean }): ComputerResolvedTarget {
  return {
    target: { label: "Name", role: "entry" },
    point: { x: 1_000, y: 1_600 },
    node: {
      role: "entry",
      label: "Name",
      value: null,
      description: null,
      frame: { x: 980, y: 1_580, width: 200, height: 40 },
      activationPoint: null,
      onScreen: true,
      windowId: "window-1" as ComputerWindow["id"],
      nodePath: [1, 2],
      editable: options.editable,
      children: [],
    },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  return Promise.withResolvers<T>();
}

interface FakeClock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly advance: (milliseconds: number) => void;
  readonly sleeps: number[];
}

/** Virtual clock: an injected sleep is the only thing that passes time for free. */
function fakeClock(): FakeClock {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      nowMs += milliseconds;
    },
    advance: (milliseconds) => {
      nowMs += milliseconds;
    },
    sleeps,
  };
}

interface PointerTimelineEntry {
  readonly method: "movePointer" | "press" | "release";
  readonly at: number;
}

/**
 * Makes every pointer D-Bus call cost `callMs` of virtual time so a test can
 * tell duration-derived pacing (latency comes out of the sleep budget) from the
 * old fixed per-step sleep (latency was added on top).
 */
function instrumentPointer(
  plugin: FakePlugin,
  clock: FakeClock,
  callMs: number,
): PointerTimelineEntry[] {
  const timeline: PointerTimelineEntry[] = [];
  const movePointer = plugin.movePointer;
  plugin.movePointer = async (x, y) => {
    timeline.push({ method: "movePointer", at: clock.now() });
    clock.advance(callMs);
    return movePointer(x, y);
  };
  const button = plugin.button;
  plugin.button = async (code, pressed) => {
    timeline.push({ method: pressed ? "press" : "release", at: clock.now() });
    return button(code, pressed);
  };
  return timeline;
}

function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function dbusError(type: string, message: string): Error {
  const error = new Error(message) as Error & { type: string };
  error.name = "DBusError";
  error.type = type;
  return error;
}

class FakeChild extends EventEmitter {
  readonly unref = vi.fn();
}

const stamp = (pluginId: string, kwinVersion: string): string =>
  [
    `plugin_id=${pluginId}`,
    "installed_at=2026-01-01T00:00:00.000Z",
    `plugin_path=/somewhere/${pluginId}.so`,
    `kwin_version=${kwinVersion}`,
    "",
  ].join("\n");

function exited(code: number, output: { stdout?: string; stderr?: string } = {}) {
  return {
    outcome: "exited",
    code,
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? "",
  } as const;
}

describe("newestPluginId", () => {
  it("selects the newest versioned plugin id", () => {
    expect(newestPluginId(["SynaraComputerUsePluginV2", "SynaraComputerUsePluginV10"])).toBe(
      "SynaraComputerUsePluginV10",
    );
    expect(newestPluginId(["OtherPlugin"])).toBeUndefined();
  });
});

describe("localBuildToolingPresent", () => {
  it("needs both KWin's cmake config and a cmake on the path", () => {
    const present = new Set(["/usr/lib64/cmake/KWin/KWinConfig.cmake", "/usr/bin/cmake"]);
    const exists = (path: string) => present.has(path);
    const env = { PATH: "/usr/local/bin:/usr/bin" };

    expect(localBuildToolingPresent(exists, env)).toBe(true);
    // The headers without a compiler, and the compiler without the headers,
    // are both machines where a source build would fail — and reporting one as
    // buildable would trade a truthful "not available" for a broken toggle.
    expect(localBuildToolingPresent(exists, { PATH: "/opt/bin" })).toBe(false);
    expect(localBuildToolingPresent((path) => path === "/usr/bin/cmake", env)).toBe(false);
  });
});

/**
 * The stamp check is what keeps repeat provisioning calls cheap once failures
 * and successes stop being memoized, so its four verdicts are pinned here.
 */
describe("installStampIsCurrent", () => {
  it("is current when the stamped file exists for the running KWin", () => {
    expect(
      installStampIsCurrent(
        stamp("SynaraComputerUsePluginV3", "6.7.3"),
        ["SynaraComputerUsePluginV3.so"],
        "6.7.3",
      ),
    ).toBe(true);
  });

  it("is not current when the stamped file is gone", () => {
    expect(installStampIsCurrent(stamp("SynaraComputerUsePluginV3", "6.7.3"), [], "6.7.3")).toBe(
      false,
    );
  });

  it("is not current when the running KWin is newer than the build", () => {
    // This verdict is what turns a KWin upgrade into a fresh install instead
    // of an eternal "already current" about a binary the compositor refuses.
    expect(
      installStampIsCurrent(
        stamp("SynaraComputerUsePluginV3", "6.7.3"),
        ["SynaraComputerUsePluginV3.so"],
        "6.8.0",
      ),
    ).toBe(false);
  });

  it("stays current when either version is unreadable", () => {
    expect(
      installStampIsCurrent(
        stamp("SynaraComputerUsePluginV3", ""),
        ["SynaraComputerUsePluginV3.so"],
        undefined,
      ),
    ).toBe(true);
    expect(
      installStampIsCurrent(
        stamp("SynaraComputerUsePluginV3", "6.7.3"),
        ["SynaraComputerUsePluginV3.so"],
        undefined,
      ),
    ).toBe(true);
  });

  it("is not current without a stamp at all", () => {
    expect(installStampIsCurrent(undefined, ["SynaraComputerUsePluginV3.so"], "6.7.3")).toBe(false);
  });
});

/**
 * Boot and every rendered chat run this, so its whole contract is that it costs
 * the user's desktop nothing: the compositor is not connected to, no plugin is
 * installed, and nothing is loaded. `dbus.calls` staying empty is that contract.
 */
describe("KWinComputerBackend passive probe", () => {
  const prebuiltManifest = async (kwinVersion: string): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "synara-prebuilt-"));
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        builds: [{ kwinVersion, arch: process.arch, file: "plugin.so", sha256: "0".repeat(64) }],
      }),
    );
    return directory;
  };

  it("is available when the plugin is already answering, and touches nothing", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, {
      busNameHasOwner: async (name) => name === KWIN_SERVICE || name === COMPUTER_SERVICE,
      installedPluginIds: async () => [],
    });

    await expect(backend.probeAvailability()).resolves.toEqual({
      kind: "available",
      backend: "kwin",
    });
    expect(dbus.calls).toEqual([]);
    expect(dbus.plugin.calls).toEqual([]);
    await backend.dispose();
  });

  it("is available from an installed plugin file alone", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, {
      busNameHasOwner: async (name) => name === KWIN_SERVICE,
      installedPluginIds: async () => ["SynaraComputerUsePluginV10"],
    });

    await expect(backend.probeAvailability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.calls).toEqual([]);
    await backend.dispose();
  });

  it("is available when a shipped build matches the running KWin exactly", async () => {
    const root = await prebuiltManifest("6.7.3");
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, {
      busNameHasOwner: async (name) => name === KWIN_SERVICE,
      installedPluginIds: async () => [],
      prebuiltRoot: () => root,
      runningKwinVersion: async () => "6.7.3",
    });

    await expect(backend.probeAvailability()).resolves.toMatchObject({ kind: "available" });

    // A near miss is a miss, here as everywhere else: KWin refuses a binary
    // built for another version, so promising one would be a broken toggle.
    const mismatched = makeBackend(new FakeDbus(), {
      busNameHasOwner: async (name) => name === KWIN_SERVICE,
      installedPluginIds: async () => [],
      prebuiltRoot: () => root,
      runningKwinVersion: async () => "6.8.0",
    });
    await expect(mismatched.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
    });

    await backend.dispose();
    await mismatched.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("is available when this machine could build the plugin itself", async () => {
    const backend = makeBackend(new FakeDbus(), {
      busNameHasOwner: async (name) => name === KWIN_SERVICE,
      installedPluginIds: async () => [],
      buildToolingPresent: () => true,
    });

    await expect(backend.probeAvailability()).resolves.toMatchObject({ kind: "available" });
    await backend.dispose();
  });

  it("reports the platform, the session, and a missing compositor without asking further", async () => {
    const notLinux = makeBackend(new FakeDbus(), { platform: "darwin" });
    await expect(notLinux.probeAvailability()).resolves.toEqual({
      kind: "unsupported-platform",
      platform: "darwin",
    });

    const notWayland = makeBackend(new FakeDbus(), { sessionType: "x11" });
    await expect(notWayland.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("Wayland session"),
    });

    const noKwin = makeBackend(new FakeDbus(), {
      busNameHasOwner: async () => false,
      installedPluginIds: async () => {
        throw new Error("the plugin scan must not run without a compositor");
      },
    });
    await expect(noKwin.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("No KWin compositor"),
    });

    await Promise.all([notLinux.dispose(), notWayland.dispose(), noKwin.dispose()]);
  });

  it("refuses rather than provisioning when no plugin exists and none could be made", async () => {
    const dbus = new FakeDbus();
    const provisionPlugin = vi.fn(async () => {
      throw new Error("provisioning must never run from a probe");
    });
    const backend = makeBackend(dbus, {
      busNameHasOwner: async (name) => name === KWIN_SERVICE,
      installedPluginIds: async () => [],
      provisionPlugin,
    });

    await expect(backend.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("Synara computer-use plugin"),
    });
    expect(provisionPlugin).not.toHaveBeenCalled();
    expect(dbus.calls).toEqual([]);
    await backend.dispose();
  });

  it("survives a session bus that cannot be reached at all", async () => {
    const backend = makeBackend(new FakeDbus(), {
      busNameHasOwner: async () => {
        throw new Error("no session bus");
      },
    });

    // A probe answers the question or answers "no"; it never fails the boot
    // that is waiting on it.
    await expect(backend.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
    });
    await backend.dispose();
  });
});

describe("KWinComputerBackend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * A monitor arranged left of and above the primary puts the workspace's
   * top-left at negative global coordinates. Before the agent↔global
   * translation existed, its windows reported bounds no coordinate could
   * address: resolveComputerPoint refuses negatives, so screenshots showed
   * pixels the pointer could never reach. Here everything above the backend —
   * window bounds, screen size, click coordinates, capture regions, clamped
   * results — agrees on one 0-based space while the plugin sees globals.
   */
  it("addresses a negative-origin multi-monitor layout in agent space", async () => {
    const dbus = new FakeDbus();
    const plugin = new FakePlugin();
    plugin.workspace = { x: -1920, y: -1080, width: 3840, height: 2160 };
    plugin.windows = [
      {
        id: "window-1",
        title: "Terminal",
        appName: "org.kde.konsole",
        pid: 123,
        // Global bounds on the left-hand monitor.
        bounds: { x: -1800, y: -900, width: 648, height: 518 },
        focused: true,
        minimized: false,
        visible: true,
      },
    ];
    dbus.serviceOwner = ":1.42";
    (dbus as { plugin: FakePlugin }).plugin = plugin;
    const backend = makeBackend(dbus);
    await backend.availability();

    // The window list speaks agent space: shifted by the workspace origin.
    await expect(backend.listWindows()).resolves.toEqual([
      expect.objectContaining({
        id: "window-1",
        bounds: { x: 120, y: 180, width: 648, height: 518 },
      }),
    ]);
    await expect(backend.getScreenSize()).resolves.toEqual({
      width: 3840,
      height: 2160,
      scale: 1,
    });

    // A bare coordinate inside the left monitor is deliverable: the sink
    // translates it back into the global space the plugin drives.
    await backend.click({ x: 200, y: 100 });
    const move = plugin.calls.findLast((call) => call.method === "movePointer");
    expect(move?.args).toEqual([200 - 1920, 100 - 1080]);

    // Capture regions go the other way: requested in agent space, captured in
    // globals, reported in agent space.
    await backend.captureScreenshot({
      kind: "region",
      region: { x: 120, y: 180, width: 648, height: 518 },
    });
    const region = plugin.calls.findLast((call) => call.method === "captureRegion");
    expect(region?.args.slice(0, 4)).toEqual([-1800, -900, 648, 518]);

    // A region on the right-hand monitor is just as capturable. The clip rect
    // is the global workspace itself; shifting it by the origin again would
    // reject everything right of or below the primary.
    await backend.captureScreenshot({
      kind: "region",
      region: { x: 2000, y: 1200, width: 400, height: 300 },
    });
    const rightRegion = plugin.calls.findLast((call) => call.method === "captureRegion");
    expect(rightRegion?.args.slice(0, 4)).toEqual([80, 120, 400, 300]);

    // A region straddling the monitor seam survives untruncated.
    await backend.captureScreenshot({
      kind: "region",
      region: { x: 1800, y: 1000, width: 400, height: 300 },
    });
    const seamRegion = plugin.calls.findLast((call) => call.method === "captureRegion");
    expect(seamRegion?.args.slice(0, 4)).toEqual([-120, -80, 400, 300]);

    await backend.dispose();
  });

  it("reports a clamp result in agent space on a negative-origin layout", async () => {
    const dbus = new FakeDbus();
    const plugin = new FakePlugin();
    plugin.workspace = { x: -1920, y: -1080, width: 3840, height: 2160 };
    // KWin lands the move somewhere other than requested; the caller learns
    // where in the same space it asked in.
    plugin.clampPointer = () => ({ x: -1900, y: -1000 });
    (dbus as { plugin: FakePlugin }).plugin = plugin;
    const backend = makeBackend(dbus);
    await backend.availability();

    const result = await backend.moveCursor({ x: 500, y: 500 });
    expect(result.point).toEqual({ x: 500, y: 500 });
    expect(result.clampedTo).toEqual({ x: 20, y: 80 });

    await backend.dispose();
  });

  it("reports Tier 1's whole capability set", () => {
    // The dedicated agent seat inside the compositor is what makes all of these
    // true at once. This set is what every other backend is measured against,
    // so a silent change here would move that baseline.
    expect(makeBackend(new FakeDbus()).capabilities()).toEqual({
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      focus: true,
      raise: true,
      ghostCursor: true,
      visibleDesktop: true,
    });
  });

  it("reports an invisible desktop when bound to a nested compositor", () => {
    // Same class, different tier: the nested session passes visibleDesktop
    // false, and the pane auto-open gate keys off exactly this flag.
    expect(makeBackend(new FakeDbus(), { visibleDesktop: false }).capabilities()).toMatchObject({
      visibleDesktop: false,
    });
  });

  it("loads the newest installed plugin and passes the health gate", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toEqual({ kind: "available", backend: "kwin" });
    expect(dbus.plugin.calls.some((call) => call.method === "start")).toBe(false);
    expect(dbus.calls).toContainEqual({
      method: "LoadPlugin",
      args: ["SynaraComputerUsePluginV10"],
    });

    await backend.dispose();
    expect(dbus.plugin.calls).toContainEqual({ method: "stop", args: [] });
    expect(dbus.calls).toContainEqual({ method: "close", args: [] });
  });

  it("starts the plugin on the first real action after a side-effect-free probe", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(0);

    await backend.focusWindow("window-1");
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(1);

    await backend.availability();
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(1);
    await backend.dispose();
  });

  it("configures the plugin idle timeout on every session start", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { idleTimeoutMs: 90_000 });

    await backend.focusWindow("window-1");
    expect(dbus.plugin.calls).toContainEqual({ method: "setIdleTimeout", args: [90_000] });
    expect(dbus.plugin.idleTimeoutMs).toBe(90_000);

    await backend.dispose();
  });

  it("takes the idle timeout from SYNARA_COMPUTER_IDLE_TIMEOUT_MS", async () => {
    vi.stubEnv("SYNARA_COMPUTER_IDLE_TIMEOUT_MS", "120000");
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await backend.focusWindow("window-1");
    expect(dbus.plugin.idleTimeoutMs).toBe(120_000);

    await backend.dispose();
  });

  it("disables the idle timeout when the environment sets it to zero", async () => {
    vi.stubEnv("SYNARA_COMPUTER_IDLE_TIMEOUT_MS", "0");
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await backend.focusWindow("window-1");
    expect(dbus.plugin.idleTimeoutMs).toBe(0);

    await backend.dispose();
  });

  it.each(["not-a-number", "", "-1", "3600001"])(
    "falls back to the default idle timeout for %j",
    async (value) => {
      vi.stubEnv("SYNARA_COMPUTER_IDLE_TIMEOUT_MS", value);
      const dbus = new FakeDbus();
      const backend = makeBackend(dbus);

      await backend.focusWindow("window-1");
      expect(dbus.plugin.idleTimeoutMs).toBe(300_000);

      await backend.dispose();
    },
  );

  it("prefers an explicit idle timeout over the environment", async () => {
    vi.stubEnv("SYNARA_COMPUTER_IDLE_TIMEOUT_MS", "120000");
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { idleTimeoutMs: 45_000 });

    await backend.focusWindow("window-1");
    expect(dbus.plugin.idleTimeoutMs).toBe(45_000);

    await backend.dispose();
  });

  it("names the driving thread on the ghost cursor, and renames it live", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await backend.setDrivingAgent("Luna");
    // Naming a thread must not be what starts the session: the human would get
    // an agent cursor before any agent asked for one.
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(0);

    await backend.focusWindow("window-1");
    expect(dbus.plugin.agentName).toBe("Luna");

    await backend.setDrivingAgent("Nova");
    expect(dbus.plugin.agentName).toBe("Nova");

    await backend.setDrivingAgent(null);
    expect(dbus.plugin.agentName).toBe("");

    await backend.dispose();
  });

  it("renames the ghost cursor again after the plugin restarts the session", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.setDrivingAgent("Luna");
    await backend.focusWindow("window-1");

    // The plugin auto-stopped, so its own copy of the name went with it.
    dbus.plugin.running = false;
    dbus.plugin.agentName = undefined;

    await backend.click({ x: 44, y: 44 });
    expect(dbus.plugin.agentName).toBe("Luna");

    await backend.dispose();
  });

  it("keeps the session usable when the plugin has no setAgentName", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.agentNameFailure = dbusError(
      "org.freedesktop.DBus.Error.UnknownMethod",
      "No such method 'setAgentName'",
    );
    const backend = makeBackend(dbus);

    await backend.setDrivingAgent("Luna");
    await expect(backend.focusWindow("window-1")).resolves.toBeUndefined();

    await backend.dispose();
  });

  it("keeps the session usable when the plugin has no setIdleTimeout", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.idleTimeoutFailure = dbusError(
      "org.freedesktop.DBus.Error.UnknownMethod",
      "No such method 'setIdleTimeout'",
    );
    const backend = makeBackend(dbus);

    await expect(backend.focusWindow("window-1")).resolves.toBeUndefined();

    await backend.dispose();
  });

  it("restarts the session when the plugin idle timeout stopped it mid-turn", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.focusWindow("window-1");
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(1);

    // The plugin auto-stopped while the model was thinking; the server still
    // believes the session is running.
    dbus.plugin.running = false;

    await expect(backend.click({ x: 44, y: 44 })).resolves.toEqual({ point: { x: 44, y: 44 } });
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(2);
    expect(dbus.plugin.running).toBe(true);

    await backend.dispose();
  });

  it("refuses to take control back after the release hotkey", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.focusWindow("window-1");

    dbus.plugin.running = false;
    dbus.plugin.releasedByUser = true;

    await expect(backend.click({ x: 44, y: 44 })).rejects.toThrow(/Meta\+Shift\+Esc/);
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(1);
    expect(dbus.plugin.running).toBe(false);

    await backend.dispose();
  });

  it("explains a released-control error raised by start itself", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.releasedByUser = true;
    const backend = makeBackend(dbus);

    await expect(backend.focusWindow("window-1")).rejects.toThrow(/hand control back/);

    await backend.dispose();
  });

  it("passes through the plugin's reason for an application it cannot reach", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.focusWindow("window-1");

    // The plugin's own text names the application and the remedy, and no
    // coordinate in that application would have worked, so the reason has to
    // survive intact rather than becoming a generic rejection.
    dbus.plugin.inputFailure = {
      method: "button",
      error: dbusError(
        "org.synara.ComputerUse.Error.SeatUnsupported",
        "Code never bound the synara-agent seat, so input to it is dropped silently.",
      ),
    };

    const refused = backend.click({ x: 44, y: 44 });
    await expect(refused).rejects.toThrow(/Code never bound the synara-agent seat/);
    await expect(refused).rejects.toMatchObject({ retryable: false });
    // A refusal is not a fault: the session stays up and the connection stays open.
    expect(dbus.calls.some((call) => call.method === "close")).toBe(false);
    await expect(backend.listWindows()).resolves.toHaveLength(1);

    await backend.dispose();
  });

  it("refuses a mutating action the plugin declined as the human's window", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.focusWindow("window-1");

    dbus.plugin.inputFailure = {
      method: "button",
      error: dbusError(
        "org.synara.ComputerUse.Error.HumanActive",
        "The human is using Firefox right now - their keyboard focus is on it and their own " +
          "devices were active 300 ms ago - so nothing was sent to it.",
      ),
    };

    const refused = backend.click({ x: 44, y: 44 });
    // The token both tiers refuse with, so the tool surface and the panel copy
    // do not have to know which desktop produced it.
    await expect(refused).rejects.toThrow(/computer_human_active/);
    await expect(refused).rejects.toThrow(/The human is using Firefox/);
    await expect(refused).rejects.toMatchObject({ retryable: true });
    // A refusal is not a fault: the session and the connection both survive it.
    expect(dbus.calls.some((call) => call.method === "close")).toBe(false);
    await expect(backend.listWindows()).resolves.toHaveLength(1);

    await backend.dispose();
  });

  it("configures the plugin human-active guard on every session start", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { humanActiveGuardMs: 1_500 });

    await backend.focusWindow("window-1");
    expect(dbus.plugin.calls).toContainEqual({
      method: "setHumanActiveGuardMs",
      args: [1_500],
    });
    expect(dbus.plugin.humanActiveGuardMs).toBe(1_500);

    await backend.dispose();
  });

  it("defaults the human-active guard to the shared two-second threshold", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await backend.focusWindow("window-1");
    expect(dbus.plugin.humanActiveGuardMs).toBe(2_000);

    await backend.dispose();
  });

  it("takes the human-active guard from SYNARA_COMPUTER_HUMAN_ACTIVE_MS", async () => {
    vi.stubEnv("SYNARA_COMPUTER_HUMAN_ACTIVE_MS", "5000");
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await backend.focusWindow("window-1");
    expect(dbus.plugin.humanActiveGuardMs).toBe(5_000);

    await backend.dispose();
  });

  it("disables the human-active guard when the environment sets it to zero", async () => {
    vi.stubEnv("SYNARA_COMPUTER_HUMAN_ACTIVE_MS", "0");
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await backend.focusWindow("window-1");
    expect(dbus.plugin.humanActiveGuardMs).toBe(0);

    await backend.dispose();
  });

  it("clamps a human-active guard below the plugin's floor", async () => {
    vi.stubEnv("SYNARA_COMPUTER_HUMAN_ACTIVE_MS", "5");
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await backend.focusWindow("window-1");
    expect(dbus.plugin.humanActiveGuardMs).toBe(100);

    await backend.dispose();
  });

  it.each(["not-a-number", "", "-1", "60001"])(
    "falls back to the default human-active guard for %j",
    async (value) => {
      vi.stubEnv("SYNARA_COMPUTER_HUMAN_ACTIVE_MS", value);
      const dbus = new FakeDbus();
      const backend = makeBackend(dbus);

      await backend.focusWindow("window-1");
      expect(dbus.plugin.humanActiveGuardMs).toBe(2_000);

      await backend.dispose();
    },
  );

  it("keeps the session usable when the plugin has no setHumanActiveGuardMs", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.humanActiveGuardFailure = dbusError(
      "org.freedesktop.DBus.Error.UnknownMethod",
      "No such method 'setHumanActiveGuardMs'",
    );
    const backend = makeBackend(dbus);

    await expect(backend.focusWindow("window-1")).resolves.toBeUndefined();

    await backend.dispose();
  });

  it("does not reload when exactly the newest installed plugin is loaded", async () => {
    const dbus = new FakeDbus();
    dbus.loaded = ["SynaraComputerUsePluginV10"];
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.calls.some((call) => call.method === "LoadPlugin")).toBe(false);
    expect(dbus.calls.some((call) => call.method === "UnloadPlugin")).toBe(false);
    await backend.dispose();
  });

  it("replaces a loaded plugin that is older than the newest installed one", async () => {
    // The regression this guards: a session whose compositor still carries an
    // old generation must not be trusted just because something Synara is
    // loaded — the installed V10 is the build the server's API expects.
    const dbus = new FakeDbus();
    dbus.loaded = ["SynaraComputerUsePluginV4"];
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.calls).toContainEqual({
      method: "UnloadPlugin",
      args: ["SynaraComputerUsePluginV4"],
    });
    expect(dbus.calls).toContainEqual({
      method: "LoadPlugin",
      args: ["SynaraComputerUsePluginV10"],
    });
    expect(dbus.loaded).toEqual(["SynaraComputerUsePluginV10"]);
    await backend.dispose();
  });

  it("unloads every stale Synara generation before loading the target", async () => {
    // The plugin claims its D-Bus name only in its constructor, so with several
    // generations loaded the oldest owns the name and newer ones sit silent.
    // Loading the target without clearing them would leave the name owned by
    // the stale build — every one of them has to go first, and the compositor's
    // unrelated plugins have to stay untouched.
    const dbus = new FakeDbus();
    dbus.loaded = [
      "kwin-script-fancy",
      "SynaraComputerUsePlugin",
      "SynaraComputerUsePluginV2",
      "SynaraComputerUsePluginV10",
    ];
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    const unloaded = dbus.calls
      .filter((call) => call.method === "UnloadPlugin")
      .map((call) => call.args[0]);
    expect(unloaded).toEqual([
      "SynaraComputerUsePlugin",
      "SynaraComputerUsePluginV2",
      "SynaraComputerUsePluginV10",
    ]);
    const loadIndex = dbus.calls.findIndex((call) => call.method === "LoadPlugin");
    const lastUnloadIndex = dbus.calls.findLastIndex((call) => call.method === "UnloadPlugin");
    expect(loadIndex).toBeGreaterThan(lastUnloadIndex);
    expect(dbus.loaded).toEqual(["SynaraComputerUsePluginV10"]);
    await backend.dispose();
  });

  it("falls back to the existing Synara service when loadedPlugins is unavailable", async () => {
    const dbus = new FakeDbus();
    dbus.listLoadedPluginIds = async () => {
      throw new Error("org.freedesktop.DBus.Error.UnknownMethod");
    };
    // The "existing service" the fallback connects to: something must own the
    // well-known name for it to be trusted.
    dbus.serviceOwner = ":1.42";
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.calls.some((call) => call.method === "LoadPlugin")).toBe(false);
    await backend.dispose();
  });

  /**
   * The plugin is addressed by the well-known org.synara.ComputerUse name, so
   * a stale duplicate Synara instance (or any same-session squatter) that kept
   * the name through an unload race would otherwise receive every input and
   * capture call — and could serve forged state the agent acts on. A load that
   * did not move the name to a new registration is refused, not driven.
   */
  it("refuses to connect when a fresh load left the previous owner holding the name", async () => {
    const dbus = new FakeDbus();
    // A stale duplicate already owns the well-known name before we connect.
    dbus.serviceOwner = ":1.42";
    dbus.loadPlugin = async (pluginId: string) => {
      // The pathological case: KWin reports the load succeeded, but the old
      // registration never gave up the well-known name.
      dbus.calls.push({ method: "LoadPlugin", args: [pluginId] });
      dbus.loaded = [pluginId];
      return true;
    };
    const backend = makeBackend(dbus);

    const availability = await backend.availability();
    expect(availability.kind).toBe("backend-unavailable");
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("still owned by");
    expect(message).toContain("rather than the one just loaded");
    await backend.dispose();
  });

  it("refuses to connect when nothing owns the service after a load", async () => {
    const dbus = new FakeDbus();
    dbus.nameOwner = async () => undefined;
    const backend = makeBackend(dbus);

    const availability = await backend.availability();
    expect(availability.kind).toBe("backend-unavailable");
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("no computer-use plugin is answering");
    await backend.dispose();
  });

  it("installs the plugin itself when nothing is installed, and loads what it installed", async () => {
    const dbus = new FakeDbus();
    let installed: readonly string[] = [];
    const backend = makeBackend(dbus, {
      installedPluginIds: async () => installed,
      provisionPlugin: async () => {
        installed = ["SynaraComputerUsePluginV1"];
        return {
          action: "installed-prebuilt",
          pluginId: "SynaraComputerUsePluginV1",
          requiresRelogin: false,
          summary: "The computer-use plugin is installed and ready.",
        };
      },
    });

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.calls.some((call) => call.method === "LoadPlugin")).toBe(true);
    await backend.dispose();
  });

  it("says a login is needed when the install landed outside what this session scans", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, {
      installedPluginIds: async () => [],
      // The directory it installed into is not one this compositor was told
      // about, so the rescan still finds nothing.
      provisionPlugin: async () => ({
        action: "installed-prebuilt",
        pluginId: "SynaraComputerUsePluginV1",
        requiresRelogin: true,
        summary: "The computer-use plugin is installed. Log out and back in once to finish.",
      }),
    });

    const availability = await backend.availability();
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("Log out and back in once");
    await backend.dispose();
  });

  it("reports an installed-plugin diagnostic when installing is not possible either", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, {
      installedPluginIds: async () => [],
      provisionPlugin: async () => {
        throw new Error("kwin-devel headers are missing");
      },
    });

    const availability = await backend.availability();
    expect(availability).toMatchObject({ kind: "backend-unavailable" });
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("kwin-devel headers are missing");
    expect(message).toContain("scripts/install-and-load.sh");
    await backend.dispose();
  });

  it("falls back to a source build when the shipped binary is refused too", async () => {
    const dbus = new FakeDbus();
    let installed = ["SynaraComputerUsePluginV2"];
    // Only the locally built one loads: the shipped binary matches this KWin
    // version but was compiled against a different distribution's Qt.
    dbus.loadPlugin = async (pluginId: string) => {
      const accepted = pluginId === "SynaraComputerUsePluginV4";
      if (accepted) dbus.serviceOwner = ":1.43";
      return accepted;
    };
    const attempts: Array<{ allowPrebuilt: boolean; force: boolean }> = [];
    const backend = makeBackend(dbus, {
      installedPluginIds: async () => installed,
      provisionPlugin: async ({ allowPrebuilt, force }) => {
        attempts.push({ allowPrebuilt, force });
        installed = [allowPrebuilt ? "SynaraComputerUsePluginV3" : "SynaraComputerUsePluginV4"];
        return {
          action: allowPrebuilt ? "installed-prebuilt" : "installed-from-source",
          pluginId: installed[0]!,
          requiresRelogin: false,
          summary: "The computer-use plugin is installed and ready.",
        };
      },
    });

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    // The source retry is forced: by then the stamp calls the refused prebuilt
    // current, and an unforced repeat would install nothing.
    expect(attempts).toEqual([
      { allowPrebuilt: true, force: false },
      { allowPrebuilt: false, force: true },
    ]);
    await backend.dispose();
  });

  it("forces the source retry past a stamp that calls the refused prebuilt current", async () => {
    const dbus = new FakeDbus();
    let installed: readonly string[] = [];
    // The shipped binary matches this KWin version but was built against
    // another distribution's ABI; only the local build loads.
    dbus.loadPlugin = async (pluginId: string) => {
      dbus.calls.push({ method: "LoadPlugin", args: [pluginId] });
      const accepted = pluginId === "SynaraComputerUsePluginV2";
      if (accepted) {
        dbus.loaded = [pluginId];
        dbus.serviceOwner = ":1.43";
      }
      return accepted;
    };
    const attempts: Array<{ allowPrebuilt: boolean; force: boolean }> = [];
    let current = false;
    const backend = makeBackend(dbus, {
      installedPluginIds: async () => installed,
      provisionPlugin: async ({ allowPrebuilt, force }) => {
        attempts.push({ allowPrebuilt, force });
        // Like the real installer: once something is in place the stamp calls
        // it current, and only a forced call installs anything more.
        if (current && !force) {
          return {
            action: "already-current",
            requiresRelogin: false,
            summary: "The computer-use plugin is installed and current.",
          };
        }
        current = true;
        const pluginId = allowPrebuilt ? "SynaraComputerUsePluginV1" : "SynaraComputerUsePluginV2";
        installed = [pluginId];
        return {
          action: allowPrebuilt ? "installed-prebuilt" : "installed-from-source",
          pluginId,
          requiresRelogin: false,
          summary: "The computer-use plugin is installed and ready.",
        };
      },
    });

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(attempts).toEqual([
      { allowPrebuilt: true, force: false },
      { allowPrebuilt: true, force: false },
      { allowPrebuilt: false, force: true },
    ]);
    expect(dbus.loaded).toEqual(["SynaraComputerUsePluginV2"]);
    await backend.dispose();
  });

  it("names the login, not a version refusal, when the scan finds an install KWin cannot see", async () => {
    const dbus = new FakeDbus();
    // The install landed in the directory the installer always writes to, so
    // the scan finds it; the running compositor was started before the env
    // script existed, so it refuses to load from there.
    dbus.loadPlugin = async (pluginId: string) => {
      dbus.calls.push({ method: "LoadPlugin", args: [pluginId] });
      return false;
    };
    let forced = false;
    const backend = makeBackend(dbus, {
      installedPluginIds: async () => ["SynaraComputerUsePluginV1"],
      provisionPlugin: async ({ force }) => {
        forced ||= force;
        return {
          action: "already-current",
          requiresRelogin: true,
          summary:
            "The computer-use plugin is installed and current. Log out and back in once to finish enabling it.",
        };
      },
    });

    const availability = await backend.availability();
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("Log out and back in once");
    expect(message).not.toContain("exact KWin version");
    // No rebuild: nothing built here could load until the next login either.
    expect(forced).toBe(false);
    await backend.dispose();
  });

  it("installs on request and leaves loading to the connect that follows", async () => {
    const dbus = new FakeDbus();
    let installed: readonly string[] = [];
    const backend = makeBackend(dbus, {
      installedPluginIds: async () => installed,
      provisionPlugin: async () => {
        installed = ["SynaraComputerUsePluginV1"];
        return {
          action: "installed-prebuilt",
          pluginId: "SynaraComputerUsePluginV1",
          requiresRelogin: false,
          summary: "The computer-use plugin is installed and ready.",
        };
      },
    });

    await expect(backend.provision()).resolves.toBe(
      "The computer-use plugin is installed and ready.",
    );
    expect(dbus.calls.some((call) => call.method === "LoadPlugin")).toBe(false);
    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.loaded).toEqual(["SynaraComputerUsePluginV1"]);
    await backend.dispose();
  });

  it("reinstalls once when KWin refuses the installed plugin, then loads the new id", async () => {
    const dbus = new FakeDbus();
    let installed = ["SynaraComputerUsePluginV2"];
    dbus.loadPlugin = async (pluginId: string) => {
      const accepted = pluginId === "SynaraComputerUsePluginV3";
      if (accepted) dbus.serviceOwner = ":1.43";
      return accepted;
    };
    const backend = makeBackend(dbus, {
      installedPluginIds: async () => installed,
      provisionPlugin: async () => {
        installed = ["SynaraComputerUsePluginV3"];
        return {
          action: "installed-prebuilt",
          pluginId: "SynaraComputerUsePluginV3",
          requiresRelogin: false,
          summary: "The computer-use plugin is installed and ready.",
        };
      },
    });

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    await backend.dispose();
  });

  /**
   * The pre-fix memo replayed a failed provision forever: one transient
   * failure (an OOM-killed compiler, a full disk) and every future connect
   * answered with the identical stale error until the server restarted.
   */
  it("retries provisioning on the next connect after a failed attempt", async () => {
    const dbus = new FakeDbus();
    let installed: readonly string[] = [];
    let fail = true;
    const attempts: number[] = [];
    const backend = makeBackend(dbus, {
      installedPluginIds: async () => installed,
      provisionPlugin: async () => {
        attempts.push(attempts.length + 1);
        if (fail) throw new Error("the compiler was OOM-killed");
        installed = ["SynaraComputerUsePluginV1"];
        return {
          action: "installed-prebuilt",
          pluginId: "SynaraComputerUsePluginV1",
          requiresRelogin: false,
          summary: "The computer-use plugin is installed and ready.",
        };
      },
    });

    const first = await backend.availability();
    expect(first.kind).toBe("backend-unavailable");
    fail = false;
    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    // The second connect really provisioned again; a background reconnect may
    // also have joined by dispose time, hence the floor rather than equality.
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    await backend.dispose();
  });

  it("answers a repeat provision from the current-install stamp without reinstalling", async () => {
    await withProvisionHome(async (home) => {
      const pluginDirectory = resolveInstallTarget(
        SYSTEM_QT_PLUGIN_ROOTS_FOR_TEST,
        home,
      ).pluginDirectory;
      const prebuiltRoot = await writePrebuiltBundle(home, "6.7.3", "shipped bytes");
      // The default wiring discovers the shipped bundle through this variable,
      // not through the backend option.
      process.env.SYNARA_KWIN_PREBUILT_DIR = prebuiltRoot;
      const backend = provisionWiringBackend({
        dbus: new FakeDbus(),
        pluginDirectory,
        prebuiltRoot,
        runningKwinVersion: async () => "6.7.3",
        // The install landed in a directory this session was never told about,
        // which is exactly the first-login case that must re-ask provisioning
        // on every connect without reinstalling each time.
        installedPluginIds: async () => [],
      });

      const first = await backend.availability();
      // Either the login-needed summary or, if connectWithBackoff's retries
      // reached the second provision within this call, the current answer —
      // both prove an install happened exactly once.
      expect(first.kind).toBe("backend-unavailable");
      expect(first.kind === "backend-unavailable" ? first.message : "").toMatch(
        /plugin is installed/,
      );
      expect(await readdir(pluginDirectory)).toEqual(["SynaraComputerUsePluginV1.so"]);

      const second = await backend.availability();
      expect(second.kind === "backend-unavailable" ? second.message : "").toContain(
        "installed and current",
      );
      // The fast path answered from the stamp: no second version suffix was
      // created, which is what a rebuild or reinstall would have done.
      expect(await readdir(pluginDirectory)).toEqual(["SynaraComputerUsePluginV1.so"]);
      await backend.dispose();
    });
  });

  it("installs a fresh candidate when the stamped install predates a KWin upgrade", async () => {
    await withProvisionHome(async (home) => {
      const pluginDirectory = resolveInstallTarget(
        SYSTEM_QT_PLUGIN_ROOTS_FOR_TEST,
        home,
      ).pluginDirectory;
      const prebuiltRoot = await writePrebuiltBundle(home, "6.8.0", "upgraded bytes");
      process.env.SYNARA_KWIN_PREBUILT_DIR = prebuiltRoot;
      await mkdir(pluginDirectory, { recursive: true });
      await writeFile(join(pluginDirectory, "SynaraComputerUsePluginV1.so"), "old build");
      const stampDirectory = join(home, "state", "synara", "kwin-computer-use-plugin");
      await mkdir(stampDirectory, { recursive: true });
      await writeFile(
        join(stampDirectory, "install.stamp"),
        [
          "plugin_id=SynaraComputerUsePluginV1",
          "installed_at=2026-01-01T00:00:00.000Z",
          `plugin_path=${join(pluginDirectory, "SynaraComputerUsePluginV1.so")}`,
          "kwin_version=6.7.3",
          "",
        ].join("\n"),
        "utf8",
      );
      const dbus = new FakeDbus();
      // Only the freshly installed build loads, as an upgraded compositor
      // refuses the binary built for its predecessor.
      dbus.loadPlugin = async (pluginId: string) => {
        dbus.calls.push({ method: "LoadPlugin", args: [pluginId] });
        const accepted = pluginId === "SynaraComputerUsePluginV2";
        if (accepted) dbus.serviceOwner = ":1.43";
        return accepted;
      };
      const backend = provisionWiringBackend({
        dbus,
        pluginDirectory,
        prebuiltRoot,
        runningKwinVersion: async () => "6.8.0",
      });

      await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
      expect(await readFile(join(pluginDirectory, "SynaraComputerUsePluginV2.so"), "utf8")).toBe(
        "upgraded bytes",
      );
      expect(
        dbus.calls.some(
          (call) => call.method === "LoadPlugin" && call.args[0] === "SynaraComputerUsePluginV2",
        ),
      ).toBe(true);
      await backend.dispose();
    });
  });

  it("names the KWin version mismatch when LoadPlugin is refused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "synara-kwin-stamp-"));
    const installStampPath = join(directory, "install.stamp");
    await writeFile(
      installStampPath,
      "signature=abc\nplugin_id=SynaraComputerUsePluginV10\nkwin_version=kwin 6.7.2\n",
      "utf8",
    );
    const dbus = new FakeDbus();
    dbus.loadPlugin = async () => false;
    const backend = makeBackend(dbus, {
      installStampPath,
      runningKwinVersion: async () => "6.7.3",
    });

    const availability = await backend.availability();
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("KWin refused to load SynaraComputerUsePluginV10");
    expect(message).toContain("built for KWin 6.7.2, but KWin 6.7.3 is running");
    expect(message).toContain("scripts/install-and-load.sh");
    expect(message).toContain("systemd/enable.sh");
    await backend.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps the load-refusal message generic when no version pair is known", async () => {
    const dbus = new FakeDbus();
    dbus.loadPlugin = async () => false;
    const backend = makeBackend(dbus);

    const availability = await backend.availability();
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("KWin refused to load SynaraComputerUsePluginV10");
    expect(message).toContain("built against");
    expect(message).not.toContain("is running.");
    expect(message).toContain("scripts/install-and-load.sh");
    expect(message).toContain("systemd/enable.sh");
    await backend.dispose();
  });

  it("omits the versions when the stamp matches the running KWin", async () => {
    const dbus = new FakeDbus();
    dbus.loadPlugin = async () => false;
    const backend = makeBackend(dbus, {
      readInstallStamp: async () => "kwin_version=kwin 6.7.3\n",
      runningKwinVersion: async () => "6.7.3",
    });

    const availability = await backend.availability();
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).not.toContain("6.7.3");
    expect(message).toContain("built against");
    await backend.dispose();
  });

  it("probes the running KWin version once across connect retries", async () => {
    const dbus = new FakeDbus();
    const loadPlugin = vi.fn(async () => false);
    dbus.loadPlugin = loadPlugin;
    const runningKwinVersion = vi.fn(async () => "6.7.3");
    const backend = makeBackend(dbus, {
      readInstallStamp: async () => "kwin_version=kwin 6.7.2\n",
      runningKwinVersion,
    });

    await backend.availability();
    expect(loadPlugin.mock.calls.length).toBeGreaterThan(1);
    expect(runningKwinVersion).toHaveBeenCalledTimes(1);
    await backend.dispose();
  });

  it("decodes capture PNG bytes and degrades state when capture fails", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { captureMaxDimension: 800 });
    await backend.availability();

    const bytes = await backend.captureWindow("window-1");
    expect(bytes).toEqual(PNG_1X1);
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureWindow",
      args: ["window-1", 800],
    });
    await expect(backend.getState({ includeScreenshot: true })).resolves.toMatchObject({
      screenshot: { width: 1, height: 1, mimeType: "image/png" },
    });

    dbus.plugin.captureFailure = new Error("org.synara.ComputerUse.Error.CaptureFailed");
    const degraded = await backend.getState({ includeScreenshot: true });
    expect(degraded.screenshot).toBeUndefined();
    await backend.dispose();
  });

  it("captures the whole workspace and reports the region and scale", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    const backend = makeBackend(dbus);
    await backend.availability();

    const state = await backend.getState({ includeScreenshot: true });
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [0, 0, 5_120, 2_520, 2_048],
    });
    expect(dbus.plugin.calls.some((call) => call.method === "captureWindow")).toBe(false);
    expect(state.screenshot).toMatchObject({
      width: 1,
      height: 1,
      region: { x: 0, y: 0, width: 5_120, height: 2_520 },
      scale: 1 / 5_120,
    });
    await backend.dispose();
  });

  it("falls back to the window bounding box when KWin reports no workspace", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = undefined;
    const backend = makeBackend(dbus);
    await backend.availability();

    const state = await backend.getState({ includeScreenshot: true });
    // The single fake window spans (956, 1519) to (1604, 2037).
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [0, 0, 1_604, 2_037, 2_048],
    });
    expect(state.screenshot?.region).toEqual({ x: 0, y: 0, width: 1_604, height: 2_037 });
    await backend.dispose();
  });

  it("maps a window capture through the window's bounds", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    // The compositor renders at the output's device pixel ratio, so a window
    // capture can come back larger than its logical size.
    dbus.plugin.captureBytes = pngOfSize(1_296, 1_036);
    const backend = makeBackend(dbus);
    await backend.availability();

    // The single fake window is 648x518 logical pixels at (956, 1519).
    await expect(
      backend.captureScreenshot({ kind: "window", windowId: "window-1" }),
    ).resolves.toMatchObject({
      width: 1_296,
      height: 1_036,
      region: { x: 956, y: 1_519, width: 648, height: 518 },
      scale: 2,
    });
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureWindow",
      args: ["window-1", 2_048],
    });
    await backend.dispose();
  });

  it("clips a window capture to the workspace, the way the plugin does", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 1_200, height: 1_800 };
    dbus.plugin.captureBytes = pngOfSize(244, 281);
    const backend = makeBackend(dbus);
    await backend.availability();

    await expect(
      backend.captureScreenshot({ kind: "window", windowId: "window-1", maxDimension: 512 }),
    ).resolves.toMatchObject({
      region: { x: 956, y: 1_519, width: 244, height: 281 },
      scale: 1,
    });
    expect(dbus.plugin.calls).toContainEqual({ method: "captureWindow", args: ["window-1", 512] });
    await backend.dispose();
  });

  it("refuses an unknown window id before spending a capture", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);
    await backend.availability();

    await expect(
      backend.captureScreenshot({ kind: "window", windowId: "window-404" }),
    ).rejects.toThrow('No desktop window has id "window-404"');
    expect(dbus.plugin.calls.some((call) => call.method === "captureWindow")).toBe(false);
    await backend.dispose();
  });

  it("aligns a fractional region and forwards the requested max dimension", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    dbus.plugin.captureBytes = pngOfSize(301, 102);
    const backend = makeBackend(dbus);
    await backend.availability();

    const screenshot = await backend.captureScreenshot({
      kind: "region",
      region: { x: 100.4, y: 200.6, width: 300.2, height: 100.9 },
      maxDimension: 512,
    });
    // D-Bus takes integers, so the rect grows outward instead of cropping.
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [100, 200, 301, 102, 512],
    });
    expect(screenshot).toMatchObject({
      region: { x: 100, y: 200, width: 301, height: 102 },
      scale: 1,
    });
    await backend.dispose();
  });

  it("clips a region to the workspace and reports the clipped mapping", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    dbus.plugin.captureBytes = pngOfSize(150, 125);
    const backend = makeBackend(dbus);
    await backend.availability();

    await expect(
      backend.captureScreenshot({
        kind: "region",
        region: { x: -100, y: -50, width: 400, height: 300 },
      }),
    ).resolves.toMatchObject({
      region: { x: 0, y: 0, width: 300, height: 250 },
      scale: 0.5,
    });
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [0, 0, 300, 250, 2_048],
    });
    await backend.dispose();
  });

  it("refuses a region that misses the workspace entirely", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    const backend = makeBackend(dbus);
    await backend.availability();

    await expect(
      backend.captureScreenshot({
        kind: "region",
        region: { x: 9_000, y: 0, width: 10, height: 10 },
      }),
    ).rejects.toThrow("does not overlap the desktop workspace");
    await expect(
      backend.captureScreenshot({ kind: "region", region: { x: 0, y: 0, width: 0, height: 10 } }),
    ).rejects.toThrow("positive width and height");
    expect(dbus.plugin.calls.some((call) => call.method === "captureRegion")).toBe(false);
    await backend.dispose();
  });

  it("propagates the compositor's capture failure reason to the caller", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    const backend = makeBackend(dbus);
    await backend.availability();
    dbus.plugin.captureFailure = dbusError(
      "org.synara.ComputerUse.Error.CaptureFailed",
      "window not visible",
    );

    await expect(
      backend.captureScreenshot({ kind: "window", windowId: "window-1" }),
    ).rejects.toThrow("window not visible");
    await expect(
      backend.captureScreenshot({ kind: "region", region: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toThrow("window not visible");
    await backend.dispose();
  });

  it("streams workspace stills to the panel instead of one window", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    const backend = makeBackend(dbus);
    await backend.attachStream(() => undefined);

    expect(dbus.plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [0, 0, 5_120, 2_520, 2_048],
    });
    expect(dbus.plugin.calls.some((call) => call.method === "captureWindow")).toBe(false);
    await backend.dispose();
  });

  /**
   * A still every half-second is the frame budget, and a window enumeration per
   * still is two D-Bus round trips that also make every title change look like
   * a desktop change to the manager subscribed above.
   */
  it("streams stills from the cached workspace rect, with the capture's own bytes", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    dbus.plugin.captureBytes = pngOfSize(64, 32);
    const backend = makeBackend(dbus);
    await backend.availability();
    const windowReads = countWindowReads(dbus.plugin);

    const frames: Array<{ readonly data: Uint8Array }> = [];
    await backend.attachStream((frame) => frames.push(frame));

    expect(windowReads()).toBe(0);
    // The bytes reach the socket as the plugin returned them: the frame path
    // used to base64 them into a ComputerScreenshot and decode them straight
    // back, which is two copies of a multi-megabyte PNG per frame.
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toEqual(dbus.plugin.captureBytes);
    expect(frames[0]?.data.buffer).toBe(dbus.plugin.captureBytes.buffer);
    await backend.dispose();
  });

  /**
   * The change key is the plugin's own window document rather than a
   * re-serialization of the parsed list, so this pins what that document does
   * not contain: which window the agent seat is aimed at, which is what decides
   * `focused` on every window in the list.
   */
  it("reports a window change once per change, including a bare focus move", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.windows = [
      ...dbus.plugin.windows,
      {
        id: "window-2",
        title: "Editor",
        bounds: { x: 0, y: 0, width: 640, height: 480 },
        focused: false,
        minimized: false,
        visible: true,
      },
    ];
    const backend = makeBackend(dbus);
    const changes: Array<readonly ComputerWindow[]> = [];
    backend.onEvent((event) => {
      if (event.type === "windows-changed") changes.push(event.windows);
    });
    await backend.availability();

    await backend.listWindows();
    expect(changes).toHaveLength(1);
    // Nothing moved: reading again must not look like a change, or every
    // publish would schedule the next one.
    await backend.listWindows();
    expect(changes).toHaveLength(1);

    dbus.plugin.targetWindowId = "window-2";
    await backend.listWindows();
    expect(changes).toHaveLength(2);
    expect(changes[1]?.find((window) => window.id === "window-2")?.focused).toBe(true);

    const [terminal, editor] = dbus.plugin.windows;
    dbus.plugin.windows = [terminal!, { ...editor!, title: "Editor — saved" }];
    await backend.listWindows();
    expect(changes).toHaveLength(3);

    await backend.dispose();
  });

  it("answers the screen size from workspace geometry without enumerating windows", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 3_840, height: 2_160 };
    const backend = makeBackend(dbus);
    await backend.availability();
    const windowReads = countWindowReads(dbus.plugin);

    await expect(backend.getScreenSize()).resolves.toEqual({
      width: 3_840,
      height: 2_160,
      scale: 1,
    });
    // Every state publish calls this, and the window read it used to make could
    // itself report a change and trigger the next publish.
    expect(windowReads()).toBe(0);
    await backend.dispose();
  });

  it("writes an editable control through AT-SPI instead of typing it", async () => {
    const dbus = new FakeDbus();
    const writes: AtspiTextWrite[] = [];
    const backend = makeBackend(dbus, {
      glideDurationMs: 0,
      atspi: {
        readTrees: async () => [],
        setText: async (write) => {
          writes.push(write);
          return true;
        },
        dispose: async () => undefined,
      },
    });
    await backend.availability();

    await expect(backend.setValue(resolvedTarget({ editable: true }), "naïve")).resolves.toEqual({
      point: { x: 1_000, y: 1_600 },
      windowId: "window-1",
      value: "naïve",
    });

    // The write travels with the window KWin reports now, not the one the tree
    // was read from, so the helper re-resolves against live geometry.
    expect(writes).toEqual([
      {
        window: {
          id: "window-1",
          title: "Terminal",
          appName: "org.kde.konsole",
          pid: 123,
          bounds: { x: 956, y: 1_519, width: 648, height: 518 },
          focused: true,
          minimized: false,
          visible: true,
        },
        path: [1, 2],
        text: "naïve",
        role: "entry",
        label: "Name",
      },
    ]);
    // The click still focuses the control, and nothing is typed into it.
    expect(dbus.plugin.calls.some((call) => call.method === "button")).toBe(true);
    expect(dbus.plugin.calls.some((call) => call.method === "key")).toBe(false);
    await backend.dispose();
  });

  it.each(["refused", "failed", "partial"] as const)(
    "refuses a %s semantic write without inserting fallback text",
    async (failure) => {
      const dbus = new FakeDbus();
      let contents = "old";
      const backend = makeBackend(dbus, {
        glideDurationMs: 0,
        atspi: {
          readTrees: async () => [],
          setText: async () => {
            if (failure === "refused") return false;
            if (failure === "partial") contents = "a";
            throw new Error("AT-SPI helper exited (code=1, signal=null).");
          },
          dispose: async () => undefined,
        },
      });
      await backend.availability();

      await expect(backend.setValue(resolvedTarget({ editable: true }), "ab")).rejects.toThrow(
        "Could not confirm that AT-SPI replaced",
      );
      expect(dbus.plugin.calls.filter((call) => call.method === "key")).toHaveLength(0);
      expect(contents).toBe(failure === "partial" ? "a" : "old");
      await backend.dispose();
    },
  );

  it("refuses a noneditable control before clicking or typing", async () => {
    const dbus = new FakeDbus();
    let writes = 0;
    const backend = makeBackend(dbus, {
      glideDurationMs: 0,
      atspi: {
        readTrees: async () => [],
        setText: async () => {
          writes += 1;
          return true;
        },
        dispose: async () => undefined,
      },
    });
    await backend.availability();

    await expect(backend.setValue(resolvedTarget({ editable: false }), "ab")).rejects.toThrow(
      "does not support replacing",
    );
    expect(writes).toBe(0);
    expect(
      dbus.plugin.calls.filter((call) => call.method === "key" || call.method === "button"),
    ).toHaveLength(0);
    await backend.dispose();
  });

  it("refuses a semantic write into the window the human is working in", async () => {
    const dbus = new FakeDbus();
    let writes = 0;
    const backend = makeBackend(dbus, {
      glideDurationMs: 0,
      atspi: {
        readTrees: async () => [],
        setText: async () => {
          writes += 1;
          return true;
        },
        dispose: async () => undefined,
      },
    });
    await backend.availability();
    dbus.plugin.humanState = { humanFocusWindowId: "window-1", msSinceHumanInput: 300 };

    const refused = backend.setValue(resolvedTarget({ editable: true }), "ab");
    await expect(refused).rejects.toThrow(/computer_human_active/);
    await expect(refused).rejects.toThrow(/Terminal/);
    await expect(refused).rejects.toMatchObject({ retryable: true });

    // An AT-SPI write never reaches the plugin, so this check is the only thing
    // between it and the human's window — and the focusing click is refused too.
    expect(writes).toBe(0);
    expect(dbus.plugin.calls.some((call) => call.method === "button")).toBe(false);
    await backend.dispose();
  });

  it("refuses a semantic activate aimed at the human's window", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.availability();
    dbus.plugin.humanState = { humanFocusWindowId: "window-1", msSinceHumanInput: 0 };

    await expect(
      backend.performAction(resolvedTarget({ editable: false }), "activate"),
    ).rejects.toThrow(/computer_human_active/);
    expect(dbus.plugin.calls.some((call) => call.method === "button")).toBe(false);

    await backend.dispose();
  });

  it.each([
    ["the human went quiet", { humanFocusWindowId: "window-1", msSinceHumanInput: 9_000 }],
    ["they are in another window", { humanFocusWindowId: "window-9", msSinceHumanInput: 10 }],
    ["nothing has focus", { humanFocusWindowId: "", msSinceHumanInput: 10 }],
    ["no input has been observed", { humanFocusWindowId: "window-1", msSinceHumanInput: -1 }],
    ["the plugin is older and reports neither", {}],
    [
      "the agent owns the compositor",
      { humanFocusWindowId: "window-1", msSinceHumanInput: 10, ownsCompositor: true },
    ],
  ])("allows a semantic write when %s", async (_label, humanState) => {
    const dbus = new FakeDbus();
    const writes: AtspiTextWrite[] = [];
    const backend = makeBackend(dbus, {
      glideDurationMs: 0,
      atspi: {
        readTrees: async () => [],
        setText: async (write) => {
          writes.push(write);
          return true;
        },
        dispose: async () => undefined,
      },
    });
    await backend.availability();
    dbus.plugin.humanState = humanState;

    await expect(backend.setValue(resolvedTarget({ editable: true }), "ab")).resolves.toMatchObject(
      {
        value: "ab",
      },
    );
    expect(writes).toHaveLength(1);

    await backend.dispose();
  });

  it("skips the semantic-write guard entirely when it is disabled", async () => {
    vi.stubEnv("SYNARA_COMPUTER_HUMAN_ACTIVE_MS", "0");
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.availability();
    dbus.plugin.humanState = { humanFocusWindowId: "window-1", msSinceHumanInput: 0 };

    await expect(
      backend.performAction(resolvedTarget({ editable: false }), "activate"),
    ).resolves.toMatchObject({ windowId: "window-1" });

    await backend.dispose();
  });

  it("reports the clamped landing point when KWin refuses a pointer move", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.clampPointer = (x, y) => ({ x, y: Math.max(y, 1_080) });
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.availability();

    await expect(backend.click({ x: 44, y: 44 })).resolves.toEqual({
      point: { x: 44, y: 44 },
      clampedTo: { x: 44, y: 1_080 },
    });
    await expect(backend.moveCursor({ x: 44, y: 1_080 })).resolves.toEqual({
      point: { x: 44, y: 1_080 },
    });
    await backend.dispose();
  });

  it("omits clamp feedback when the pointer lands on the requested point", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.availability();

    await expect(backend.doubleClick({ x: 300, y: 400 })).resolves.toEqual({
      point: { x: 300, y: 400 },
    });
    await expect(backend.drag({ x: 10, y: 10 }, { x: 20, y: 20 }, 0)).resolves.toEqual({
      point: { x: 20, y: 20 },
    });
    await expect(backend.scroll({ x: 30, y: 30 }, 1, 1)).resolves.toEqual({
      point: { x: 30, y: 30 },
    });
    await backend.dispose();
  });

  it("spends the requested duration on a drag instead of a fixed sleep per step", async () => {
    const dbus = new FakeDbus();
    const clock = fakeClock();
    const callMs = 5;
    const timeline = instrumentPointer(dbus.plugin, clock, callMs);
    const backend = makeBackend(dbus, {
      now: clock.now,
      sleep: clock.sleep,
      // The lead-in move to the drag origin must not contribute any sleeps.
      glideDurationMs: 0,
    });
    await backend.availability();

    await backend.drag({ x: 0, y: 0 }, { x: 200, y: 0 }, 480);

    const pressedAt = timeline.find((entry) => entry.method === "press")?.at;
    const releasedAt = timeline.find((entry) => entry.method === "release")?.at;
    expect(pressedAt).toBeDefined();
    expect(releasedAt! - pressedAt!).toBeCloseTo(480, 6);

    const dragMoves = timeline.filter(
      (entry) => entry.method === "movePointer" && entry.at >= pressedAt!,
    );
    // D-Bus latency comes out of the sleep budget rather than adding to it.
    expect(total(clock.sleeps)).toBeCloseTo(480 - dragMoves.length * callMs, 6);
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(GLIDE_FRAME_INTERVAL_MS);
    await backend.dispose();
  });

  it("issues no sleeps for a zero-duration drag", async () => {
    const dbus = new FakeDbus();
    const clock = fakeClock();
    instrumentPointer(dbus.plugin, clock, 5);
    const backend = makeBackend(dbus, {
      now: clock.now,
      sleep: clock.sleep,
      glideDurationMs: 0,
    });
    await backend.availability();

    await backend.drag({ x: 0, y: 0 }, { x: 200, y: 0 }, 0);

    expect(clock.sleeps).toEqual([]);
    await backend.dispose();
  });

  it("spends the glide duration on a cursor move", async () => {
    const dbus = new FakeDbus();
    const clock = fakeClock();
    const callMs = 4;
    const timeline = instrumentPointer(dbus.plugin, clock, callMs);
    const backend = makeBackend(dbus, { now: clock.now, sleep: clock.sleep, glideDurationMs: 240 });
    await backend.availability();

    const startedAt = clock.now();
    await backend.moveCursor({ x: 400, y: 0 });

    expect(clock.now() - startedAt).toBeCloseTo(240, 6);
    expect(total(clock.sleeps)).toBeCloseTo(240 - timeline.length * callMs, 6);
    await backend.dispose();
  });

  it("stops sleeping when pointer calls are slower than the frame budget", async () => {
    const dbus = new FakeDbus();
    const clock = fakeClock();
    instrumentPointer(dbus.plugin, clock, 40);
    const backend = makeBackend(dbus, { now: clock.now, sleep: clock.sleep, glideDurationMs: 240 });
    await backend.availability();

    await backend.moveCursor({ x: 400, y: 0 });

    // Every deadline is already in the past, so pacing must not pile extra
    // waiting on top of a glide that is already over budget.
    expect(clock.sleeps).toEqual([]);
    await backend.dispose();
  });

  it("serializes window and region captures through one queue", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);
    await backend.availability();

    const gate = deferred<Uint8Array>();
    let active = 0;
    let maximumActive = 0;
    const calls: string[] = [];
    const capture = async (kind: string): Promise<Uint8Array<ArrayBuffer>> => {
      calls.push(kind);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (calls.length === 1) await gate.promise;
        return PNG_1X1;
      } finally {
        active -= 1;
      }
    };
    dbus.plugin.captureWindow = async () => capture("window");
    dbus.plugin.captureRegion = async () => capture("region");

    const first = backend.captureWindow("window-1");
    for (let attempt = 0; attempt < 50 && calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    const second = backend.captureRegion(0, 0, 10, 10);
    await Promise.resolve();
    expect(calls).toEqual(["window"]);
    expect(maximumActive).toBe(1);

    gate.resolve(PNG_1X1);
    await Promise.all([first, second]);
    expect(calls).toEqual(["window", "region"]);
    expect(maximumActive).toBe(1);
    await backend.dispose();
  });

  it("skips still ticks while an agent capture is pending", async () => {
    vi.useFakeTimers();
    try {
      const dbus = new FakeDbus();
      const backend = makeBackend(dbus, { stillIntervalMs: 100 });
      await backend.attachStream(() => undefined);
      const stillCaptures = () =>
        dbus.plugin.calls.filter((call) => call.method === "captureRegion").length;
      expect(stillCaptures()).toBe(1);

      const gate = deferred<Uint8Array<ArrayBuffer>>();
      let captureCalls = 0;
      dbus.plugin.captureWindow = async () => {
        captureCalls += 1;
        if (captureCalls === 1) return await gate.promise;
        return PNG_1X1;
      };
      const agentCapture = backend.captureWindow("window-1");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (captureCalls > 0) break;
        await Promise.resolve();
      }

      await vi.advanceTimersByTimeAsync(500);
      expect(captureCalls).toBe(1);
      expect(stillCaptures()).toBe(1);
      gate.resolve(PNG_1X1);
      await agentCapture;
      await backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the D-Bus connection for a method-level capture error", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);
    await backend.availability();
    dbus.plugin.captureFailure = dbusError(
      "org.synara.ComputerUse.Error.CaptureFailed",
      "window is not visible",
    );

    await expect(backend.captureWindow("window-1")).rejects.toThrow("window is not visible");
    expect(dbus.calls.some((call) => call.method === "close")).toBe(false);
    await expect(backend.listWindows()).resolves.toHaveLength(1);
    await backend.dispose();
  });

  it("surfaces plugin stacking and occlusion metadata without trusting its shape", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.windowsJson = async () =>
      JSON.stringify([
        {
          id: "window-top",
          title: "Browser",
          bounds: { x: 0, y: 0, width: 1_600, height: 900 },
          visible: true,
          active: true,
          stackingIndex: 0,
          occludedBy: [],
        },
        {
          id: "window-1",
          title: "Calculator",
          bounds: { x: 100, y: 100, width: 300, height: 400 },
          visible: true,
          active: false,
          stackingIndex: 1,
          occludedBy: ["window-top", 7, ""],
        },
        // A plugin build predating the stacking fields, plus values a corrupt
        // one could emit: the window itself must still list.
        {
          id: "window-legacy",
          title: "Legacy",
          bounds: { x: 1_700, y: 0, width: 200, height: 200 },
          visible: true,
          active: "yes",
          stackingIndex: -3,
          occludedBy: "not-an-array",
        },
      ]);
    const backend = makeBackend(dbus);

    const windows = await backend.listWindows();
    expect(windows.map((window) => window.id)).toEqual(["window-top", "window-1", "window-legacy"]);
    expect(windows[0]).toMatchObject({ stackingIndex: 0, active: true });
    expect(windows[0]).not.toHaveProperty("occludedBy");
    expect(windows[1]).toMatchObject({
      stackingIndex: 1,
      occludedBy: ["window-top"],
      active: false,
    });
    expect(windows[2]).not.toHaveProperty("stackingIndex");
    expect(windows[2]).not.toHaveProperty("occludedBy");
    expect(windows[2]).not.toHaveProperty("active");

    await backend.dispose();
  });

  it("raises a window through the plugin under the same session rules as focus", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(0);

    await backend.raiseWindow("window-1");
    expect(dbus.plugin.calls).toContainEqual({ method: "raiseWindow", args: ["window-1"] });
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(1);

    // An idle stop the server never asked for is recovered and the call retried.
    dbus.plugin.running = false;
    await backend.raiseWindow("window-1");
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(2);

    // A human takeover is not.
    dbus.plugin.running = false;
    dbus.plugin.releasedByUser = true;
    await expect(backend.raiseWindow("window-1")).rejects.toThrow(/Meta\+Shift\+Esc/);
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(2);

    await backend.dispose();
  });

  it("reports the stale plugin when the loaded plugin has no raiseWindow", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.raiseWindowFailure = dbusError(
      "org.freedesktop.DBus.Error.UnknownMethod",
      "No such method 'raiseWindow'",
    );
    const backend = makeBackend(dbus);

    await expect(backend.raiseWindow("window-1")).rejects.toThrow(/install-and-load\.sh/);
    expect(dbus.plugin.calls).toContainEqual({ method: "raiseWindow", args: ["window-1"] });

    await backend.dispose();
  });

  it("still surfaces real raiseWindow failures", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.raiseWindowFailure = dbusError(
      "org.synara.ComputerUse.Error.SomethingBroke",
      "restack failed",
    );
    const backend = makeBackend(dbus);

    await expect(backend.raiseWindow("window-1")).rejects.toThrow(/restack failed/);

    await backend.dispose();
  });

  it("uses workspace geometry when KWin reports no windows", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.windows = [];
    dbus.plugin.workspace = { x: 0, y: 0, width: 2_560, height: 1_440 };
    const backend = makeBackend(dbus);

    await backend.availability();
    await expect(backend.getScreenSize()).resolves.toEqual({
      width: 2_560,
      height: 1_440,
      scale: 1,
    });
    await backend.dispose();
  });

  it("rejects launchApp on an asynchronous spawn error", async () => {
    const dbus = new FakeDbus();
    const child = new FakeChild();
    let spawned = false;
    const backend = makeBackend(dbus, {
      spawnProcess: () => {
        spawned = true;
        return child as unknown as ChildProcess;
      },
    });
    await backend.availability();
    await backend.focusWindow("window-1");

    const launch = backend.launchApp("missing-program", []);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (spawned) break;
      await Promise.resolve();
    }
    expect(spawned).toBe(true);
    expect(child.unref).toHaveBeenCalledTimes(1);
    child.emit("error", new Error("spawn failed: ENOENT"));
    await expect(launch).rejects.toThrow("spawn failed: ENOENT");
    await backend.dispose();
  });

  it("spawns the resolved command and reports it back", async () => {
    const dbus = new FakeDbus();
    const child = new FakeChild();
    const spawned: Array<{ app: string; args: readonly string[] }> = [];
    const backend = makeBackend(dbus, {
      resolveApp: (app, args) => ({
        command: `/var/lib/flatpak/exports/bin/${app}`,
        args: [...args],
        via: "flatpak-export",
      }),
      spawnProcess: (app, args) => {
        spawned.push({ app, args });
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcess;
      },
    });
    await backend.availability();

    await expect(
      backend.launchApp("app.zen_browser.zen", ["--new-window", "https://example.com"]),
    ).resolves.toMatchObject({
      app: "app.zen_browser.zen",
      resolvedCommand: "/var/lib/flatpak/exports/bin/app.zen_browser.zen",
    });
    expect(spawned).toEqual([
      {
        app: "/var/lib/flatpak/exports/bin/app.zen_browser.zen",
        args: ["--new-window", "https://example.com"],
      },
    ]);
    await backend.dispose();
  });

  it("maps eased pointer input, evdev buttons, scroll, text, and hotkeys", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.availability();

    await backend.click({ x: 100, y: 100 });
    await backend.rightClick({ x: 110, y: 120 });
    await backend.scroll({ x: 110, y: 120 }, 2, -3);
    await backend.typeText("A!");
    await backend.hotkey(["Ctrl", "a"]);
    await backend.focusWindow("window-1");
    await backend.clearFocusWindow();

    expect(dbus.plugin.calls).toContainEqual({ method: "button", args: [272, true] });
    expect(dbus.plugin.calls).toContainEqual({ method: "button", args: [272, false] });
    expect(dbus.plugin.calls).toContainEqual({ method: "button", args: [273, true] });
    expect(dbus.plugin.calls).toContainEqual({ method: "axis", args: [2, -3] });
    expect(dbus.plugin.calls).toContainEqual({ method: "key", args: [42, true] });
    expect(dbus.plugin.calls).toContainEqual({ method: "key", args: [30, true] });
    expect(dbus.plugin.calls).toContainEqual({ method: "focusWindow", args: ["window-1"] });
    expect(dbus.plugin.calls).toContainEqual({ method: "clearFocusWindow", args: [] });
    await backend.dispose();
  });

  it("clears the old stream timer before attaching a replacement listener", async () => {
    vi.useFakeTimers();
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    try {
      const dbus = new FakeDbus();
      const backend = makeBackend(dbus, { stillIntervalMs: 100 });
      await backend.attachStream(() => undefined);
      const firstTimer = (backend as unknown as { streamTimer: ReturnType<typeof setInterval> })
        .streamTimer;

      await backend.attachStream(() => undefined);
      expect(clearInterval).toHaveBeenCalledWith(firstTimer);
      await backend.dispose();
    } finally {
      clearInterval.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stops an eased pointer glide after disposal", async () => {
    const dbus = new FakeDbus();
    const gate = deferred<undefined>();
    let sleepCalls = 0;
    const backend = makeBackend(dbus, {
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls === 1) await gate.promise;
      },
    });
    await backend.availability();
    await backend.focusWindow("window-1");

    const glide = backend.moveCursor({ x: 400, y: 0 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (sleepCalls > 0) break;
      await Promise.resolve();
    }
    const disposal = backend.dispose();
    gate.resolve(undefined);

    await expect(glide).rejects.toThrow("disposed");
    await disposal;
    expect(dbus.plugin.calls.filter((call) => call.method === "movePointer")).toHaveLength(1);
  });

  it("reconnects through the same supervision seam after a D-Bus disconnect", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);
    await backend.availability();
    dbus.disconnect();
    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    await backend.dispose();
  });
});

describe("KWinComputerBackend clipboard", () => {
  function clipboardBackend(
    reply: (spec: ClipboardCommandSpec) => ClipboardCommandResult | Promise<never>,
  ): {
    readonly backend: KWinComputerBackend;
    readonly dbus: FakeDbus;
    readonly specs: ClipboardCommandSpec[];
  } {
    const dbus = new FakeDbus();
    const specs: ClipboardCommandSpec[] = [];
    const backend = makeBackend(dbus, {
      runClipboardCommand: async (spec) => {
        specs.push(spec);
        return await reply(spec);
      },
    });
    return { backend, dbus, specs };
  }

  it("reads text from the desktop clipboard without touching the plugin", async () => {
    const { backend, dbus, specs } = clipboardBackend(() =>
      exited(0, { stdout: "  copied\ntext  " }),
    );

    await expect(backend.readClipboard()).resolves.toBe("  copied\ntext  ");
    expect(specs[0]?.command).toBe("wl-paste");
    // The generic text type is what makes wl-paste refuse an image instead of
    // streaming its raw bytes back as "text".
    expect(specs[0]?.args).toEqual(["--no-newline", "--type", "text"]);
    // Clipboard access uses neither the agent seat nor the input session.
    expect(dbus.plugin.calls).toHaveLength(0);

    await backend.dispose();
  });

  it("reads an empty clipboard as an empty string rather than an error", async () => {
    const { backend } = clipboardBackend(() => exited(1, { stderr: "Nothing is copied\n" }));
    await expect(backend.readClipboard()).resolves.toBe("");
    await backend.dispose();
  });

  it("explains a clipboard that holds non-text content", async () => {
    const { backend } = clipboardBackend(() =>
      exited(1, {
        stderr:
          'Clipboard content is not available as requested type "text"\nUse "wl-paste --list-types" to view available types.\n',
      }),
    );
    await expect(backend.readClipboard()).rejects.toThrow(/non-text content/);
    await backend.dispose();
  });

  it("refuses an oversized clipboard instead of truncating it", async () => {
    const { backend } = clipboardBackend(() => ({
      outcome: "output-limit",
      code: null,
      stdout: "",
      stderr: "",
    }));
    await expect(backend.readClipboard()).rejects.toThrow(/past the limit/);
    await backend.dispose();
  });

  it("writes clipboard text through stdin so it never reaches the process arguments", async () => {
    const { backend, specs } = clipboardBackend(() => exited(0));
    const text = "-secret-\nline two";

    await expect(backend.writeClipboard(text)).resolves.toBeUndefined();
    expect(specs[0]).toMatchObject({ command: "wl-copy", input: text, forks: true });
    expect(specs[0]?.args).toEqual(["--type", "text/plain"]);
    expect(specs[0]?.args).not.toContain(text);

    await backend.dispose();
  });

  it("rejects clipboard text past the byte cap before spawning anything", async () => {
    const { backend, specs } = clipboardBackend(() => exited(0));
    await expect(
      backend.writeClipboard("x".repeat(MAX_COMPUTER_CLIPBOARD_BYTES + 1)),
    ).rejects.toThrow(/byte limit/);
    expect(specs).toHaveLength(0);
    await backend.dispose();
  });

  it("quotes the failure when wl-copy refuses the write", async () => {
    const { backend } = clipboardBackend(() =>
      exited(1, { stderr: "Failed to connect to a Wayland server\n" }),
    );
    await expect(backend.writeClipboard("hello")).rejects.toThrow(
      /wl-copy failed to write the desktop clipboard: Failed to connect to a Wayland server/,
    );
    await backend.dispose();
  });

  it("names the missing binary and its package when wl-clipboard is absent", async () => {
    const missing = Object.assign(new Error("spawn wl-paste ENOENT"), { code: "ENOENT" });
    const { backend } = clipboardBackend(() => Promise.reject(missing));

    await expect(backend.readClipboard()).rejects.toThrow(
      /wl-paste is not installed.*wl-clipboard package/s,
    );
    await expect(backend.writeClipboard("hello")).rejects.toThrow(
      /wl-copy is not installed.*wl-clipboard package/s,
    );

    await backend.dispose();
  });
});

describe("KWinComputerBackend KWin crash recovery", () => {
  it("drops the stale proxy and re-loads the plugin when KWin's bus name vanishes", async () => {
    const dbus = new FakeDbus();
    dbus.loaded = ["SynaraComputerUsePluginV10"];
    const backend = makeBackend(dbus);

    await expect(backend.listWindows()).resolves.toMatchObject([{ id: "window-1" }]);

    // A KWin crash keeps the session-bus connection alive — onDisconnect never
    // fires — and calls to the now-ownerless service fail with ServiceUnknown.
    const healthyWindowsJson = dbus.plugin.windowsJson;
    dbus.plugin.windowsJson = async () => {
      throw Object.assign(
        new Error("The name org.synara.ComputerUse was not provided by any .service files"),
        { type: "org.freedesktop.DBus.Error.ServiceUnknown" },
      );
    };

    await expect(backend.listWindows()).rejects.toMatchObject({ retryable: true });

    // KWin restarts without the plugin loaded. The next call must not reuse the
    // stale proxy: it reconnects, re-loads the plugin, and recovers.
    dbus.plugin.windowsJson = healthyWindowsJson;
    dbus.loaded = [];
    const callsBeforeRecovery = dbus.calls.length;

    await expect(backend.listWindows()).resolves.toMatchObject([{ id: "window-1" }]);
    const recoveryCalls = dbus.calls.slice(callsBeforeRecovery).map((call) => call.method);
    expect(recoveryCalls).toContain("LoadPlugin");
    expect(recoveryCalls).toContain("connectPlugin");

    await backend.dispose();
  });

  it("counts the outage and the recovery, and reports both without a D-Bus call", async () => {
    const dbus = new FakeDbus();
    dbus.loaded = ["SynaraComputerUsePluginV10"];
    const clock = fakeClock();
    const backend = makeBackend(dbus, { now: clock.now });
    const published: ComputerHealth[] = [];
    backend.onEvent((event) => {
      if (event.type === "health-changed") published.push(event.health);
    });

    await expect(backend.listWindows()).resolves.toMatchObject([{ id: "window-1" }]);
    expect(backend.health()).toEqual({
      status: "connected",
      consecutiveFailures: 0,
      reconnects: 0,
      captureAvailable: true,
    });

    clock.advance(5_000);
    const healthyWindowsJson = dbus.plugin.windowsJson;
    dbus.plugin.windowsJson = async () => {
      throw Object.assign(new Error("KWin went away"), {
        type: "org.freedesktop.DBus.Error.ServiceUnknown",
      });
    };
    await expect(backend.listWindows()).rejects.toMatchObject({ retryable: true });

    // One outage, counted once: the connect path rethrows the error its caller
    // then reports, and both hops reach the counters.
    expect(backend.health()).toMatchObject({
      status: "reconnecting",
      consecutiveFailures: 1,
      reconnects: 0,
      captureAvailable: false,
      lastFailure: { message: "KWin went away", at: new Date(5_000).toISOString() },
    });
    const dbusCallsBeforeRead = dbus.calls.length;
    backend.health();
    expect(dbus.calls).toHaveLength(dbusCallsBeforeRead);

    dbus.plugin.windowsJson = healthyWindowsJson;
    dbus.loaded = [];
    await expect(backend.listWindows()).resolves.toMatchObject([{ id: "window-1" }]);

    // The failure survives the recovery: it is how a healed outage stays
    // explainable in a panel that only ever sees the current health.
    expect(backend.health()).toMatchObject({
      status: "connected",
      consecutiveFailures: 0,
      reconnects: 1,
      captureAvailable: true,
      lastFailure: { message: "KWin went away" },
    });
    expect(published.map((health) => health.status)).toEqual([
      "connected",
      "reconnecting",
      "connected",
    ]);

    await backend.dispose();
  });
});

describe("KWinComputerBackend dormant desktop", () => {
  it("stands the reconnect loop down when the factory refuses to boot for it", async () => {
    vi.useFakeTimers();
    try {
      const dbus = new FakeDbus();
      dbus.loaded = ["SynaraComputerUsePluginV10"];
      let factoryCalls = 0;
      const backend = makeBackend(dbus, {
        // What the nested backend's factory does once its compositor process
        // has exited and the caller is the reconnect loop, not a real use.
        dbusFactory: async () => {
          factoryCalls += 1;
          throw new ComputerBackendError("The desktop is not running.", {
            dormant: true,
            retryable: true,
          });
        },
      });

      await expect(backend.listWindows()).resolves.toMatchObject([{ id: "window-1" }]);

      dbus.disconnect();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(factoryCalls).toBe(1);
      expect(backend.health()).toMatchObject({
        status: "unavailable",
        lastFailure: { message: "The desktop is not running." },
      });

      // Stood down for good: no amount of waiting produces another attempt.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(factoryCalls).toBe(1);

      await backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("plugin source and prebuilt lookup", () => {
  it("prefers a bundled installer script and falls back to the checkout layout", () => {
    const bundled = join("/app", "computer-use-kwin", "scripts", "install-and-load.sh");
    expect(resolveInstallScriptPath("/app", undefined, (candidate) => candidate === bundled)).toBe(
      bundled,
    );
    expect(resolveInstallScriptPath("/repo/apps/server/src/computer", undefined, () => false)).toBe(
      join(
        "/repo/apps/server/src/computer",
        "..",
        "..",
        "native",
        "computer-use-kwin",
        "scripts",
        "install-and-load.sh",
      ),
    );
  });

  it("lets an explicit directory win, and only when it really holds a manifest", () => {
    const configured = "/opt/prebuilt";
    expect(prebuiltPluginRoot("/app", configured, (candidate) => candidate === configured)).toBe(
      configured,
    );
    // A path that was pointed at but holds nothing is not a prebuilt root: this
    // is the difference between installing a shipped binary and building one.
    expect(prebuiltPluginRoot("/app", configured, () => false)).toBeUndefined();
  });
});

describe("serialized desktop input", () => {
  it("keeps concurrent clicks at their requested points", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(new FakeDbus(plugin), { glideDurationMs: 0 });
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({
      backend,
      actionSettleMs: 0,
    });
    const pressedAt: Array<{ x: number; y: number }> = [];
    const button = plugin.button;
    plugin.button = async (code, pressed) => {
      if (pressed) pressedAt.push({ ...plugin.position });
      return button(code, pressed);
    };
    try {
      await backend.availability();
      await Promise.all([
        manager.withAgentActivity("audit-thread", () =>
          manager.click("audit-thread", { x: 100, y: 100 }),
        ),
        manager.withAgentActivity("audit-thread", () =>
          manager.click("audit-thread", { x: 300, y: 300 }),
        ),
      ]);
      expect(pressedAt).toEqual(
        expect.arrayContaining([
          { x: 100, y: 100 },
          { x: 300, y: 300 },
        ]),
      );
    } finally {
      await manager.dispose();
    }
  });
});
