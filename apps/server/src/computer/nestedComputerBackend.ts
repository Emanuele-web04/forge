/**
 * The default Linux backend on every desktop that is not already KWin: the
 * KWin backend, pointed at a private nested compositor this server boots on
 * demand — headless by default, so nothing appears on the host desktop and
 * the Computer pane is the only place the agent's desktop is ever seen.
 *
 * The whole point of this class is *when* things happen, not *what* happens —
 * `KWinComputerBackend` already knows how to connect, load the plugin, and
 * drive the desktop, and it reaches the compositor through an injected
 * `dbusFactory` it only calls on first real use. This subclass makes that
 * factory boot the nested session, which gives the one-click setup story its
 * shape:
 *
 * - Construction and `probeAvailability()` touch nothing. No compositor window
 *   appears because a server started.
 * - First real use boots the session, compiling and installing the plugin into
 *   the user's home directory first if it is missing. All of that is
 *   user-space and silent.
 * - `provision()` — the settings panel's "Set up" button — is the only place a
 *   system package install happens, because that is the only step that raises
 *   the desktop's polkit authorization dialog, and a dialog nobody asked for
 *   is a phishing lesson. It installs `kwin` and the plugin's build
 *   dependencies in one authorization, provisions the plugin, and boots the
 *   session so the card can say the desktop is running.
 *
 * A nested compositor that dies is not restarted behind anyone's back. In the
 * windowed debug mode the desktop is an ordinary window of the host session,
 * so "it died" is usually "the human closed it", and a window that respawns on
 * a supervision timer is a haunting; headless mode has no window to close, but
 * a compositor that just crashed could crash again, and a respawn loop nobody
 * asked for is the same haunting without the visuals. Either way the dead
 * session is reaped, the reconnect loop is told the desktop is dormant and
 * stands down, and the next *real* use — an agent action, a pane attach, the
 * settings panel's Refresh or Set up — boots a fresh session, exactly like
 * first use did.
 */
import type { ComputerAvailability, ComputerCapabilities } from "@synara/contracts";
import { COMPUTER_NESTED_KWIN_BACKEND } from "@synara/contracts";
import { readdirSync } from "node:fs";

import { NO_COMPUTER_CAPABILITIES, ComputerBackendError } from "./ComputerBackend.ts";
import { AtspiHelperClient, type AtspiTreeReader } from "./atspiClient.ts";
import {
  KWinComputerBackend,
  defaultPluginDirectories,
  localBuildToolingPresent,
  prebuiltPluginRoot,
  scanInstalledPluginIds,
  type KWinComputerBackendOptions,
  type KWinDbusConnectContext,
} from "./KWinComputerBackend.ts";
import { createSessionKWinComputerDbus, type KWinComputerDbus } from "./kwinDbus.ts";
import {
  nestedClipboardRunner,
  nestedSessionEnv,
  nestedSpawnProcess,
  startNestedKWinSession,
  unavailableAtspiReader,
  type NestedAtspiMode,
  type NestedKWinSession,
  type NestedKWinSessionOptions,
  type NestedSessionMode,
  type NestedSize,
} from "./nestedKWinSession.ts";
import {
  commandOnPath,
  installSystemPackages,
  planSystemPackageInstall,
  type SystemPackagePlan,
} from "./provisioning/systemPackages.ts";

const KWIN_COMMAND = "kwin_wayland";
const INSTALLED_PLUGIN_FILE = /^SynaraComputerUsePluginV\d+\.so$/;
/**
 * Only the windowed mode blames a closed window: the headless desktop has no
 * window anyone could have closed, so naming one would send the user hunting
 * for something that never existed.
 */
function desktopDormantMessage(mode: NestedSessionMode): string {
  const restart =
    "It starts again the next time an agent uses the computer, or click Refresh to start it now.";
  return mode === "window"
    ? `The agent's isolated desktop is not running — its window may have been closed. ${restart}`
    : `The agent's isolated desktop is not running. ${restart}`;
}
const NO_WAYLAND_HOST_MESSAGE =
  "The agent's isolated desktop runs as a window of your Wayland session, and WAYLAND_DISPLAY " +
  "is not set for this server. Start Synara from inside the desktop session, or set " +
  "SYNARA_COMPUTER_NESTED=1 for a headless virtual desktop.";

export interface NestedComputerBackendOptions {
  /** `virtual` (the default) is headless; `window` nests into the host session. */
  readonly mode?: NestedSessionMode;
  readonly size?: NestedSize;
  readonly atspiMode?: NestedAtspiMode;
  /**
   * Builds the AT-SPI client for one nested session's environment. A test
   * seam: the default spawns the Python helper against that session's bus.
   */
  readonly createAtspiClient?: (env: NodeJS.ProcessEnv) => AtspiTreeReader;
  readonly platform?: string;
  /** The server's own environment, injected so tests do not read the host display. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** Replaced in tests, which must never boot a compositor. */
  readonly startSession?: (options: NestedKWinSessionOptions) => Promise<NestedKWinSession>;
  readonly connectDbus?: (busAddress: string) => Promise<KWinComputerDbus>;
  /** Whether a binary resolves on PATH; the passive setup check. */
  readonly hasCommand?: (command: string) => boolean;
  /** Synchronous installed-plugin check for `capabilities()`. */
  readonly installedPluginPresent?: () => boolean;
  /** Installed-plugin scan, shared with the base class's connect path. */
  readonly installedPluginIds?: () => Promise<readonly string[]>;
  /** Plugin installer, forwarded to the KWin backend; a test seam. */
  readonly provisionPlugin?: KWinComputerBackendOptions["provisionPlugin"];
  readonly buildToolingPresent?: () => boolean;
  readonly prebuiltRoot?: () => string | undefined;
  readonly planPackages?: () => SystemPackagePlan | undefined;
  readonly installPackages?: (plan: SystemPackagePlan) => Promise<string>;
}

/** Mutable box shared with the closures handed to the base constructor. */
interface NestedSessionRef {
  session: NestedKWinSession | undefined;
  backend: NestedComputerBackend | undefined;
}

export class NestedComputerBackend extends KWinComputerBackend {
  private readonly ref: NestedSessionRef;
  private readonly mode: NestedSessionMode;
  private readonly size: NestedSize | undefined;
  private readonly nestedPlatform: string;
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly startSession: (options: NestedKWinSessionOptions) => Promise<NestedKWinSession>;
  private readonly connectDbus: (busAddress: string) => Promise<KWinComputerDbus>;
  private readonly hasCommand: (command: string) => boolean;
  private readonly installedPluginPresent: () => boolean;
  private readonly nestedBuildToolingPresent: () => boolean;
  private readonly nestedPrebuiltRoot: () => string | undefined;
  private readonly planPackages: () => SystemPackagePlan | undefined;
  private readonly installPackages: (plan: SystemPackagePlan) => Promise<string>;
  private readonly listInstalledPluginIds: () => Promise<readonly string[]>;
  private sessionStart: Promise<NestedKWinSession> | undefined;
  private provisionRun: Promise<string> | undefined;

  constructor(options: NestedComputerBackendOptions = {}) {
    const ref: NestedSessionRef = { session: undefined, backend: undefined };
    const hostEnv = options.hostEnv ?? process.env;
    const installedPluginIds = options.installedPluginIds ?? (() => scanInstalledPluginIds());
    super({
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.provisionPlugin ? { provisionPlugin: options.provisionPlugin } : {}),
      installedPluginIds,
      // The nested compositor is a Wayland session even when this server was
      // started from a tty or with no session at all; the base class must not
      // gate on the ambient session type.
      sessionType: "wayland",
      // Offscreen or a window either way: the Computer pane is the agent's
      // desktop, and the release hotkey does not exist here.
      visibleDesktop: false,
      // The private bus is born owned by a compositor this process started;
      // the ambient session bus knows nothing about it.
      busNameHasOwner: async () => true,
      // The compositor here is spawned with the plugin root already on its
      // QT_PLUGIN_PATH, so a fresh install loads without anyone logging out;
      // the default check reads the server's session environment and would
      // tell the user to relogin a session this plugin never loads into.
      compositorSeesPluginRoot: () => true,
      dbusFactory: (context) => requireBackend(ref).connectToNestedSession(context),
      spawnProcess: (app, args) => nestedSpawnProcess(runningSessionEnv(ref))(app, args),
      runClipboardCommand: (spec) => nestedClipboardRunner(runningSessionEnv(ref))(spec),
      atspi: nestedAtspi(
        options.atspiMode ?? "off",
        ref,
        options.createAtspiClient ?? ((env) => new AtspiHelperClient({ env })),
      ),
    });
    ref.backend = this;
    this.ref = ref;
    // Headless is the default and the acceptance bar: an agent using the
    // computer must never pop a window onto the host desktop. The windowed
    // mode stays reachable (`SYNARA_COMPUTER_NESTED=window`) for debugging a
    // compositor you want to see directly.
    this.mode = options.mode ?? "virtual";
    this.size = options.size;
    this.nestedPlatform = options.platform ?? process.platform;
    this.hostEnv = hostEnv;
    this.startSession = options.startSession ?? startNestedKWinSession;
    this.connectDbus =
      options.connectDbus ?? ((busAddress) => createSessionKWinComputerDbus({ busAddress }));
    this.hasCommand = options.hasCommand ?? ((command) => commandOnPath(command, hostEnv));
    this.installedPluginPresent = options.installedPluginPresent ?? anyPluginFileInstalled;
    this.nestedBuildToolingPresent = options.buildToolingPresent ?? localBuildToolingPresent;
    this.nestedPrebuiltRoot = options.prebuiltRoot ?? prebuiltPluginRoot;
    this.planPackages = options.planPackages ?? (() => planSystemPackageInstall());
    this.installPackages = options.installPackages ?? installSystemPackages;
    this.listInstalledPluginIds = installedPluginIds;
  }

  /**
   * Passive and optimistic, per the `probeAvailability` contract: nothing is
   * booted or installed, and a machine that merely *could* be set up answers
   * "available" so the settings panel gets the chance to offer Set up. The one
   * hard refusal is a windowed session with no Wayland host to nest into,
   * because no amount of provisioning conjures a display this server was not
   * started inside.
   */
  override async probeAvailability(): Promise<ComputerAvailability> {
    if (this.nestedPlatform !== "linux") {
      return { kind: "unsupported-platform", platform: this.nestedPlatform };
    }
    if (this.mode === "window" && !this.hostEnv.WAYLAND_DISPLAY) {
      return { kind: "backend-unavailable", message: NO_WAYLAND_HOST_MESSAGE };
    }
    return { kind: "available", backend: COMPUTER_NESTED_KWIN_BACKEND };
  }

  /** The establishing read, with the backend named as what it actually is. */
  override async availability(): Promise<ComputerAvailability> {
    const availability = await super.availability();
    return availability.kind === "available"
      ? { kind: "available", backend: COMPUTER_NESTED_KWIN_BACKEND }
      : availability;
  }

  /**
   * All-or-nothing on purpose. Before setup the settings card must offer Set
   * up, and `needsSetup` keys off missing capabilities; after setup — or with
   * the session already running — the full KWin capability set is the truth,
   * and reporting it before first engage is what lets ordinary first use boot
   * the session lazily instead of routing everyone through the settings panel
   * again.
   */
  override capabilities(): ComputerCapabilities {
    if (this.ref.session) return super.capabilities();
    if (this.hasCommand(KWIN_COMMAND) && this.installedPluginPresent()) {
      return super.capabilities();
    }
    return NO_COMPUTER_CAPABILITIES;
  }

  /**
   * The settings panel's Set up button, and the only path that may raise the
   * polkit authorization dialog. Single-flight while running so a double click
   * cannot race two package installs; a failed run clears so the next click
   * retries.
   */
  override async provision(): Promise<string> {
    this.provisionRun ??= this.runProvision().finally(() => {
      this.provisionRun = undefined;
    });
    return await this.provisionRun;
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    const session = this.ref.session;
    this.ref.session = undefined;
    await session?.dispose();
  }

  private async runProvision(): Promise<string> {
    const steps: string[] = [];
    if (this.needsSystemPackages()) {
      const plan = this.planPackages();
      if (!plan) {
        throw new ComputerBackendError(
          `No supported package manager was found, so Synara cannot install ${KWIN_COMMAND}. ` +
            "Install your distribution's kwin package and the plugin build tools " +
            "(cmake, extra-cmake-modules, a C++ compiler), then click Set up again.",
        );
      }
      steps.push(await this.installPackages(plan));
    }
    if (!(await this.pluginInstalled())) {
      steps.push((await this.provisionOnce()).summary);
    }
    let availability = await this.availability();
    if (availability.kind !== "available" && this.ref.session) {
      // A session whose processes exited was already reaped and replaced on
      // the way into availability(); reaching here with a session still cached
      // means it is alive but broken — a wedged compositor, a refused plugin.
      // The user explicitly asked for a working desktop, so replace it too.
      const dead = this.ref.session;
      this.ref.session = undefined;
      await dead.dispose().catch(() => undefined);
      availability = await this.availability();
    }
    if (availability.kind !== "available") {
      throw new ComputerBackendError(
        availability.kind !== "unsupported-platform"
          ? availability.message
          : `Computer use is not supported on ${availability.platform}.`,
      );
    }
    steps.push("The agent's isolated desktop is running.");
    return steps.join(" ");
  }

  /**
   * Whether Set up has a privileged step to run. The compositor missing is the
   * clear case; missing build tooling only matters on a machine that has no
   * installed plugin and no shipped binary to fall back to.
   */
  private needsSystemPackages(): boolean {
    if (!this.hasCommand(KWIN_COMMAND)) return true;
    return (
      !this.installedPluginPresent() &&
      this.nestedPrebuiltRoot() === undefined &&
      !this.probeBuildToolingSafely()
    );
  }

  private probeBuildToolingSafely(): boolean {
    try {
      return this.nestedBuildToolingPresent();
    } catch {
      return false;
    }
  }

  private async pluginInstalled(): Promise<boolean> {
    const installed = await this.listInstalledPluginIds().catch(() => [] as readonly string[]);
    return installed.length > 0;
  }

  /** What the base class's lazy `dbusFactory` resolves to: session, then bus. */
  private async connectToNestedSession(context: KWinDbusConnectContext): Promise<KWinComputerDbus> {
    const session = await this.ensureSession(context.automatic);
    return await this.connectDbus(session.busAddress);
  }

  private async ensureSession(automatic: boolean): Promise<NestedKWinSession> {
    const current = this.ref.session;
    if (current) {
      if (current.exited() === undefined) return current;
      // In windowed mode a dead compositor is usually a window the human
      // closed; headless it simply crashed. Its bus address never comes back
      // either way; reap the session so it stops pinning dead pipes and so
      // the next boot is not mistaken for a duplicate of a live one.
      this.ref.session = undefined;
      await current.dispose().catch(() => undefined);
    }
    if (this.sessionStart) return await this.sessionStart;
    if (automatic) {
      // The reconnect loop is asking, with no user or agent behind it. Booting
      // here would respawn a window the human just closed, or crash-loop a
      // headless compositor that just died, so report dormancy — which stands
      // the loop down — and leave the boot to the next real use.
      throw new ComputerBackendError(desktopDormantMessage(this.mode), {
        dormant: true,
        retryable: true,
      });
    }
    this.sessionStart = this.bootSession().finally(() => {
      this.sessionStart = undefined;
    });
    return await this.sessionStart;
  }

  private async bootSession(): Promise<NestedKWinSession> {
    // The session loads the plugin as part of coming up, so a machine that has
    // never had one gets the silent user-space install first: a shipped binary
    // when one matches, a source build otherwise. The system packages that
    // build needs are provision()'s business, not this path's — booting must
    // never raise an authorization dialog.
    if (!(await this.pluginInstalled())) {
      await this.provisionOnce().catch((error: unknown) => {
        throw new ComputerBackendError(
          "The Synara KWin plugin is not installed and could not be built: " +
            `${error instanceof Error ? error.message : String(error)} ` +
            "Open Settings → Computer use and click Set up to install everything this needs.",
          { cause: error },
        );
      });
    }
    const session = await this.startSession({
      mode: this.mode,
      hostEnv: this.hostEnv,
      installedPluginIds: this.listInstalledPluginIds,
      ...(this.size ? { size: this.size } : {}),
    });
    this.ref.session = session;
    // The manager caches capabilities until this event: pre-setup they were
    // reported empty so the settings card offered Set up, and the running
    // session is what makes the full set true.
    this.emit({ type: "capabilities-changed", capabilities: this.capabilities() });
    return session;
  }
}

function requireBackend(ref: NestedSessionRef): NestedComputerBackend {
  // Unreachable by construction: the ref is populated immediately after
  // super() returns, and the base class only calls dbusFactory on first use.
  if (!ref.backend) throw new ComputerBackendError("Nested computer backend is not constructed.");
  return ref.backend;
}

function runningSessionEnv(ref: NestedSessionRef): NodeJS.ProcessEnv {
  if (!ref.session) {
    throw new ComputerBackendError("The agent's isolated desktop is not running.");
  }
  return nestedSessionEnv(ref.session);
}

/**
 * Session-mode AT-SPI has to wait for a session to exist, so the reader is a
 * shell that builds the real client on first use. Off remains the default —
 * see `nestedKWinSession.ts` on why a per-user registry makes "session" an
 * opt-in for hosts that actually run one on the nested bus.
 */
function nestedAtspi(
  mode: NestedAtspiMode,
  ref: NestedSessionRef,
  createClient: (env: NodeJS.ProcessEnv) => AtspiTreeReader,
): AtspiTreeReader {
  if (mode !== "session") return unavailableAtspiReader();
  // The client carries the session's private bus address in its environment,
  // so it is only as alive as the session it was made for. A compositor that
  // died and was replaced on the next real use gets a replacement client too;
  // the old one is disposed rather than left answering from a bus that is gone.
  let current:
    | { readonly session: NestedKWinSession; readonly client: AtspiTreeReader }
    | undefined;
  const ready = async (): Promise<AtspiTreeReader | undefined> => {
    const session = ref.session;
    if (current && current.session !== session) {
      const stale = current;
      current = undefined;
      await stale.client.dispose().catch(() => undefined);
    }
    if (!session) return undefined;
    current ??= { session, client: createClient(nestedSessionEnv(session)) };
    return current.client;
  };
  return {
    readTrees: async (windows) => (await (await ready())?.readTrees(windows)) ?? [],
    setText: async (write) => (await (await ready())?.setText(write)) ?? false,
    dispose: async () => {
      const stale = current;
      current = undefined;
      await stale?.client.dispose();
    },
  };
}

/** Synchronous counterpart of `scanInstalledPluginIds`, for `capabilities()`. */
function anyPluginFileInstalled(): boolean {
  return defaultPluginDirectories().some((directory) => {
    try {
      return readdirSync(directory).some((entry) => INSTALLED_PLUGIN_FILE.test(entry));
    } catch {
      return false;
    }
  });
}
