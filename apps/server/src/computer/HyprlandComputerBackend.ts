/**
 * Tier 1 on a Hyprland desktop: the agent drives the human's **real** desktop
 * — real apps, real files, the same session — with a dedicated seat of its
 * own. The Synara Hyprland plugin draws the agent's ghost cursor and injects
 * input directly on target clients' own wl_pointer/wl_keyboard resources; the
 * human's cursor, focus, and seat state are never touched.
 *
 * Everything below the plugin-management layer is `KWinComputerBackend`: the
 * plugin speaks the identical `org.synara.ComputerUse` D-Bus surface, so this
 * class only swaps in what actually differs, through the same option seams the
 * nested backend established —
 *
 * - plugins are managed with `hyprctl` by path instead of KWin's D-Bus plugin
 *   manager (`hyprlandPluginHost.ts`),
 * - installs go to a user-owned data directory and load live, with no env
 *   script and never a relogin (`hyprlandPluginProvisioning.ts`),
 * - availability is gated on a live Hyprland session (instance signature plus
 *   its runtime socket), not on `org.kde.KWin` having a bus owner.
 *
 * The release hotkey story is KWin's: the plugin binds the same Meta+Shift+Esc
 * chord, and `visibleDesktop` stays true, so the panel advertises it.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { COMPUTER_HYPRLAND_BACKEND, type ComputerAvailability } from "@synara/contracts";

import {
  detectRunningHyprlandVersion,
  hyprlandSessionPresent,
  makeHyprctlRunner,
  type HyprctlRunner,
} from "./hyprctl.ts";
import {
  createSessionHyprlandComputerDbus,
  type HyprlandComputerDbus,
} from "./hyprlandPluginHost.ts";
import {
  buildHyprlandPluginFromSource,
  HYPRLAND_INSTALL_SCRIPT_PATH,
  hyprlandBuildToolingPresent,
  hyprlandInstallStampPath,
  hyprlandPluginDirectory,
  hyprlandPrebuiltRoot,
  provisionHyprlandPlugin,
  readHyprlandPrebuiltManifest,
  selectHyprlandPrebuilt,
} from "./hyprlandPluginProvisioning.ts";
import { KWinComputerBackend, type KWinComputerBackendOptions } from "./KWinComputerBackend.ts";
import { COMPUTER_SERVICE } from "./kwinDbus.ts";
import { sessionBusNameHasOwner } from "./sessionBusNames.ts";

const NO_HYPRLAND_MESSAGE =
  "No Hyprland session is running (no instance signature with a live socket), " +
  "so there is no Hyprland desktop to drive.";
const NO_PLUGIN_ANYWHERE_MESSAGE =
  "Hyprland is running, but this machine has no Synara computer-use plugin: none is installed, " +
  "none of the bundled builds matches the running Hyprland, and the compiler and Hyprland " +
  "development headers needed to build one are not present. Install them, or build the plugin " +
  `with ${HYPRLAND_INSTALL_SCRIPT_PATH}.`;

export interface HyprlandComputerBackendOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: string;
  /** An explicit compositor instance, for driving the dev-test nested one. */
  readonly signature?: string;
  readonly runHyprctl?: HyprctlRunner;
  /** Live-session check, replaced in tests to avoid touching the host. */
  readonly sessionPresent?: () => boolean;
  readonly pluginDirectory?: string;
  readonly installStampPath?: string;
  readonly buildToolingPresent?: () => boolean;
  readonly prebuiltRoot?: () => string | undefined;
  /** Whether a name is owned on the ambient session bus; the passive probe. */
  readonly busNameHasOwner?: (name: string) => Promise<boolean>;
  readonly provisionPlugin?: KWinComputerBackendOptions["provisionPlugin"];
  readonly dbusFactory?: KWinComputerBackendOptions["dbusFactory"];
  readonly atspi?: KWinComputerBackendOptions["atspi"];
}

/** Mutable box shared with the closures handed to the base constructor. */
interface HyprlandDbusRef {
  dbus: HyprlandComputerDbus | undefined;
}

export class HyprlandComputerBackend extends KWinComputerBackend {
  private readonly ref: HyprlandDbusRef;
  private readonly hyprlandPlatform: string;
  private readonly sessionPresent: () => boolean;
  private readonly hyprlandBusNameHasOwner: (name: string) => Promise<boolean>;
  private readonly pluginDirectory: string;
  private readonly hyprlandPrebuiltRootFn: () => string | undefined;
  private readonly hyprlandBuildToolingPresent: () => boolean;
  private readonly probeHyprlandVersion: () => Promise<string | undefined>;

  constructor(options: HyprlandComputerBackendOptions = {}) {
    const ref: HyprlandDbusRef = { dbus: undefined };
    const env = options.env ?? process.env;
    const pluginDirectory = options.pluginDirectory ?? hyprlandPluginDirectory(env);
    const installStampPath = options.installStampPath ?? hyprlandInstallStampPath(env);
    const runHyprctl =
      options.runHyprctl ??
      makeHyprctlRunner(options.signature ? { signature: options.signature } : {});
    // Memoized like the base's KWin probe: the compositor cannot change under
    // a live session, and this runs inside connect retries.
    let versionPromise: Promise<string | undefined> | undefined;
    const hyprlandVersion = () => (versionPromise ??= detectRunningHyprlandVersion(runHyprctl));
    const prebuiltRoot = options.prebuiltRoot ?? (() => hyprlandPrebuiltRoot());
    const innerDbusFactory =
      options.dbusFactory ??
      (async () =>
        createSessionHyprlandComputerDbus({
          pluginDirectory,
          ...(options.signature ? { signature: options.signature } : {}),
          runHyprctl,
        }));
    super({
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.atspi ? { atspi: options.atspi } : {}),
      integrationName: "Hyprland",
      installHint: HYPRLAND_INSTALL_SCRIPT_PATH,
      // A live Hyprland instance is a Wayland session by construction, even
      // when this server was started from a tty that predates it; the gate
      // that matters is the session-presence check in the overrides below.
      sessionType: "wayland",
      pluginDirectories: [pluginDirectory],
      installStampPath,
      runningKwinVersion: hyprlandVersion,
      // hyprctl loads by absolute path into the live compositor; there is no
      // session-start search path a relogin would be needed for.
      compositorSeesPluginRoot: () => true,
      // The base clears its own reference on every reconnect and calls the
      // factory fresh; the ref-box keeps the newest adapter reachable so
      // `describeLoadRefusal` can quote Hyprland's actual refusal text.
      dbusFactory: async (context) => {
        const dbus = await innerDbusFactory(context);
        ref.dbus = "lastLoadRefusal" in dbus ? (dbus as HyprlandComputerDbus) : undefined;
        return dbus;
      },
      provisionPlugin:
        options.provisionPlugin ??
        (({ allowPrebuilt }) =>
          provisionHyprlandPlugin({
            pluginDirectory,
            listInstalled: () => readdir(pluginDirectory).catch(() => [] as string[]),
            hyprlandVersion,
            arch: process.arch,
            prebuiltRoot: allowPrebuilt ? prebuiltRoot() : undefined,
            buildFromSource: buildHyprlandPluginFromSource,
            stampPath: installStampPath,
          })),
    });
    this.ref = ref;
    this.hyprlandPlatform = options.platform ?? process.platform;
    this.sessionPresent = options.sessionPresent ?? (() => hyprlandSessionPresent(env));
    this.hyprlandBusNameHasOwner =
      options.busNameHasOwner ?? ((name) => sessionBusNameHasOwner(name));
    this.pluginDirectory = pluginDirectory;
    this.hyprlandPrebuiltRootFn = prebuiltRoot;
    this.hyprlandBuildToolingPresent = options.buildToolingPresent ?? hyprlandBuildToolingPresent;
    this.probeHyprlandVersion = hyprlandVersion;
  }

  /**
   * "Could this machine drive Hyprland?", answered without touching the
   * compositor beyond a version read — same contract and same four ways to be
   * available as the KWin probe: a plugin is answering on the bus, installed
   * on disk, shipped for exactly this Hyprland, or buildable here.
   */
  override async probeAvailability(): Promise<ComputerAvailability> {
    if (this.hyprlandPlatform !== "linux") {
      return { kind: "unsupported-platform", platform: this.hyprlandPlatform };
    }
    if (!this.sessionPresent()) {
      return { kind: "backend-unavailable", message: NO_HYPRLAND_MESSAGE };
    }
    if (await this.hyprlandBusNameHasOwner(COMPUTER_SERVICE).catch(() => false)) {
      return this.availableAsHyprland();
    }
    if ((await this.installedHyprlandPluginFiles()).length > 0) return this.availableAsHyprland();
    if (await this.hasMatchingHyprlandPrebuilt()) return this.availableAsHyprland();
    try {
      if (this.hyprlandBuildToolingPresent()) return this.availableAsHyprland();
    } catch {
      // An unanswerable question is a "no", not an error.
    }
    return { kind: "backend-unavailable", message: NO_PLUGIN_ANYWHERE_MESSAGE };
  }

  /** The establishing read, with the backend named as what it actually is. */
  override async availability(): Promise<ComputerAvailability> {
    if (this.hyprlandPlatform === "linux" && !this.sessionPresent()) {
      return { kind: "backend-unavailable", message: NO_HYPRLAND_MESSAGE };
    }
    const availability = await super.availability();
    return availability.kind === "available" ? this.availableAsHyprland() : availability;
  }

  /**
   * Unlike KWin's wordless `false`, `hyprctl plugin load` names its reason —
   * an ABI mismatch, a missing symbol — so the refusal message leads with
   * Hyprland's own words when the adapter captured them.
   */
  protected override async describeLoadRefusal(pluginId: string): Promise<string> {
    const refusal = this.ref.dbus?.lastLoadRefusal()?.replace(/\.\s*$/, "");
    const cause =
      refusal ??
      "a Hyprland plugin only loads into the exact Hyprland version it was built against";
    return (
      `Hyprland refused to load ${pluginId}: ${cause}. ` +
      `If Hyprland was upgraded, rebuild and reload the plugin with ${HYPRLAND_INSTALL_SCRIPT_PATH}.`
    );
  }

  private availableAsHyprland(): ComputerAvailability {
    return { kind: "available", backend: COMPUTER_HYPRLAND_BACKEND };
  }

  private async installedHyprlandPluginFiles(): Promise<readonly string[]> {
    const entries = await readdir(this.pluginDirectory).catch(() => [] as string[]);
    return entries.filter((name) => /^SynaraComputerUsePluginV\d+\.so$/.test(name));
  }

  /** Whether a shipped binary was built for exactly the Hyprland running here. */
  private async hasMatchingHyprlandPrebuilt(): Promise<boolean> {
    const root = this.hyprlandPrebuiltRootFn();
    if (!root) return false;
    const [manifest, version] = await Promise.all([
      readHyprlandPrebuiltManifest(join(root, "manifest.json")).catch(() => undefined),
      this.probeHyprlandVersion().catch(() => undefined),
    ]);
    if (!manifest || !version) return false;
    return selectHyprlandPrebuilt(manifest, version, process.arch) !== undefined;
  }
}
