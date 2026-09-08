/**
 * A private KWin this server owns, in one of two modes.
 *
 * A nested session is a dedicated session bus plus a `kwin_wayland` on it.
 * `virtual` is the default: a headless compositor with no display of its own,
 * with the Computer pane as its only screen. `window` is a debugging opt-in:
 * the same compositor running as an ordinary Wayland client of the host, so
 * the isolated desktop is a window on a desktop KWin does not otherwise run. Nothing about the desktop backend
 * changes in either mode: the same KWin plugin loads into the private
 * compositor, and `KWinComputerBackend` reaches it through the same D-Bus
 * surface, only pointed at the private bus.
 *
 * Both modes are opt-in and neither is ever a fallback, including for each
 * other — a nested compositor standing in for a broken desktop would hand an
 * agent an invisible screen and report it as healthy, and a virtual compositor
 * standing in for a windowed one would hand the operator an isolated desktop
 * that is nowhere on screen.
 *
 * The compositor is never restarted behind anyone's back if it dies — in
 * windowed mode the desktop is an ordinary window of the host session, so "it
 * died" is usually "the human closed it", and a window that respawns on its
 * own is a haunting. The session only *reports* that its processes have ended
 * (`exited`); `NestedComputerBackend` reaps a dead session and boots a
 * replacement the next time a user or agent actually uses the desktop,
 * exactly like first use did.
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { randomBytes } from "node:crypto";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { AtspiHelperClient, type AtspiTreeReader } from "./atspiClient.ts";
import { asRecord, parseJsonPayload } from "./computerGeometry.ts";
import {
  assertFreshServiceOwner,
  assertServiceOwnerPresent,
  resolveSynaraPluginLoad,
  scanInstalledPluginIds,
  SYSTEM_QT_PLUGIN_ROOTS,
  type KWinComputerBackendOptions,
} from "./KWinComputerBackend.ts";
import { resolveInstallTarget } from "./kwinPluginProvisioning.ts";
import {
  COMPUTER_SERVICE,
  createSessionKWinComputerDbus,
  KWIN_SERVICE,
  waitForSessionBusName,
  type KWinComputerDbus,
} from "./kwinDbus.ts";
import {
  describeProcessError,
  spawnSupervisedProcess,
  startSupervisedProcess,
  type SupervisedProcess,
  type SupervisedSpawn,
} from "./supervisedProcess.ts";
import { spawnClipboardCommand, type ClipboardCommandRunner } from "./wlClipboard.ts";

const DBUS_DAEMON_COMMAND = "dbus-daemon";
const KWIN_COMMAND = "kwin_wayland";
const DEFAULT_NESTED_WIDTH = 1_920;
const DEFAULT_NESTED_HEIGHT = 1_080;
const MIN_NESTED_DIMENSION = 64;
const MAX_NESTED_DIMENSION = 16_384;
const BUS_ADDRESS_TIMEOUT_MS = 10_000;
const KWIN_READY_TIMEOUT_MS = 30_000;
const NESTED_SIZE_PATTERN = /^(\d+)x(\d+)$/i;
const INSTALL_SCRIPT_PATH = "apps/server/native/computer-use-kwin/scripts/install-and-load.sh";

export interface NestedSize {
  readonly width: number;
  readonly height: number;
}

/**
 * How the private compositor is displayed.
 *
 * `virtual` has no output a human can see, which is the point on a CI runner or
 * a headless host. `window` nests the compositor inside the host session as an
 * ordinary Wayland client, which is the only difference between the two — the
 * bus, the plugin, the seat, and the backend are identical.
 */
export type NestedSessionMode = "virtual" | "window";

export interface NestedKWinSessionOptions {
  readonly mode?: NestedSessionMode;
  readonly size?: NestedSize;
  /** Wayland socket name; generated per session so two servers cannot collide. */
  readonly socketName?: string;
  readonly readyTimeoutMs?: number;
  /** The server's own environment, injected so tests do not read the host display. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly installedPluginIds?: () => Promise<readonly string[]>;
  /** Replaced in tests, which must never spawn a compositor. */
  readonly spawnProcess?: SupervisedSpawn;
  readonly connectDbus?: (busAddress: string) => Promise<KWinComputerDbus>;
  readonly waitForBusName?: typeof waitForSessionBusName;
}

export interface NestedKWinSession {
  readonly busAddress: string;
  readonly waylandDisplay: string;
  readonly size: NestedSize;
  /** The plugin id explicitly loaded, after every shadowing id was unloaded. */
  readonly pluginId: string;
  /**
   * The nested Xwayland's display name, so X11 clients can be launched into
   * this session. Undefined only if the compositor started without one.
   */
  readonly xDisplay: string | undefined;
  /**
   * How one of the session's own processes ended, or `undefined` while both
   * still run. The session's bus address dies with them and never comes back,
   * so a non-`undefined` answer means this session is gone for good — reap it
   * and boot a new one; reconnecting to it can only fail.
   */
  readonly exited: () => string | undefined;
  readonly dispose: () => Promise<void>;
}

/**
 * Boots the private bus and compositor, then leaves exactly one Synara plugin
 * loaded in it. Rejects with a message naming the step that failed, because
 * that message is all the availability card can show an operator.
 */
export async function startNestedKWinSession(
  options: NestedKWinSessionOptions = {},
): Promise<NestedKWinSession> {
  const spawnProcess = options.spawnProcess ?? spawnSupervisedProcess;
  const connectDbus =
    options.connectDbus ?? ((busAddress: string) => createSessionKWinComputerDbus({ busAddress }));
  const waitForBusName = options.waitForBusName ?? waitForSessionBusName;
  const installedPluginIds = options.installedPluginIds ?? (() => scanInstalledPluginIds());
  const mode = options.mode ?? "virtual";
  const hostEnv = options.hostEnv ?? process.env;
  const size = normalizeNestedSize(options.size);
  const waylandDisplay = options.socketName ?? generateSocketName();
  const children: SupervisedProcess[] = [];
  const dispose = async () => {
    // Newest first: the compositor is torn down before the bus it announced
    // itself on, which keeps its exit from racing a dead bus.
    for (const child of children.toReversed()) await child.terminate();
  };

  try {
    if (mode === "window" && !hostEnv.WAYLAND_DISPLAY) {
      throw new ComputerBackendError(
        "A windowed nested session needs a running Wayland session to nest into, and " +
          `WAYLAND_DISPLAY is not set for this server. Start Synara from the desktop session, or ` +
          "use SYNARA_COMPUTER_NESTED=1 for a headless virtual session.",
      );
    }

    const bus = start(
      spawnProcess,
      children,
      DBUS_DAEMON_COMMAND,
      ["--session", "--print-address=1", "--nofork"],
      hostEnv,
    );
    const busAddress = await bus.readFirstStdoutLine(BUS_ADDRESS_TIMEOUT_MS);
    if (!busAddress.startsWith("unix:")) {
      throw new ComputerBackendError(
        `${DBUS_DAEMON_COMMAND} printed no usable bus address for the nested session.`,
      );
    }

    const kwin = start(
      spawnProcess,
      children,
      KWIN_COMMAND,
      compositorArgs(mode, waylandDisplay, size),
      compositorEnv(busAddress, mode, hostEnv),
      // stdout is the undrained-buffer hazard; stderr stays piped because its
      // diagnostics are what a failed session's error names.
      ["ignore", "ignore", "pipe"],
    );

    const timeoutMs = options.readyTimeoutMs ?? KWIN_READY_TIMEOUT_MS;
    const ready = await waitForBusName({
      busAddress,
      name: KWIN_SERVICE,
      timeoutMs,
      abort: () => kwin.exitDiagnostic() !== undefined,
    });
    if (!ready) throw kwinNotReadyError(kwin, mode, timeoutMs);

    const dbus = await connectDbus(busAddress);
    let pluginId: string;
    let xDisplay: string | undefined;
    try {
      pluginId = await loadNestedPlugin(dbus, await installedPluginIds());
      xDisplay = await readXDisplay(dbus);
    } finally {
      await dbus.close().catch(() => undefined);
    }
    return {
      busAddress,
      waylandDisplay,
      size,
      pluginId,
      xDisplay,
      // The compositor is what the human can close; the bus daemon only dies
      // with the server or a crash. Either one ending ends the session.
      exited: () => kwin.exitDiagnostic() ?? bus.exitDiagnostic(),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error instanceof ComputerBackendError
      ? error
      : new ComputerBackendError(describeProcessError(error), {
          cause: error,
        });
  }
}

/** Environment that puts a child process inside the nested session. */
export function nestedSessionEnv(session: {
  readonly busAddress: string;
  readonly waylandDisplay: string;
  readonly xDisplay?: string | undefined;
}): NodeJS.ProcessEnv {
  return {
    WAYLAND_DISPLAY: session.waylandDisplay,
    DBUS_SESSION_BUS_ADDRESS: session.busAddress,
    // Always set, never merely omitted. A child inherits the server's own
    // environment underneath this one, so an absent key leaves the human's
    // DISPLAY in place and an X11 client opens on their screen while the agent
    // drives the nested one. Empty is a display name Xlib rejects, so a client
    // with nowhere to go fails instead of going somewhere wrong.
    DISPLAY: session.xDisplay ?? "",
    // Qt defaults to whatever platform plugin the ambient session suggests, and
    // an app that picks xcb here would never reach the nested compositor.
    QT_QPA_PLATFORM: "wayland",
  };
}

/**
 * Whether the nested session's own accessibility perception is used.
 *
 * `off` is the default because the AT-SPI registry is per-user, not per session
 * bus: without a registry inside the nested session the helper either fails or,
 * worse, reads the human's real desktop and fuses it into the nested window
 * list. Hosts that do activate a registry on the nested bus — a CI container
 * with no ambient desktop — opt back in.
 */
export type NestedAtspiMode = "off" | "session";

export interface NestedBackendOptions {
  readonly atspiMode?: NestedAtspiMode;
}

/** Backend options that bind a `KWinComputerBackend` to a nested session. */
export function nestedKWinBackendOptions(
  session: NestedKWinSession,
  options: NestedBackendOptions = {},
): KWinComputerBackendOptions {
  const env = nestedSessionEnv(session);
  return {
    busAddress: session.busAddress,
    // The nested compositor is headless: nothing the agent does there reaches
    // the human's screen, so the Computer pane is the only view onto it.
    visibleDesktop: false,
    // The nested compositor is a Wayland session even when the server was
    // started from a tty or a CI runner with no session at all, so the platform
    // gate must not read the ambient session type.
    sessionType: "wayland",
    spawnProcess: nestedSpawnProcess(env),
    runClipboardCommand: nestedClipboardRunner(env),
    atspi:
      (options.atspiMode ?? "off") === "session"
        ? new AtspiHelperClient({ env })
        : unavailableAtspiReader(),
  };
}

/**
 * Launches apps into the nested session. Mirrors the backend's own default —
 * detached and with no inherited stdio — and only adds the session environment.
 */
export function nestedSpawnProcess(
  env: NodeJS.ProcessEnv,
): (app: string, args: readonly string[]) => ChildProcess {
  return (app, args) =>
    spawn(app, [...args], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
}

/** wl-clipboard against the nested compositor's own seat rather than seat0. */
export function nestedClipboardRunner(env: NodeJS.ProcessEnv): ClipboardCommandRunner {
  return (spec) => spawnClipboardCommand(spec, env);
}

/**
 * Semantic perception turned off. Reporting no trees is what the backend
 * already handles for an application without accessibility support, so
 * coordinate actions, window listing, and capture stay fully usable.
 */
export function unavailableAtspiReader(): AtspiTreeReader {
  return {
    readTrees: async () => [],
    setText: async () => false,
    dispose: async () => undefined,
  };
}

/**
 * `SYNARA_COMPUTER_NESTED` is the only way a nested session is ever booted, and
 * it names the mode: `1` for virtual, `window` for windowed. Anything else, a
 * typo included, leaves the real desktop backend in place rather than guessing a
 * mode — booting the wrong one is either an invisible desktop or a window the
 * operator never asked for.
 */
export function nestedSessionMode(
  env: NodeJS.ProcessEnv = process.env,
): NestedSessionMode | undefined {
  switch (env.SYNARA_COMPUTER_NESTED) {
    case "1":
      return "virtual";
    case "window":
      return "window";
    default:
      return undefined;
  }
}

/** The mode as it reads in a failure message an operator has to act on. */
export function nestedModeLabel(mode: NestedSessionMode): string {
  return mode === "window" ? "windowed" : "virtual";
}

export function nestedAtspiMode(env: NodeJS.ProcessEnv = process.env): NestedAtspiMode {
  return env.SYNARA_COMPUTER_NESTED_ATSPI === "1" ? "session" : "off";
}

/**
 * `SYNARA_COMPUTER_NESTED_SIZE` is an operator override, so a typo must neither
 * crash the server nor boot a compositor of some accidental size: anything that
 * is not `WxH` within the supported range is dropped and the default applies.
 */
export function parseNestedSizeEnv(value: string | undefined): NestedSize | undefined {
  const match = value === undefined ? null : NESTED_SIZE_PATTERN.exec(value.trim());
  if (!match?.[1] || !match[2]) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!inNestedDimensionRange(width) || !inNestedDimensionRange(height)) return undefined;
  return { width, height };
}

/**
 * KWin auto-loads every installed plugin version at compositor startup, so the
 * fresh nested session almost always begins with several stale generations
 * loaded. `resolveSynaraPluginLoad` owns the unload-all-then-load-newest
 * doctrine; this only adds the nested session's error sentences.
 */
/**
 * The nested Xwayland's display name, which only the plugin can answer.
 *
 * KWin picks the number for the Xwayland it starts and publishes it by setenv
 * on itself: nothing appears on the bus and nothing usable appears in its
 * output. The plugin runs inside that process, so it reads the variable and
 * reports it. A failure here is not fatal - Wayland clients do not need it.
 */
async function readXDisplay(dbus: KWinComputerDbus): Promise<string | undefined> {
  try {
    const plugin = await dbus.connectPlugin();
    const display = asRecord(parseJsonPayload(await plugin.healthJson())).xDisplay;
    return typeof display === "string" && display.length > 0 ? display : undefined;
  } catch {
    return undefined;
  }
}

async function loadNestedPlugin(
  dbus: KWinComputerDbus,
  installed: readonly string[],
): Promise<string> {
  // Who owns the well-known name before anything is loaded, so a load that
  // leaves the previous holder in place is refused rather than driven. The
  // nested session owns its bus, so a mismatch here means an unload race
  // against this process's own previous generation.
  const ownerBefore = await dbus.nameOwner(COMPUTER_SERVICE);
  const plan = resolveSynaraPluginLoad({ loaded: await dbus.listLoadedPluginIds(), installed });
  if (!plan) {
    throw new ComputerBackendError(
      "No installed SynaraComputerUsePluginVn was found for the nested KWin session. " +
        `Build and install it with ${INSTALL_SCRIPT_PATH}.`,
    );
  }
  if (plan.kind === "replace") {
    for (const pluginId of plan.unload) await dbus.unloadPlugin(pluginId);
    if (!(await dbus.loadPlugin(plan.pluginId))) {
      throw new ComputerBackendError(
        `The nested KWin session refused to load ${plan.pluginId}: a KWin plugin only loads into ` +
          `the exact KWin version it was built against. Rebuild it with ${INSTALL_SCRIPT_PATH}.`,
      );
    }
    assertFreshServiceOwner(await dbus.nameOwner(COMPUTER_SERVICE), ownerBefore);
  } else {
    assertServiceOwnerPresent(await dbus.nameOwner(COMPUTER_SERVICE));
  }
  return plan.pluginId;
}

/** Names which of the two ways the compositor can fail to appear happened. */
function kwinNotReadyError(
  kwin: SupervisedProcess,
  mode: NestedSessionMode,
  timeoutMs: number,
): ComputerBackendError {
  const exit = kwin.exitDiagnostic();
  // The one failure every non-KDE machine hits first, so it names the package
  // instead of the errno: the nested desktop is KWin running as a window of the
  // host session, whichever compositor that session runs, and installing kwin
  // does not switch anyone's desktop.
  if (exit?.includes("ENOENT")) {
    return new ComputerBackendError(
      `${KWIN_COMMAND} is not installed, and the agent's isolated desktop is KWin running as ` +
        "a window of this session. Open Settings → Computer use and click Set up to install " +
        "it, or install the kwin package (kwin-wayland on Debian and Ubuntu) yourself; it " +
        "will not change which desktop this machine runs.",
    );
  }
  const nested = `The nested ${KWIN_COMMAND} (${nestedModeLabel(mode)} mode)`;
  return new ComputerBackendError(
    exit === undefined
      ? `${nested} did not take ${KWIN_SERVICE} within ${timeoutMs} ms.${kwin.diagnostic()}`
      : `${nested} exited before it was ready (${exit}).${kwin.diagnostic()}`,
  );
}

/** `--virtual` is the whole difference: without it the compositor nests as a client. */
function compositorArgs(
  mode: NestedSessionMode,
  socketName: string,
  size: NestedSize,
): readonly string[] {
  return [
    ...(mode === "virtual" ? ["--virtual"] : []),
    // X11 clients are one of the two families the agent's dedicated seat on the
    // human's desktop cannot reach, and this session is where they are supposed
    // to be driven instead, so it has to be able to run them at all.
    "--xwayland",
    "--no-global-shortcuts",
    "--socket",
    socketName,
    "--width",
    String(size.width),
    "--height",
    String(size.height),
  ];
}

/**
 * A virtual compositor must not inherit the ambient display: with
 * WAYLAND_DISPLAY or DISPLAY set, kwin_wayland can attach to the very session a
 * nested one exists to stay independent of. A windowed one is the exact
 * opposite — the host WAYLAND_DISPLAY is the socket it nests through, and
 * without it there is no window. DISPLAY goes in both modes, because an X11
 * attach is never what either was asked for.
 */
function compositorEnv(
  busAddress: string,
  mode: NestedSessionMode,
  hostEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...hostEnv,
    DBUS_SESSION_BUS_ADDRESS: busAddress,
    // Nobody but the agent uses this compositor, so the plugin drives its one
    // seat as an ordinary input device instead of adding a second seat nothing
    // has to bind. That is what lets Chromium, Electron, and every X11 client
    // behind Xwayland be driven here: they each keep only the first seat, and
    // here the first seat is the one being driven.
    SYNARA_COMPUTER_USE_OWNS_COMPOSITOR: "1",
    // Provisioning installs the plugin under the user's home Qt plugin root
    // and teaches the *Plasma* session about it through an env script sourced
    // at login. This compositor is spawned by the server on hosts that mostly
    // are not Plasma, so the same root has to ride the environment here or the
    // freshly installed plugin is invisible to the very KWin booted to load it.
    QT_PLUGIN_PATH: prependQtPluginRoot(hostEnv.QT_PLUGIN_PATH),
  };
  if (mode === "virtual") delete env.WAYLAND_DISPLAY;
  delete env.DISPLAY;
  return env;
}

function prependQtPluginRoot(existing: string | undefined): string {
  const root = resolveInstallTarget(SYSTEM_QT_PLUGIN_ROOTS).qtPluginRoot;
  if (!existing) return root;
  return existing.split(":").includes(root) ? existing : `${root}:${existing}`;
}

/**
 * Starts one child and registers it for disposal. Both nested processes are
 * ordinary children so a signal to the server's process group reaches them too,
 * and both are unref'd so they never keep the server alive. Dispose is what
 * reliably ends them.
 */
function start(
  spawnProcess: NonNullable<NestedKWinSessionOptions["spawnProcess"]>,
  children: SupervisedProcess[],
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  /**
   * Non-piped streams for this child. kwin_wayland's stdout is chatty and
   * nobody reads it: left piped and undrained it fills its ~64 KiB buffer and
   * blocks the compositor mid-frame while health still reports connected.
   */
  stdio?: StdioOptions,
): SupervisedProcess {
  const supervised = startSupervisedProcess({
    command,
    args,
    env,
    ...(stdio ? { stdio } : {}),
    spawnProcess,
  });
  children.push(supervised);
  return supervised;
}

function normalizeNestedSize(size: NestedSize | undefined): NestedSize {
  return {
    width: normalizeNestedDimension(size?.width, DEFAULT_NESTED_WIDTH),
    height: normalizeNestedDimension(size?.height, DEFAULT_NESTED_HEIGHT),
  };
}

function normalizeNestedDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_NESTED_DIMENSION, Math.min(MAX_NESTED_DIMENSION, Math.floor(value)));
}

function inNestedDimensionRange(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_NESTED_DIMENSION && value <= MAX_NESTED_DIMENSION;
}

/**
 * The socket lives in the shared XDG runtime directory, so the name has to be
 * unique across servers, and across restarts of this one.
 */
function generateSocketName(): string {
  return `synara-nested-${process.pid}-${randomBytes(3).toString("hex")}`;
}
