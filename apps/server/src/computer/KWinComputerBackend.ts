import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

import {
  COMPUTER_KWIN_BACKEND,
  COMPUTER_RELEASE_CONTROL_HOTKEY,
  type ComputerAvailability,
  type ComputerCapabilities,
  type ComputerHealth,
  type ComputerId,
  type ComputerLaunchAppResult,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenshot,
  type ComputerScreenSize,
  type ComputerState,
  type ComputerUiNode,
  type ComputerWindow,
} from "@synara/contracts";
import { describeErrorMessage } from "@synara/shared/errorMessages";

import {
  clampComputerMessage,
  ComputerBackendError,
  intersectComputerRects,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBackendEventListener,
  type ComputerCaptureRequest,
  type ComputerFrameListener,
  type ComputerResolvedTarget,
} from "./ComputerBackend.ts";
import { resolveAppLaunchOnHost, type AppLaunchResolver } from "./appLaunchResolution.ts";
import { AtspiHelperClient, type AtspiTreeReader } from "./atspiClient.ts";
import {
  atspiTextWriteAddress,
  describeComputerUiTree,
  fuseAtspiTrees,
  type AtspiRawNode,
  type AtspiWindowTree,
} from "./atspiTreeTargeting.ts";
import {
  alignRect,
  asRecord,
  asString,
  formatRect,
  parseComputerPoint,
  parseComputerRect,
  parseJsonPayload,
  parseWindows,
  readPngDimensions,
  requireWindowBounds,
  screenSizeFromWindows,
  screenshotFromPng,
  shiftPoint,
  shiftRect,
  unwrapDbusValue,
  windowInAgentSpace,
  workspaceRectFromWindows,
} from "./computerGeometry.ts";
import { ComputerHealthState } from "./computerHealthState.ts";
import { DEFAULT_HUMAN_ACTIVE_THRESHOLD_MS, HUMAN_ACTIVE_REFUSAL } from "./humanActivity.ts";
import {
  COMPUTER_SERVICE,
  createSessionKWinComputerDbus,
  KWIN_SERVICE,
  KWinDbusTimeoutError,
  type KWinComputerDbus,
  type KWinComputerPluginApi,
} from "./kwinDbus.ts";
import { sessionBusNameHasOwner } from "./sessionBusNames.ts";
import { EVDEV_BUTTON_CODES, keyStrokeForKey, qwertyTextKeyStrokes } from "./evdevInput.ts";
import {
  provisionKWinPlugin,
  readPrebuiltManifest,
  resolveInstallTarget,
  selectPrebuilt,
  type ProvisionAction,
  type ProvisionResult,
} from "./kwinPluginProvisioning.ts";
import {
  glidePointerToDeadline,
  POINTER_SEQUENCE_OPERATIONS,
  pressButtonOnce,
  pressHotkeyStrokes,
  pressKeyStroke,
  type ComputerInputSink,
} from "./pointerSequencing.ts";
import {
  readWlClipboard,
  spawnClipboardCommand,
  writeWlClipboard,
  type ClipboardCommandRunner,
} from "./wlClipboard.ts";

const DEFAULT_COMPUTER_ID = "desktop";
const DEFAULT_GLIDE_DURATION_MS = 180;
const DEFAULT_STILL_INTERVAL_MS = 500;
// Keep Linux capture detail unchanged by the macOS image-budget tuning.
const DEFAULT_CAPTURE_MAX_DIMENSION = 2_048;
const POINTER_CLAMP_TOLERANCE_PX = 2;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const KWIN_RECONNECT_BASE_DELAY_MS = 250;
const KWIN_RECONNECT_MAX_DELAY_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
const MIN_IDLE_TIMEOUT_MS = 1_000;
const MAX_IDLE_TIMEOUT_MS = 60 * 60 * 1_000;
const CONTROL_RELEASED_ERROR_TYPE = "org.synara.ComputerUse.Error.ControlReleased";
const CONTROL_RELEASED_MESSAGE =
  `Computer control was released with the ${COMPUTER_RELEASE_CONTROL_HOTKEY} hotkey. ` +
  `Press ${COMPUTER_RELEASE_CONTROL_HOTKEY} again to hand control back.`;
/**
 * The plugin declining to inject into an application that never bound the
 * agent's seat. Its own text names the application and the remedy, so it is
 * passed through verbatim rather than replaced.
 */
const SEAT_UNSUPPORTED_ERROR_TYPE = "org.synara.ComputerUse.Error.SeatUnsupported";
/**
 * The plugin declining to act on the window the human is working in.
 *
 * The server-side guard refuses the same situation with the same
 * `computer_human_active` token (`humanActivity.ts`), because the caller that
 * matters — the tool surface, and the panel copy explaining why the agent
 * paused — treats both identically: wait, then try again.
 */
const HUMAN_ACTIVE_ERROR_TYPE = "org.synara.ComputerUse.Error.HumanActive";
/** Guard window bounds, mirroring the plugin's own clamp. */
const MIN_HUMAN_ACTIVE_GUARD_MS = 100;
const MAX_HUMAN_ACTIVE_GUARD_MS = 60 * 1_000;
const INSTALL_SCRIPT_PATH = "apps/server/native/computer-use-kwin/scripts/install-and-load.sh";
/** Said the same way by the passive probe and the establishing availability read. */
const WAYLAND_REQUIRED_MESSAGE = "Linux computer control requires a Wayland session.";
const NO_KWIN_MESSAGE =
  "No KWin compositor is answering on the session bus, so there is no KDE desktop to drive.";
const NO_PLUGIN_ANYWHERE_MESSAGE =
  "KWin is running, but this machine has no Synara computer-use plugin: none is installed, none of " +
  "the bundled builds matches the running KWin, and the cmake and KWin development headers needed " +
  `to build one are not present. Install them, or build the plugin with ${INSTALL_SCRIPT_PATH}.`;
/**
 * Where a distribution puts `find_package(KWin)`'s config file, which is the
 * one part of the development headers a source build cannot do without. The
 * lib64/lib split and the Debian multiarch directories are packaging choices,
 * so all of them are probed rather than derived.
 */
const KWIN_CMAKE_CONFIG_PATHS = [
  "/usr/lib64/cmake/KWin/KWinConfig.cmake",
  "/usr/lib/cmake/KWin/KWinConfig.cmake",
  "/usr/lib/x86_64-linux-gnu/cmake/KWin/KWinConfig.cmake",
  "/usr/lib/aarch64-linux-gnu/cmake/KWin/KWinConfig.cmake",
] as const;
const ENABLE_REBUILD_SCRIPT_PATH = "apps/server/native/computer-use-kwin/systemd/enable.sh";
const KWIN_VERSION_PATTERN = /\d+(?:\.\d+)+/;
const KWIN_VERSION_PROBE_TIMEOUT_MS = 2_000;
/**
 * A cold cmake configure plus build of the plugin, generously bounded. Long
 * because it is a C++ build on the user's machine and a false timeout would
 * throw away minutes of work that was about to succeed.
 */
const PLUGIN_BUILD_TIMEOUT_MS = 10 * 60 * 1_000;
const execFileAsync = promisify(execFile);
const MAX_PLUGIN_ID = /^SynaraComputerUsePlugin(?:V(\d+))?$/;
const INSTALLED_PLUGIN_FILE = /^(SynaraComputerUsePluginV(\d+))\.so$/;
/** Shifts every coordinate in an AT-SPI tree, preserving shape and identity. */
function shiftTree(tree: AtspiWindowTree, dx: number, dy: number): AtspiWindowTree {
  const shiftNode = (node: AtspiRawNode): AtspiRawNode => ({
    ...node,
    frame: shiftRect(node.frame, dx, dy),
    ...(node.activationPoint ? { activationPoint: shiftPoint(node.activationPoint, dx, dy) } : {}),
    children: node.children.map(shiftNode),
  });
  return { ...tree, root: shiftNode(tree.root) };
}

interface KWinHealth {
  readonly ok: boolean;
  readonly running: boolean;
  readonly capture: boolean;
  readonly releasedByUser: boolean;
  readonly workspace: ComputerRect | null;
}

interface KWinPluginState {
  readonly position: ComputerPoint | null;
  readonly targetWindowId: string | null;
  /**
   * The human-active guard's two halves, as the plugin reports them. Both are
   * `undefined` on a loaded plugin older than Phase 4, which is the one case a
   * server-side check has to skip rather than guess at.
   */
  readonly humanFocusWindowId: string | undefined;
  readonly msSinceHumanInput: number | undefined;
  /** CapsLock latched on the plugin's keyboard; `undefined` on an older build. */
  readonly capsLockOn: boolean | undefined;
}

/**
 * Why the backend is dialing D-Bus right now. The default factories ignore it;
 * a factory that boots a desktop on demand (the nested backend) must not boot
 * for an `automatic` call — that is the reconnect loop running on a timer,
 * with no user or agent behind it, and a desktop window that respawns on a
 * timer is a haunting rather than a recovery. Such a factory answers an
 * automatic call for a desktop it will not boot with a `dormant`
 * `ComputerBackendError`, which stands the reconnect loop down.
 */
export interface KWinDbusConnectContext {
  readonly automatic: boolean;
}

export interface KWinComputerBackendOptions {
  readonly computerId?: string;
  /**
   * Names the compositor integration in user-facing runtime messages ("KWin").
   * The Hyprland backend reuses this whole engine against the same plugin
   * D-Bus surface, and a failure card must never blame the wrong compositor.
   */
  readonly integrationName?: string;
  /**
   * The "build it yourself" pointer in provisioning failures, as a repo path
   * the user can run. Defaults to the KWin install script.
   */
  readonly installHint?: string;
  readonly dbus?: KWinComputerDbus;
  readonly dbusFactory?: (context: KWinDbusConnectContext) => Promise<KWinComputerDbus>;
  /**
   * A private session bus carrying the compositor, set only by the nested
   * Tier 3 session. Absent, KWin is reached on the ambient session bus.
   */
  readonly busAddress?: string;
  readonly atspi?: AtspiTreeReader;
  readonly installedPluginIds?: () => Promise<readonly string[]>;
  readonly pluginDirectories?: readonly string[];
  /**
   * "Is anyone answering to this bus name?", for the passive probe only. A
   * backend bound to a private bus (the nested Tier 3 session) answers yes
   * without asking, because that session's compositor and plugin were started
   * by this process and the ambient session bus knows nothing about either.
   */
  readonly busNameHasOwner?: (name: string) => Promise<boolean>;
  /** Where the shipped plugin binaries live; probed for a version match. */
  readonly prebuiltRoot?: () => string | undefined;
  /** Whether this machine could build the plugin from source if it had to. */
  readonly buildToolingPresent?: () => boolean;
  readonly platform?: string;
  readonly sessionType?: string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly spawnProcess?: (app: string, args: readonly string[]) => ChildProcess;
  /** Name-to-executable resolution, replaced in tests to avoid host lookups. */
  readonly resolveApp?: AppLaunchResolver;
  /** wl-clipboard process runner, replaced in tests. */
  readonly runClipboardCommand?: ClipboardCommandRunner;
  readonly glideDurationMs?: number;
  readonly stillIntervalMs?: number;
  readonly captureMaxDimension?: number;
  /**
   * Plugin-side session deadline. `0` disables it; see the Phase 3b notes.
   * Falls back to `SYNARA_COMPUTER_IDLE_TIMEOUT_MS`, then to five minutes.
   */
  readonly idleTimeoutMs?: number;
  /**
   * How recently the human's own seat must have been active for a mutating
   * action aimed at their focused window to be refused. `0` disables the guard.
   * Falls back to `SYNARA_COMPUTER_HUMAN_ACTIVE_MS`, then to
   * `DEFAULT_HUMAN_ACTIVE_THRESHOLD_MS`.
   */
  readonly humanActiveGuardMs?: number;
  /**
   * Whether the driven compositor renders on the human's own display. True for
   * the host session (the default), false when the backend is bound to a
   * nested, offscreen compositor — see `nestedKWinBackendOptions`.
   */
  readonly visibleDesktop?: boolean;
  /** Installer stamp consulted when KWin refuses to load the plugin. */
  readonly installStampPath?: string;
  readonly readInstallStamp?: () => Promise<string | undefined>;
  /** Running KWin version, read only to explain a load refusal. */
  readonly runningKwinVersion?: () => Promise<string | undefined>;
  /**
   * Installs the plugin for the running KWin. Asked when connecting finds
   * nothing loadable, or when the user presses "Set up"; after KWin refuses
   * what it installed, asked once more for the other install shape with
   * `force` set, because the install stamp now calls the refused build current.
   */
  readonly provisionPlugin?: (options: {
    readonly allowPrebuilt: boolean;
    readonly force: boolean;
  }) => Promise<ProvisionResult>;
  /**
   * Whether the compositor that will load the plugin can already see the
   * install root, forwarded to provisioning. The nested backend answers `true`:
   * it spawns its compositor with the root injected, so the default test
   * against the server's session environment would wrongly tell its user to
   * log out.
   */
  readonly compositorSeesPluginRoot?: () => boolean;
}

/**
 * Linux/KWin implementation of the Phase 1 computer backend.
 *
 * All KWin calls go through the user-session D-Bus proxy in kwinDbus.ts. The
 * backend never shells out to busctl, which keeps method calls typed at the
 * boundary, makes service errors observable, and avoids paying a process spawn
 * plus shell parsing cost for every pointer or key event.
 */
export class KWinComputerBackend implements ComputerBackend {
  readonly computerId: ComputerId;

  protected readonly integrationName: string;
  /** What an empty availability or health message degrades to. */
  protected get failureFallbackMessage(): string {
    return `The Synara ${this.integrationName} backend failed without a message.`;
  }
  protected readonly installHint: string;
  /** Names this backend in a capture failure, which reaches a tool call verbatim. */
  private readonly captureSource: string;
  private readonly platform: string;
  private readonly sessionType: string;
  private readonly visibleDesktop: boolean;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly glideDurationMs: number;
  private readonly stillIntervalMs: number;
  private readonly captureMaxDimension: number;
  private readonly idleTimeoutMs: number;
  private readonly humanActiveGuardMs: number;
  private readonly atspi: AtspiTreeReader;
  private readonly dbusFactory: (context: KWinDbusConnectContext) => Promise<KWinComputerDbus>;
  private readonly installedPluginIds: () => Promise<readonly string[]>;
  private readonly busNameHasOwner: (name: string) => Promise<boolean>;
  private readonly prebuiltRoot: () => string | undefined;
  private readonly buildToolingPresent: () => boolean;
  private readonly readInstallStamp: () => Promise<string | undefined>;
  private readonly runningKwinVersion: () => Promise<string | undefined>;
  private runningKwinVersionPromise: Promise<string | undefined> | undefined;
  private readonly provisionPlugin: (options: {
    readonly allowPrebuilt: boolean;
    readonly force: boolean;
  }) => Promise<ProvisionResult>;
  /**
   * Memoized so the reconnect loop cannot start a second install - or a second
   * source build, which takes minutes - while the first is still running. Keyed
   * by attempt because the source-only retry is a different install, not a
   * repeat of the first.
   */
  private readonly provisionPromises = new Map<string, Promise<ProvisionResult>>();
  /**
   * The shape of the last install this process made, so a refusal can retry
   * with the other one. The stamp does not record it, and a repeat provision
   * answers "already current" without saying what is current.
   */
  private lastInstallAction: Exclude<ProvisionAction, "already-current"> | undefined;

  /**
   * The thread currently holding the desktop, cached because the plugin loses it
   * on every restart: a reconnect or an idle stop rebuilds the session, and the
   * badge has to come back naming the same thread.
   */
  private drivingAgent: string | null = null;
  private dbus: KWinComputerDbus | undefined;
  private plugin: KWinComputerPluginApi | undefined;
  private pluginId: string | undefined;
  private pluginHealth: KWinHealth | undefined;
  private disconnect: (() => void) | undefined;
  private connectPromise: Promise<KWinComputerPluginApi> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectFailures = 0;
  /** A retry is pending or running, which is what `reconnecting` reports. */
  private reconnecting = false;
  private readonly healthState: ComputerHealthState;
  private disposed = false;
  private streamListener: ComputerFrameListener | undefined;
  private streamTimer: ReturnType<typeof setInterval> | undefined;
  private stillInFlight = false;
  private captureQueue: Promise<void> = Promise.resolve();
  private capturePending = 0;
  private startPromise: Promise<void> | undefined;
  private readonly spawnProcess: (app: string, args: readonly string[]) => ChildProcess;
  private readonly resolveApp: AppLaunchResolver;
  private readonly runClipboardCommand: ClipboardCommandRunner;
  private nextSequence = 1;
  private currentPoint: ComputerPoint | null = null;
  /**
   * Where the workspace's top-left sat in global coordinates at the last
   * window or workspace read. Input actions translate through it; see
   * `readWindows` for why the agent speaks a 0-based space at all.
   */
  private lastAgentOrigin: ComputerPoint = { x: 0, y: 0 };
  private previousWindowsFingerprint: string | undefined;
  private readonly eventListeners = new Set<ComputerBackendEventListener>();

  constructor(options: KWinComputerBackendOptions = {}) {
    this.computerId = (options.computerId ?? DEFAULT_COMPUTER_ID) as ComputerId;
    this.integrationName = options.integrationName ?? "KWin";
    this.installHint = options.installHint ?? INSTALL_SCRIPT_PATH;
    this.captureSource = `Synara ${this.integrationName} capture`;
    this.platform = options.platform ?? process.platform;
    this.sessionType =
      options.sessionType ??
      process.env.XDG_SESSION_TYPE ??
      (process.env.WAYLAND_DISPLAY ? "wayland" : "");
    this.visibleDesktop = options.visibleDesktop ?? true;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
    this.spawnProcess =
      options.spawnProcess ??
      ((app, args) => spawn(app, [...args], { detached: true, stdio: "ignore" }));
    this.resolveApp = options.resolveApp ?? resolveAppLaunchOnHost;
    this.runClipboardCommand = options.runClipboardCommand ?? spawnClipboardCommand;
    this.glideDurationMs = Math.max(0, options.glideDurationMs ?? DEFAULT_GLIDE_DURATION_MS);
    this.stillIntervalMs = Math.max(100, options.stillIntervalMs ?? DEFAULT_STILL_INTERVAL_MS);
    this.captureMaxDimension = Math.max(
      1,
      Math.min(32_768, Math.floor(options.captureMaxDimension ?? DEFAULT_CAPTURE_MAX_DIMENSION)),
    );
    this.idleTimeoutMs = normalizeIdleTimeout(
      options.idleTimeoutMs ?? parseIdleTimeoutEnv(process.env.SYNARA_COMPUTER_IDLE_TIMEOUT_MS),
    );
    this.humanActiveGuardMs = normalizeHumanActiveGuard(
      options.humanActiveGuardMs ??
        parseHumanActiveGuardEnv(process.env.SYNARA_COMPUTER_HUMAN_ACTIVE_MS),
    );
    this.atspi = options.atspi ?? new AtspiHelperClient();
    this.dbus = options.dbus;
    this.dbusFactory =
      options.dbusFactory ??
      (options.dbus
        ? async () => options.dbus!
        : () =>
            createSessionKWinComputerDbus(
              options.busAddress ? { busAddress: options.busAddress } : {},
            ));
    this.installedPluginIds =
      options.installedPluginIds ??
      (() => scanInstalledPluginIds(options.pluginDirectories ?? defaultPluginDirectories()));
    this.busNameHasOwner =
      options.busNameHasOwner ??
      (options.busAddress ? async () => true : (name) => sessionBusNameHasOwner(name));
    this.prebuiltRoot = options.prebuiltRoot ?? (() => prebuiltPluginRoot());
    this.buildToolingPresent = options.buildToolingPresent ?? localBuildToolingPresent;
    this.readInstallStamp =
      options.readInstallStamp ??
      (() => readInstallStamp(options.installStampPath ?? defaultInstallStampPath()));
    this.runningKwinVersion = options.runningKwinVersion ?? detectRunningKwinVersion;
    this.provisionPlugin =
      options.provisionPlugin ??
      (({ allowPrebuilt, force }) =>
        provisionKWinPlugin({
          target: resolveInstallTarget(SYSTEM_QT_PLUGIN_ROOTS),
          force,
          // Numbering scans every root a plugin could live in, not just the
          // install target: an earlier sudo install under /usr must be
          // outranked too, or the new id collides with one the running
          // compositor may already have pinned to an older library — a load
          // failure KWin reports as nothing but `b false`.
          listInstalled: () =>
            listPluginFiles(options.pluginDirectories ?? defaultPluginDirectories()),
          kwinVersion: () => this.probeRunningKwinVersion(),
          arch: process.arch,
          prebuiltRoot: allowPrebuilt ? prebuiltPluginRoot() : undefined,
          buildFromSource: buildPluginFromSource,
          // Provisioning runs again whenever connecting finds nothing loadable
          // - a failed first attempt, a KWin upgrade - so "current" has to be
          // read off the machine rather than assumed false. This check is what
          // keeps those repeat calls cheap instead of reinstalling or
          // rebuilding an install that is already in place.
          isCurrent: async () => {
            const [stamp, files, running] = await Promise.all([
              this.readInstallStamp(),
              listPluginFiles(options.pluginDirectories ?? defaultPluginDirectories()),
              this.probeRunningKwinVersion(),
            ]);
            return installStampIsCurrent(stamp, files, running);
          },
          stampPath: options.installStampPath ?? defaultInstallStampPath(),
          ...(options.compositorSeesPluginRoot
            ? { compositorSeesPluginRoot: options.compositorSeesPluginRoot }
            : {}),
        }));
    this.healthState = new ComputerHealthState({
      readStatus: () => ({
        status: this.connectedPlugin()
          ? "connected"
          : this.reconnecting
            ? "reconnecting"
            : "unavailable",
        captureAvailable: this.pluginHealth?.capture === true,
      }),
      emit: (health) => this.emit({ type: "health-changed", health }),
      now: () => this.now(),
      failureFallbackMessage: this.failureFallbackMessage,
    });
  }

  /**
   * Tier 1's whole capability set. The KWin plugin owns a dedicated seat inside
   * the compositor, which is what makes every one of these true at once:
   * enumeration with real `frameGeometry`, a stacking order and its occlusion,
   * focus and raise, and a second pointer drawn without touching the human's.
   */
  capabilities(): ComputerCapabilities {
    return {
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      focus: true,
      raise: true,
      ghostCursor: true,
      visibleDesktop: this.visibleDesktop,
    };
  }

  /**
   * "Could this machine drive KWin?", answered without touching the compositor.
   *
   * Nothing here connects to the plugin, installs anything, or loads anything:
   * the whole probe is the platform gate, two `NameHasOwner` questions on a
   * connection that does not outlive them, and reads of the filesystem. That
   * matters because this runs at boot and on every thread the UI renders, and
   * `availability()` — which provisions, compiles on a cold machine, and loads
   * a module into the live compositor — used to run there instead.
   *
   * The four ways to be available are four ways of saying "a plugin exists or
   * could exist": one is already answering on the bus, one is installed on
   * disk, one ships with the app for exactly this KWin, or this machine can
   * compile one. A yes that turns out to be wrong costs the first real use one
   * error card, which is the same card provisioning already produces; a no
   * costs the user the feature, so the trade only runs one way.
   */
  async probeAvailability(): Promise<ComputerAvailability> {
    if (this.platform !== "linux") {
      return { kind: "unsupported-platform", platform: this.platform };
    }
    if (this.sessionType.toLowerCase() !== "wayland") {
      return { kind: "backend-unavailable", message: WAYLAND_REQUIRED_MESSAGE };
    }
    if (!(await this.nameHasOwner(KWIN_SERVICE))) {
      return { kind: "backend-unavailable", message: NO_KWIN_MESSAGE };
    }
    // Ordered by cost. A loaded plugin and an installed file are a bus round
    // trip and a directory read; the prebuilt match runs `kwin_wayland
    // --version`, so it only happens on a machine that has neither.
    if (await this.nameHasOwner(COMPUTER_SERVICE)) return this.availableNow();
    if ((await this.installedPluginIds().catch(() => [])).length > 0) return this.availableNow();
    if (await this.hasMatchingPrebuilt()) return this.availableNow();
    if (this.probeBuildTooling()) return this.availableNow();
    return { kind: "backend-unavailable", message: NO_PLUGIN_ANYWHERE_MESSAGE };
  }

  private availableNow(): ComputerAvailability {
    return { kind: "available", backend: COMPUTER_KWIN_BACKEND };
  }

  /** A probe never fails: an unanswerable question is a "no", not an error. */
  private async nameHasOwner(name: string): Promise<boolean> {
    return await this.busNameHasOwner(name).catch(() => false);
  }

  /** Whether a shipped binary was built for exactly the KWin running here. */
  private async hasMatchingPrebuilt(): Promise<boolean> {
    const root = this.prebuiltRoot();
    if (!root) return false;
    const [manifest, version] = await Promise.all([
      readPrebuiltManifest(join(root, "manifest.json")).catch(() => undefined),
      this.probeRunningKwinVersion(),
    ]);
    if (!manifest || !version) return false;
    return selectPrebuilt(manifest, version, process.arch) !== undefined;
  }

  private probeBuildTooling(): boolean {
    try {
      return this.buildToolingPresent();
    } catch {
      return false;
    }
  }

  async availability(): Promise<ComputerAvailability> {
    if (this.platform !== "linux") {
      return { kind: "unsupported-platform", platform: this.platform };
    }
    if (this.sessionType.toLowerCase() !== "wayland") {
      return { kind: "backend-unavailable", message: WAYLAND_REQUIRED_MESSAGE };
    }
    try {
      const plugin = await this.ensurePlugin({ start: false });
      const health = parseHealth(await plugin.healthJson());
      if (!health.ok) {
        throw new ComputerBackendError(
          `Synara ${this.integrationName} computer-use health check failed.`,
        );
      }
      this.pluginHealth = health;
      this.publishHealth();
      return { kind: "available", backend: COMPUTER_KWIN_BACKEND };
    } catch (error) {
      const failure = this.reportPluginFailure(error);
      // A refusal the reconnect path never sees — no installed plugin, a KWin
      // version mismatch — is still the newest thing that went wrong, so it is
      // recorded here rather than only where a retry is scheduled.
      this.recordHealthFailure(error);
      this.publishHealth();
      return {
        kind: "backend-unavailable",
        // Composed from error text this backend does not control, so it meets
        // the contract's bound here rather than failing the payload carrying
        // it. Same fallback the health state uses for the same reason.
        message: clampComputerMessage(failure.message, this.failureFallbackMessage),
      };
    }
  }

  /**
   * Health as the supervision path already knows it: no D-Bus call, no probe.
   * `connected` is exactly the condition `ensureConnectedPlugin` reuses a live
   * plugin under, so what a panel is told and what the next action will find
   * cannot drift apart.
   */
  health(): ComputerHealth {
    return this.healthState.health();
  }

  async listWindows(): Promise<readonly ComputerWindow[]> {
    const [windows] = await this.readWindows();
    return windows;
  }

  /**
   * One window enumeration, in both coordinate spaces.
   *
   * The plugin reports global desktop coordinates, and a multi-monitor layout
   * may place monitors left of or above the primary, so the workspace's
   * top-left can sit at negative globals. Everything crossing this backend's
   * boundary speaks **agent space** — 0..screenSize — instead: window bounds
   * and screenshot regions go out shifted by the workspace origin, pointer
   * coordinates come in and are shifted back. That keeps one translation at
   * one choke point rather than teaching every tool, the manager, and the pane
   * that the origin might not be (0, 0).
   */
  private async readWindows(): Promise<
    readonly [windows: ComputerWindow[], origin: ComputerPoint]
  > {
    const plugin = await this.ensurePlugin({ start: false });
    try {
      const state = await this.readPluginState(plugin);
      const payload = await plugin.windowsJson();
      const raw = parseWindows(payload, state.targetWindowId);
      const rect = workspaceRectFromWindows(raw, this.pluginHealth?.workspace);
      const origin = { x: rect.x, y: rect.y };
      // The cached origin input actions translate with until the next read:
      // it comes from the reported workspace whenever KWin has one, which is
      // the same rule this computation applies, so the two never disagree.
      this.lastAgentOrigin = origin;
      const windows = raw.map((window) => windowInAgentSpace(window, origin));
      // The plugin's own document is the change fingerprint. It is already a
      // string on the wire and it changes whenever any window does, so
      // re-serializing the parsed list — on a call that runs several times per
      // action and per publish — buys nothing. The focus target rides along
      // because it decides `focused` without appearing in that document.
      const fingerprint = `${state.targetWindowId ?? ""} ${windowsPayloadFingerprint(payload)}`;
      if (fingerprint !== this.previousWindowsFingerprint) {
        this.previousWindowsFingerprint = fingerprint;
        this.emit({ type: "windows-changed", windows });
      }
      return [windows, origin];
    } catch (error) {
      throw this.reportPluginFailure(error);
    }
  }

  /**
   * The workspace rect KWin reported, without a window read.
   *
   * Reading every window to derive one screen size put a second full window
   * enumeration inside every state publish — and each enumeration can report a
   * window change, which schedules another publish. The size only ever came
   * from the workspace rect anyway; the window bounding box is the fallback for
   * a plugin that did not report one, and `workspaceRect` still uses it.
   */
  async getScreenSize(): Promise<ComputerScreenSize> {
    await this.ensurePlugin({ start: false });
    const rect = await this.workspaceRect();
    return { width: rect.width, height: rect.height, scale: 1 };
  }

  async getState(options: {
    readonly includeScreenshot?: boolean;
    readonly includeText?: boolean;
  }): Promise<ComputerState> {
    await this.ensurePlugin({ start: false });
    // One enumeration feeds the windows, the size, the tree fusion, and the
    // workspace capture; a second round trip here would only add latency.
    const [windows, origin] = await this.readWindows();
    const screenSize = screenSizeFromWindows(windows, this.pluginHealth?.workspace);
    let root: ComputerUiNode | undefined;
    if (options.includeText) {
      try {
        // AT-SPI reports extents in global screen coordinates, so the trees
        // shift into agent space with everything else before fusing.
        const trees = (await this.atspi.readTrees(windows)).map((tree) =>
          shiftTree(tree, -origin.x, -origin.y),
        );
        root = fuseAtspiTrees({ windows, trees, screenSize });
      } catch {
        // AT-SPI is an optional perception source. KWin window state and
        // coordinate actions stay usable when an application has no tree or
        // the helper is temporarily restarting.
      }
    }

    const screenshot =
      options.includeScreenshot && this.pluginHealth?.capture === true
        ? await this.captureWorkspaceScreenshot(origin).catch(() => undefined)
        : undefined;
    return {
      computerId: this.computerId,
      windows,
      screenSize,
      ...(root ? { root } : {}),
      ...(root && options.includeText ? { text: describeComputerUiTree(root) } : {}),
      ...(screenshot ? { screenshot } : {}),
      capturedAt: new Date(this.now()).toISOString(),
    };
  }

  async focusWindow(windowId: string): Promise<void> {
    const plugin = await this.ensurePlugin();
    await this.pluginSuccess("focusWindow", () => plugin.focusWindow(windowId));
  }

  async raiseWindow(windowId: string): Promise<void> {
    const plugin = await this.ensurePlugin();
    try {
      await this.pluginSuccess("raiseWindow", () => plugin.raiseWindow(windowId));
    } catch (error) {
      // A loaded plugin that predates raiseWindow cannot restack, and the
      // caller has to hear that: focus routes keyboard input, not pointer
      // input, so a click on a covered window lands in whatever is on top of
      // it. Swallowing this is what made buried clicks look like dead buttons.
      if (!isUnknownMethodDbusError(error)) throw error;
      throw new ComputerBackendError(
        `The loaded Synara ${this.integrationName} plugin has no raiseWindow, so windows cannot ` +
          "be raised above what covers them. Build, install, and load the current plugin with " +
          `${this.installHint}.`,
      );
    }
  }

  async clearFocusWindow(): Promise<void> {
    const plugin = await this.ensurePlugin();
    await this.pluginSuccess("clearFocusWindow", () => plugin.clearFocusWindow());
  }

  async setDrivingAgent(name: string | null): Promise<void> {
    this.drivingAgent = name?.trim() ? name.trim() : null;
    // Only pushed to a session that is already up. A start pushes the cached
    // name itself, so naming a thread must not be what starts the session -
    // the human would get an agent cursor before any agent asked for one.
    const plugin = this.connectedPlugin();
    if (!plugin || this.pluginHealth?.running !== true) return;
    await this.pushDrivingAgent(plugin);
  }

  async launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult> {
    await this.ensurePlugin();
    const launch = this.resolveApp(app, args);
    let child: ChildProcess;
    try {
      child = this.spawnProcess(launch.command, launch.args);
    } catch (error) {
      throw launchAppError(app, error);
    }

    return await new Promise<ComputerLaunchAppResult>((resolve, reject) => {
      const result = {
        computerId: this.computerId,
        app,
        resolvedCommand: launch.command,
        window: null,
      } as ComputerLaunchAppResult;
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve(result);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(launchAppError(app, error));
      };

      child.once("error", onError);
      child.once("spawn", onSpawn);
      try {
        child.unref();
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async click(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    const moved = await this.moveCursor(point);
    await this.pressButton(EVDEV_BUTTON_CODES.left);
    return moved;
  }

  async doubleClick(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    const moved = await this.moveCursor(point);
    await this.pressButton(EVDEV_BUTTON_CODES.left);
    await this.sleep(60);
    await this.pressButton(EVDEV_BUTTON_CODES.left);
    return moved;
  }

  async rightClick(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    const moved = await this.moveCursor(point);
    await this.pressButton(EVDEV_BUTTON_CODES.right);
    return moved;
  }

  async moveCursor(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    const plugin = await this.ensurePlugin();
    const from = this.currentPoint ?? (await this.readPluginState(plugin)).position ?? point;
    await this.glidePointer(plugin, from, point, this.glideDurationMs);
    this.currentPoint = point;
    return await this.pointerResult(plugin, point);
  }

  async drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
  ): Promise<ComputerBackendActionResult> {
    const plugin = await this.ensurePlugin();
    const sink = this.inputSink(plugin);
    await this.moveCursor(from);
    this.throwIfDisposed();
    await sink.button(EVDEV_BUTTON_CODES.left, true, POINTER_SEQUENCE_OPERATIONS.buttonPress);
    try {
      await this.glidePointer(plugin, from, to, durationMs);
    } finally {
      if (!this.disposed) {
        await sink.button(
          EVDEV_BUTTON_CODES.left,
          false,
          POINTER_SEQUENCE_OPERATIONS.buttonRelease,
        );
      }
    }
    this.currentPoint = to;
    return await this.pointerResult(plugin, to);
  }

  async scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerBackendActionResult> {
    const plugin = await this.ensurePlugin();
    const moved = point ? await this.moveCursor(point) : {};
    await this.pluginSuccess("axis", () => plugin.axis(deltaX, deltaY));
    return moved;
  }

  async typeText(text: string): Promise<ComputerBackendActionResult> {
    const plugin = await this.ensurePlugin();
    // Sampled before the first stroke: CapsLock latched on the driven keyboard
    // inverts the letter Shifts, and synthesizing blind would land `Hello` as
    // `hELLO`. Older plugins do not report it, which leaves Shift-only
    // synthesis — the documented limitation on this tier.
    const capsLockOn = (await this.readPluginState(plugin)).capsLockOn === true;
    const strokes = qwertyTextKeyStrokes(text, { capsLock: capsLockOn });
    const sink = this.inputSink(plugin);
    for (const stroke of strokes) await pressKeyStroke({ sink, stroke });
    return { value: text };
  }

  async pressKey(key: string): Promise<ComputerBackendActionResult> {
    const stroke = keyStrokeForKey(key);
    const plugin = await this.ensurePlugin();
    await pressKeyStroke({ sink: this.inputSink(plugin), stroke });
    return {};
  }

  async hotkey(keys: readonly string[]): Promise<ComputerBackendActionResult> {
    const strokes = keys.map(keyStrokeForKey);
    const plugin = await this.ensurePlugin();
    await pressHotkeyStrokes({ sink: this.inputSink(plugin), strokes });
    return {};
  }

  /**
   * The human's clipboard, shared on purpose: see wlClipboard.ts for why the
   * agent seat cannot own a private one. Neither direction uses the KWin plugin
   * or the agent seat, so both work without an input session.
   */
  async readClipboard(): Promise<string> {
    return await readWlClipboard(this.runClipboardCommand);
  }

  async writeClipboard(text: string): Promise<void> {
    await writeWlClipboard(this.runClipboardCommand, text);
  }

  /** Replace the complete value through EditableText; insertion is a separate operation. */
  async setValue(
    target: ComputerResolvedTarget,
    value: string,
  ): Promise<ComputerBackendActionResult> {
    // Ahead of the click, so a refusal costs the human nothing at all: the click
    // that focuses the control is itself a mutation of their window.
    if (!atspiTextWriteAddress(target.node)) {
      throw new ComputerBackendError(
        "This control does not support replacing its value through AT-SPI.",
      );
    }
    await this.guardHumanActiveWindow(await this.ensurePlugin(), target.node.windowId);
    const clicked = await this.click(target.point);
    if (!(await this.writeValueThroughAtspi(target, value))) {
      throw new ComputerBackendError(
        "Could not confirm that AT-SPI replaced the control's value. Read the control again before retrying; it may have changed.",
      );
    }
    return {
      ...clicked,
      point: target.point,
      ...(target.node.windowId ? { windowId: target.node.windowId } : {}),
      value,
    };
  }

  /** A failed or partial semantic write must never be retried as key insertion. */
  private async writeValueThroughAtspi(
    target: ComputerResolvedTarget,
    value: string,
  ): Promise<boolean> {
    const address = atspiTextWriteAddress(target.node);
    if (!address) return false;
    try {
      const window = (await this.listWindows()).find(
        (candidate) => candidate.id === address.windowId,
      );
      if (!window) return false;
      return await this.atspi.setText({
        window,
        path: address.path,
        text: value,
        role: target.node.role,
        label: target.node.label,
      });
    } catch {
      return false;
    }
  }

  async performAction(
    target: ComputerResolvedTarget,
    action: string,
  ): Promise<ComputerBackendActionResult> {
    if (action === "activate" || action === "click") {
      await this.guardHumanActiveWindow(await this.ensurePlugin(), target.node.windowId);
      const clicked = await this.click(target.point);
      return {
        ...clicked,
        point: target.point,
        ...(target.node.windowId ? { windowId: target.node.windowId } : {}),
        value: action,
      };
    }
    throw new ComputerBackendError(
      `${this.integrationName} computer action ${JSON.stringify(action)} has no safe input mapping.`,
    );
  }

  onEvent(listener: ComputerBackendEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async attachStream(listener: ComputerFrameListener): Promise<void> {
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer);
    this.streamTimer = undefined;
    await this.ensurePlugin();
    // An overlapping attach (a second pane joining mid-attach) cleared the
    // first interval above, but the await let the FIRST attach resume here and
    // install its own interval — which nothing would ever clear again, because
    // `streamTimer` now names the second one. Cleared once more so exactly the
    // newest attach's interval survives.
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer);
    this.streamListener = listener;
    await this.publishStillFrame();
    this.streamTimer = setInterval(() => {
      void this.publishStillFrame();
    }, this.stillIntervalMs);
    this.streamTimer.unref?.();
  }

  async detachStream(): Promise<void> {
    this.streamListener = undefined;
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer);
    this.streamTimer = undefined;
  }

  async requestKeyframe(): Promise<void> {
    if (!this.streamListener) return;
    await this.publishStillFrame();
  }

  async captureWindow(
    windowId: string,
    maxDimension = this.captureMaxDimension,
  ): Promise<Uint8Array> {
    const plugin = await this.ensurePlugin();
    if (this.pluginHealth?.capture !== true) {
      throw new ComputerBackendError(
        `The loaded Synara ${this.integrationName} plugin has no capture support.`,
      );
    }
    return readByteArray(
      await this.enqueueCapture(() =>
        this.pluginValue(() => plugin.captureWindow(windowId, normalizeDimension(maxDimension))),
      ),
    );
  }

  async captureRegion(
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension = this.captureMaxDimension,
  ): Promise<Uint8Array> {
    const plugin = await this.ensurePlugin();
    if (this.pluginHealth?.capture !== true) {
      throw new ComputerBackendError(
        `The loaded Synara ${this.integrationName} plugin has no capture support.`,
      );
    }
    return readByteArray(
      await this.enqueueCapture(() =>
        this.pluginValue(() =>
          plugin.captureRegion(x, y, width, height, normalizeDimension(maxDimension)),
        ),
      ),
    );
  }

  /**
   * Zoomed perception for the agent. The workspace shot in `getState` is one
   * downscaled image of every monitor, so small text is unreadable; this
   * captures a single window or region, which spends the same pixel budget on a
   * fraction of the desktop.
   *
   * The returned `region` is always what KWin actually captured: the plugin
   * clips both forms to the workspace geometry, and a window capture uses the
   * window's `frameGeometry`, which is the same rect `windowsJson` reports. The
   * scale is derived from the encoded PNG rather than assumed, because the
   * plugin renders at the output's device pixel ratio and only then downscales
   * to `maxDimension`.
   */
  async captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    const maxDimension = request.maxDimension ?? this.captureMaxDimension;
    if (request.kind === "window") {
      const [windows, origin] = await this.readWindows();
      const window = windows.find((candidate) => candidate.id === request.windowId);
      if (!window) {
        throw new ComputerBackendError(
          `No desktop window has id ${JSON.stringify(request.windowId)}. ` +
            "Call computer_list_windows for the current window ids.",
        );
      }
      // Both rects are agent-space. The clip is the *reported* workspace when
      // KWin gave one — its edges are what actually clip a capture — and the
      // window bounding box otherwise.
      const reported = this.pluginHealth?.workspace;
      const agentWorkspace =
        reported && reported.width > 0 && reported.height > 0
          ? shiftRect(reported, -origin.x, -origin.y)
          : workspaceRectFromWindows(windows);
      const region = intersectComputerRects(
        requireWindowBounds(window, "a window screenshot"),
        agentWorkspace,
      );
      if (!region) {
        throw new ComputerBackendError(
          `Window ${JSON.stringify(request.windowId)} sits outside the desktop workspace and has nothing to capture.`,
        );
      }
      return this.screenshot(await this.captureWindow(request.windowId, maxDimension), region);
    }

    const requested = request.region;
    if (
      ![requested.x, requested.y, requested.width, requested.height].every((value) =>
        Number.isFinite(value),
      ) ||
      requested.width <= 0 ||
      requested.height <= 0
    ) {
      throw new ComputerBackendError(
        "A screenshot region needs finite x/y and a positive width and height.",
      );
    }
    // The request arrives in agent space; the plugin captures in globals.
    // workspaceRect() is already global — shifting it again would double the
    // origin offset and reject on-screen regions on negative-origin layouts.
    const origin = this.currentOrigin();
    const globalWorkspace = await this.workspaceRect();
    const global = intersectComputerRects(
      shiftRect(alignRect(requested), origin.x, origin.y),
      globalWorkspace,
    );
    if (!global) {
      throw new ComputerBackendError(
        `Region ${formatRect(requested)} does not overlap the desktop workspace. ` +
          "Regions use desktop logical pixels, the same space as window bounds.",
      );
    }
    return this.screenshot(
      await this.captureRegion(global.x, global.y, global.width, global.height, maxDimension),
      shiftRect(global, -origin.x, -origin.y),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.connectPromise?.catch(() => undefined);
    await this.startPromise?.catch(() => undefined);
    await this.detachStream();
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnecting = false;
    const plugin = this.plugin;
    if (plugin) await plugin.stop().catch(() => undefined);
    this.disconnect?.();
    this.disconnect = undefined;
    await this.dbus?.close().catch(() => undefined);
    this.dbus = undefined;
    this.plugin = undefined;
    this.pluginHealth = undefined;
    await this.atspi.dispose().catch(() => undefined);
    this.eventListeners.clear();
  }

  private async ensurePlugin(
    options: { readonly start?: boolean; readonly automatic?: boolean } = {},
  ): Promise<KWinComputerPluginApi> {
    const plugin = await this.ensureConnectedPlugin(options.automatic === true);
    if (options.start !== false) await this.startPlugin(plugin);
    return plugin;
  }

  private async ensureConnectedPlugin(automatic: boolean): Promise<KWinComputerPluginApi> {
    if (this.disposed)
      throw new ComputerBackendError(`${this.integrationName} computer backend is disposed.`);
    const connected = this.connectedPlugin();
    if (connected) return connected;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectWithBackoff(automatic)
      .catch((error) => {
        if (isDormantBackendError(error)) this.standDownReconnect();
        else if (!isMethodLevelDbusError(error)) this.scheduleReconnect();
        this.recordHealthFailure(error);
        this.publishHealth();
        throw error;
      })
      .finally(() => {
        this.connectPromise = undefined;
      });
    return this.connectPromise;
  }

  /**
   * Best effort on purpose: an older loaded plugin has no setAgentName, and an
   * unnamed badge is not a reason to fail the session or the action.
   */
  private async pushDrivingAgent(plugin: KWinComputerPluginApi): Promise<void> {
    await plugin.setAgentName(this.drivingAgent ?? "").catch(() => undefined);
  }

  private async startPlugin(plugin: KWinComputerPluginApi): Promise<void> {
    if (this.disposed)
      throw new ComputerBackendError(`${this.integrationName} computer backend is disposed.`);
    if (this.pluginHealth?.running === true) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        const started = readBoolean(await plugin.start());
        if (!started) {
          throw new ComputerBackendError(
            `Synara ${this.integrationName} computer-use plugin failed to start.`,
          );
        }
        // A plugin build without setIdleTimeout keeps its own default deadline,
        // so an older loaded plugin must not fail the session.
        await plugin.setIdleTimeout(this.idleTimeoutMs).catch(() => undefined);
        // Same tolerance, same reason: a plugin that predates the human-active
        // guard keeps its own default rather than failing the session over a
        // method it has never heard of.
        await plugin.setHumanActiveGuardMs(this.humanActiveGuardMs).catch(() => undefined);
        await this.pushDrivingAgent(plugin);
        const runningHealth = parseHealth(await plugin.healthJson());
        if (!runningHealth.ok || !runningHealth.running) {
          throw new ComputerBackendError(
            `Synara ${this.integrationName} computer-use plugin is not running.`,
          );
        }
        this.pluginHealth = runningHealth;
        this.publishHealth();
      } catch (error) {
        throw this.reportPluginFailure(error);
      }
    })().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async connectWithBackoff(automatic: boolean): Promise<KWinComputerPluginApi> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.connectOnce(automatic);
      } catch (error) {
        lastError = error;
        // A dormant refusal is a decision, not a fault: retrying cannot boot
        // the desktop this very call was told not to boot.
        if (isMethodLevelDbusError(error) || isDormantBackendError(error)) throw error;
        this.invalidateConnection();
        if (attempt < 2) await this.sleep(KWIN_RECONNECT_BASE_DELAY_MS * 2 ** attempt);
      }
    }
    throw new ComputerBackendError(
      lastError instanceof Error ? lastError.message : String(lastError),
      { retryable: true, cause: lastError },
    );
  }

  private async connectOnce(automatic: boolean): Promise<KWinComputerPluginApi> {
    const dbus = this.dbus ?? (this.dbus = await this.dbusFactory({ automatic }));
    if (!this.disconnect) {
      this.disconnect = dbus.onDisconnect(() => {
        this.invalidateConnection();
        this.scheduleReconnect();
      });
    }
    // Who owns the well-known service name *before* anything is loaded. The
    // plugin is addressed by that name, so without pinning the owner, a stale
    // duplicate Synara instance — or any same-session squatter — would receive
    // every pointer, key, and capture call this server sends, and could serve
    // forged state and screenshots an agent then acts on.
    const ownerBefore = await dbus.nameOwner(COMPUTER_SERVICE);
    let loaded: readonly string[];
    try {
      loaded = await dbus.listLoadedPluginIds();
    } catch (error) {
      if (isConnectionLevelFailure(error)) throw error;
      // Older KWin builds may not expose loadedPlugins. If the Synara service
      // already exists, use it directly; otherwise continue with the
      // installed-file scan below and let LoadPlugin establish the service.
      try {
        assertServiceOwnerPresent(await dbus.nameOwner(COMPUTER_SERVICE));
        const plugin = await dbus.connectPlugin();
        return await this.finishPluginConnection(plugin, undefined);
      } catch (fallbackError) {
        if (isConnectionLevelFailure(fallbackError)) throw fallbackError;
        loaded = [];
      }
    }
    let plan = resolveSynaraPluginLoad({ loaded, installed: await this.installedPluginIds() });
    if (!plan) {
      // Nothing to load: this is a machine that has the update but has never had
      // the plugin, which is the ordinary first-run case rather than an error.
      const installed = await this.provisionOnce().catch((error: unknown) => {
        throw new ComputerBackendError(
          "No SynaraComputerUsePluginVn is installed, and installing one failed: " +
            `${describeErrorMessage(error, "the installer gave no reason")}. ` +
            `You can build and install it yourself with ${this.installHint}.`,
        );
      });
      // An install the running compositor cannot see yet needs the user to log
      // out once, and its own summary says so in those words. Decided before
      // the rescan: the scan looks where the installer writes, so it does find
      // the new file, and loading it would fail with a reason KWin never gives.
      if (installed.requiresRelogin) throw new ComputerBackendError(installed.summary);
      plan = resolveSynaraPluginLoad({ loaded, installed: await this.installedPluginIds() });
      if (!plan) throw new ComputerBackendError(installed.summary);
    }
    if (plan.kind === "replace") {
      // A false reply means the id was already gone, which is the state the
      // unload was after, so the replies are deliberately ignored.
      for (const staleId of plan.unload) await dbus.unloadPlugin(staleId);
      if (!(await dbus.loadPlugin(plan.pluginId))) {
        // Overwhelmingly a KWin upgrade under an installed plugin, and
        // reinstalling is the fix for exactly that - so try it before reporting
        // the refusal the user cannot act on.
        let accepted: string | undefined;
        let refusedId = plan.pluginId;
        for await (const candidate of this.reprovisionAfterRefusal(plan.pluginId)) {
          await dbus.unloadPlugin(refusedId);
          if (await dbus.loadPlugin(candidate)) {
            accepted = candidate;
            break;
          }
          refusedId = candidate;
        }
        if (!accepted) throw new ComputerBackendError(await this.describeLoadRefusal(refusedId));
        plan = { kind: "replace", unload: plan.unload, pluginId: accepted };
      }
      // A successful load must have moved the name to a *new* registration. If
      // the owner is unchanged, whatever answered before still holds the name —
      // an unload race or a squatter — and connecting would drive the wrong
      // build. Retryable: a genuine race settles within moments, and the next
      // attempt re-checks from scratch.
      await assertFreshServiceOwner(await dbus.nameOwner(COMPUTER_SERVICE), ownerBefore);
    } else {
      // Nothing was (re)loaded, so the name may legitimately be held by the
      // generation already running — but something must hold it at all.
      assertServiceOwnerPresent(await dbus.nameOwner(COMPUTER_SERVICE));
    }
    const plugin = await dbus.connectPlugin();
    return await this.finishPluginConnection(plugin, plan.pluginId);
  }

  /**
   * Installs the plugin, deduplicating only concurrent callers.
   *
   * The user's side of "enable computer use" is the toggle; everything under it
   * happens here. It writes the session env script, installs a shipped binary
   * for this KWin when there is one, and builds against the local headers when
   * there is not.
   *
   * The map exists so the reconnect loop cannot start a second install - or a
   * second source build, which takes minutes - while the first is still
   * running; it is keyed by attempt because the source-only retry is a
   * different install, not a repeat of the first. Entries are dropped on
   * settlement: a memoized failure would replay forever, and a memoized
   * success would keep naming an id KWin may since have refused, so every
   * later call re-asks `provisionPlugin`, whose already-current stamp check
   * keeps a repeat cheap when nothing changed.
   */
  protected async provisionOnce(allowPrebuilt = true, force = false): Promise<ProvisionResult> {
    const key = `${allowPrebuilt ? "any" : "source"}:${force ? "forced" : "current"}`;
    const existing = this.provisionPromises.get(key);
    if (existing) return await existing;
    const pending = this.provisionPlugin({ allowPrebuilt, force }).then((result) => {
      if (result.action !== "already-current") this.lastInstallAction = result.action;
      return result;
    });
    this.provisionPromises.set(key, pending);
    const forget = () => {
      if (this.provisionPromises.get(key) === pending) {
        this.provisionPromises.delete(key);
      }
    };
    // Both branches handled together, so the derived promise never rejects
    // unobserved; the caller gets the original rejection from the await below.
    void pending.then(forget, forget);
    return await pending;
  }

  /**
   * The settings card's "Set up". Installs without loading: the establishing
   * read the manager makes right after is what loads the result, and it
   * already knows how to unload stale ids first.
   */
  async provision(): Promise<string> {
    return (await this.provisionOnce()).summary;
  }

  /**
   * The plugin ids worth trying after KWin refused `refusedId`, in order. Each
   * is produced only once the previous one has been refused too: a source
   * build takes minutes and is not worth starting while a shipped binary might
   * still load.
   *
   * Install failures are swallowed on purpose: the caller's next move is to
   * report the refusal, and a build error here would replace that accurate
   * message with a less useful one about cmake. An install the running
   * compositor cannot see is different - nothing can load until the user logs
   * in again - so that verdict is thrown in the installer's own words rather
   * than letting the refusal be reported as a version mismatch.
   *
   * The first attempt is the ordinary one: after a KWin upgrade it installs
   * the build for the new version, and when the refused install is the one the
   * stamp calls current it installs nothing. The second is the other install
   * shape, forced past that stamp: prebuilt→source covers a distribution
   * mismatch the shipped binary hits, and source→prebuilt covers the reverse -
   * a version probe or checksum that failed the first time but passes now.
   */
  private async *reprovisionAfterRefusal(refusedId: string): AsyncGenerator<string, void> {
    const tried = new Set([refusedId]);
    const attempts = [
      () => this.provisionOnce(),
      () => this.provisionOnce(this.lastInstallAction === "installed-from-source", true),
    ];
    for (const attempt of attempts) {
      const result = await attempt().catch(() => undefined);
      if (!result) continue;
      if (result.requiresRelogin) throw new ComputerBackendError(result.summary);
      if (result.pluginId && !tried.has(result.pluginId)) {
        tried.add(result.pluginId);
        yield result.pluginId;
      }
    }
  }

  /**
   * KWin only logs why it refused a plugin ("has mismatching plugin version"),
   * so the D-Bus `false` reply carries no reason at all. The plugin is a binary
   * KWin module tied to the KWin version it was compiled against, which makes a
   * KWin upgrade the overwhelmingly likely cause. Name the version pair when the
   * installer stamp and the KWin binary can supply it, and always point at the
   * rebuild, because this message is all the availability card can show.
   */
  protected async describeLoadRefusal(pluginId: string): Promise<string> {
    const mismatch = await this.readKwinVersionMismatch();
    const cause = mismatch
      ? `it was built for KWin ${mismatch.builtFor}, but KWin ${mismatch.running} is running`
      : "a KWin plugin only loads into the exact KWin version it was built against";
    return (
      `KWin refused to load ${pluginId}: ${cause}. ` +
      `If KWin was upgraded, rebuild and reload the plugin with ${INSTALL_SCRIPT_PATH}; ` +
      `automatic rebuilds can be enabled with ${ENABLE_REBUILD_SCRIPT_PATH}.`
    );
  }

  private async readKwinVersionMismatch(): Promise<
    { readonly builtFor: string; readonly running: string } | undefined
  > {
    const [builtFor, running] = await Promise.all([
      this.readInstallStamp().then(stampKwinVersion, () => undefined),
      this.probeRunningKwinVersion(),
    ]);
    // Equal versions mean the refusal has some other cause, and a half-known
    // pair says nothing, so only a real mismatch is worth naming.
    if (!builtFor || !running || builtFor === running) return undefined;
    return { builtFor, running };
  }

  private probeRunningKwinVersion(): Promise<string | undefined> {
    // KWin cannot change under a live session, so probing once keeps the
    // connect retry loop from spawning a process per attempt.
    this.runningKwinVersionPromise ??= this.runningKwinVersion().catch(() => undefined);
    return this.runningKwinVersionPromise;
  }

  private async finishPluginConnection(
    plugin: KWinComputerPluginApi,
    pluginId: string | undefined,
  ): Promise<KWinComputerPluginApi> {
    if (this.disposed) {
      await plugin.stop().catch(() => undefined);
      throw new ComputerBackendError(`${this.integrationName} computer backend is disposed.`);
    }
    const health = parseHealth(await plugin.healthJson());
    if (!health.ok)
      throw new ComputerBackendError(
        `Synara ${this.integrationName} computer-use health check failed.`,
      );
    this.plugin = plugin;
    this.pluginId = pluginId;
    this.pluginHealth = health;
    this.reconnectFailures = 0;
    this.reconnecting = false;
    this.healthState.recordConnected();
    this.publishHealth();
    return plugin;
  }

  private invalidateConnection(): void {
    const dbus = this.dbus;
    this.dbus = undefined;
    this.plugin = undefined;
    this.pluginHealth = undefined;
    this.pluginId = undefined;
    this.disconnect?.();
    this.disconnect = undefined;
    void dbus?.close().catch(() => undefined);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return;
    const delayMs = Math.min(
      KWIN_RECONNECT_MAX_DELAY_MS,
      KWIN_RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectFailures,
    );
    this.reconnectFailures = Math.min(this.reconnectFailures + 1, 5);
    // Set before the timer, and cleared only by a successful connection: the
    // attempt the timer runs is part of the same reconnecting state, so a
    // reader between the timer firing and the connection landing must not see
    // the backend as given up on.
    this.reconnecting = true;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensurePlugin({ start: false, automatic: true }).catch((error: unknown) => {
        if (!isDormantBackendError(error)) this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
    this.publishHealth();
  }

  /**
   * Ends the reconnect loop without a connection. Only a dormant refusal lands
   * here: the factory said the desktop is deliberately not running and only a
   * real use may boot it, so a pending retry would either lie about recovery
   * or respawn a desktop window the human just closed. The next real use
   * connects — and thereby boots — without any of this state in the way.
   */
  private standDownReconnect(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectFailures = 0;
    this.reconnecting = false;
  }

  private async readPluginState(plugin: KWinComputerPluginApi): Promise<KWinPluginState> {
    let raw: unknown;
    try {
      raw = await plugin.stateJson();
    } catch (error) {
      throw this.reportPluginFailure(error);
    }
    const parsed = asRecord(parseJsonPayload(raw));
    const globalPosition = parseComputerPoint(parsed.position);
    // The plugin speaks global coordinates; everything this backend caches and
    // returns is agent-space, so the cached position shifts with the origin.
    const origin = this.currentOrigin();
    const position = globalPosition ? shiftPoint(globalPosition, -origin.x, -origin.y) : null;
    if (position) this.currentPoint = position;
    const targetWindowId =
      asString(parsed.targetWindowId) ?? asString(parsed.focusedWindowId) ?? null;
    // The plugin reports an empty id for "nobody has focus", which is a real
    // answer and not a missing field; a missing field is an older plugin.
    const humanFocusWindowId = asString(parsed.humanFocusWindowId);
    const msSinceHumanInput =
      typeof parsed.msSinceHumanInput === "number" && Number.isFinite(parsed.msSinceHumanInput)
        ? parsed.msSinceHumanInput
        : undefined;
    // Nothing to protect in a compositor the agent owns, and reporting a guard
    // there would refuse the agent on its own input.
    const guarded = parsed.ownsCompositor !== true;
    return {
      position,
      targetWindowId,
      humanFocusWindowId: guarded ? humanFocusWindowId : undefined,
      msSinceHumanInput: guarded ? msSinceHumanInput : undefined,
      capsLockOn:
        parsed.capsLockOn === true ? true : parsed.capsLockOn === false ? false : undefined,
    };
  }

  /**
   * Refuses a semantic write aimed at the window the human is working in.
   *
   * The plugin's own guard covers everything it injects, and an AT-SPI write
   * goes nowhere near it: `setText` reaches the application over the
   * accessibility bus, so the one thing standing between it and the human's
   * half-written message is this check. It reads the guard's two halves out of a
   * fresh `stateJson` — the state has to be sampled before the action, never
   * after — and skips when the loaded plugin does not report them, which is the
   * honest answer for a version-skewed session rather than a refusal built on a
   * field that was never there.
   */
  private async guardHumanActiveWindow(
    plugin: KWinComputerPluginApi,
    windowId: string | null | undefined,
  ): Promise<void> {
    if (this.humanActiveGuardMs === 0 || !windowId) return;
    const state = await this.readPluginState(plugin);
    const { humanFocusWindowId, msSinceHumanInput } = state;
    if (humanFocusWindowId === undefined || msSinceHumanInput === undefined) return;
    // -1 is the plugin saying it has observed no real device event at all, which
    // is not the same as a long quiet period and is not grounds for refusing.
    if (msSinceHumanInput < 0 || msSinceHumanInput > this.humanActiveGuardMs) return;
    if (humanFocusWindowId !== windowId) return;

    const title = (await this.listWindows().catch(() => [])).find(
      (window) => window.id === windowId,
    )?.title;
    throw this.humanActiveError(
      `The human is using ${title ?? "the focused window"} right now — their keyboard focus is ` +
        `on it and their own devices were active ${msSinceHumanInput} ms ago — so nothing was ` +
        `written to it. Every other window is still available, and this action can be retried ` +
        `once they have been idle for ${this.humanActiveGuardMs} ms.`,
    );
  }

  private humanActiveError(detail: string, cause?: unknown): ComputerBackendError {
    return new ComputerBackendError(`${HUMAN_ACTIVE_REFUSAL}: ${detail}`, {
      retryable: true,
      ...(cause === undefined ? {} : { cause }),
    });
  }

  /**
   * The shared glide, driven through the plugin's D-Bus surface. Every timing
   * decision lives in pointerSequencing.ts so a second backend's pointer moves
   * the same way; all this supplies is the transport and the disposal check.
   */
  private async glidePointer(
    plugin: KWinComputerPluginApi,
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
  ): Promise<void> {
    await glidePointerToDeadline({
      sink: this.inputSink(plugin),
      from,
      to,
      durationMs,
      now: () => this.now(),
      sleep: (milliseconds) => this.sleep(milliseconds),
      beforeStep: () => this.throwIfDisposed(),
      onStep: (point) => {
        this.currentPoint = point;
      },
    });
  }

  /**
   * The plugin's evdev-shaped D-Bus API as the shared sequencing sink. Each
   * method carries the operation name through so a refusal still says which half
   * of a press/release pair KWin rejected. Coordinates arrive in agent space
   * and leave translated into the global space the plugin drives.
   */
  private inputSink(plugin: KWinComputerPluginApi): ComputerInputSink {
    return {
      movePointer: (x, y, operation) => {
        const origin = this.currentOrigin();
        return this.pluginSuccess(operation, () => plugin.movePointer(x + origin.x, y + origin.y));
      },
      button: (code, pressed, operation) =>
        this.pluginSuccess(operation, () => plugin.button(code, pressed)),
      key: (code, pressed, operation) =>
        this.pluginSuccess(operation, () => plugin.key(code, pressed)),
    };
  }

  /**
   * Pointer requests are advisory: KWin clamps a move to the nearest output
   * when the global coordinate lands in a gap between monitors. One state read
   * after the final move tells the caller where the pointer really is without
   * paying a round trip for every intermediate glide step. The state read
   * already reports agent-space coordinates, so request and answer are
   * compared in the same space.
   */
  private async pointerResult(
    plugin: KWinComputerPluginApi,
    point: ComputerPoint,
  ): Promise<ComputerBackendActionResult> {
    const actual = await this.readPluginState(plugin)
      .then((state) => state.position)
      .catch(() => null);
    if (
      !actual ||
      (Math.abs(actual.x - point.x) <= POINTER_CLAMP_TOLERANCE_PX &&
        Math.abs(actual.y - point.y) <= POINTER_CLAMP_TOLERANCE_PX)
    ) {
      return { point };
    }
    return { point, clampedTo: actual };
  }

  /**
   * Captures the whole workspace instead of one window. A window capture cannot
   * tell the model where anything sits in the coordinate space that the pointer
   * tools use, and the focused-window fallback silently resolved to the desktop
   * wallpaper whenever KWin had no better candidate.
   *
   * The pixels come from the global workspace rect the plugin speaks; the
   * reported region is that same rect in agent space, which is what every
   * caller maps screenshot pixels against.
   */
  private async captureWorkspaceScreenshot(origin: ComputerPoint): Promise<ComputerScreenshot> {
    const global = await this.workspaceRect();
    const bytes = await this.captureRegion(global.x, global.y, global.width, global.height);
    return this.screenshot(bytes, shiftRect(global, -origin.x, -origin.y));
  }

  private screenshot(bytes: Uint8Array, region: ComputerRect): ComputerScreenshot {
    return screenshotFromPng({
      bytes,
      region,
      capturedAt: new Date(this.now()).toISOString(),
      source: this.captureSource,
    });
  }

  /** Workspace geometry in GLOBAL coordinates, without a window read when KWin reported it. */
  private async workspaceRect(): Promise<ComputerRect> {
    const workspace = this.pluginHealth?.workspace;
    if (workspace && workspace.width > 0 && workspace.height > 0) {
      const rect = workspaceRectFromWindows([], workspace);
      this.lastAgentOrigin = { x: rect.x, y: rect.y };
      return rect;
    }
    const [windows, origin] = await this.readWindows();
    // The list is agent-space, so its bounding box is anchored near zero;
    // re-anchored at the real origin it becomes the global capture region.
    return shiftRect(workspaceRectFromWindows(windows), origin.x, origin.y);
  }

  /**
   * The global-space origin agent coordinates are translated by, as of the
   * freshest information this backend has without extra round trips. Pointer
   * actions run between window reads, so the cached value is what they get —
   * and it is refreshed from the reported workspace whenever health carries
   * one, which is every reconnect and state publish.
   */
  private currentOrigin(): ComputerPoint {
    const workspace = this.pluginHealth?.workspace;
    if (workspace && workspace.width > 0 && workspace.height > 0) {
      this.lastAgentOrigin = {
        x: Math.floor(workspace.x),
        y: Math.floor(workspace.y),
      };
    }
    return this.lastAgentOrigin;
  }

  /**
   * One workspace still, straight out of the plugin and onto the wire.
   *
   * Nothing here goes through `captureWorkspaceScreenshot`: that builds a
   * `ComputerScreenshot`, whose payload is base64, and a frame carries raw
   * bytes. Round-tripping a multi-megabyte PNG through base64 and back — twice
   * a second, forever, while anyone is watching the pane — cost two full copies
   * and an encode per frame to arrive back at the bytes the capture already
   * returned. The rect comes from the cached workspace geometry for the same
   * reason: a window enumeration per frame is a window enumeration per frame.
   */
  private async publishStillFrame(): Promise<void> {
    const listener = this.streamListener;
    if (
      !listener ||
      this.pluginHealth?.capture !== true ||
      this.stillInFlight ||
      this.capturePending > 0
    )
      return;
    this.stillInFlight = true;
    try {
      const region = await this.workspaceRect();
      if (this.capturePending > 0) return;
      const data = await this.captureRegion(region.x, region.y, region.width, region.height);
      // Cheap header read, kept for the same reason the screenshot path has it:
      // a payload that is not a PNG must fail here rather than in a decoder in
      // the browser, where the only symptom is a blank pane.
      readPngDimensions(data, { source: this.captureSource });
      if (this.streamListener !== listener) return;
      const frame = {
        sequence: this.nextSequence++,
        timestampMs: this.now(),
        // Every frame is a complete PNG still. There is no H.264 codec config
        // or delta frame in Tier 1, so the envelope remains keyframe-only.
        keyframe: true,
        codecConfig: false,
        data,
      };
      listener(frame);
      this.emit({ type: "frame", frame });
    } catch {
      // A transient capture failure should not tear down a subscribed stream.
    } finally {
      this.stillInFlight = false;
    }
  }

  private async pressButton(code: number): Promise<void> {
    const plugin = await this.ensurePlugin();
    await pressButtonOnce({
      sink: this.inputSink(plugin),
      code,
      sleep: (milliseconds) => this.sleep(milliseconds),
    });
  }

  /**
   * The plugin refuses input while its session is stopped, which is how the
   * server learns about a stop it never asked for: the idle deadline expiring
   * during a long model turn, or the user's release hotkey. An idle stop is
   * routine, so the session is restarted and the call retried once. A hotkey
   * release is a deliberate human takeover, so it surfaces as a clear error
   * instead of the agent silently grabbing the desktop back.
   */
  private async pluginSuccess(operation: string, invoke: () => Promise<unknown>): Promise<void> {
    if (readBoolean(await this.pluginValue(invoke))) return;
    if (await this.restartAfterExternalStop()) {
      if (readBoolean(await this.pluginValue(invoke))) return;
    }
    throw new ComputerBackendError(`Synara ${this.integrationName} plugin rejected ${operation}.`, {
      retryable: true,
      rejectedOperation: operation,
    });
  }

  private async restartAfterExternalStop(): Promise<boolean> {
    const plugin = this.plugin;
    if (!plugin || this.disposed) return false;
    const health = parseHealth(await this.pluginValue(() => plugin.healthJson()));
    if (!health.ok || health.running) return false;
    this.pluginHealth = health;
    this.publishHealth();
    if (health.releasedByUser) throw new ComputerBackendError(CONTROL_RELEASED_MESSAGE);
    await this.startPlugin(plugin);
    return true;
  }

  private async pluginValue<T>(invoke: () => Promise<T>): Promise<T> {
    try {
      return await invoke();
    } catch (error) {
      throw this.reportPluginFailure(error);
    }
  }

  private enqueueCapture<T>(invoke: () => Promise<T>): Promise<T> {
    this.capturePending += 1;
    const queued = this.captureQueue.then(() => {
      this.throwIfDisposed();
      return invoke();
    });
    this.captureQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued.finally(() => {
      this.capturePending -= 1;
    });
  }

  private throwIfDisposed(): void {
    if (this.disposed)
      throw new ComputerBackendError(`${this.integrationName} computer backend is disposed.`);
  }

  /** The live plugin, or undefined while the connection must be re-established. */
  private connectedPlugin(): KWinComputerPluginApi | undefined {
    return this.pluginHealth?.ok === true ? this.plugin : undefined;
  }

  private recordHealthFailure(error: unknown): void {
    this.healthState.recordFailure(error);
  }

  /** Health rides the window/frame listeners, and only on a real change. */
  private publishHealth(): void {
    this.healthState.publish();
  }

  protected emit(event: Parameters<ComputerBackendEventListener>[0]): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // One observer must not prevent the remaining observers from seeing a
        // window or frame update.
      }
    }
  }

  private reportPluginFailure(error: unknown): ComputerBackendError {
    if (dbusErrorType(error) === CONTROL_RELEASED_ERROR_TYPE) {
      return new ComputerBackendError(CONTROL_RELEASED_MESSAGE, { cause: error });
    }
    // Never retryable, and deliberately not a rejectedOperation: the caller must
    // read this reason rather than the generic "aim elsewhere in the window"
    // advice a refused injection otherwise carries, because no coordinate in
    // this application would have worked.
    if (dbusErrorType(error) === SEAT_UNSUPPORTED_ERROR_TYPE) {
      return new ComputerBackendError(dbusErrorText(error), { cause: error });
    }
    // Retryable, and carrying the token the server-side guard refuses with.
    // Nothing was injected, so the caller's move is to wait and try again.
    if (dbusErrorType(error) === HUMAN_ACTIVE_ERROR_TYPE) {
      return this.humanActiveError(dbusErrorText(error), error);
    }
    if (isConnectionLevelFailure(error)) {
      this.recordHealthFailure(error);
      this.invalidateConnection();
      this.scheduleReconnect();
      this.publishHealth();
    }
    if (error instanceof ComputerBackendError) return error;
    return new ComputerBackendError(error instanceof Error ? error.message : String(error), {
      retryable: isConnectionLevelFailure(error),
      cause: error,
    });
  }
}

export function newestPluginId(ids: readonly string[]): string | undefined {
  return ids
    .map((id) => id.replace(/\.so$/, ""))
    .filter((id) => MAX_PLUGIN_ID.test(id))
    .toSorted((left, right) => pluginVersion(right) - pluginVersion(left))[0];
}

/** Separates Synara plugin ids from the rest of KWin's loaded plugin list. */
export function isSynaraPluginId(id: string): boolean {
  return MAX_PLUGIN_ID.test(id);
}

export type SynaraPluginLoadPlan =
  | { readonly kind: "keep"; readonly pluginId: string }
  | {
      /** Loaded generations to unload, the target included when it is loaded. */
      readonly kind: "replace";
      readonly unload: readonly string[];
      readonly pluginId: string;
    };

/**
 * The one healthy compositor state is exactly one loaded Synara plugin: the
 * newest generation known, loaded or installed. The plugin claims the
 * `org.synara.ComputerUse` bus name only in its constructor, so when several
 * generations are loaded the first registrant owns the name and the rest sit
 * silent — a session that once loaded an old build keeps answering with it (no
 * capture, missing methods) no matter how many newer builds are loaded after
 * it, and an explicit LoadPlugin of the newest returns `false` (already
 * loaded) while the old build keeps serving. Anything other than exactly
 * [newest] is therefore a "replace": unload every loaded generation so the
 * name is free, then load the target. Shared by the host backend's connect
 * path and the nested session's first load. `undefined` when no Synara plugin
 * exists at all, which is not recoverable here.
 */
export function resolveSynaraPluginLoad(options: {
  readonly loaded: readonly string[];
  readonly installed: readonly string[];
}): SynaraPluginLoadPlan | undefined {
  const loadedSynara = options.loaded.filter(isSynaraPluginId);
  const pluginId = newestPluginId([...loadedSynara, ...options.installed]);
  if (!pluginId) return undefined;
  if (loadedSynara.length === 1 && loadedSynara[0] === pluginId) return { kind: "keep", pluginId };
  return { kind: "replace", unload: loadedSynara, pluginId };
}

export async function scanInstalledPluginIds(
  directories: readonly string[] = defaultPluginDirectories(),
): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(INSTALLED_PLUGIN_FILE);
      if (match?.[1]) ids.add(match[1]);
    }
  }
  return [...ids].toSorted((left, right) => pluginVersion(right) - pluginVersion(left));
}

/**
 * Where the app's shipped plugin binaries live.
 *
 * Absent on a checkout that was never packaged, which is the developer case:
 * provisioning then falls through to a source build, which is what a developer
 * wants anyway.
 */
export function prebuiltPluginRoot(
  moduleDirectory: string = import.meta.dirname,
  configuredDirectory: string | undefined = process.env.SYNARA_KWIN_PREBUILT_DIR,
  hasManifest: (candidate: string) => boolean = (candidate) =>
    existsSync(join(candidate, "manifest.json")),
): string | undefined {
  const candidates = [
    ...(configuredDirectory ? [resolve(configuredDirectory)] : []),
    join(moduleDirectory, "computer-use-kwin", "prebuilt"),
    join(moduleDirectory, "..", "..", "native", "computer-use-kwin", "prebuilt"),
  ];
  return candidates.find(hasManifest);
}

/**
 * Whether this machine could compile the plugin, decided by the two things a
 * source build cannot proceed without: cmake on the path, and KWin's own cmake
 * config file, which is the marker for the development headers.
 *
 * Deliberately not a build attempt, and deliberately not exhaustive — Qt, KF6,
 * ECM and ninja are all needed too. This runs inside a probe that must stay
 * free, and its only job is to tell "a machine where turning computer use on
 * will plausibly work" from "a machine with no compiler in sight". The install
 * script does the real check, with a message per missing package.
 */
export function localBuildToolingPresent(
  exists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!KWIN_CMAKE_CONFIG_PATHS.some((path) => exists(path))) return false;
  return (env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .some((directory) => exists(join(directory, "cmake")));
}

async function listPluginFiles(directories: readonly string[]): Promise<readonly string[]> {
  const listings = await Promise.all(
    directories.map((directory) => readdir(directory).catch(() => [] as string[])),
  );
  return listings.flat();
}

/**
 * Builds the plugin against the local KWin headers and resolves the built `.so`.
 *
 * The build itself lives in the installer script rather than here so there is
 * exactly one of it; `--build-only` is that script with its install, load, and
 * stamp steps removed, and it prints the path as its last line.
 */
async function buildPluginFromSource(): Promise<string> {
  const script = resolveInstallScriptPath(import.meta.dirname);
  const { stdout } = await execFileAsync("bash", [script, "--build-only"], {
    timeout: PLUGIN_BUILD_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  const path = stdout.trimEnd().split("\n").at(-1)?.trim();
  if (!path) throw new ComputerBackendError(`${INSTALL_SCRIPT_PATH} --build-only printed no path.`);
  return path;
}

/**
 * The installer script on disk, bundled beside this module in a packaged build
 * and up in `native/` in a checkout.
 */
export function resolveInstallScriptPath(
  moduleDirectory: string,
  configuredDirectory: string | undefined = process.env.SYNARA_KWIN_SOURCE_DIR,
  sourceExists: (candidate: string) => boolean = existsSync,
): string {
  const relative = join("scripts", "install-and-load.sh");
  const candidates = [
    ...(configuredDirectory ? [join(resolve(configuredDirectory), relative)] : []),
    join(moduleDirectory, "computer-use-kwin", relative),
  ];
  return (
    candidates.find(sourceExists) ??
    join(moduleDirectory, "..", "..", "native", "computer-use-kwin", relative)
  );
}

export const SYSTEM_QT_PLUGIN_ROOTS = ["/usr/lib64/qt6/plugins", "/usr/lib/qt6/plugins"] as const;

export function defaultPluginDirectories(): readonly string[] {
  const configured = process.env.SYNARA_KWIN_PLUGIN_DIR;
  return [
    ...(configured ? [configured] : []),
    // Listed first among the unconfigured directories because it is where
    // provisioning installs, and a user-owned build is by definition newer than
    // whatever a package once dropped in /usr.
    resolveInstallTarget(SYSTEM_QT_PLUGIN_ROOTS).pluginDirectory,
    ...SYSTEM_QT_PLUGIN_ROOTS.map((root) => join(root, "kwin", "plugins")),
  ];
}

/** Mirrors `STATE_ROOT`/`STAMP_FILE` in scripts/install-and-load.sh. */
function defaultInstallStampPath(): string {
  const stateRoot =
    process.env.SYNARA_KWIN_STATE_ROOT ??
    join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "synara",
      "kwin-computer-use-plugin",
    );
  return join(stateRoot, "install.stamp");
}

async function readInstallStamp(path: string): Promise<string | undefined> {
  return await readFile(path, "utf8").catch(() => undefined);
}

/** Reads the `kwin_version=` line the installer records for the built plugin. */
function stampKwinVersion(stamp: string | undefined): string | undefined {
  const line = stamp?.split("\n").find((entry) => entry.startsWith("kwin_version="));
  return line ? (KWIN_VERSION_PATTERN.exec(line)?.[0] ?? undefined) : undefined;
}

/** Reads the `plugin_id=` line both installers record. */
function stampPluginId(stamp: string | undefined): string | undefined {
  const line = stamp
    ?.split("\n")
    .find((entry) => entry.startsWith("plugin_id="))
    ?.slice("plugin_id=".length)
    .trim();
  return line || undefined;
}

/**
 * Whether the install stamp describes a plugin this machine still has and the
 * running KWin can still load.
 *
 * The stamped file must exist - a deleted plugin is not current - and the KWin
 * version it was built for must match the running compositor when both are
 * readable. That mismatch check is what lets provisioning produce a fresh
 * candidate after a KWin upgrade instead of answering "already current" about
 * an install KWin now refuses; a half-known pair stays current, because an
 * unreadable version is not evidence of anything.
 */
export function installStampIsCurrent(
  stamp: string | undefined,
  installedFiles: readonly string[],
  runningKwinVersion: string | undefined,
): boolean {
  const pluginId = stampPluginId(stamp);
  if (!pluginId) return false;
  if (!installedFiles.includes(`${pluginId}.so`)) return false;
  const builtFor = stampKwinVersion(stamp);
  if (builtFor && runningKwinVersion && builtFor !== runningKwinVersion) return false;
  return true;
}

/**
 * `kwin_wayland --version` prints `kwin <version>` and exits, and it is only
 * spawned on the cold load-refusal path, so a missing or exotic binary just
 * costs the caller the version detail.
 */
function detectRunningKwinVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "kwin_wayland",
      ["--version"],
      { timeout: KWIN_VERSION_PROBE_TIMEOUT_MS },
      (error, stdout) => {
        resolve(error ? undefined : (KWIN_VERSION_PATTERN.exec(stdout)?.[0] ?? undefined));
      },
    );
  });
}

function pluginVersion(id: string): number {
  const match = id.match(MAX_PLUGIN_ID);
  return match?.[1] ? Number(match[1]) : 0;
}

function launchAppError(app: string, error: unknown): ComputerBackendError {
  const message = error instanceof Error ? error.message : String(error);
  return new ComputerBackendError(`Failed to launch ${app}: ${message}`, { cause: error });
}

const CONNECTION_DBUS_ERROR_TYPES = new Set([
  "org.freedesktop.DBus.Error.NoReply",
  "org.freedesktop.DBus.Error.Disconnected",
  "org.freedesktop.DBus.Error.IOError",
  "org.freedesktop.DBus.Error.Timeout",
  // A KWin crash does not drop this backend's session-bus connection — only
  // KWin's bus names vanish, so calls to the stale proxy fail with these two
  // instead of a disconnect. The remedy is the connection-level one: drop the
  // proxy, reconnect, and re-load the plugin into the restarted compositor.
  "org.freedesktop.DBus.Error.ServiceUnknown",
  "org.freedesktop.DBus.Error.NameHasNoOwner",
]);

function isDormantBackendError(error: unknown): boolean {
  return error instanceof ComputerBackendError && error.dormant;
}

/**
 * The well-known service name arriving from the wrong process.
 *
 * Method-level on purpose: a retry inside `connectWithBackoff` would re-read
 * the (now stale) loaded list, take the "keep" path, and connect straight to
 * the owner this check exists to refuse — so it must propagate out of the
 * attempt instead. The next explicit action starts a fresh connect that
 * re-checks ownership from scratch.
 */
class ServiceOwnerMismatchError extends ComputerBackendError {
  readonly type = "org.synara.ComputerUse.Error.ServiceOwnerMismatch";

  constructor(message: string) {
    super(message);
    this.name = "ServiceOwnerMismatchError";
  }
}

export function assertServiceOwnerPresent(owner: string | undefined): void {
  if (owner !== undefined) return;
  throw new ServiceOwnerMismatchError(
    `Nothing owns ${COMPUTER_SERVICE} on the session bus even though KWin reports a Synara plugin loaded, ` +
      "so no computer-use plugin is answering. Retrying may help; if this persists, another process may be interfering with the session bus.",
  );
}

export function assertFreshServiceOwner(
  owner: string | undefined,
  previous: string | undefined,
): void {
  if (previous === undefined) {
    assertServiceOwnerPresent(owner);
    return;
  }
  if (owner === undefined) {
    throw new ServiceOwnerMismatchError(
      `Nobody owns ${COMPUTER_SERVICE} after LoadPlugin succeeded, so the plugin that was just loaded did not register its service.`,
    );
  }
  if (owner === previous) {
    throw new ServiceOwnerMismatchError(
      `${COMPUTER_SERVICE} is still owned by ${previous}, its holder from before this server loaded a new plugin generation. ` +
        "Connecting anyway would drive whichever process answered first rather than the one just loaded, so it was refused.",
    );
  }
}

function isMethodLevelDbusError(error: unknown): boolean {
  const type = dbusErrorType(error);
  if (type?.startsWith("org.synara.ComputerUse.Error.")) return true;
  if (type?.startsWith("org.freedesktop.DBus.Error.")) {
    return !CONNECTION_DBUS_ERROR_TYPES.has(type);
  }
  const cause = errorCause(error);
  return cause !== undefined && cause !== error ? isMethodLevelDbusError(cause) : false;
}

function isUnknownMethodDbusError(error: unknown): boolean {
  if (dbusErrorType(error) === "org.freedesktop.DBus.Error.UnknownMethod") return true;
  const cause = errorCause(error);
  return cause !== undefined && cause !== error ? isUnknownMethodDbusError(cause) : false;
}

function isConnectionLevelFailure(error: unknown): boolean {
  if (error instanceof KWinDbusTimeoutError || hasConnectionLevelMarker(error)) return true;
  if (isMethodLevelDbusError(error)) return false;

  const type = dbusErrorType(error);
  if (type && CONNECTION_DBUS_ERROR_TYPES.has(type)) return true;

  const code = errorField(error, "code");
  if (code === "ENOENT" || code === "ECONNRESET" || code === "EPIPE") return true;

  const message = error instanceof Error ? error.message : String(error);
  if (/(?:closed|disconnected|not connected).*(?:bus|stream|socket|connection)/i.test(message))
    return true;
  if (
    /(?:bus|stream|socket|connection).*(?:closed|disconnected|not connected|reset|refused)/i.test(
      message,
    )
  )
    return true;
  if (/\b(?:ENOENT|ECONNRESET|EPIPE)\b/i.test(message)) return true;

  const cause = errorCause(error);
  if (cause !== undefined && cause !== error) return isConnectionLevelFailure(cause);
  if (error instanceof ComputerBackendError) return error.retryable;
  return true;
}

function dbusErrorType(error: unknown): string | undefined {
  const type = errorField(error, "type");
  if (typeof type === "string") return type;
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/org\.(?:synara\.ComputerUse|freedesktop\.DBus)\.Error\.[\w.]+/)?.[0];
}

/** The `text` a D-Bus error reply carried, which dbus-next also uses as its message. */
function dbusErrorText(error: unknown): string {
  const text = errorField(error, "text");
  if (typeof text === "string" && text.length > 0) return text;
  return error instanceof Error ? error.message : String(error);
}

function errorCause(error: unknown): unknown {
  return errorField(error, "cause");
}

function errorField(error: unknown, field: string): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

function hasConnectionLevelMarker(error: unknown): boolean {
  return errorField(error, "connectionLevel") === true;
}

function parseHealth(value: unknown): KWinHealth {
  const record = asRecord(parseJsonPayload(value));
  return {
    ok: record.ok === true,
    running: record.running === true,
    capture: record.capture === true,
    releasedByUser: record.releasedByUser === true,
    workspace: parseWorkspaceGeometry(record),
  };
}

function parseWorkspaceGeometry(record: Record<string, unknown>): ComputerRect | null {
  const workspace = asRecord(record.workspace);
  return (
    parseComputerRect(record.workspaceGeometry) ??
    parseComputerRect(record.workspace) ??
    parseComputerRect(workspace.geometry) ??
    parseComputerRect(workspace.bounds) ??
    null
  );
}

/**
 * The plugin's window document as an opaque change key. It arrives as a string
 * on the wire, so in the normal case this costs nothing at all.
 */
function windowsPayloadFingerprint(payload: unknown): string {
  const unwrapped = unwrapDbusValue(payload);
  return typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped);
}

function readBoolean(value: unknown): boolean {
  const unwrapped = unwrapDbusValue(value);
  return unwrapped === true;
}

function readByteArray(value: unknown): Uint8Array {
  const unwrapped = unwrapDbusValue(value);
  if (unwrapped instanceof Uint8Array) {
    if (unwrapped.byteLength === 0 || unwrapped.byteLength > MAX_CAPTURE_BYTES) {
      throw new ComputerBackendError("Synara computer capture exceeded the PNG size limit.");
    }
    // A view, not a copy: this is a whole screenshot, the D-Bus message owns the
    // bytes and is discarded right after, and the only thing this conversion is
    // for is turning a Node Buffer into a plain Uint8Array.
    return new Uint8Array(unwrapped.buffer, unwrapped.byteOffset, unwrapped.byteLength);
  }
  if (
    Array.isArray(unwrapped) &&
    unwrapped.length > 0 &&
    unwrapped.length <= MAX_CAPTURE_BYTES &&
    unwrapped.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return Uint8Array.from(unwrapped as number[]);
  }
  throw new ComputerBackendError("Synara computer capture returned invalid PNG bytes.");
}

/**
 * `SYNARA_COMPUTER_HUMAN_ACTIVE_MS` is an operator override, read the same way
 * the idle timeout is: `0` turns the guard off on purpose, anything that is not
 * a millisecond count inside the plugin's own range is a typo and is dropped so
 * the default applies. A malformed value must never be the reason the agent
 * starts typing into a window someone is working in.
 */
function parseHumanActiveGuardEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const milliseconds = Number(value);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > MAX_HUMAN_ACTIVE_GUARD_MS
  ) {
    return undefined;
  }
  return milliseconds;
}

function normalizeHumanActiveGuard(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_HUMAN_ACTIVE_THRESHOLD_MS;
  const milliseconds = Math.floor(value);
  if (milliseconds <= 0) return 0;
  return Math.max(MIN_HUMAN_ACTIVE_GUARD_MS, Math.min(MAX_HUMAN_ACTIVE_GUARD_MS, milliseconds));
}

/**
 * `SYNARA_COMPUTER_IDLE_TIMEOUT_MS` is an operator override, so a typo must
 * neither crash the backend nor silently disable the plugin-side deadline:
 * anything that is not `0` or a millisecond count up to an hour is dropped and
 * the default applies. Accepted values still pass through normalizeIdleTimeout.
 */
function parseIdleTimeoutEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_IDLE_TIMEOUT_MS) {
    return undefined;
  }
  return milliseconds;
}

function normalizeIdleTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_IDLE_TIMEOUT_MS;
  const milliseconds = Math.floor(value);
  if (milliseconds <= 0) return 0;
  return Math.max(MIN_IDLE_TIMEOUT_MS, Math.min(MAX_IDLE_TIMEOUT_MS, milliseconds));
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CAPTURE_MAX_DIMENSION;
  return Math.max(1, Math.min(32_768, Math.floor(value)));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
