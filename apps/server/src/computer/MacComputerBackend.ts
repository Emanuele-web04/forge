import { assertDesktopOperationActive, desktopOperationSignal } from "./DesktopOperationQueue.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  COMPUTER_MAC_BACKEND,
  type ComputerAvailability,
  type ComputerBuildSignature,
  type ComputerCapabilities,
  type ComputerDeliveryVerification,
  type ComputerHealth,
  type ComputerId,
  type ComputerInputModifier,
  type ComputerLaunchAppResult,
  type ComputerPermission,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenshot,
  type ComputerScreenSize,
  type ComputerState,
  type ComputerUiNode,
  type ComputerWindow,
} from "@synara/contracts";
import {
  COMPUTER_PERMISSIONS,
  computerPermissionSetupMessage,
  computerStaleGrantAdvice,
  listComputerPermissions,
  TCC_SERVICE_NAMES,
} from "@synara/shared/computerPermissions";

import {
  clampComputerMessage,
  ComputerBackendError,
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  intersectComputerRects,
  MAX_COMPUTER_CLIPBOARD_BYTES,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBackendEventListener,
  type ComputerCaptureRequest,
  type ComputerFrameListener,
  type ComputerResolvedTarget,
  DEFAULT_COMPUTER_ID,
  assertComputerClipboardWriteFits,
} from "./ComputerBackend.ts";
import {
  alignRect,
  asFiniteNumber,
  asRecord,
  asString,
  formatRect,
  parseComputerRect,
  pointerClampResult,
  readPngDimensions,
  requireWindowBounds,
  screenSizeFromWindows,
  screenshotFromPng,
  shiftRect,
  WindowListChangeNotifier,
  windowsDigestFingerprint,
  workspaceRectFromWindows,
  parseWindows,
  windowInAgentSpace,
} from "./computerGeometry.ts";
import { ComputerHealthState } from "./computerHealthState.ts";
import { responsibleDesktopBundleId } from "./computerSetupSignal.ts";
import { resolveStillIntervalMs, StillFramePublisher } from "./stillFramePublisher.ts";
import {
  MacComputerHelperClient,
  MAC_HELPER_METHODS,
  type MacComputerHelperClientOptions,
  type MacHelperTransport,
} from "./macComputerHelperClient.ts";
import {
  MACOS_BELOW_HELPER_FLOOR_MESSAGE,
  MacComputerHelperProvisioner,
  MacHelperBuildError,
  resolveComputerHelperSourceDir,
  type ProcessRunResult,
} from "./macComputerHelperProvisioning.ts";
import { parseMacUiForest } from "./macUiTree.ts";

const DEFAULT_DRAG_DURATION_MS = 220;
const UNSUPPORTED_MACOS_MESSAGE =
  "This Synara build does not include its macOS computer-control helper, and no Swift " +
  "toolchain is available for the development fallback. Update or reinstall Synara.";

/**
 * The JSON-RPC code the helper returns when the action needed a TCC grant it
 * does not have (`RPCError.permissionDenied` = -32000, wrapped by the client as
 * `helper_<code>`). A capture that fails this way is the live answer to
 * "is Screen Recording granted?", so the backend believes it over the last
 * capability probe.
 */
const HELPER_PERMISSION_DENIED_CODE = "helper_-32000";
/** `RPCError.targetMissing` — the named window is gone, minimized, or never existed. */
const HELPER_TARGET_MISSING_CODE = "helper_-32001";
/**
 * `RPCError.notDelivered` — the helper walked its whole delivery ladder and no
 * rung accepted the input, so nothing at all was injected. That is a refusal
 * rather than a fault, and the distinction is the difference between "the
 * control did not react" and "the keystroke never left this process".
 */
const HELPER_NOT_DELIVERED_CODE = "helper_-32002";
const HELPER_INACTIVE_SPACE_CODE = "helper_-32015";
/** JSON-RPC `invalidParams` — an argument this helper build cannot act on. */
const HELPER_INVALID_PARAMS_CODE = "helper_-32602";

/**
 * The transport failures that mean "this helper connection is finished", as
 * opposed to "the desktop refused this request".
 *
 * Every one of them is answered the same way: drop the connection, record the
 * outage, and report a retryable failure, because the next call spawns a fresh
 * process and a fresh process is very often all it takes. The three that were
 * missing are the three that left the backend stuck against a helper it could
 * never talk to again — a write to a closed stdin, a client that had already
 * been shut down, and, worst of all, a timeout: a helper wedged in a
 * synchronous AX or capture call went on being asked and went on timing out
 * every fifteen seconds for the life of the server, because nothing ever
 * concluded that the process itself was the problem.
 */
const HELPER_CONNECTION_FAILURE_CODES: ReadonlySet<string> = new Set([
  "helper_exited",
  "helper_unavailable",
  "helper_spawn_failed",
  "helper_write_failed",
  "helper_disposed",
  "helper_timeout",
]);

/**
 * The methods that carry no coordinate of their own, so the only thing deciding
 * where they land is the window the helper was last aimed at.
 *
 * The helper has no frontmost fallback on purpose: returning "whatever is in
 * front" meant a `type` with no preceding click wrote the agent's text into the
 * human's own document, including through the accessibility rung that needs no
 * activation at all. It refuses with `targetMissing` instead, and that refusal
 * needs its own explanation here — the generic window-not-found answer names an
 * id the caller never gave.
 */
const KEYBOARD_METHODS: ReadonlySet<string> = new Set<string>(["type", "press-key", "hotkey"]);

/**
 * The helper wire contract this server speaks. The helper and the server ship
 * together, so a mismatch is not a version to negotiate — it is a stale binary
 * (a cached development build from before a protocol change, most often) that
 * would otherwise answer today's calls with yesterday's shapes and fail in ways
 * that look like desktop bugs.
 */
const SUPPORTED_HELPER_PROTOCOL_VERSION = 1;

/**
 * How long a capability probe is trusted while the helper stays up.
 *
 * `ComputerManager.publish` asks `availability()` on every publish, and a
 * publish follows every action — so on macOS each click paid three helper round
 * trips to re-read TCC grants that change at human speed, if at all. Short
 * enough that revoking Screen Recording in System Settings is noticed within a
 * couple of actions, long enough that a burst of actions reads it once.
 */
const CAPABILITY_CACHE_TTL_MS = 2_000;

/**
 * How long a failed helper build disables the backend before it is retried.
 *
 * A build failure is usually permanent (no Xcode, an unaccepted licence) and
 * remembering it is what stops every action paying for a doomed five-minute
 * compile. But it is not always permanent — a killed build, a full disk, a
 * toolchain the user has since fixed — and without a bound the first bad build
 * disabled desktop control for the life of the process. An explicit `provision()`
 * clears it outright, because that is the user saying "try again".
 */
const BUILD_FAILURE_TTL_MS = 60_000;

/**
 * How long a `tccutil reset` is given before it is abandoned. It is a local
 * database write that finishes in milliseconds; anything longer is a machine in
 * trouble, and the permission dialog behind it must not wait on it.
 */
const TCC_RESET_TIMEOUT_MS = 5_000;

/**
 * How long a passive availability answer is reused.
 *
 * `ComputerManager.publish` asks `probeAvailability()` on every publish while
 * nothing has engaged the desktop, and on a source-build Mac that answer costs
 * an `xcodebuild -version` spawn and a digest of every Swift source in the
 * helper — boot-path work, repeated per publish, to re-derive machine state
 * that changes when somebody installs Xcode. Long enough that a burst of
 * publishes pays once; short enough that a helper the user just built is
 * noticed without restarting the server. An explicit `provision()` drops it
 * outright, because that is the user saying "look again".
 */
const PROBE_CACHE_TTL_MS = 10_000;

/**
 * How long the remembered workspace rectangle is trusted.
 *
 * Every capture region is expressed against it, and the only things that
 * refresh it are a window enumeration and a screen-size read — both of which an
 * action performs and a still-frame loop does not. So a pane left streaming
 * across a display change (a monitor unplugged, a resolution switch) went on
 * asking for a rectangle that no longer exists, which the helper refuses with
 * `invalidParams`, once per tick, forever. Re-read on the same cadence the
 * capability probe uses: cheap relative to the capture it precedes, and a
 * display change is visible within one interval.
 */
const WORKSPACE_GEOMETRY_TTL_MS = 2_000;

/**
 * How long `dispose()` waits for an in-flight helper start before it stops
 * being polite about it.
 *
 * The start it is waiting on can be a cold Swift build: five minutes of
 * compiler, holding server shutdown open, for a binary nothing will ever run.
 * After the grace the shutdown signal is raised, which aborts the build
 * subprocess itself rather than merely abandoning the promise in front of it.
 * Exported so a test can advance exactly this far.
 */
export const MAC_HELPER_DISPOSE_GRACE_MS = 2_000;

const execFileAsync = promisify(execFile);

/** A timer that never keeps the process alive on its own. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The tri-state verdicts the helper may report; anything else is dropped. */
const DELIVERY_VERIFICATIONS = new Set<string>([
  "confirmed",
  "unconfirmed",
  "unverifiable",
] satisfies ComputerDeliveryVerification[]);

/**
 * The helper's own error code behind a failure, whether it arrived raw or
 * already wrapped in a `ComputerBackendError` (which keeps the original as
 * `cause`).
 */
function helperErrorCode(error: unknown): string | undefined {
  const record = asRecord(error);
  if (typeof record.code === "string") return record.code;
  const cause = asRecord(record.cause);
  return typeof cause.code === "string" ? cause.code : undefined;
}

/**
 * Runs a subprocess to completion, capturing stdout/stderr and never throwing
 * on a non-zero exit — the provisioner reads the code. A spawn failure (no such
 * binary, as on a Linux CI host asked about Xcode) rejects, which every caller
 * already treats as "tooling absent".
 */
const runProcess: MacHelperRun = async (command, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      timeout: options.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      ...(options.env ? { env: options.env } : {}),
      // Aborting kills the child. Without it a disposed backend left a five
      // minute Swift compile running against a cache nobody would read.
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { code: 0, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    const record = asRecord(error);
    if (typeof record.code === "number") {
      return {
        code: record.code,
        stdout: typeof record.stdout === "string" ? record.stdout : "",
        stderr: typeof record.stderr === "string" ? record.stderr : "",
      };
    }
    throw error;
  }
};

/**
 * The private-SPI symbols the helper resolved at runtime, as it reports them.
 *
 * These are the rungs of the delivery ladder. `keyWindowRecord` is the one that
 * reaches a web view without bringing its window forward, and it is the one
 * Apple moves between releases — when it is missing the helper still delivers,
 * but only by raising the window first, which the human sees. The report
 * therefore has to reach the settings panel rather than staying a helper
 * internal, because "windows keep jumping to the front" is otherwise
 * unexplainable to the person watching it happen.
 */
export interface MacHelperSkylightReport {
  readonly setWindowLocation: boolean;
  readonly focusWithoutRaise: boolean;
  readonly setFrontProcess: boolean;
  readonly keyWindowRecord: boolean;
}

/**
 * One capture as the helper answered it: the decoded PNG (the frame pipeline
 * and the header read both need bytes), the encoding it arrived in (a
 * screenshot payload needs exactly that string back), and the region the helper
 * says the pixels cover.
 */
interface MacCapturedImage {
  readonly helperGeneration: number;
  readonly bytes: Uint8Array;
  readonly base64: string;
  readonly region: ComputerRect | undefined;
}

interface MacHelperCapabilities {
  readonly screenRecording: boolean;
  readonly accessibility: boolean;
  /** Absent when the helper predates protocol versioning, which is itself drift. */
  readonly protocolVersion: number | undefined;
  readonly skylight: MacHelperSkylightReport;
  /**
   * How this build is signed, as the helper read it off its own code signature.
   *
   * The one thing that separates "you have not granted this yet" from "you
   * granted it to a build that no longer exists": macOS pins an ad-hoc
   * signature's TCC grant to the binary's cdhash, so every local rebuild
   * silently invalidates it while System Settings goes on showing Synara
   * switched on. Only the helper can answer it, and only for the build actually
   * running. Anything the helper cannot classify is read as `signed`, because
   * telling a release user to reset their TCC database is worse than saying
   * nothing.
   */
  readonly signature: ComputerBuildSignature;
}

/**
 * The grants a capability report says are absent, in the order every surface
 * names them. Both the blocking one and the merely degrading one, because a user
 * sent to System Settings should be told everything to switch on while they are
 * there rather than making the trip twice.
 */
function missingMacPermissions(capabilities: MacHelperCapabilities): readonly ComputerPermission[] {
  const missing: ComputerPermission[] = [];
  if (!capabilities.accessibility) missing.push("accessibility");
  if (!capabilities.screenRecording) missing.push("screenRecording");
  return missing;
}

/**
 * A helper capability report, from `capabilities` or `request-permissions` —
 * both answer with the same shape, and the second one is a probe as much as it
 * is a request, so both feed the same cache.
 */
function parseMacCapabilities(payload: unknown): MacHelperCapabilities {
  const record = asRecord(payload);
  const skylightPayload = asRecord(record.skylight);
  return {
    screenRecording: record.screenRecording === true,
    accessibility: record.accessibility === true,
    protocolVersion: asFiniteNumber(record.protocolVersion),
    signature: record.signature === "adhoc" ? "adhoc" : "signed",
    skylight: {
      setWindowLocation: skylightPayload.setWindowLocation === true,
      focusWithoutRaise: skylightPayload.focusWithoutRaise === true,
      setFrontProcess: skylightPayload.setFrontProcess === true,
      keyWindowRecord: skylightPayload.keyWindowRecord === true,
    },
  };
}

type MacHelperRun = (
  command: string,
  args: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly env?: NodeJS.ProcessEnv;
    /** Raised when the backend is disposed; kills the child rather than orphaning it. */
    readonly signal?: AbortSignal;
  },
) => Promise<ProcessRunResult>;

export interface MacComputerBackendOptions {
  readonly computerId?: string;
  /** Overridden in tests; defaults to `process.platform`. */
  readonly platform?: string;
  /** Absolute path to `apps/server/native/computer-use-macos`; resolved when omitted. */
  readonly helperSourceDir?: string;
  readonly helperCacheRoot?: string;
  readonly now?: () => number;
  readonly stillIntervalMs?: number;
  readonly captureMaxDimension?: number;
  /**
   * Subprocess runner for the toolchain probe, the helper build, and the
   * `tccutil reset` that clears a stale ad-hoc grant; injected in tests, which
   * must never spawn any of the three.
   */
  readonly run?: MacHelperRun;
  /**
   * Builds the helper client around a binary path. Injected so a test can hand
   * back a fake transport without a real Mach-O on disk. The default constructs
   * the real `MacComputerHelperClient`.
   */
  readonly makeHelperClient?: (options: MacComputerHelperClientOptions) => MacHelperTransport;
  /**
   * Resolves the binary the helper client will spawn. Injected so tests skip
   * the compile entirely; the default is the provisioner's build-or-cache.
   *
   * Handed the backend's shutdown signal, which is raised when `dispose()` has
   * waited out its grace on a resolution still in flight. The default resolver
   * needs no argument — the same signal reaches its build subprocess through
   * the injected runner — but a caller standing in for it can honour it.
   */
  readonly resolveBinary?: (signal: AbortSignal) => Promise<string>;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * macOS implementation of the computer backend — the Codex-style "computer use"
 * ported onto Synara's `ComputerBackend` contract.
 *
 * The load-bearing facts, all confirmed by the reverse-engineering research in
 * `docs/computer-use-macos-reference.md`:
 *
 * - The "second cursor" is a picture the native helper draws, not a real
 *   pointer. macOS has one system cursor and the agent never touches it.
 * - Input is delivered by posting a synthetic event to the **target process**
 *   with `CGEventSetWindowLocation` stamping window-local coordinates, so the
 *   event never enters the HID stream that would warp the human's pointer.
 * - Perception is AX-first (structure) with a screenshot (pixels) alongside.
 *
 * All of that lives in the native helper; this class is the same thin
 * orchestration layer the KWin backend is — coordinate translation into the
 * agent's 0-based space, health supervision, still-frame publishing, and the
 * lazy build-and-spawn of the helper on first real use. Nothing here touches a
 * desktop at construction time, so it is safe to build at boot on every host.
 */
export class MacComputerBackend implements ComputerBackend {
  readonly inputDoesNotRequireReveal = true;
  readonly computerId: ComputerId;

  private readonly platform: string;
  private readonly now: () => number;
  private readonly stillIntervalMs: number;
  private readonly captureMaxDimension: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: MacHelperRun;
  private readonly provisioner: MacComputerHelperProvisioner;
  private readonly makeHelperClient: (
    options: MacComputerHelperClientOptions,
  ) => MacHelperTransport;
  private readonly resolveBinary: (signal: AbortSignal) => Promise<string>;
  private readonly healthState: ComputerHealthState;
  /**
   * Raised by `dispose()`. Every subprocess this backend starts — the toolchain
   * probe, the helper build, the TCC reset — runs under it, so shutdown can
   * reclaim them instead of waiting on them.
   */
  private readonly shutdown = new AbortController();

  private helper: MacHelperTransport | undefined;
  private helperPromise: Promise<MacHelperTransport> | undefined;
  private binaryPromise: Promise<string> | undefined;
  private disposed = false;
  private drivingAgent: string | null = null;
  private cursorActivity: string | null = null;
  /** Capture availability follows both the preflight and actual OS capture results. */
  private captureGranted = false;
  private captureVerified = false;
  private capturePreflight: boolean | undefined;
  private helperGeneration = 0;
  private buildFailure: { readonly message: string; readonly at: number } | undefined;
  private capabilityCache:
    | { readonly value: MacHelperCapabilities; readonly at: number }
    | undefined;
  /** The last passive availability answer, reused for `PROBE_CACHE_TTL_MS`. */
  private probeCache: { readonly value: ComputerAvailability; readonly at: number } | undefined;
  /**
   * Grants macOS has already been asked for on the current helper process. See
   * `requestMissingPermissions`: the Accessibility dialog reappears on every
   * ask, and the tool surface consults `missingPermissions()` on every call.
   */
  private readonly permissionsAsked = new Set<ComputerPermission>();
  /**
   * True once the helper says it cannot deliver background input into a window
   * without bringing it forward. Reported on health so the settings panel can
   * say so plainly rather than leaving the user to notice windows raising.
   */
  private backgroundInputDegraded = false;
  /** The desktop's backing-store scale as the helper reported it, not a guess. */
  private screenScale = 1;

  /** Last known global-space workspace origin, so pointer/capture translate without a fresh read. */
  private lastOrigin: ComputerPoint = { x: 0, y: 0 };
  private lastWorkspaceGlobal: ComputerRect | undefined;
  /** When that rectangle was last read from the desktop, for `WORKSPACE_GEOMETRY_TTL_MS`. */
  private workspaceReadAt = 0;

  /** The still-frame loop, shared with the KWin backend. */
  private readonly stills: StillFramePublisher;
  private actionCapturesInFlight = 0;
  private readonly windowsChanges: WindowListChangeNotifier;
  /**
   * How many captures each ScreenCaptureKit path has served. The helper names
   * the source it fell back to, and the only way "how often does the fast path
   * miss?" is answerable is by counting the answers.
   */
  private readonly sourceCounts = new Map<string, number>();
  private readonly eventListeners = new Set<ComputerBackendEventListener>();

  constructor(options: MacComputerBackendOptions = {}) {
    this.computerId = (options.computerId ?? DEFAULT_COMPUTER_ID) as ComputerId;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.stillIntervalMs = resolveStillIntervalMs(options.stillIntervalMs);
    this.captureMaxDimension = Math.max(
      1,
      Math.min(
        32_768,
        Math.floor(options.captureMaxDimension ?? DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION),
      ),
    );
    this.env = options.env ?? process.env;
    const configuredRun = options.run ?? runProcess;
    // Every subprocess is enrolled in the shutdown signal here rather than at
    // each call site, so nothing this backend spawns can outlive it — including
    // the build the provisioner starts, which this class never sees a handle to.
    const run: MacHelperRun = (command, args, runOptions) =>
      configuredRun(command, args, { ...runOptions, signal: this.shutdown.signal });
    this.run = run;
    const helperSourceDir =
      options.helperSourceDir ?? resolveComputerHelperSourceDir(import.meta.dirname);
    this.provisioner = new MacComputerHelperProvisioner({
      helperSourceDir,
      ...(options.helperCacheRoot ? { helperCacheRoot: options.helperCacheRoot } : {}),
      run,
      env: this.env,
    });
    this.makeHelperClient =
      options.makeHelperClient ?? ((clientOptions) => new MacComputerHelperClient(clientOptions));
    this.resolveBinary = options.resolveBinary ?? (() => this.provisioner.ensureBinary());
    this.healthState = new ComputerHealthState({
      readStatus: () => ({
        status: this.helper?.running ? "connected" : "unavailable",
        captureAvailable: this.captureGranted,
        backgroundInputDegraded: this.backgroundInputDegraded,
      }),
      emit: (health) => this.emit({ type: "health-changed", health }),
      now: () => this.now(),
      failureFallbackMessage: "The Synara macOS computer backend failed without a message.",
    });
    this.stills = new StillFramePublisher({
      capture: (force) => this.captureStillFrame(force),
      // No Screen Recording grant means every capture would fail identically;
      // the tick is skipped rather than spending a round trip to learn that.
      isCaptureAvailable: () => this.captureGranted,
      prepare: async () => {
        await this.ensureHelper();
      },
      emit: (frame) => this.emit({ type: "frame", frame }),
      now: () => this.now(),
      intervalMs: this.stillIntervalMs,
    });
    this.windowsChanges = new WindowListChangeNotifier((windows) =>
      this.emit({ type: "windows-changed", windows }),
    );
  }

  /**
   * The macOS Tier-1 capability set. The native helper enumerates windows with
   * `CGWindowList` geometry and stacking, captures with ScreenCaptureKit, posts
   * input to target processes, reads and writes `NSPasteboard`, and draws the
   * Software Cursor overlay — so every capability is true. `capture` being true
   * is the capability's existence; whether the live Screen Recording grant is
   * present rides on `health.captureAvailable`.
   *
   * `raise` reveals the window before input; `focus` selects the agent's
   * keyboard target. The physical pointer remains under the user's control.
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
      visibleDesktop: true,
    };
  }

  /**
   * "Could this Mac drive its desktop?", answered without spawning the helper.
   *
   * Two ways to be available, both cheap: a helper binary is already cached for
   * this toolchain, or a full Xcode is present so one can be built on first use.
   * Neither builds anything, reads a TCC grant, or starts a process that
   * outlives the call — which matters because this runs at boot for every user.
   * Optimism is intended: a yes that later cannot provision costs one error card
   * at first use; a no costs the user the feature.
   */
  async probeAvailability(): Promise<ComputerAvailability> {
    if (this.platform !== "darwin") {
      return { kind: "unsupported-platform", platform: this.platform };
    }
    const buildFailure = this.currentBuildFailure();
    if (buildFailure) {
      return { kind: "backend-unavailable", message: buildFailure };
    }
    // A helper that is up right now is a stronger answer than anything on disk,
    // and it is free — no stat, no digest, no spawn.
    if (this.helper?.running) return this.availableNow();
    const cached = this.probeCache;
    if (cached && this.now() - cached.at < PROBE_CACHE_TTL_MS) return cached.value;
    const answer = await this.readProbeAvailability();
    this.probeCache = { value: answer, at: this.now() };
    return answer;
  }

  /** The uncached passive probe: the three cheap-to-expensive ways to be available. */
  private async readProbeAvailability(): Promise<ComputerAvailability> {
    // The floor comes first because it outranks every other answer: a shipped
    // helper on macOS 12.2 is still a binary that cannot launch, and reporting
    // "available" there costs the user a dyld failure instead of a sentence
    // naming the actual reason.
    if (await this.provisioner.macosBelowFloor().catch(() => false)) {
      return { kind: "backend-unavailable", message: MACOS_BELOW_HELPER_FLOOR_MESSAGE };
    }
    if (await this.provisioner.bundledBinary().catch(() => null)) return this.availableNow();
    if (await this.provisioner.cachedBinaryPath().catch(() => null)) return this.availableNow();
    if (await this.provisioner.swiftToolchainPresent().catch(() => false))
      return this.availableNow();
    return { kind: "backend-unavailable", message: UNSUPPORTED_MACOS_MESSAGE };
  }

  /**
   * Availability as established: builds the helper if needed, starts it, and
   * reads its capability probe (OS version, arch, TCC grants). Belongs only on
   * paths about to use the desktop — `probeAvailability` is the passive twin.
   */
  async availability(): Promise<ComputerAvailability> {
    if (this.platform !== "darwin") {
      return { kind: "unsupported-platform", platform: this.platform };
    }
    try {
      const capabilities = await this.readCapabilities();
      // Deliberately not a `recordConnected()`. The manager asks this on every
      // publish and a publish follows every action, so counting each ask as a
      // connection turned `reconnects` into a publish counter and put two
      // `health-changed` events — hence two thread-state broadcasts per thread —
      // on the wire for every click. The connection is recorded where a
      // connection is actually made, in `startHelper`, exactly as the KWin
      // backend records one per connect. Publishing stays: it is change-gated,
      // so an unchanged warm path emits nothing at all.
      this.publishHealth();
      // Accessibility is not optional for this backend: without it every click
      // and keystroke is dropped by WindowServer. Reporting "available" here
      // let the pane open onto a desktop nothing could be done to.
      //
      // Screen Recording alone does not reach this branch. A desktop that can be
      // driven but not seen is still worth having, so it stays `available` with
      // `health.captureAvailable` false — the missing grant is reported through
      // `missingPermissions()`, which is what still raises the chat's setup card
      // for it without taking the working half of the feature away.
      if (!capabilities.accessibility) {
        const missing = missingMacPermissions(capabilities);
        // Ask the OS here rather than only describing what is missing: this is
        // an agent path, and the user is owed the dialog at the moment the
        // desktop is needed. Not awaited — the dialog outlives this call.
        void this.requestMissingPermissions(missing);
        return {
          kind: "permission-required",
          missing,
          message: clampComputerMessage(
            computerPermissionSetupMessage(
              missing,
              capabilities.signature,
              responsibleDesktopBundleId(this.env),
            ),
            "Synara needs a macOS privacy permission to control this Mac.",
          ),
          buildSignature: capabilities.signature,
        };
      }
      return this.availableNow();
    } catch (error) {
      this.recordHealthFailure(error);
      this.publishHealth();
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "backend-unavailable",
        message: clampComputerMessage(
          message,
          "The Synara macOS computer backend failed without a message.",
        ),
      };
    }
  }

  private availableNow(): ComputerAvailability {
    return { kind: "available", backend: COMPUTER_MAC_BACKEND };
  }

  /**
   * The TCC grants this Mac is withholding right now.
   *
   * Empty before anything has probed, which is the honest answer: nobody has
   * looked, so nobody is owed a permission card yet — and that is a free read,
   * as is the case where the last probe saw everything granted.
   *
   * The one case that costs anything is the one that matters. A probe that saw
   * a gap is the only kind of answer that can go stale in a way the user can
   * see: they grant the permission, the tool surface reads this after the very
   * next call, and a remembered "missing" keeps the setup card and the model's
   * refusal on screen over a desktop that already works. So a probe that named a
   * missing grant is re-read here rather than reused, through the same
   * `CAPABILITY_CACHE_TTL_MS` window every other reader honours — a burst of
   * calls still pays for one round trip, and a grant that lands is noticed on
   * the next one.
   */
  async missingPermissions(): Promise<readonly ComputerPermission[]> {
    const cached = this.capabilityCache?.value;
    if (!cached || missingMacPermissions(cached).length === 0) return [];
    // A probe failure leaves the last report standing: the caller is a tool
    // call with its own outcome to report, and inventing a granted desktop out
    // of an unreachable helper would drop the card the user is owed.
    const capabilities = await this.readCapabilities().catch(() => cached);
    const missing = missingMacPermissions(capabilities);
    // The tool surface reads this on every computer call to decide whether the
    // user is owed a setup card, which makes it the one place that sees a
    // merely-degrading grant (Screen Recording) go missing without anything
    // failing. Asking from here is what turns that card into an OS dialog; the
    // per-grant throttle is what keeps a per-call read from stacking dialogs.
    if (missing.length > 0) void this.requestMissingPermissions(missing);
    return missing;
  }

  /**
   * How this build is signed, as the last probe read it off the binary. Free,
   * and undefined until something has probed. Rides beside `missingPermissions`
   * so the chat's setup card can explain an ad-hoc build's stale grant rather
   * than leaving the user looking at a switch that is already on.
   */
  buildSignature(): ComputerBuildSignature | undefined {
    return this.capabilityCache?.value.signature;
  }

  /**
   * What to ask macOS for after it has refused a live call. The last probe when
   * it named something, and both grants when it did not: a refusal is proof the
   * probe is wrong or absent, and the helper only ever prompts for a grant it
   * genuinely lacks, so offering both cannot put a dialog on screen for
   * something already granted.
   */
  private deniedPermissions(): readonly ComputerPermission[] {
    const capabilities = this.capabilityCache?.value;
    const missing = capabilities ? missingMacPermissions(capabilities) : [];
    return missing.length > 0 ? missing : COMPUTER_PERMISSIONS;
  }

  /**
   * The user pressing "Set up" — in settings, or on the chat's setup card.
   *
   * Compiles the native helper for this Xcode toolchain (a cold Swift build) and
   * starts it, so the first agent turn does not pay the build, and then asks
   * macOS for anything it is still withholding. That last part is why this is
   * the same mechanism the agent path uses rather than a second one: pressing
   * the button is an explicit request for the dialog, so it also re-arms the
   * per-grant throttle and puts the prompt back on screen for a user who
   * dismissed it.
   *
   * Returns one sentence naming what happened and the grants still needed, which
   * is exactly what the card that pressed it renders.
   */
  async provision(): Promise<string> {
    if (this.platform !== "darwin") {
      throw new ComputerBackendError(
        `The macOS computer backend cannot provision on ${this.platform}.`,
      );
    }
    // The user pressing "Set up" is the user asking for another attempt, so a
    // remembered build failure must not short-circuit it — that is what turned
    // one bad build into a backend that stayed dead until the server restarted.
    this.buildFailure = undefined;
    // Same reasoning for the passive answer: the user pressing the button is
    // the user saying the machine may have changed since it was last looked at.
    this.probeCache = undefined;
    // Re-arm before the probe: the ask this user just made outranks whatever
    // an agent path already spent, and a dismissed dialog is exactly the case
    // this button exists for.
    this.permissionsAsked.clear();
    const built = await this.ensureHelperBuilt();
    let capabilities = await this.readCapabilities({ force: true });
    let missing = missingMacPermissions(capabilities);
    if (missing.length > 0) {
      // Awaited, unlike the agent paths: the sentence this returns describes
      // where the request left things, and the reply is a fresh report that may
      // already say the user granted it.
      capabilities = (await this.requestMissingPermissions(missing)) ?? capabilities;
      missing = missingMacPermissions(capabilities);
    }
    this.publishHealth();
    // A packaged build ships a signed helper, so nothing is compiled and saying
    // "Built" is simply untrue — and the sentence this returns is the whole
    // content of the card the user is reading.
    const started = built ? "Built and started" : "Started";
    if (missing.length === 0) {
      // Named through the shared list so this sentence agrees with every other
      // surface: a hand-written "Screen Recording and Accessibility" here read
      // as a different pair of grants from the "Accessibility and Screen
      // Recording" the very next message uses.
      return `${started} the bundled macOS computer-use helper; ${listComputerPermissions(
        COMPUTER_PERMISSIONS,
      )} are granted.`;
    }
    // The stale-grant sentence belongs here too: "Set up" is exactly where a user
    // with an ad-hoc build sees Synara already switched on and concludes Synara
    // is broken.
    const advice = computerStaleGrantAdvice(
      missing,
      capabilities.signature,
      responsibleDesktopBundleId(this.env),
    );
    return (
      `${started} the bundled macOS computer-use helper and asked macOS for ` +
      `${listComputerPermissions(missing)}. Allow it when macOS asks, or turn Synara on in ` +
      `System Settings › Privacy & Security.${advice ? ` ${advice}` : ""}`
    );
  }

  /**
   * Brings the helper up and reports whether provisioning had to compile it.
   * A packaged desktop build ships a signed universal binary and a warm cache
   * serves an earlier compile; only a cold source build is a build.
   */
  private async ensureHelperBuilt(): Promise<boolean> {
    const before = this.provisioner.compiledBuilds;
    await this.ensureHelper();
    return this.provisioner.compiledBuilds > before;
  }

  health(): ComputerHealth {
    return this.healthState.health();
  }

  /**
   * Captures served per ScreenCaptureKit path, since this backend was
   * constructed.
   *
   * The helper names the link that served each capture precisely so the
   * fallback rate is a health metric rather than a guess (see
   * `native/computer-use-macos/Sources/Capture.swift`). Reading the field was
   * the missing half: without a count, "how often does the fast path miss?" had
   * no answer at all.
   */
  captureSourceCounts(): ReadonlyMap<string, number> {
    return new Map(this.sourceCounts);
  }

  async listWindows(): Promise<readonly ComputerWindow[]> {
    const [windows] = await this.readWindows();
    return windows;
  }

  /**
   * One window enumeration, in both coordinate spaces — the macOS twin of the
   * KWin backend's `readWindows`. The helper reports global top-left screen
   * coordinates; a multi-display layout can place a screen above or left of the
   * main one, so the workspace origin can be negative. Everything crossing this
   * boundary speaks agent space (0..screenSize), translated once here.
   */
  private async readWindows(): Promise<readonly [readonly ComputerWindow[], ComputerPoint]> {
    const payload = await this.call(MAC_HELPER_METHODS.listWindows);
    const record = asRecord(payload);
    const focusedWindowId = asString(record.focusedWindowId) ?? null;
    const raw = parseWindows(record.windows, focusedWindowId);
    const workspace = this.parseWorkspace(record.workspace) ?? workspaceRectFromWindows(raw);
    const origin = this.rememberWorkspace(workspace);
    const windows = raw.map((window) => windowInAgentSpace(window, origin));
    // Digested from the parsed list rather than by re-encoding the helper's
    // reply: the helper answers with a decoded object, so fingerprinting "the
    // payload" would mean a full JSON encode on a call that runs several times
    // per action.
    this.windowsChanges.observe(windowsDigestFingerprint(raw, focusedWindowId), windows);
    return [windows, origin];
  }

  async getScreenSize(): Promise<ComputerScreenSize> {
    const payload = await this.call(MAC_HELPER_METHODS.screenSize);
    const record = asRecord(payload);
    const width = asFiniteNumber(record.width);
    const height = asFiniteNumber(record.height);
    const scale = asFiniteNumber(record.scale);
    if (width === undefined || height === undefined || width < 1 || height < 1) {
      // Fall back to the window bounding box rather than failing the pane.
      const [windows] = await this.readWindows();
      return screenSizeFromWindows(windows, this.lastWorkspaceGlobal);
    }
    // Cache the workspace so pointer/capture translation has an origin without a
    // second round trip; the helper reports the workspace top-left alongside.
    const originX = asFiniteNumber(record.x) ?? this.lastOrigin.x;
    const originY = asFiniteNumber(record.y) ?? this.lastOrigin.y;
    this.rememberWorkspace({ x: originX, y: originY, width, height });
    // Remembered so `getState` can report a truthful scale without a round trip
    // of its own: derived from the window bounding box it had no scale at all
    // and reported 1, which on every Retina Mac is simply wrong.
    if (scale !== undefined && scale > 0) this.screenScale = scale;
    return {
      width: Math.round(width),
      height: Math.round(height),
      scale: this.screenScale,
    };
  }

  async getState(options: {
    readonly includeScreenshot?: boolean;
    readonly includeTree?: boolean;
    readonly windowId?: string;
  }): Promise<ComputerState> {
    const [windows, origin] = await this.readWindows();
    const screenSize = screenSizeFromWindows(windows, this.lastWorkspaceGlobal, this.screenScale);
    // The AX walk and the capture are independent reads of the same moment, and
    // the helper serves perception and pixels on separate queues, so they are
    // issued together: running them back to back doubled the latency of every
    // `computer_get_state` for nothing.
    const [uiPayload, screenshot] = await Promise.all([
      options.includeTree
        ? // AX is an optional perception source: a window with no tree, a helper
          // restarting, or a missing Accessibility grant degrades to
          // windows-only rather than failing the state, as the KWin path does.
          this.call(
            MAC_HELPER_METHODS.describeUi,
            options.windowId ? { windowIds: [options.windowId] } : {},
          ).catch(() => undefined)
        : undefined,
      options.includeScreenshot && this.captureGranted
        ? this.captureWorkspaceScreenshot(origin).catch(() => undefined)
        : undefined,
    ]);
    let root: ComputerUiNode | undefined;
    if (uiPayload !== undefined) {
      try {
        root = parseMacUiForest(uiPayload, screenSize, origin);
      } catch {
        // A tree this build cannot parse degrades the same way a missing one does.
      }
    }
    const unavailableWindowIds = asRecord(asRecord(uiPayload).root).unavailableWindowIds;
    return {
      ...(options.includeTree
        ? {
            accessibility: {
              status: !root
                ? ("unavailable" as const)
                : root.truncated
                  ? ("partial" as const)
                  : ("complete" as const),
              unavailableWindowIds: Array.isArray(unavailableWindowIds)
                ? unavailableWindowIds.filter((id): id is string => typeof id === "string")
                : [],
            },
          }
        : {}),
      computerId: this.computerId,
      windows,
      screenSize,
      ...(root ? { root } : {}),
      ...(screenshot ? { screenshot } : {}),
      capturedAt: new Date(this.now()).toISOString(),
    };
  }

  captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    return this.withActionCapture(() => this.captureActionScreenshot(request));
  }

  private async withActionCapture(
    capture: () => Promise<ComputerScreenshot>,
  ): Promise<ComputerScreenshot> {
    this.actionCapturesInFlight += 1;
    try {
      return await capture();
    } finally {
      this.actionCapturesInFlight -= 1;
    }
  }

  private async captureActionScreenshot(
    request: ComputerCaptureRequest,
  ): Promise<ComputerScreenshot> {
    const maxDimension = request.maxDimension ?? this.captureMaxDimension;
    if (request.kind === "window") {
      const origin = await this.workspaceRect();
      const captured = await this.callCapture({
        kind: "window",
        windowId: request.windowId,
        maxDimension,
      });
      // The helper reports the region it actually captured, in globals; the
      // window's own frame is the fallback when it omits one.
      let globalRegion = captured.region;
      if (!globalRegion) {
        const [windows] = await this.readWindows();
        const window = windows.find((candidate) => candidate.id === request.windowId);
        if (!window)
          throw new ComputerBackendError(
            `No desktop window has id ${JSON.stringify(request.windowId)}.`,
          );
        globalRegion = shiftRect(
          requireWindowBounds(window, "a window screenshot"),
          origin.x,
          origin.y,
        );
      }
      return this.screenshot(captured, shiftRect(globalRegion, -origin.x, -origin.y));
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
    const captured = await this.callCapture({ kind: "region", region: global, maxDimension });
    const region = captured.region ?? global;
    return this.screenshot(captured, shiftRect(region, -origin.x, -origin.y));
  }

  async launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult> {
    const payload = asRecord(
      await this.call(MAC_HELPER_METHODS.launchApp, { app, arguments: [...args] }),
    );
    const resolvedCommand = asString(payload.resolvedCommand);
    return {
      computerId: this.computerId,
      app,
      ...(resolvedCommand ? { resolvedCommand } : {}),
      window: null,
    };
  }

  async checkInputReady(windowId: string): Promise<void> {
    await this.call(MAC_HELPER_METHODS.checkInputReady, { windowId });
  }

  async click(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    return await this.pointerAction(MAC_HELPER_METHODS.click, point, windowId, modifiers);
  }

  async doubleClick(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    return await this.pointerAction(MAC_HELPER_METHODS.doubleClick, point, windowId, modifiers);
  }

  async tripleClick(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    return await this.pointerAction(MAC_HELPER_METHODS.tripleClick, point, windowId, modifiers);
  }

  async rightClick(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    return await this.pointerAction(MAC_HELPER_METHODS.rightClick, point, windowId, modifiers);
  }

  async moveCursor(point: ComputerPoint, windowId?: string): Promise<ComputerBackendActionResult> {
    return await this.pointerAction(MAC_HELPER_METHODS.move, point, windowId);
  }

  async drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
    windowId?: string,
  ): Promise<ComputerBackendActionResult> {
    const origin = this.currentOrigin();
    const payload = asRecord(
      await this.call(MAC_HELPER_METHODS.drag, {
        fromX: from.x + origin.x,
        fromY: from.y + origin.y,
        toX: to.x + origin.x,
        toY: to.y + origin.y,
        durationMs: durationMs > 0 ? durationMs : DEFAULT_DRAG_DURATION_MS,
        ...(windowId ? { windowId } : {}),
      }),
    );
    // A drag ends where the pointer ended, and the display server can clamp that
    // endpoint just as it clamps a click's. Reporting the requested destination
    // regardless told the caller the drop landed somewhere it did not.
    return {
      ...pointerClampResult(to, this.landedPoint(payload, origin)),
      ...MacComputerBackend.deliveryReport(payload),
    };
  }

  async scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    const origin = this.currentOrigin();
    const params: Record<string, unknown> = { deltaX, deltaY };
    if (windowId) params.windowId = windowId;
    if (modifiers && modifiers.length > 0) params.modifiers = [...new Set(modifiers)];
    if (point) {
      params.x = point.x + origin.x;
      params.y = point.y + origin.y;
    }
    const payload = asRecord(await this.call(MAC_HELPER_METHODS.scroll, params));
    const delivery = MacComputerBackend.deliveryReport(payload);
    // A scroll with no point is aimed by focus, so there is no requested
    // coordinate for the helper's echo to disagree with.
    if (!point) return delivery;
    return { ...pointerClampResult(point, this.landedPoint(payload, origin)), ...delivery };
  }

  /**
   * Every input reply — keyboard and pointer alike — names the rung the helper
   * took and what it could establish about the outcome, which is the whole point
   * of the helper's delivery ladder. This backend used to discard both, so an
   * unconfirmed delivery and a proven one were indistinguishable to everything
   * above it.
   *
   * The verdict is validated rather than trusted: a value this build does not
   * recognize is dropped, because a `delivery` the contract cannot encode would
   * fail the whole result of an action that already happened. Nothing here
   * accommodates the older boolean form — the helper ships with the server, so
   * there is no mixed-version pair to be compatible with.
   */
  private static deliveryReport(payload: unknown): ComputerBackendActionResult {
    const record = asRecord(payload);
    const deliveryPath = asString(record.path);
    const windowId = asString(record.windowId);
    const reported = asString(record.verified);
    const verified =
      reported !== undefined && DELIVERY_VERIFICATIONS.has(reported)
        ? (reported as ComputerDeliveryVerification)
        : undefined;
    return {
      ...(windowId !== undefined ? { windowId } : {}),
      ...(deliveryPath !== undefined ? { deliveryPath } : {}),
      ...(verified !== undefined ? { verified } : {}),
    };
  }

  async typeText(text: string, windowId?: string): Promise<ComputerBackendActionResult> {
    const payload = await this.call(MAC_HELPER_METHODS.type, {
      text,
      ...(windowId ? { windowId } : {}),
    });
    return { textLength: text.length, ...MacComputerBackend.deliveryReport(payload) };
  }

  async pressKey(key: string, windowId?: string): Promise<ComputerBackendActionResult> {
    const payload = await this.call(MAC_HELPER_METHODS.pressKey, {
      key,
      ...(windowId ? { windowId } : {}),
    });
    return MacComputerBackend.deliveryReport(payload);
  }

  async hotkey(keys: readonly string[], windowId?: string): Promise<ComputerBackendActionResult> {
    const payload = await this.call(MAC_HELPER_METHODS.hotkey, {
      keys: [...keys],
      ...(windowId ? { windowId } : {}),
    });
    return MacComputerBackend.deliveryReport(payload);
  }

  async readClipboard(): Promise<string> {
    const payload = asRecord(
      await this.call(MAC_HELPER_METHODS.readClipboard, {
        maxBytes: MAX_COMPUTER_CLIPBOARD_BYTES,
      }),
    );
    const text = asString(payload.text) ?? "";
    // The same ceiling the Linux clipboard path enforces, and for the same
    // reason: a clipboard holding a whole document would otherwise stream
    // unbounded text into a turn — and, here, through the helper's line framer.
    if (
      payload.truncated === true ||
      Buffer.byteLength(text, "utf8") > MAX_COMPUTER_CLIPBOARD_BYTES
    ) {
      throw new ComputerBackendError(
        `The desktop clipboard holds more than ${MAX_COMPUTER_CLIPBOARD_BYTES} bytes of text, which is past the limit this tool reads.`,
      );
    }
    return text;
  }

  async writeClipboard(text: string): Promise<void> {
    // The same ceiling the Linux path enforces, through the same check: without
    // it a whole document went down the helper's line framer.
    assertComputerClipboardWriteFits(text);
    await this.call(MAC_HELPER_METHODS.writeClipboard, { text });
  }

  async setValue(
    target: ComputerResolvedTarget,
    value: string,
  ): Promise<ComputerBackendActionResult> {
    const address = this.writeAddress(target);
    let payload: unknown;
    if (address) {
      payload = await this.call(MAC_HELPER_METHODS.setValue, {
        ...address,
        ...this.globalPoint(target.point),
        value,
      });
    } else {
      // Clicking and typing cannot guarantee replacement of the old value.
      throw new ComputerBackendError(
        "Replacing a value requires an addressable accessibility control. Read the window state again, or explicitly select the text before typing.",
      );
    }
    return {
      ...MacComputerBackend.deliveryReport(payload),
      point: target.point,
      ...(target.node.windowId ? { windowId: target.node.windowId } : {}),
      textLength: value.length,
    };
  }

  async performAction(
    target: ComputerResolvedTarget,
    action: string,
  ): Promise<ComputerBackendActionResult> {
    if ((action === "activate" || action === "click") && !this.writeAddress(target)) {
      const clicked = await this.click(target.point, target.node.windowId ?? undefined);
      return {
        ...clicked,
        point: target.point,
        ...(target.node.windowId ? { windowId: target.node.windowId } : {}),
        value: action,
      };
    }
    const address = this.writeAddress(target);
    if (!address) {
      throw new ComputerBackendError(
        `macOS computer action ${JSON.stringify(action)} needs an addressable accessibility node.`,
      );
    }
    const payload = await this.call(MAC_HELPER_METHODS.performAction, {
      ...address,
      ...this.globalPoint(target.point),
      action,
    });
    return {
      ...MacComputerBackend.deliveryReport(payload),
      point: target.point,
      ...(target.node.windowId ? { windowId: target.node.windowId } : {}),
      value: action,
    };
  }

  /** AX action names, `open`-style app identifiers, single-chord shortcuts. */
  readonly agentDialect = "macos" as const;

  /**
   * Points the helper's keyboard at a window without raising or activating it,
   * so a `computer_type_text` that names a window reaches it even when the last
   * pointer gesture aimed somewhere else.
   */
  async clearFocusWindow(): Promise<void> {
    await this.call("clear-focus-window");
  }

  async focusWindow(windowId: string): Promise<void> {
    await this.call(MAC_HELPER_METHODS.focusWindow, { windowId });
  }

  /** Reveal the target before input, matching the Linux desktop backends. */
  async raiseWindow(windowId: string): Promise<void> {
    await this.call(MAC_HELPER_METHODS.raiseWindow, { windowId });
  }

  async setCursorActivity(text: string | null): Promise<void> {
    this.cursorActivity = text;
    if (!this.helper?.running) return;
    await this.helper
      .request(MAC_HELPER_METHODS.setAgentCursor, {
        name: this.drivingAgent ?? "",
        activity: text ?? "",
      })
      .catch(() => undefined);
  }

  async setDrivingAgent(name: string | null): Promise<void> {
    this.drivingAgent = name?.trim() ? name.trim() : null;
    if (!this.helper?.running) return;
    // Best effort: the agent cursor's name badge is presentation, so a failure
    // here must never fail the action that changed the holder.
    await this.call(MAC_HELPER_METHODS.setAgentCursor, {
      name: this.drivingAgent ?? "",
      activity: this.cursorActivity ?? "",
    }).catch(() => undefined);
  }

  onEvent(listener: ComputerBackendEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async attachStream(listener: ComputerFrameListener): Promise<void> {
    await this.stills.attach(listener);
  }

  async detachStream(): Promise<void> {
    await this.stills.detach();
  }

  async requestKeyframe(): Promise<void> {
    await this.stills.requestKeyframe();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.detachStream();
    // A helper still being spawned owns a child process that nothing else will
    // ever reach: `this.helper` is not assigned until the start resolves, so
    // disposing only what is already assigned leaked the process.
    //
    // But that start is allowed to be a cold Swift build, and waiting it out
    // held the whole server's shutdown open for up to five minutes to finish
    // compiling a binary nothing would ever run. So it gets a grace and then
    // the shutdown signal, which kills the build subprocess itself rather than
    // walking away from the promise in front of it; the second race is only
    // there so a runner that ignores the signal cannot block shutdown either.
    const starting = this.helperPromise?.catch(() => undefined);
    if (starting) {
      const finished = await Promise.race([
        starting.then(() => true),
        delay(MAC_HELPER_DISPOSE_GRACE_MS).then(() => false),
      ]);
      if (!finished) {
        this.shutdown.abort();
        await Promise.race([starting, delay(MAC_HELPER_DISPOSE_GRACE_MS)]);
      }
    }
    this.shutdown.abort();
    await this.helper?.dispose().catch(() => undefined);
    this.helper = undefined;
    this.eventListeners.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────

  private writeAddress(target: ComputerResolvedTarget):
    | {
        readonly windowId: string;
        readonly nodePath: readonly number[];
        readonly accessibilityRoot?: "window" | "menu-bar" | "menu-bar-extra";
        readonly expectedRole: string;
        readonly expectedLabel?: string;
      }
    | undefined {
    const windowId = target.node.windowId;
    const nodePath = target.node.nodePath;
    if (!windowId || !nodePath || nodePath.length === 0) return undefined;
    return {
      windowId,
      nodePath,
      expectedRole: target.node.role,
      ...(!target.node.truncated && target.node.label && target.node.label.length < 1_024
        ? { expectedLabel: target.node.label }
        : {}),
      ...(target.node.accessibilityRoot
        ? { accessibilityRoot: target.node.accessibilityRoot }
        : {}),
    };
  }

  private globalPoint(point: ComputerPoint): ComputerPoint {
    const origin = this.currentOrigin();
    return { x: point.x + origin.x, y: point.y + origin.y };
  }

  private async pointerAction(
    method: string,
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    const origin = this.currentOrigin();
    const payload = asRecord(
      await this.call(method, {
        x: point.x + origin.x,
        y: point.y + origin.y,
        // Names the delivery target. Without it the helper resolves the
        // topmost window at the point, so a click meant for a partially
        // covered window landed on whatever was drawn over it.
        ...(windowId ? { windowId } : {}),
        // Held down across the gesture and released after it. Omitted entirely
        // when empty, so an older helper sees the request it always saw.
        ...(modifiers && modifiers.length > 0 ? { modifiers: [...new Set(modifiers)] } : {}),
      }),
    );
    // The helper reports where the pointer actually landed when the display
    // clamped it (a coordinate in a gap between screens); shift back to agent
    // space and surface the mismatch through the same rule the KWin path uses.
    return {
      ...pointerClampResult(point, this.landedPoint(payload, origin)),
      // A pointer action rides the same delivery ladder the keyboard does, and
      // "the click was posted but nothing acknowledged it" is exactly as worth
      // reporting as the keyboard equivalent.
      ...MacComputerBackend.deliveryReport(payload),
    };
  }

  /** The helper's echoed endpoint in agent space, or null when it reported none. */
  private landedPoint(
    payload: Record<string, unknown>,
    origin: ComputerPoint,
  ): ComputerPoint | null {
    const x = asFiniteNumber(payload.x);
    const y = asFiniteNumber(payload.y);
    return x !== undefined && y !== undefined ? { x: x - origin.x, y: y - origin.y } : null;
  }

  private captureWorkspaceScreenshot(origin: ComputerPoint): Promise<ComputerScreenshot> {
    // State observations deserve the same capture priority as explicit shots.
    // Release it when pixels finish, independently of the concurrent AX walk.
    return this.withActionCapture(async () => {
      const global = await this.workspaceRect();
      const captured = await this.callCapture({
        kind: "region",
        region: global,
        maxDimension: this.captureMaxDimension,
      });
      return this.screenshot(captured, shiftRect(captured.region ?? global, -origin.x, -origin.y));
    });
  }

  /**
   * One whole-workspace still as raw PNG bytes, for the shared publisher.
   *
   * Nothing here builds a `ComputerScreenshot`: that payload is base64, and a
   * frame carries the bytes the capture already returned. Round-tripping a
   * multi-megabyte PNG through base64 twice a second, forever, while anyone
   * watches the pane, would cost two copies and an encode per frame to arrive
   * back where it started.
   */
  private async captureStillFrame(force: boolean): Promise<Uint8Array | undefined> {
    // A requested keyframe must always run; dropping its force can leave a new
    // receiver blank on a static desktop. Ordinary ticks can wait until next time.
    if (!force && this.actionCapturesInFlight > 0) return undefined;
    const global = await this.workspaceRect();
    if (!force && this.actionCapturesInFlight > 0) return undefined;
    const helperGeneration = this.helperGeneration;
    const payload = asRecord(
      await this.callCaptureMethod({
        kind: "region",
        region: global,
        maxDimension: this.captureMaxDimension,
        deduplicate: true,
        force,
      }),
    );
    if (payload.unchanged === true) {
      if (force) throw new ComputerBackendError("The macOS helper omitted a requested keyframe.");
      return undefined;
    }
    const captured = this.decodeCapture(payload, helperGeneration);
    readPngDimensions(captured.bytes, { source: "Synara macOS capture" });
    return captured.bytes;
  }

  /**
   * A capture as a contract screenshot. The helper's own base64 is handed
   * straight through: it is already the exact string the payload carries, and
   * re-encoding the bytes it was decoded from cost a second copy of a
   * multi-megabyte image to arrive back where it started.
   */
  private screenshot(captured: MacCapturedImage, region: ComputerRect): ComputerScreenshot {
    const screenshot = screenshotFromPng({
      bytes: captured.bytes,
      bytesBase64: captured.base64,
      region,
      capturedAt: new Date(this.now()).toISOString(),
      source: "Synara macOS capture",
    });
    // CGPreflight can remain false in a process started before consent even
    // when ScreenCaptureKit now returns real images. Do not tell the model to
    // stop using vision while returning a validated screenshot from that API.
    if (captured.helperGeneration === this.helperGeneration) {
      this.captureVerified = true;
      const cached = this.capabilityCache;
      if (cached) {
        this.capabilityCache = { ...cached, value: { ...cached.value, screenRecording: true } };
      }
      this.setCaptureGranted(true);
    }
    return screenshot;
  }

  /**
   * Records the workspace the desktop just reported, and answers with its
   * origin. The single write path for both halves of the cache, so the origin
   * every coordinate is translated through and the rectangle every capture is
   * clipped to cannot describe two different moments.
   */
  private rememberWorkspace(workspace: ComputerRect): ComputerPoint {
    const origin = { x: workspace.x, y: workspace.y };
    this.lastOrigin = origin;
    this.lastWorkspaceGlobal = workspace;
    this.workspaceReadAt = this.now();
    return origin;
  }

  /**
   * Workspace geometry in GLOBAL coordinates, from cache while the cache is
   * young enough to still describe this desktop.
   *
   * An action refreshes the cache on its own (it enumerates windows), so the
   * TTL only ever costs the streaming path — which is the one path that would
   * otherwise hold a rectangle from before the user unplugged a display and ask
   * the helper for it twice a second for as long as the pane stayed open.
   */
  private async workspaceRect(): Promise<ComputerRect> {
    const cached = this.lastWorkspaceGlobal;
    if (cached && cached.width > 0 && cached.height > 0) {
      if (this.now() - this.workspaceReadAt < WORKSPACE_GEOMETRY_TTL_MS) return cached;
      // `screen-size` is the helper's display-derived answer, so it is the read
      // that notices a display change. A failed refresh is not worth failing a
      // capture over: the remembered rectangle is still the best guess there is.
      await this.getScreenSize().catch(() => undefined);
      const refreshed = this.lastWorkspaceGlobal;
      return refreshed && refreshed.width > 0 && refreshed.height > 0 ? refreshed : cached;
    }
    const [windows, origin] = await this.readWindows();
    // That read reports the desktop's own workspace, which is the answer; the
    // bounding box of the windows on it is only the fallback for a reply that
    // carried none. Preferring the box regardless meant the first still after a
    // cold start photographed the rectangle the windows happened to occupy
    // instead of the screen.
    const read = this.lastWorkspaceGlobal;
    if (read && read.width > 0 && read.height > 0) return read;
    return shiftRect(workspaceRectFromWindows(windows), origin.x, origin.y);
  }

  private currentOrigin(): ComputerPoint {
    return this.lastOrigin;
  }

  /**
   * A rect off the helper, rejected unless it has area.
   *
   * The parse itself is `parseComputerRect`, shared with every other backend;
   * the only thing added here is the stricter emptiness rule. A zero-sized
   * workspace or capture region is not a degenerate rect to carry forward, it
   * is a helper that answered without knowing, and the callers have a real
   * fallback for that (`workspaceRectFromWindows`).
   */
  private parseWorkspace(value: unknown): ComputerRect | undefined {
    const rect = parseComputerRect(value);
    if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;
    return rect;
  }

  /**
   * The helper's capability probe, cached for `CAPABILITY_CACHE_TTL_MS`.
   *
   * The cache exists because `ComputerManager.publish` asks `availability()`
   * after every action, and each of those asks was a helper round trip to
   * re-read TCC grants and an OS version — state that changes when a human
   * visits System Settings, not between two clicks. The TTL is short enough
   * that a revoked grant still surfaces almost immediately, and the helper
   * exiting drops the cache outright, because a fresh process has to be asked
   * again from scratch.
   *
   * A forced read after a probe that saw a missing grant restarts the helper
   * first. macOS decides a TCC question once per process and answers every
   * later ask from that decision, so a helper that started before the user
   * granted Screen Recording goes on reporting it missing for as long as it
   * lives — which made "grant it, then press Set up" report failure forever.
   * Nothing in the helper survives a restart that matters: every call names its
   * own target and the agent-cursor badge is pushed back on start.
   */
  private async readCapabilities(
    options: { readonly force?: boolean } = {},
  ): Promise<MacHelperCapabilities> {
    const cached = this.capabilityCache;
    if (
      !options.force &&
      cached &&
      this.helper?.running === true &&
      this.now() - cached.at < CAPABILITY_CACHE_TTL_MS
    ) {
      return cached.value;
    }
    if (options.force && cached && this.helper && missingMacPermissions(cached.value).length > 0) {
      // Clears the cache with the process, so the probe `startHelper` runs is
      // itself the forced read and never recurses back into this branch.
      this.invalidateHelper();
      await this.ensureHelper();
      const restarted = this.capabilityCache;
      if (restarted) return restarted.value;
    }
    return this.recordCapabilities(
      parseMacCapabilities(await this.call(MAC_HELPER_METHODS.capabilities)),
    );
  }

  /**
   * Asks macOS for the grants it is withholding, at most once per grant per
   * helper process.
   *
   * This is the whole point of the feature: the OS dialog appears the moment an
   * agent needs the grant, attributed to Synara (TCC files a helper's request
   * against its responsible process — the app — see the helper's
   * Capability.swift). Nothing waits for the answer, because the answer is a
   * human deciding at a dialog and the tool call that triggered this has already
   * failed.
   *
   * The throttle is not politeness. macOS shows the Screen Recording prompt once
   * per app and silently returns false afterwards, but the Accessibility prompt
   * reappears on *every* request — so an unthrottled ask from `missingPermissions()`,
   * which the tool surface consults on every single call, would stack a dialog
   * per action on top of the user. One ask per grant per helper process is
   * enough for the first-need case, and pressing "Set up" re-arms it explicitly
   * (as does a helper restart, which is a fresh process with fresh answers).
   *
   * On an ad-hoc build the ask is preceded by a `tccutil reset` of Synara's own
   * rows for those grants — see `resetStaleAdhocGrants`, without which macOS
   * answers a rebuilt binary's request from a decision it filed against the
   * previous one and never puts a dialog on screen.
   */
  private async requestMissingPermissions(
    missing: readonly ComputerPermission[],
  ): Promise<MacHelperCapabilities | undefined> {
    const pending = missing.filter((permission) => !this.permissionsAsked.has(permission));
    if (pending.length === 0 || this.disposed) return undefined;
    // Marked before the call, so the failure paths this request can travel
    // through — including a `-32000` refusal answered by this same method —
    // cannot loop back into a second ask.
    for (const permission of pending) this.permissionsAsked.add(permission);
    await this.resetStaleAdhocGrants(pending);
    try {
      const payload = asRecord(await this.call(MAC_HELPER_METHODS.requestPermissions));
      // A reply this build cannot read is dropped rather than parsed: every
      // absent field reads as a withheld grant, so believing one would invent
      // missing permissions out of a malformed answer.
      if (
        typeof payload.accessibility !== "boolean" ||
        typeof payload.screenRecording !== "boolean"
      )
        return undefined;
      // Otherwise it is a fresh report, cached like any other probe: the user may
      // have answered the dialog while the call was in flight.
      return this.recordCapabilities(parseMacCapabilities(payload));
    } catch {
      // A helper that cannot be asked is already reported through health; the
      // caller is an action that has its own failure to return.
      return undefined;
    }
  }

  /**
   * Removes Synara's own TCC rows for the grants it is about to ask for, on an
   * ad-hoc build only.
   *
   * On such a build a missing grant has exactly two possible causes, and both
   * are cured by the same command: either the user has never granted it — in
   * which case there is no row and the reset is a no-op — or they granted it to
   * a *previous* binary, and macOS pinned that grant to a cdhash this build no
   * longer has. In the second case System Settings shows Synara switched on, the
   * helper reports the grant missing, and macOS will not prompt again while the
   * row stands: the ask below silently returns false forever. Removing the row
   * is the only thing that makes the dialog appear, and it can only remove a
   * decision the user is being asked to make again anyway.
   *
   * Never on a signed build. A Developer ID signature keys on identifier plus
   * team and survives rebuilds, so a missing grant there is simply not granted —
   * and throwing away a release user's real permission to re-ask for it would be
   * vandalism, not self-healing.
   *
   * `tccutil` needs no privilege for the caller's own bundle id (it refuses an
   * unknown one with OSStatus -10814), and the service names are the command's,
   * not the labels: Screen Recording is `ScreenCapture`. A failure is ignored —
   * the ask that follows is still worth making, and this is a repair attempt,
   * not a precondition.
   */
  private async resetStaleAdhocGrants(missing: readonly ComputerPermission[]): Promise<void> {
    const cached = this.capabilityCache?.value;
    if (cached?.signature !== "adhoc") return;
    // Which app macOS holds responsible for this helper's grants, as the
    // desktop shell that spawned this server reported it. Never assumed: the
    // `.dev` and `.canary` flavors are separate bundle identifiers with their
    // own TCC rows, so guessing the production one both fails to repair the row
    // that is actually stale and throws away a separately installed release
    // build's real permissions. A server with no desktop behind it — a CLI run,
    // a test — has no responsible app at all, and leaves TCC alone.
    const bundleId = responsibleDesktopBundleId(this.env);
    if (!bundleId) return;
    // Narrowed to what the probe actually reports missing, which is wider than
    // it looks: a live refusal offers *both* grants when it cannot say which
    // one it wanted, and resetting a row the helper can see is granted would
    // take a working permission off a developer to fix a different one.
    const stale = missingMacPermissions(cached);
    for (const permission of missing.filter((candidate) => stale.includes(candidate))) {
      const service = TCC_SERVICE_NAMES[permission];
      try {
        const result = await this.run("tccutil", ["reset", service, bundleId], {
          timeoutMs: TCC_RESET_TIMEOUT_MS,
        });
        if (result.code !== 0) {
          console.debug(
            `synara: tccutil reset ${service} exited ${result.code}: ${result.stderr.trim()}`,
          );
        }
      } catch (error) {
        console.debug(
          `synara: tccutil reset ${service} could not run: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Caches a fresh report and folds it into health. */
  private recordCapabilities(capabilities: MacHelperCapabilities): MacHelperCapabilities {
    // A true-to-false preflight transition is a revocation, not the stale
    // negative seen after an in-process grant. Actual capture denial also
    // clears the observation below, and a helper restart forgets it entirely.
    if (this.capturePreflight === true && !capabilities.screenRecording) {
      this.captureVerified = false;
    }
    this.capturePreflight = capabilities.screenRecording;
    capabilities = {
      ...capabilities,
      screenRecording: capabilities.screenRecording || this.captureVerified,
    };
    this.capabilityCache = { value: capabilities, at: this.now() };
    this.setCaptureGranted(capabilities.screenRecording);
    this.setBackgroundInputDegraded(!capabilities.skylight.keyWindowRecord);
    return capabilities;
  }

  /** Records whether input can reach a background window, publishing on a change. */
  private setBackgroundInputDegraded(degraded: boolean): void {
    if (this.backgroundInputDegraded === degraded) return;
    this.backgroundInputDegraded = degraded;
    this.publishHealth();
  }

  /** The remembered build failure, unless it has aged out of its TTL. */
  private currentBuildFailure(): string | undefined {
    const failure = this.buildFailure;
    if (!failure) return undefined;
    if (this.now() - failure.at < BUILD_FAILURE_TTL_MS) return failure.message;
    this.buildFailure = undefined;
    return undefined;
  }

  private async callCapture(request: {
    readonly kind: "window" | "region";
    readonly windowId?: string;
    readonly region?: ComputerRect;
    readonly maxDimension: number;
  }): Promise<MacCapturedImage> {
    const params: Record<string, unknown> = {
      kind: request.kind,
      maxDimension: request.maxDimension,
    };
    if (request.kind === "window") params.windowId = request.windowId;
    if (request.region) params.region = request.region;
    const helperGeneration = this.helperGeneration;
    const payload = asRecord(await this.callCaptureMethod(params));
    return this.decodeCapture(payload, helperGeneration);
  }

  private decodeCapture(
    payload: Record<string, unknown>,
    helperGeneration: number,
  ): MacCapturedImage {
    // The helper names the ScreenCaptureKit path it actually used, and it falls
    // back when the fast one is unavailable. Counting the answers is what makes
    // the fallback rate a number somebody can look at instead of a guess.
    const source = asString(payload.source);
    if (source !== undefined) {
      this.sourceCounts.set(source, (this.sourceCounts.get(source) ?? 0) + 1);
    }
    const base64 = asString(payload.base64);
    if (!base64) {
      throw new ComputerBackendError("The macOS capture returned no image data.");
    }
    const bytes = Buffer.from(base64, "base64");
    return { bytes, base64, region: this.parseWorkspace(payload.region), helperGeneration };
  }

  /**
   * The capture round trip, with the one failure that means more than itself:
   * a permission refusal is the desktop saying Screen Recording is gone, which
   * `availability()` alone would not notice until someone asked again. Health
   * follows the live answer, and the next capability read puts it back.
   */
  private async callCaptureMethod(params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.call(MAC_HELPER_METHODS.capture, params);
    } catch (error) {
      if (helperErrorCode(error) === HELPER_PERMISSION_DENIED_CODE) {
        this.captureVerified = false;
        // The refusal is a live contradiction of whatever the probe last said,
        // and it is itself a report: Screen Recording is not granted, proven by
        // a call that just tried to use it. Recorded as such rather than by
        // dropping the cache — an empty cache reads as "nobody has looked",
        // which is exactly the answer `missingPermissions()` gives, so throwing
        // it away meant the tool surface learned a grant was gone and
        // immediately reported that nothing was missing. The report is stamped
        // now, so the ordinary TTL still lets a grant the user restores in
        // System Settings be noticed on the next read.
        //
        // Stamped already-expired rather than fresh, so the next reader still
        // re-probes: the refusal is the truth about this instant, not a licence
        // to keep answering from it once the user has been to System Settings.
        const known = this.capabilityCache?.value;
        if (known) {
          this.capabilityCache = {
            value: { ...known, screenRecording: false },
            at: this.now() - CAPABILITY_CACHE_TTL_MS,
          };
        }
        this.setCaptureGranted(false);
      }
      throw error;
    }
  }

  /** Records the live Screen Recording grant, publishing health when it moved. */
  private setCaptureGranted(granted: boolean): void {
    if (this.captureGranted === granted) return;
    this.captureGranted = granted;
    this.publishHealth();
  }

  /**
   * Ensures the helper is up, sends one request, and normalizes failures.
   *
   * A transport-level failure (the helper process exited, a Screen Recording
   * prompt killed it) invalidates the connection so the next call rebuilds and
   * respawns — the macOS twin of the KWin reconnect, but lazy: the helper is
   * cheap to respawn, so a timer loop earns nothing.
   */
  private async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    assertDesktopOperationActive();
    const helper = await this.ensureHelper();
    assertDesktopOperationActive();
    try {
      return await helper.request(method, params, { signal: desktopOperationSignal() });
    } catch (error) {
      const record = asRecord(error);
      const code = typeof record.code === "string" ? record.code : "";
      if (HELPER_CONNECTION_FAILURE_CODES.has(code)) {
        this.invalidateHelper();
        this.recordHealthFailure(error);
        this.publishHealth();
        throw new ComputerBackendError(error instanceof Error ? error.message : String(error), {
          retryable: true,
          cause: error,
        });
      }
      if (error instanceof ComputerBackendError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (code === HELPER_INACTIVE_SPACE_CODE) {
        const windowId = typeof params.windowId === "string" ? params.windowId : undefined;
        throw new ComputerBackendError(message, {
          cause: error,
          inputPause: {
            ...(windowId ? { windowId } : {}),
            message: clampComputerMessage(message, "The target window is unavailable for input."),
          },
        });
      }
      if (code === HELPER_PERMISSION_DENIED_CODE) {
        // The one failure the agent cannot recover from by trying something
        // else: macOS is withholding Screen Recording or Accessibility from
        // Synara, and only the human can grant it. Marking it is what raises
        // the chat's setup card instead of burying the reason in a tool error.
        //
        // The refusal is also the most reliable moment to ask: a live call just
        // proved the grant is absent. The helper prompts only for what it is
        // actually missing, so when the last probe cannot say which grant that
        // was — a refusal can arrive before any probe, or contradict one — both
        // are offered and macOS decides.
        void this.requestMissingPermissions(this.deniedPermissions());
        throw new ComputerBackendError(message, { setupRequired: true, cause: error });
      }
      if (code === HELPER_NOT_DELIVERED_CODE) {
        // The helper exhausted its ladder and injected nothing, which is a
        // refusal rather than a fault. Naming the declined call is what lets
        // `ComputerManager.injectScoped` say "refused, nothing injected"
        // instead of leaving the caller to assume the control is broken.
        throw new ComputerBackendError(message, { rejectedOperation: method, cause: error });
      }
      if (code === HELPER_TARGET_MISSING_CODE) {
        const windowId = typeof params.windowId === "string" ? params.windowId : undefined;
        if (windowId !== undefined) {
          throw new ComputerBackendError(
            `No desktop window has id ${JSON.stringify(windowId)}. ` +
              "Call computer_list_windows for the current window ids.",
            { cause: error },
          );
        }
        if (KEYBOARD_METHODS.has(method)) {
          // Nothing was typed, and repeating the call cannot change that — the
          // caller has to aim first. Saying so plainly is the difference between
          // one corrective action and a retry loop against a refusal that names
          // a window id nobody supplied.
          throw new ComputerBackendError(
            "No window is aimed for keyboard input, so nothing was typed. Click into the " +
              "window you mean, or pass its window_id with the keyboard action, and send the " +
              "input again. Repeating it without aiming will refuse the same way.",
            { rejectedOperation: method, cause: error },
          );
        }
        throw new ComputerBackendError(message, { cause: error });
      }
      if (code === HELPER_INVALID_PARAMS_CODE) {
        // An argument this helper cannot act on: an unknown modifier name, a
        // region off every display. Retrying it verbatim can only fail again,
        // so the message has to say what to change rather than read as a fault.
        throw new ComputerBackendError(
          `The macOS desktop rejected the arguments to ${method}: ${message}`,
          { cause: error },
        );
      }
      throw new ComputerBackendError(message, { cause: error });
    }
  }

  private async ensureHelper(): Promise<MacHelperTransport> {
    if (this.disposed) throw new ComputerBackendError("macOS computer backend is disposed.");
    if (this.helper?.running) return this.helper;
    this.helperPromise ??= this.startHelper().finally(() => {
      this.helperPromise = undefined;
    });
    return await this.helperPromise;
  }

  private async startHelper(): Promise<MacHelperTransport> {
    // The remembered failure is honoured here, not only by the passive probe.
    // Without this an action path went straight back into `resolveBinary`, and a
    // Mac whose helper cannot compile re-ran a five-minute Swift build for every
    // publish — which is every action — while answering each one with the same
    // error it already knew. `provision()` clears the memory explicitly, which
    // is how the user asks for another attempt, and it ages out on its own.
    const remembered = this.currentBuildFailure();
    if (remembered) {
      // Not recorded as a fresh health failure: nothing new went wrong, and
      // counting one per call would turn `consecutiveFailures` into a call
      // counter for as long as the memory stands.
      throw new ComputerBackendError(remembered);
    }
    let binaryPath: string;
    try {
      binaryPath = await (this.binaryPromise ??= this.resolveBinary(this.shutdown.signal).finally(
        () => {
          this.binaryPromise = undefined;
        },
      ));
    } catch (error) {
      if (error instanceof MacHelperBuildError) {
        this.buildFailure = { message: error.message, at: this.now() };
      }
      this.recordHealthFailure(error);
      this.publishHealth();
      throw error instanceof ComputerBackendError
        ? error
        : new ComputerBackendError(error instanceof Error ? error.message : String(error), {
            cause: error,
          });
    }
    this.buildFailure = undefined;
    const helper = this.makeHelperClient({
      binaryPath,
      env: this.env,
      onExit: () => {
        if (this.helper === helper) this.invalidateHelper();
        this.publishHealth();
      },
    });
    helper.start();
    this.helper = helper;
    // A dispose that raced this start would otherwise leave the child running
    // with nothing holding it: `dispose()` already ran and saw no helper.
    if (this.disposed) {
      await helper.dispose().catch(() => undefined);
      this.helper = undefined;
      throw new ComputerBackendError("macOS computer backend is disposed.");
    }
    // Establish the TCC grants here, where the helper comes up, so every path
    // that starts it knows whether capture is allowed. Learning this only from
    // `availability()` meant a stream attached through another path published
    // no frames at all, because `captureGranted` was still false.
    let capabilities: MacHelperCapabilities | undefined;
    let probeFailure: unknown;
    try {
      capabilities = await this.readCapabilities({ force: true });
    } catch (error) {
      // A probe that merely could not be answered — an unknown method on an odd
      // build — is not a reason to refuse the helper, so the error is held
      // rather than thrown, and only the check below decides.
      probeFailure = error;
    }
    // The probe runs through `call()`, whose transport-failure branch disposes
    // the helper and clears `this.helper`. Returning it anyway handed every
    // later call a dead client that answered `helper_disposed` — classified
    // non-retryable, and carrying none of the real cause: a `spawn ENOENT`
    // arrived at the user as "Computer helper was shut down". If the probe took
    // the connection down with it, the start failed, and it failed for the
    // reason the probe reported.
    if (this.helper !== helper || !helper.running) {
      if (this.helper === helper) this.helper = undefined;
      await helper.dispose().catch(() => undefined);
      const failure =
        probeFailure instanceof ComputerBackendError
          ? probeFailure
          : new ComputerBackendError(
              probeFailure instanceof Error
                ? probeFailure.message
                : "The macOS computer-use helper stopped while it was starting.",
              { retryable: true, ...(probeFailure === undefined ? {} : { cause: probeFailure }) },
            );
      // The cause where there is one: `call()` already counted the raw
      // transport error, and the health counters de-duplicate an outage by
      // object identity, so recording the wrapper instead would count this one
      // failure twice.
      this.recordHealthFailure(failure.cause ?? failure);
      this.publishHealth();
      throw failure;
    }
    // Recorded here, not before the probe: a helper that never answered one is
    // not a connection, and counting it as one made the next real start look
    // like a reconnect from an outage that never happened.
    this.healthState.recordConnected();
    // The helper and this server ship together, so a protocol mismatch is never
    // a version to negotiate — it is a stale binary (a cached development build
    // from before a wire change, most often) answering today's calls with
    // yesterday's shapes. Failing here names that; letting it run would surface
    // as unexplainable desktop misbehaviour instead.
    if (capabilities && capabilities.protocolVersion !== SUPPORTED_HELPER_PROTOCOL_VERSION) {
      await helper.dispose().catch(() => undefined);
      if (this.helper === helper) this.helper = undefined;
      this.capabilityCache = undefined;
      const failure = new ComputerBackendError(
        `The macOS computer-use helper speaks protocol ${capabilities.protocolVersion ?? "(none)"}, ` +
          `but this build of Synara speaks ${SUPPORTED_HELPER_PROTOCOL_VERSION}. ` +
          "Delete ~/Library/Caches/synara/computer-helper and try again, or reinstall Synara.",
      );
      this.recordHealthFailure(failure);
      this.publishHealth();
      throw failure;
    }
    // Push the cached badge name onto the fresh session so a reconnect brings
    // the agent cursor back naming the same thread.
    if (this.drivingAgent || this.cursorActivity) {
      await helper
        .request(MAC_HELPER_METHODS.setAgentCursor, {
          name: this.drivingAgent ?? "",
          activity: this.cursorActivity ?? "",
        })
        .catch(() => undefined);
    }
    this.publishHealth();
    return helper;
  }

  private invalidateHelper(): void {
    this.helperGeneration += 1;
    this.captureVerified = false;
    this.capturePreflight = undefined;
    this.setCaptureGranted(false);
    const helper = this.helper;
    this.helper = undefined;
    // A fresh helper process has to answer the capability probe from scratch:
    // the grants it can see are its own, not the dead process's.
    this.capabilityCache = undefined;
    // And it gets its own chance to ask. The throttle exists to stop a dialog
    // per tool call within one process; a new process is a new decision by
    // macOS, and re-arming here is what lets a restart-and-retry prompt again.
    this.permissionsAsked.clear();
    void helper?.dispose().catch(() => undefined);
  }

  private recordHealthFailure(error: unknown): void {
    this.healthState.recordFailure(error);
  }

  private publishHealth(): void {
    this.healthState.publish();
  }

  private emit(event: Parameters<ComputerBackendEventListener>[0]): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // One observer must not prevent the others from seeing an update.
      }
    }
  }
}
