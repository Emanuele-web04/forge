// FILE: main.ts
// Purpose: Starts the Electron shell, backend process, native menus, IPC bridges, and updater.
// Layer: Desktop main process
// Depends on: Electron, backend startup helpers, browser manager, and update runtime.

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
// Electron-only builtin that sees app.asar as a real file instead of a virtual
// directory — required to stat the archive itself for swap detection.
import * as OriginalFS from "original-fs";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
} from "electron";
import type {
  BrowserWindowConstructorOptions,
  FileFilter,
  IpcMainEvent,
  MenuItemConstructorOptions,
} from "electron";
import * as Effect from "effect/Effect";
import type {
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@synara/contracts";
import {
  autoUpdater,
  BaseUpdater,
  CancellationToken,
  type UpdateDownloadedEvent,
} from "electron-updater";

import type { ContextMenuItem } from "@synara/contracts";
import { isKeyboardShortcutsHelpChord } from "@synara/shared/browserShortcuts";
import { getMacTrafficLightPosition } from "@synara/shared/desktopChrome";
import {
  SYNARA_DESKTOP_UPDATE_CHANNEL,
  resolveSynaraDesktopFlavor,
  synaraDesktopIdentity,
} from "@synara/shared/desktopIdentity";
import { NetService } from "@synara/shared/Net";
import { applyShellEnvironmentHydrationMarker } from "@synara/shared/shell";
import { RotatingFileSink } from "@synara/shared/logging";
import { ensureStaticSnapshot, findAsarArchivePath } from "@synara/shared/staticSnapshot";
import { isBackendReadinessAborted, waitForHttpReady } from "./backendReadiness";
import { resolveBackendNodeArgs } from "./backendNodeOptions";
import {
  retainLiveBackendAfterShutdownFailure,
  requireWindowsBackendExit,
  runAfterDesktopShutdown,
  shouldDeferDesktopWindowClose,
  stopPosixBackendAndWait,
  stopWindowsBackendAndWait,
} from "./backendShutdown";
import {
  bundleSignatureFromStats,
  isBundleStable,
  isBundleSwapped,
  isWatchableBundlePath,
  type BundleSignature,
} from "./bundleSwapDetection";
import { waitForBackendStartupReady } from "./backendStartupReadiness";
import { showDesktopConfirmDialog } from "./confirmDialog";
import {
  makeUpdateInstallPreparationCoordinator,
  type UpdateInstallPreparationAttempt,
} from "./updateInstallPreparation";
import {
  hasPendingDesktopMigrationRecovery,
  requiresDesktopMigrationRecovery,
  recoverDesktopMigrationIfRequired,
  resolveDesktopMigrationRecoveryPaths,
  restoreDesktopMigrationBackup,
  type DesktopMigrationRecoveryDecision,
  type DesktopMigrationRecoveryOutcome,
  type DesktopMigrationRecoveryPaths,
} from "./desktopMigrationRecovery";
import {
  LSREGISTER_PATH,
  parseLastLaunchVersion,
  resolveLaunchVersionRecordPath,
  resolveMacAppBundlePath,
  serializeLaunchVersionRecord,
  shouldRefreshIconCache,
} from "./macIconCacheRefresh";
import { collectMacUpdateDiagnostics } from "./macUpdateDiagnostics";
import { openInitialBackendWindow } from "./initialBackendWindowOpen";
import { isTrustedMediaPermissionRequest } from "./mediaPermissions";
import {
  installResumableUpdateDownloader,
  type ResumableDownloaderTarget,
} from "./resumableUpdateDownload";
import { hardenElectronUpdater } from "./electronUpdaterSecurity";
import { ServerListeningDetector } from "./serverListeningDetector";
import { BackendStartupBlockDetector, type BackendStartupBlock } from "./backendStartupBlock";
import {
  BACKEND_MAX_CONSECUTIVE_START_FAILURES,
  BackendOutputTailDetector,
  BackendSupervisionPolicy,
  summarizeBackendFailureOutput,
} from "./backendSupervisionPolicy";
import { captureBackendProcessOutput } from "./backendProcessOutput";
import { syncShellEnvironment } from "./syncShellEnvironment";
import {
  RENDERER_MAX_AUTOMATIC_RELOADS,
  RendererCrashPolicy,
  type RendererCrashResponse,
} from "./rendererCrashRecovery";
import {
  type DownloadProgressSample,
  getAutoUpdateDisabledReason,
  getDownloadStallTimeoutMessage,
  hasDownloadProgressAdvanced,
  isExpectedStalledDownloadCancellationError,
  isUpdateVersionNewer,
  shouldBroadcastDownloadProgress,
  shouldCheckForUpdatesOnForeground,
} from "./updateState";
import { registerDesktopVoiceTranscriptionHandler } from "./voiceTranscription";
import {
  applyDesktopPhysicalZoomAction,
  resolveDesktopMenuAccelerator,
  resolveDesktopPhysicalZoomAction,
  resolveKeyboardShortcutsMenuAccelerator,
  shouldUseNativeZoomMenuRoles,
} from "./menuShortcuts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnInstallRestartFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import {
  PendingUpdateCacheClearQueue,
  resolveElectronUpdaterCacheDirName,
  resolveElectronUpdaterLegacyZipPath,
  resolveElectronUpdaterPendingCacheDir,
} from "./updatePendingCache";
import {
  clearInstallMarker,
  createUpdateInstallMarker,
  markInstallHandoffSync,
  readInstallMarker,
  recordInstallMarkerFailureSync,
  resolveInstallMarkerOutcome,
  writeInstallMarker,
  type UpdateInstallHandoffExpectation,
  type UpdateInstallMarker,
} from "./updateInstallMarker";
import {
  fingerprintUpdateArtifact,
  verifyUpdateArtifactIdentity,
  type UpdateArtifactIdentity,
} from "./updateArtifactIdentity";
import { buildGitHubReleasesPageUrl, resolveGitHubUpdateSource } from "./githubUpdateFeed";
import { isArm64HostRunningIntelBuild, resolveDesktopRuntimeInfo } from "./runtimeArch";
import { BROWSER_SESSION_PARTITION, DesktopBrowserManager } from "./browserManager";
import {
  registerBrowserIpcHandlers,
  sendBrowserAnnotationEvent,
  sendBrowserCopyLink,
  sendBrowserState,
} from "./browserIpc";
import {
  BrowserHostPipeServer,
  SYNARA_BROWSER_HOST_PIPE_PATH,
  resolveBrowserHostPipeBackendEnv,
} from "./browserUsePipeServer";
import { normalizeDesktopWsUrl, resolveDesktopWsUrlFromEnv } from "./desktopWsBridge";
import {
  repairBrowserProfileFromBridgeManifest,
  resolveDesktopAppDataBase,
  resolveDesktopUserDataPath,
} from "./desktopUserDataProfile";
import { isBrokenPipeError } from "./desktopProcessErrors";
import { createDesktopStaticProtocolResolver } from "./desktopStaticProtocol";
import {
  readDesktopWindowState,
  resolveVisibleWindowBounds,
  writeDesktopWindowState,
} from "./windowState";
import {
  acknowledgeSynaraStorageSnapshot,
  readSynaraStorageSnapshot,
  resolveSynaraStorageSnapshotPath,
} from "./desktopStorageMigration";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { DesktopAppSnapManager } from "./appSnapManager";
import { hardenBrowserAnnotationWebviewPreferences } from "./browserAnnotations/webviewSecurity";
import { LOCAL_HTML_PREVIEW_SCHEME } from "./localHtmlPreviewProtocol";
import {
  registerAppSnapIpcHandlers,
  sendAppSnapCaptured,
  sendAppSnapError,
  sendAppSnapState,
} from "./appSnapIpc";

// Capture the real archive identity before any explicit app.asar lookup. Static
// snapshotting and the runtime watcher both use this same generation as their
// baseline, so a replacement during startup cannot silently become "normal."
const startupBundleIdentity = captureStartupBundleIdentity();

// Deliberately still on the pre-`whenReady()` path. On posix it is normally a cache read
// (see `createCachedLoginShellEnvironmentReader`); only a first launch, a changed shell
// startup file, or an aged-out entry pays the ~1s login-shell probe again.
// The reads a few lines below decide where this install's data lives, and two of them
// depend on what this probe brings in: `resolveUserDataPath()` takes the Electron profile
// directory from XDG_CONFIG_HOME on Linux, which the login-shell probe captures, and
// `BASE_DIR` prefers SYNARA_HOME, which the Windows registry read hydrates whenever the
// user set it persistently. Resolving either against an unhydrated environment would
// silently relocate an existing user's profile and data directory.
// (The probe also carries PATH, SSH_AUTH_SOCK and HOMEBREW_* for later provider spawns.
// APPDATA on Windows is inherited from the process env, not hydrated here.)
const shellEnvironmentSync = syncShellEnvironment();

const IPC = DESKTOP_IPC_CHANNELS;
const MAX_CLIPBOARD_IMAGE_DATA_URL_LENGTH = 16 * 1024 * 1024;
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const desktopFlavor = resolveSynaraDesktopFlavor({
  isDevelopment,
  requestedFlavor: process.env.SYNARA_DESKTOP_FLAVOR,
});
const desktopIdentity = synaraDesktopIdentity(desktopFlavor);
const BASE_DIR =
  process.env.SYNARA_HOME?.trim() ||
  Path.join(OS.homedir(), desktopIdentity.defaultHomeDirectoryName);
const STATE_DIR = Path.join(BASE_DIR, "userdata");
const DESKTOP_WINDOW_STATE_PATH = Path.join(STATE_DIR, "desktop-window-state.json");
const DESKTOP_SCHEME = desktopIdentity.scheme;
const ROOT_DIR = Path.resolve(__dirname, "../../..");
const APP_DISPLAY_NAME = desktopIdentity.displayName;
const APP_USER_MODEL_ID = desktopIdentity.bundleId;
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = Path.join(STATE_DIR, "logs");
const DESKTOP_LOG_FILE_NAME = "desktop-main.log";
const BACKEND_LOG_FILE_NAME = "server-child.log";
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const DESKTOP_BACKEND_SHUTDOWN_TOKEN = Crypto.randomBytes(32).toString("hex");
const DESKTOP_BROWSER_HOST_CAPABILITY = Crypto.randomBytes(32).toString("base64url");
const DESKTOP_BROWSER_HOST_CAPABILITY_FD = 3;
// Electron's single-instance lock is scoped through userData on Windows/Linux.
// Set the flavor-specific profile first so Stable, Dev, and Canary never contend
// for the same lock even when they use the same Electron executable.
const userDataPath = resolveUserDataPath();
app.setPath("userData", userDataPath);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const AUTO_UPDATE_FOREGROUND_RECHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_UPDATE_FOREGROUND_RECHECK_MIN_BACKGROUND_MS = 30 * 1000;
const AUTO_UPDATE_CHECK_TIMEOUT_MS = 45 * 1000;
const AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS = 60 * 1000;
// Upper bound on how long we wait for electron-updater to release a cancelled
// download before allowing a retry, so a wedged updater promise can't block updates.
const AUTO_UPDATE_DOWNLOAD_SETTLE_TIMEOUT_MS = 20 * 1000;
const AUTO_UPDATE_STALLED_DOWNLOAD_CANCELLATION_SUPPRESSION_MS = 2 * 60 * 1000;
// How long we give quitAndInstall() to actually quit/relaunch the app before we
// conclude the OS installer never started (unsigned/quarantined build, read-only
// install dir, blocked NSIS run) and surface the manual-download fallback.
const AUTO_UPDATE_INSTALL_WATCHDOG_MS = 15 * 1000;
const AUTO_UPDATE_DIAGNOSTICS_TIMEOUT_MS = 2_800;
// User-driven like the menu and renderer reasons, so it must not be filtered
// out by the automatic-activity suppression a previous install failure arms.
const UPDATE_CHECK_REASON_MIGRATION_RECOVERY = "migration recovery";
const UPDATE_INSTALL_MARKER_FILE_NAME = "pending-update-install.json";
const BACKEND_FORCE_KILL_DELAY_MS = 8_000;
const BACKEND_SHUTDOWN_TIMEOUT_MS = 10_000;
const BACKEND_MAX_OLD_SPACE_ENV_KEYS = ["SYNARA_BACKEND_MAX_OLD_SPACE_MB"] as const;
const DESKTOP_UPDATE_ALLOW_PRERELEASE = false;
const BROWSER_PERF_SAMPLE_INTERVAL_MS = 5_000;
const DESKTOP_MENU_ZOOM_FACTOR_STEP = 1.1;
const DESKTOP_MENU_MIN_ZOOM_FACTOR = 0.25;
const DESKTOP_MENU_MAX_ZOOM_FACTOR = 5;
const SYNARA_BROWSER_LABEL = "Synara browser";
const browserPerfLoggingEnabled = process.env.SYNARA_BROWSER_PERF === "1";

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess.ChildProcess | null = null;
let backendPort = 0;
let backendAuthToken = "";
let backendHttpUrl = "";
let backendWsUrl = "";
let backendReadinessAbortController: AbortController | null = null;
let backendInitialWindowOpenInFlight: Promise<void> | null = null;
// Guards every blocking backend-lifecycle dialog (startup block, give-up) so a
// crash loop can never stack modal windows on top of each other.
let backendLifecycleDialogInFlight: Promise<void> | null = null;
let backendListeningDetector: ServerListeningDetector | null = null;
const backendSupervision = new BackendSupervisionPolicy();
// Survives window recreation on purpose: a renderer that keeps dying must not refill
// its reload budget just because the crash produced a new window.
const rendererCrashPolicy = new RendererCrashPolicy();
let rendererCrashDialogInFlight: Promise<void> | null = null;
let lastBackendFailureDetail: string | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let isUpdaterInstallPreparing = false;
let isUpdaterQuitAndInstallInFlight = false;
const updateInstallPreparation = makeUpdateInstallPreparationCoordinator();
let desktopShutdownPromise: Promise<void> | null = null;
let desktopStartupBlockedForMigrationRecovery = false;
let desktopShutdownComplete = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let appUpdateYmlCache: Record<string, string> | null | undefined;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;
let unreadBackgroundNotificationCount = 0;
let browserPerfInterval: ReturnType<typeof setInterval> | null = null;
const browserManager = new DesktopBrowserManager({
  beforeInputEvent: (event, input) => {
    if (
      isKeyboardShortcutsHelpChord(
        {
          type: input.type,
          key: input.key,
          code: input.code,
          meta: input.meta,
          ctrl: input.control,
          shift: input.shift,
          alt: input.alt,
          repeat: input.isAutoRepeat,
        },
        {
          isMac: process.platform === "darwin",
          isWindows: process.platform === "win32",
        },
      )
    ) {
      event.preventDefault();
      dispatchMenuAction("show-shortcuts");
      return true;
    }

    const target = resolveMenuTargetWindow()?.webContents;
    return target ? handleDesktopPhysicalZoomShortcut(event, input, target) : false;
  },
});
let browserHostPipeServer: BrowserHostPipeServer | null = null;
let appSnapManager: DesktopAppSnapManager | null = null;
let configuredUpdaterCacheDirName: string | null = null;

browserManager.subscribe((state) => {
  sendBrowserState(mainWindow?.webContents, state);
});

browserManager.subscribeCopyLink((event) => {
  sendBrowserCopyLink(mainWindow?.webContents, event);
});

browserManager.subscribeAnnotationEvents((event) => {
  sendBrowserAnnotationEvent(mainWindow?.webContents, event);
});

function startBrowserPerformanceLogging(): void {
  if (browserPerfInterval || !browserPerfLoggingEnabled) {
    return;
  }

  browserPerfInterval = setInterval(() => {
    const snapshot = browserManager.getPerformanceSnapshot();
    const trackedProcessIds = new Set(snapshot.trackedProcessIds);
    const processMetrics = app
      .getAppMetrics()
      .filter((metric) => trackedProcessIds.has(metric.pid))
      .map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        cpu: Number(metric.cpu.percentCPUUsage.toFixed(1)),
        memMb: Math.round(metric.memory.workingSetSize / 1024),
        name: metric.name,
      }));

    console.info(`[${SYNARA_BROWSER_LABEL} perf]`, {
      ...snapshot.counters,
      trackedProcessIds: snapshot.trackedProcessIds,
      processes: processMetrics,
    });
  }, BROWSER_PERF_SAMPLE_INTERVAL_MS);
  browserPerfInterval.unref();
}

async function ensureBrowserHostPipeServer(): Promise<void> {
  if (browserHostPipeServer || !SYNARA_BROWSER_HOST_PIPE_PATH) {
    return;
  }
  const server = new BrowserHostPipeServer(browserManager, {
    capability: DESKTOP_BROWSER_HOST_CAPABILITY,
    requestOpenPanel: (threadId) => {
      if (!threadId) return;
      mainWindow?.webContents.send(IPC.browser.requestOpenPanel, { threadId });
    },
  });
  await server.start();
  browserHostPipeServer = server;
}

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});
const initialUpdateState = (): DesktopUpdateState =>
  createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo);

function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

function safeConsoleError(...args: Parameters<typeof console.error>): void {
  try {
    console.error(...args);
  } catch (error: unknown) {
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }

  return null;
}

function getDesktopWindowState(window: BrowserWindow): {
  isMaximized: boolean;
  isFullscreen: boolean;
} {
  return {
    isMaximized: window.isMaximized(),
    isFullscreen: window.isFullScreen(),
  };
}

function emitDesktopWindowState(window: BrowserWindow | null = mainWindow): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.windowState, getDesktopWindowState(window));
}

function isSaveFileInput(input: unknown): input is {
  defaultFilename: string;
  contents: string;
  filters?: FileFilter[];
} {
  if (!input || typeof input !== "object") {
    return false;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.defaultFilename !== "string" || record.defaultFilename.trim().length === 0) {
    return false;
  }
  if (typeof record.contents !== "string") {
    return false;
  }
  if (record.filters === undefined) {
    return true;
  }
  if (!Array.isArray(record.filters)) {
    return false;
  }
  return record.filters.every((filter) => {
    if (!filter || typeof filter !== "object") return false;
    const filterRecord = filter as Record<string, unknown>;
    return (
      typeof filterRecord.name === "string" &&
      Array.isArray(filterRecord.extensions) &&
      filterRecord.extensions.every((extension) => typeof extension === "string")
    );
  });
}

async function waitForBackendHttpReady(
  baseUrl: string,
  options?: Parameters<typeof waitForHttpReady>[1],
): Promise<void> {
  cancelBackendReadinessWait();
  const controller = new AbortController();
  backendReadinessAbortController = controller;

  try {
    await waitForHttpReady(baseUrl, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    if (backendReadinessAbortController === controller) {
      backendReadinessAbortController = null;
    }
  }
}

function cancelBackendReadinessWait(): void {
  backendReadinessAbortController?.abort();
  backendReadinessAbortController = null;
}

async function reserveBackendEndpoint(reason: string): Promise<void> {
  backendPort = await Effect.service(NetService).pipe(
    Effect.flatMap((net) => net.reserveLoopbackPort()),
    Effect.provide(NetService.layer),
    Effect.runPromise,
  );
  backendHttpUrl = `http://127.0.0.1:${backendPort}`;
  backendWsUrl = `ws://127.0.0.1:${backendPort}/?token=${encodeURIComponent(backendAuthToken)}`;
  process.env.SYNARA_DESKTOP_WS_URL = backendWsUrl;
  writeDesktopLogHeader(`${reason} resolved backend endpoint port=${backendPort}`);
}

async function waitForBackendWindowReady(baseUrl: string): Promise<"listening" | "http"> {
  return await waitForBackendStartupReady({
    listeningPromise: backendListeningDetector?.promise ?? null,
    waitForHttpReady: () =>
      waitForBackendHttpReady(baseUrl, {
        path: "/health",
        timeoutMs: 60_000,
        isReady: async (response) => {
          if (!response.ok) {
            return false;
          }
          try {
            const payload = (await response.json()) as {
              startupReady?: unknown;
            };
            return payload.startupReady === true;
          } catch {
            return false;
          }
        },
      }),
    cancelHttpWait: cancelBackendReadinessWait,
  });
}

function ensureInitialBackendWindowOpen(baseUrl: string): void {
  openInitialBackendWindow({
    isDevelopment,
    baseUrl,
    hasExistingWindow: () => (mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null) !== null,
    createWindow: () => {
      mainWindow = createWindow();
    },
    getReadinessInFlight: () => backendInitialWindowOpenInFlight,
    setReadinessInFlight: (promise) => {
      backendInitialWindowOpenInFlight = promise;
    },
    waitForBackendWindowReady,
    writeLog: writeDesktopLogHeader,
    isReadinessAborted: isBackendReadinessAborted,
    formatErrorMessage,
    warn: (message, error) => {
      console.warn(message, error);
    },
  });
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, DESKTOP_LOG_FILE_NAME),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, BACKEND_LOG_FILE_NAME),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

initializePackagedLogging();

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let activeUpdateCheck: Promise<void> | null = null;
let settleActiveUpdateCheck: (() => void) | null = null;
let activeUpdatePreparation: Promise<void> | null = null;
let updaterConfigured = false;
let updateState: DesktopUpdateState = initialUpdateState();
let updateBackgroundedAtMs: number | null = null;
let updateBackgroundBlurTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let updateDownloadStallTimer: ReturnType<typeof setTimeout> | null = null;
let updateInstallWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
let automaticUpdateActivitySuppressed = false;
let updateDownloadCancellationToken: CancellationToken | null = null;
let rejectUpdateDownloadStall: ((error: Error) => void) | null = null;
let lastUpdateDownloadProgressSample: DownloadProgressSample | null = null;
let stalledDownloadCancellationSuppressionsRemaining = 0;
let stalledDownloadCancellationSuppressionExpiresAtMs = 0;
let downloadedUpdateArtifact: {
  readonly version: string;
  readonly identity: UpdateArtifactIdentity;
} | null = null;
let downloadedUpdateIdentityTask: Promise<void> | null = null;
let activeUpdateInstallHandoff: UpdateInstallHandoffExpectation | null = null;
const pendingUpdateCacheClearQueue = new PendingUpdateCacheClearQueue();

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (isUpdaterInstallPreparing || isUpdaterQuitAndInstallInFlight) return "install";
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

function clearUpdaterInstallInFlightAfterError(input?: {
  readonly preservePendingPreparation?: boolean;
}): boolean {
  const preparationCancelled = updateInstallPreparation.cancel();
  if (preparationCancelled && input?.preservePendingPreparation) {
    return true;
  }
  if (!isUpdaterInstallPreparing && !isUpdaterQuitAndInstallInFlight) {
    return preparationCancelled;
  }
  isUpdaterInstallPreparing = false;
  isUpdaterQuitAndInstallInFlight = false;
  activeUpdateInstallHandoff = null;
  isQuitting = false;
  return preparationCancelled;
}

function clearUpdateInstallWatchdogTimer(): void {
  if (updateInstallWatchdogTimer) {
    clearTimeout(updateInstallWatchdogTimer);
    updateInstallWatchdogTimer = null;
  }
}

function getUpdateInstallMarkerPath(): string {
  return Path.join(app.getPath("userData"), UPDATE_INSTALL_MARKER_FILE_NAME);
}

function recordInstallMarkerFailure(
  nowIso: string,
  expected: UpdateInstallHandoffExpectation | null,
): number {
  if (!expected) {
    console.error(
      "[desktop-updater] Could not record durable install failure without an exact active attempt.",
    );
    return Math.max(1, updateState.installFailureCount + 1);
  }
  const result = recordInstallMarkerFailureSync(getUpdateInstallMarkerPath(), expected, nowIso);
  if (result.status === "missing" || result.status === "invalid") {
    console.error(
      `[desktop-updater] Could not record durable install failure: marker is ${result.status}${result.status === "invalid" ? ` (${result.error})` : ""}.`,
    );
    return Math.max(1, updateState.installFailureCount + 1);
  }
  if (result.status === "mismatch") {
    console.error(
      "[desktop-updater] Refusing to record install failure against a different durable attempt.",
    );
    return Math.max(1, updateState.installFailureCount + 1);
  }
  if (result.status === "write-failed") {
    console.error(
      `[desktop-updater] Failed to persist install failure marker: ${formatErrorMessage(result.error)}`,
    );
  }
  return result.marker.consecutiveFailures;
}

async function logMacUpdateDiagnostics(context: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const diagnostics = await Promise.race([
      collectMacUpdateDiagnostics(APP_USER_MODEL_ID),
      new Promise<string>((resolve) => {
        timeout = setTimeout(
          () => resolve("Diagnostic collection timed out."),
          AUTO_UPDATE_DIAGNOSTICS_TIMEOUT_MS,
        );
      }),
    ]);
    if (diagnostics) {
      console.info(`[desktop-updater] diagnostics (${context})\n${diagnostics}`);
    }
  } catch (error) {
    console.info(
      `[desktop-updater] diagnostics (${context}) unavailable: ${formatErrorMessage(error)}`,
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

// quitAndInstall() is a fire-and-forget void call with no success signal: when
// the OS installer silently fails the app never quits and the user is left with
// no feedback (the "update doesn't work for some people" report). If the process
// is still alive after the watchdog window, recover and surface an actionable
// install failure so the UI can offer the manual-download fallback.
function armInstallWatchdog(): void {
  clearUpdateInstallWatchdogTimer();
  updateInstallWatchdogTimer = setTimeout(() => {
    updateInstallWatchdogTimer = null;
    if (!isUpdaterQuitAndInstallInFlight) {
      return;
    }
    const failedHandoff = activeUpdateInstallHandoff;
    clearUpdaterInstallInFlightAfterError();
    // The backend was already stopped before quitAndInstall(); since the app is
    // not actually quitting, bring it back so the recovered app is functional
    // (renderer reconnects) instead of a zombie window with a dead backend.
    startBackend();
    // Polling was stopped before the install attempt; resume it so background
    // update checks keep running after this recovery.
    scheduleUpdatePoll();
    const consecutiveFailures = recordInstallMarkerFailure(new Date().toISOString(), failedHandoff);
    setUpdateState({
      ...reduceDesktopUpdateStateOnInstallFailure(
        updateState,
        "The update couldn’t be installed automatically.",
      ),
      installFailureCount: consecutiveFailures,
    });
    console.error(
      "[desktop-updater] quitAndInstall did not exit the app within the watchdog window; surfacing manual-download fallback.",
    );
  }, AUTO_UPDATE_INSTALL_WATCHDOG_MS);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: LOCAL_HTML_PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

function resolveAppRoot(): string {
  if (!app.isPackaged) {
    return ROOT_DIR;
  }
  return app.getAppPath();
}

/**
 * Read the baked-in app-update.yml config (if applicable). The file ships inside
 * the package and never changes at runtime, so the parsed result is cached to keep
 * repeated callers off the synchronous-FS path on the main thread.
 */
function readAppUpdateYml(): Record<string, string> | null {
  if (appUpdateYmlCache !== undefined) {
    return appUpdateYmlCache;
  }
  appUpdateYmlCache = parseAppUpdateYml();
  return appUpdateYmlCache;
}

function parseAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

function resolveEmbeddedCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { synaraCommitHash?: unknown };
    return normalizeCommitHash(parsed.synaraCommitHash);
  } catch {
    return null;
  }
}

declare const __SYNARA_WINDOWS_UPDATER_PUBLISHER__: string;

function resolveEmbeddedWindowsPublisherSubjects(): string[] {
  if (!app.isPackaged || process.platform !== "win32") {
    return [];
  }

  const subject = __SYNARA_WINDOWS_UPDATER_PUBLISHER__.trim();
  return subject ? [subject] : [];
}

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(process.env.SYNARA_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/index.mjs");
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

function desktopMigrationRecoveryPaths(): DesktopMigrationRecoveryPaths {
  return resolveDesktopMigrationRecoveryPaths({
    baseDir: BASE_DIR,
    appRoot: resolveAppRoot(),
    isDevelopment,
  });
}

function isDesktopMigrationRecoveryPending(): boolean {
  try {
    // Deliberately not "a marker exists": while the backend still has resume
    // attempts left, a failed start is an ordinary restart, not a recovery
    // prompt. Escalating early would bury the self-heal under a dialog.
    return requiresDesktopMigrationRecovery(desktopMigrationRecoveryPaths());
  } catch (error) {
    // An unreadable marker path must not break crash supervision.
    writeDesktopLogHeader(
      `migration recovery marker check failed message=${formatErrorMessage(error)}`,
    );
    return false;
  }
}

/** Joins user-facing options as "a, b or c". */
function formatRecoveryOptionList(options: ReadonlyArray<string>): string {
  if (options.length <= 1) return options[0] ?? "";
  return `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}`;
}

async function handleDesktopMigrationRecovery(): Promise<DesktopMigrationRecoveryOutcome> {
  const paths = desktopMigrationRecoveryPaths();
  desktopStartupBlockedForMigrationRecovery = true;
  const outcome = await recoverDesktopMigrationIfRequired({
    // The gate opens only once the backend has spent its resume budget, while
    // the post-restore verification checks the marker file itself.
    requiresRecovery: () => requiresDesktopMigrationRecovery(paths),
    markerRemains: () => hasPendingDesktopMigrationRecovery(paths),
    choose: async ({ previousFailure }) => {
      // The user is here because Synara cannot open its database, so the
      // in-app update button is unreachable by definition. A newer build is
      // often the actual fix, and this dialog is the only surface left to
      // offer it from: installing it in place when the updater can reach the
      // feed, and handing over the download page otherwise.
      const releaseUrl = updateState.releaseUrl;
      const canInstallUpdate = canInstallUpdateFromRecovery();
      const restoreFailed = previousFailure?.attempt === "restore";
      const choices: Array<{
        readonly label: string;
        readonly detail: string;
        readonly decision: DesktopMigrationRecoveryDecision;
      }> = [
        restoreFailed
          ? {
              label: "Try restore again",
              detail: "retry the verified backup restore",
              decision: "restore",
            }
          : {
              label: "Restore backup and restart",
              detail: "restore the verified pre-migration backup and restart",
              decision: "restore",
            },
      ];
      if (canInstallUpdate) {
        choices.push({
          label: "Update Synara and restart",
          detail: "install the newest Synara release, which may already contain the fix",
          decision: "install-update",
        });
      }
      if (releaseUrl !== null) {
        choices.push({
          label: "Download latest release",
          detail: `${canInstallUpdate ? "download that release" : "download the latest Synara release"} in a browser`,
          decision: "open-release-page",
        });
      }
      choices.push({
        label: "Quit",
        detail: "quit without opening the database",
        decision: "quit",
      });

      const options = formatRecoveryOptionList(choices.map((choice) => choice.detail));
      const result = await dialog.showMessageBox({
        type: previousFailure === null ? "warning" : "error",
        title:
          previousFailure === null
            ? "Synara needs to recover its database"
            : restoreFailed
              ? "Migration recovery failed"
              : "Synara could not update itself",
        message:
          previousFailure === null
            ? "Synara stopped a database migration before it could finish safely."
            : restoreFailed
              ? "The saved database backup could not be restored."
              : "The newest Synara release could not be installed.",
        detail: `${previousFailure === null ? "" : `${previousFailure.message}\n\n`}You can ${options}. No provider or chat process will start until recovery succeeds.`,
        buttons: choices.map((choice) => choice.label),
        defaultId: 0,
        cancelId: choices.length - 1,
        noLink: true,
      });
      return choices[result.response]?.decision ?? "quit";
    },
    installUpdate: installLatestUpdateForMigrationRecovery,
    openReleasePage: () => {
      const releaseUrl = updateState.releaseUrl;
      if (releaseUrl !== null) void shell.openExternal(releaseUrl);
    },
    restore: () =>
      restoreDesktopMigrationBackup({
        executablePath: process.execPath,
        nodeArgs: backendNodeArgs(),
        paths,
        cwd: resolveBackendCwd(),
        env: process.env,
      }),
    requestRestart: () => app.relaunch(),
    requestQuit: (reason) => requestGracefulAppQuit(reason),
    formatError: formatErrorMessage,
    log: writeDesktopLogHeader,
  });
  if (outcome === "continue") {
    desktopStartupBlockedForMigrationRecovery = false;
  }
  return outcome;
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

interface ServedStaticRoot {
  readonly dir: string;
  /** True when serving a real-disk snapshot instead of reading through the asar. */
  readonly snapshotted: boolean;
}

interface BundleIdentity {
  readonly path: string;
  readonly signature: BundleSignature | null;
}

class BundleChangedDuringStartupError extends Error {
  readonly bundlePath: string;
  readonly baseline: BundleSignature | null;
  readonly current: BundleSignature | null;

  constructor(input: {
    bundlePath: string;
    baseline: BundleSignature | null;
    current: BundleSignature | null;
  }) {
    super("The packaged application changed while its static assets were being prepared.");
    this.name = "BundleChangedDuringStartupError";
    this.bundlePath = input.bundlePath;
    this.baseline = input.baseline;
    this.current = input.current;
  }
}

let servedStaticRootCache: ServedStaticRoot | null | undefined;

// Serving static assets straight out of app.asar is vulnerable to the archive
// being replaced beneath the running app (Electron caches the header per process,
// so every later read returns bytes from the wrong offsets). Extract the client
// to a per-archive snapshot on real disk and serve that instead — both for the
// synara:// protocol here and, via SYNARA_STATIC_DIR, for the backend's HTTP static
// route. Memoized so one app run serves one coherent asset generation.
function resolveServedStaticRoot(): ServedStaticRoot | null {
  if (servedStaticRootCache === undefined) {
    servedStaticRootCache = computeServedStaticRoot();
  }
  return servedStaticRootCache;
}

function computeServedStaticRoot(): ServedStaticRoot | null {
  const sourceDir = resolveDesktopStaticDir();
  if (!sourceDir) {
    return null;
  }
  const archivePath = findAsarArchivePath(sourceDir);
  if (!archivePath) {
    // Plain-directory client (dev, unpacked build): real files already survive swaps.
    return { dir: sourceDir, snapshotted: false };
  }
  const startupArchiveSignature =
    startupBundleIdentity && Path.resolve(startupBundleIdentity.path) === Path.resolve(archivePath)
      ? startupBundleIdentity.signature
      : undefined;
  if (startupArchiveSignature === null) {
    throw new BundleChangedDuringStartupError({
      bundlePath: archivePath,
      baseline: null,
      current: readBundleSignature(archivePath),
    });
  }
  const archiveSignature = startupArchiveSignature ?? readBundleSignature(archivePath);
  if (!archiveSignature) {
    return { dir: sourceDir, snapshotted: false };
  }
  const startedAtMs = Date.now();
  let snapshot: ReturnType<typeof ensureStaticSnapshot>;
  try {
    snapshot = ensureStaticSnapshot({
      sourceDir,
      cacheRoot: Path.join(app.getPath("userData"), "static-snapshots"),
      signature: `${archiveSignature.size}-${archiveSignature.mtimeMs}-${archiveSignature.inode}`,
    });
  } catch (error) {
    const currentArchiveSignature = readBundleSignature(archivePath);
    if (!isBundleStable(archiveSignature, currentArchiveSignature)) {
      throw new BundleChangedDuringStartupError({
        bundlePath: archivePath,
        baseline: archiveSignature,
        current: currentArchiveSignature,
      });
    }
    console.warn(
      "[desktop] Failed to snapshot static assets; serving from the archive",
      formatErrorMessage(error),
    );
    return { dir: sourceDir, snapshotted: false };
  }

  const currentArchiveSignature = readBundleSignature(archivePath);
  if (!isBundleStable(archiveSignature, currentArchiveSignature)) {
    // A newly-created snapshot may contain reads from both archive generations.
    // Never leave it behind for a future launch to reuse.
    if (!snapshot.reused) {
      try {
        FS.rmSync(snapshot.dir, { recursive: true, force: true });
      } catch {
        // The signature changes the snapshot key, so failed cleanup is disk waste
        // rather than a path the replacement generation can accidentally reuse.
      }
    }
    throw new BundleChangedDuringStartupError({
      bundlePath: archivePath,
      baseline: archiveSignature,
      current: currentArchiveSignature,
    });
  }

  writeDesktopLogHeader(
    `static snapshot ${snapshot.reused ? "reused" : "created"} dir=${snapshot.dir} in ${Date.now() - startedAtMs}ms`,
  );
  return { dir: snapshot.dir, snapshotted: true };
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("Synara failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  if (process.platform === "win32") {
    requestGracefulAppQuit(`fatal startup (${stage})`);
    return;
  }
  stopBackend();
  restoreStdIoCapture?.();
  app.quit();
}

function registerDesktopProtocol(): void {
  if (isDevelopment || desktopProtocolRegistered) return;

  // An unreadable first observation cannot be replaced by a later baseline:
  // Electron may already hold the header for the generation that disappeared.
  if (startupBundleIdentity && !startupBundleIdentity.signature) {
    throw new BundleChangedDuringStartupError({
      bundlePath: startupBundleIdentity.path,
      baseline: null,
      current: readBundleSignature(startupBundleIdentity.path),
    });
  }

  const staticRoot = resolveServedStaticRoot()?.dir ?? null;
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const resolveStaticRequest = createDesktopStaticProtocolResolver(staticRoot);

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    callback(resolveStaticRequest(request.url));
  });

  desktopProtocolRegistered = true;
}

function dispatchMenuAction(action: string): void {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(IPC.menuAction, action);
    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }
    targetWindow.focus();
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function resolveMenuTargetWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function sendDesktopZoomFactor(webContents: Electron.WebContents): void {
  if (webContents.isDestroyed()) return;
  webContents.send(IPC.zoomFactorChanged, webContents.getZoomFactor());
}

function attachDesktopZoomFactorSync(window: BrowserWindow): void {
  const notify = () => sendDesktopZoomFactor(window.webContents);
  window.webContents.on("zoom-changed", notify);
  window.webContents.on("did-finish-load", notify);
}

function adjustWebContentsZoom(webContents: Electron.WebContents, multiplier: number): void {
  const nextZoomFactor = Math.min(
    DESKTOP_MENU_MAX_ZOOM_FACTOR,
    Math.max(DESKTOP_MENU_MIN_ZOOM_FACTOR, webContents.getZoomFactor() * multiplier),
  );
  webContents.setZoomFactor(nextZoomFactor);
}

function handleDesktopPhysicalZoomShortcut(
  event: Electron.Event,
  input: Electron.Input,
  target: Electron.WebContents,
): boolean {
  const action = resolveDesktopPhysicalZoomAction(process.platform, input);
  if (!action || target.isDestroyed()) {
    return false;
  }

  event.preventDefault();
  applyDesktopPhysicalZoomAction(target, action);
  return true;
}

function attachDesktopPhysicalZoomShortcuts(window: BrowserWindow): void {
  window.webContents.on("before-input-event", (event, input) => {
    handleDesktopPhysicalZoomShortcut(event, input, window.webContents);
  });
}

function resetWindowZoomFromMenu(): void {
  resolveMenuTargetWindow()?.webContents.setZoomFactor(1);
}

function adjustWindowZoomFromMenu(multiplier: number): void {
  const webContents = resolveMenuTargetWindow()?.webContents;
  if (!webContents) return;
  adjustWebContentsZoom(webContents, multiplier);
}

// A configured app-update.yml (or the mock-updates flag) is the prerequisite for any
// auto-update activity; centralized so the menu and the enable check stay in lockstep.
function hasConfiguredUpdateFeed(): boolean {
  return readAppUpdateYml() !== null || Boolean(process.env.SYNARA_DESKTOP_MOCK_UPDATES);
}

function resolveAutoUpdateDisabledReason(): string | null {
  return getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv:
      desktopIdentity.usesScriptedUpdates || process.env.SYNARA_DISABLE_AUTO_UPDATE === "1",
    hasUpdateFeedConfig: hasConfiguredUpdateFeed(),
  });
}

function handleCheckForUpdatesMenuClick(): void {
  const disabledReason = resolveAutoUpdateDisabledReason();
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow();
  }
  void checkForUpdatesFromMenu();
}

async function checkForUpdatesFromMenu(): Promise<void> {
  await checkForUpdates("menu");

  if (updateState.status === "up-to-date") {
    void dialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `Synara ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "downloading" || updateState.status === "available") {
    void dialog.showMessageBox({
      type: "info",
      title: "Update found",
      message: "Synara is preparing the update in the background.",
      buttons: ["OK"],
    });
  } else if (updateState.status === "downloaded") {
    void dialog.showMessageBox({
      type: "info",
      title: "Update ready",
      message: "Click Update in the sidebar when you’re ready to restart and install it.",
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    void dialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];
  const keyboardShortcutsAccelerator = resolveKeyboardShortcutsMenuAccelerator(process.platform);
  const acceleratorProps = (
    accelerator: MenuItemConstructorOptions["accelerator"],
  ): Pick<MenuItemConstructorOptions, "accelerator"> => {
    const resolved = resolveDesktopMenuAccelerator(process.platform, accelerator);
    return resolved ? { accelerator: resolved } : {};
  };
  const zoomMenuItems: MenuItemConstructorOptions[] = shouldUseNativeZoomMenuRoles(process.platform)
    ? [
        { role: "resetZoom" },
        { role: "zoomIn", ...acceleratorProps("CmdOrCtrl+=") },
        { role: "zoomIn", ...acceleratorProps("CmdOrCtrl+Plus"), visible: false },
        { role: "zoomOut" },
      ]
    : [
        { label: "Reset Zoom", click: () => resetWindowZoomFromMenu() },
        {
          label: "Zoom In",
          click: () => adjustWindowZoomFromMenu(DESKTOP_MENU_ZOOM_FACTOR_STEP),
        },
        {
          label: "Zoom Out",
          click: () => adjustWindowZoomFromMenu(1 / DESKTOP_MENU_ZOOM_FACTOR_STEP),
        },
      ];

  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuAction("open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        ...(process.platform === "darwin"
          ? []
          : [
              {
                label: "Settings...",
                ...acceleratorProps("CmdOrCtrl+,"),
                click: () => dispatchMenuAction("open-settings"),
              },
              { type: "separator" as const },
            ]),
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "New Terminal Tab",
          ...acceleratorProps("CmdOrCtrl+T"),
          click: () => dispatchMenuAction("new-terminal-tab"),
        },
        { type: "separator" },
        {
          label: "Toggle Sidebar",
          ...acceleratorProps("CmdOrCtrl+B"),
          click: () => dispatchMenuAction("toggle-sidebar"),
        },
        {
          label: "Toggle Browser",
          ...acceleratorProps("CmdOrCtrl+Shift+B"),
          click: () => dispatchMenuAction("toggle-browser"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        ...zoomMenuItems,
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Keyboard Shortcuts",
          ...(keyboardShortcutsAccelerator ? { accelerator: keyboardShortcutsAccelerator } : {}),
          click: () => dispatchMenuAction("show-shortcuts"),
        },
        { type: "separator" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources", fileName),
    Path.join(__dirname, "../prod-resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  return resolveResourcePath(`icon.${ext}`);
}

function resolveNotificationIconPath(): string | null {
  if (process.platform === "darwin") {
    return null;
  }
  if (process.platform === "win32") {
    return resolveResourcePath("synara.png") ?? resolveIconPath("ico");
  }
  return resolveResourcePath("synara.png") ?? resolveIconPath("png");
}

function resolveAppSnapHelperPath(): string {
  if (app.isPackaged) {
    return Path.resolve(process.resourcesPath, "..", "Helpers", "synara-appsnap-helper");
  }
  return Path.resolve(__dirname, "..", ".electron-runtime", "appsnap", "synara-appsnap-helper");
}

function ensureMainWindowForAppSnap(): BrowserWindow | null {
  if (mainWindow?.isDestroyed()) {
    mainWindow = null;
  }
  if (!mainWindow && backendPort > 0 && !isQuitting) {
    mainWindow = createWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  focusMainWindow({ stealAppFocus: true });
  return mainWindow;
}

function canSendAppSnapEvent(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(
    window &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed() &&
    !window.webContents.isLoadingMainFrame(),
  );
}

function sendAppSnapEvent(
  window: BrowserWindow | null,
  send: (webContents: BrowserWindow["webContents"]) => void,
): boolean {
  if (!canSendAppSnapEvent(window)) return false;
  send(window.webContents);
  return true;
}

function initializeDesktopAppSnap(): void {
  if (appSnapManager) return;
  appSnapManager = new DesktopAppSnapManager({
    platform: process.platform,
    helperPath: resolveAppSnapHelperPath(),
    captureDirectory: Path.join(app.getPath("userData"), "appsnap", "tmp"),
    excludedBundleId: APP_USER_MODEL_ID,
    shortcutRegistry: globalShortcut,
    onState: (state) => {
      sendAppSnapEvent(mainWindow, (webContents) => sendAppSnapState(webContents, state));
    },
    onCaptured: (capture) => {
      const window = ensureMainWindowForAppSnap();
      if (sendAppSnapEvent(window, (webContents) => sendAppSnapCaptured(webContents, capture))) {
        return;
      }
      // The renderer is still loading: replay the event once the main frame is
      // ready. The renderer dedupes by capture id, and the capture also stays
      // in the pending queue as a fallback for the next mount.
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.once("did-finish-load", () => {
          sendAppSnapEvent(window, (webContents) => sendAppSnapCaptured(webContents, capture));
        });
      }
    },
    onError: (error, focusApp) => {
      const window = focusApp ? ensureMainWindowForAppSnap() : mainWindow;
      if (!sendAppSnapEvent(window, (webContents) => sendAppSnapError(webContents, error))) {
        showDesktopNotification({
          title: error.code === "pending-capture-overflow" ? "AppSnap discarded" : "AppSnap failed",
          body: error.message,
        });
      }
    },
  });
}

// Keep the app badge aligned with desktop notifications that arrive off-focus.
function syncUnreadNotificationBadge(): void {
  app.setBadgeCount(unreadBackgroundNotificationCount);
}

// Count minimized, hidden, or unfocused windows as background notification targets.
function isMainWindowForeground(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }
  return window.isVisible() && !window.isMinimized() && window.isFocused();
}

function incrementUnreadNotificationBadge(): void {
  unreadBackgroundNotificationCount = Math.min(unreadBackgroundNotificationCount + 1, 99);
  syncUnreadNotificationBadge();
}

function clearUnreadNotificationBadge(): void {
  if (unreadBackgroundNotificationCount === 0) {
    return;
  }
  unreadBackgroundNotificationCount = 0;
  syncUnreadNotificationBadge();
}

// Reuse the existing desktop window when the app is launched again so users
// don't end up with multiple packaged instances racing the same local state.
function focusMainWindow(options: { stealAppFocus?: boolean } = {}): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = null;
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  if (process.platform === "darwin" && options.stealAppFocus === true) {
    // BrowserWindow.focus() alone does not activate an app while another macOS
    // application owns focus. Only AppSnap is an explicit global user gesture;
    // notification clicks and ordinary activation keep their existing focus policy.
    app.show();
    app.focus({ steal: true });
  }
  mainWindow.focus();
}

// Show a native OS notification and refocus the app window when the alert is clicked.
function showDesktopNotification(input: {
  title: string;
  body?: string;
  silent?: boolean;
  threadId?: string;
}): boolean {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
  if (title.length === 0 || !Notification.isSupported()) {
    return false;
  }

  const iconPath = resolveNotificationIconPath();
  const notification = new Notification({
    title,
    body,
    silent: input.silent === true,
    ...(iconPath ? { icon: iconPath } : {}),
  });
  if (!isMainWindowForeground(mainWindow)) {
    incrementUnreadNotificationBadge();
  }

  notification.on("click", () => {
    clearUnreadNotificationBadge();
    focusMainWindow();
    if (!mainWindow) {
      return;
    }
    if (threadId.length > 0) {
      mainWindow.webContents.send(IPC.menuAction, `notification-open-thread:${threadId}`);
    }
  });

  notification.show();
  return true;
}

/**
 * Resolve the Electron userData directory path.
 *
 * Electron derives the default userData path from `productName` in
 * package.json. We override it to a clean lowercase Synara name.
 */
function resolveUserDataPath(): string {
  const appDataBase = resolveDesktopAppDataBase();
  return resolveDesktopUserDataPath({
    appDataBase,
    userDataDirectoryName: desktopIdentity.userDataDirectoryName,
  });
}

function repairBrowserProfileBeforeElectronReady(userDataPath: string): void {
  const browserProfileRepair = repairBrowserProfileFromBridgeManifest(userDataPath);
  if (browserProfileRepair.status === "repaired") {
    console.info("[desktop] Completed Synara browser profile bridge repair", {
      sourcePath: browserProfileRepair.sourcePath,
      targetPath: browserProfileRepair.targetPath,
      copiedEntries: browserProfileRepair.copiedEntries,
    });
  } else if (browserProfileRepair.status === "repair-failed") {
    console.warn("[desktop] Failed to complete Synara browser profile bridge repair", {
      sourcePath: browserProfileRepair.sourcePath,
      targetPath: browserProfileRepair.targetPath,
      error: browserProfileRepair.error,
    });
  }
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
    copyright: `© ${new Date().getFullYear()} Emanuele Di Pietro`,
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
}

// The packaged bundle icon is a solid, pre-rounded ICNS so Tahoe does not reinterpret
// the mark as Icon Composer glass. Older macOS gets the same literal rounded artwork as
// a runtime dock override because it does not apply the modern system mask itself.
function applyLegacyMacDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock) {
    return;
  }
  const darwinMajor = Number.parseInt(OS.release().split(".")[0] ?? "", 10);
  if (!Number.isFinite(darwinMajor) || darwinMajor >= 25) {
    return;
  }
  const iconPath = resolveResourcePath("dock-icon.png");
  if (!iconPath) {
    return;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    return;
  }
  app.dock.setIcon(image);
}

function readLaunchVersionRecordContents(): string | null {
  try {
    return FS.readFileSync(resolveLaunchVersionRecordPath(app.getPath("userData")), "utf8");
  } catch {
    // No prior record (fresh profile) or an unreadable file.
    return null;
  }
}

function persistLastLaunchVersion(version: string): void {
  const recordPath = resolveLaunchVersionRecordPath(app.getPath("userData"));
  try {
    // The userData directory is not guaranteed to exist this early on a clean
    // first launch, so ensure it before writing or the record silently fails to
    // persist and the refresh re-runs on every launch.
    FS.mkdirSync(Path.dirname(recordPath), { recursive: true });
    FS.writeFileSync(recordPath, serializeLaunchVersionRecord(version));
  } catch (error) {
    console.warn("[desktop] Failed to persist last launch version", error);
  }
}

// macOS keeps an aggressive Launch Services / IconServices cache keyed by bundle
// path + identifier. electron-updater swaps the bundle in place, so after an
// update the refreshed icon.icns is already on disk while the dock and Finder
// keep painting the previous icon — most visibly on Tahoe, where we no longer
// apply a runtime dock icon (see applyLegacyMacDockIcon). When the version
// changes across launches, force Launch Services to re-read the bundle so the
// new icon shows on every surface. Best-effort: never blocks startup.
function refreshMacIconCacheOnVersionChange(): void {
  if (process.platform !== "darwin" || !app.isPackaged) {
    return;
  }

  const currentVersion = app.getVersion();
  const previousVersion = parseLastLaunchVersion(readLaunchVersionRecordContents());
  if (!shouldRefreshIconCache(previousVersion, currentVersion)) {
    return;
  }

  // Record the new version before refreshing so a failed re-registration is not
  // retried on every launch; the icon then heals on the next version bump
  // instead of spawning lsregister each time.
  persistLastLaunchVersion(currentVersion);

  const bundlePath = resolveMacAppBundlePath(process.execPath, process.platform);
  if (!bundlePath || !FS.existsSync(LSREGISTER_PATH)) {
    return;
  }

  // Bump the bundle mtime so Launch Services notices the swap, then re-register
  // it. The codesign signature covers Contents, not the bundle directory mtime,
  // so this is signature-safe; the bundle may be read-only for this user, in
  // which case the re-registration below still nudges the cache.
  try {
    const now = new Date();
    FS.utimesSync(bundlePath, now, now);
  } catch {
    // Read-only bundle: fall through to lsregister.
  }

  const child = ChildProcess.spawn(LSREGISTER_PATH, ["-f", bundlePath], { stdio: "ignore" });
  child.unref();
  child.once("error", (error) => {
    console.warn("[desktop] Failed to refresh macOS icon cache after update", error);
  });
  child.once("exit", (code) => {
    console.info(
      `[desktop] Refreshed macOS icon registration after update ${previousVersion ?? "(none)"} -> ${currentVersion} (lsregister exit ${code ?? "unknown"}).`,
    );
  });
}

// How often the bundle-swap watcher stats app.asar. A stat is cheap; the cost of
// missing a swap is every subsequent asar read returning bytes from the wrong
// file (invisible icons, corrupted lazy-loaded route chunks), so poll briskly.
const BUNDLE_SWAP_POLL_INTERVAL_MS = 15_000;

let bundleSwapPollTimer: NodeJS.Timeout | null = null;
let bundleSwapPromptOpen = false;

function readBundleSignature(bundlePath: string): BundleSignature | null {
  try {
    return bundleSignatureFromStats(OriginalFS.statSync(bundlePath));
  } catch {
    return null;
  }
}

function captureStartupBundleIdentity(): BundleIdentity | null {
  if (!app.isPackaged) {
    return null;
  }
  const bundlePath = app.getAppPath();
  if (!isWatchableBundlePath(bundlePath)) {
    return null;
  }
  return { path: bundlePath, signature: readBundleSignature(bundlePath) };
}

function restartAfterStartupBundleSwap(error: BundleChangedDuringStartupError): void {
  const baselineSize = error.baseline?.size ?? "unreadable";
  const currentSize = error.current?.size ?? "unreadable";
  writeDesktopLogHeader(
    `bundle changed during startup path=${error.bundlePath} size=${baselineSize}->${currentSize}`,
  );
  console.warn("[desktop] Packaged application changed during startup; restarting", error);

  void dialog
    .showMessageBox({
      type: "warning",
      title: "Synara needs to restart",
      message: "Synara changed while it was opening.",
      detail:
        "The current process cannot safely read the replaced application bundle. Restart Synara to finish opening with one consistent version.",
      buttons: ["Restart Synara"],
      defaultId: 0,
    })
    .catch(() => undefined)
    .then(() => {
      app.relaunch();
      requestGracefulAppQuit("startup-bundle-swap");
    });
}

// Electron caches the asar header per process, so once app.asar changes on disk
// (updater retry racing a relaunch, a reinstall, a build copied over the bundle)
// every archive read in this process — the synara:// protocol, the backend's static
// files, lazily-loaded renderer chunks — resolves to stale offsets and silently
// returns the wrong bytes. Detect the swap and offer a restart; continuing is
// never safe.
function startBundleSwapWatcher(): void {
  if (!app.isPackaged || bundleSwapPollTimer) {
    return;
  }
  const bundlePath = app.getAppPath();
  if (!isWatchableBundlePath(bundlePath)) {
    return;
  }
  let baseline =
    startupBundleIdentity && Path.resolve(startupBundleIdentity.path) === Path.resolve(bundlePath)
      ? (startupBundleIdentity.signature ?? readBundleSignature(bundlePath))
      : readBundleSignature(bundlePath);
  if (!baseline) {
    return;
  }

  bundleSwapPollTimer = setInterval(() => {
    // The updater owns the quit/relaunch during its own install handoff, and a
    // quitting app is about to re-read the new archive anyway.
    if (isQuitting || isUpdaterInstallPreparing || bundleSwapPromptOpen) {
      return;
    }
    const current = readBundleSignature(bundlePath);
    if (!baseline || !isBundleSwapped(baseline, current)) {
      return;
    }
    writeDesktopLogHeader(
      `bundle swap detected path=${bundlePath} size=${baseline.size}->${current?.size ?? "unknown"}`,
    );
    // Re-arm on the new identity so declining the restart still catches the
    // next replacement instead of re-prompting for the same one.
    baseline = current;
    bundleSwapPromptOpen = true;
    void dialog
      .showMessageBox({
        type: "warning",
        title: "Synara was replaced on disk",
        message: "The installed Synara app changed while it was running.",
        detail:
          "The interface keeps running from a safeguarded copy, but parts of the app loaded later can still read the replaced file. Restart now to pick up the new version safely.",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        bundleSwapPromptOpen = false;
        if (response === 0) {
          app.relaunch();
          requestGracefulAppQuit("bundle-swap-restart");
        }
      })
      .catch(() => {
        bundleSwapPromptOpen = false;
      });
  }, BUNDLE_SWAP_POLL_INTERVAL_MS);
  bundleSwapPollTimer.unref();
}

function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

// Starts the periodic background update check. Used by configureAutoUpdater and
// by the install watchdog recovery so polling resumes after a silent install
// failure instead of staying off until the next app restart.
function scheduleUpdatePoll(): void {
  if (updatePollTimer || automaticUpdateActivitySuppressed) {
    return;
  }
  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}

function isExplicitUpdateCheckReason(reason: string): boolean {
  return (
    reason === "menu" || reason === "renderer" || reason === UPDATE_CHECK_REASON_MIGRATION_RECOVERY
  );
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(IPC.updateState, updateState);
  }
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch };
  emitUpdateState();
}

function shouldEnableAutoUpdates(): boolean {
  return resolveAutoUpdateDisabledReason() === null;
}

function isKnownUpdateVersionNewer(version: string | null | undefined): boolean {
  return typeof version === "string" && isUpdateVersionNewer(app.getVersion(), version);
}

function getUpdaterCachePathArgs(): {
  cacheDirName: string | null;
  platform: NodeJS.Platform;
  homeDir: string;
  localAppData: string | null;
  xdgCacheHome: string | null;
} {
  return {
    cacheDirName: configuredUpdaterCacheDirName,
    platform: process.platform,
    homeDir: OS.homedir(),
    localAppData: process.env.LOCALAPPDATA ?? null,
    xdgCacheHome: process.env.XDG_CACHE_HOME ?? null,
  };
}

function getPendingUpdateCacheDir(): string | null {
  return resolveElectronUpdaterPendingCacheDir(getUpdaterCachePathArgs());
}

function clearLegacyUpdaterZipAfterVerifiedInstall(): void {
  const legacyZipPath = resolveElectronUpdaterLegacyZipPath(getUpdaterCachePathArgs());
  if (!legacyZipPath) {
    return;
  }
  try {
    FS.rmSync(legacyZipPath, { force: true });
    console.info("[desktop-updater] Cleared legacy top-level update.zip after verified install.");
  } catch (error) {
    console.warn(
      `[desktop-updater] Failed to clear legacy top-level update.zip: ${formatErrorMessage(error)}`,
    );
  }
}

function quarantineInstallMarker(reason: string): void {
  console.warn(`[desktop-updater] Discarding update install marker (${reason}).`);
  try {
    clearInstallMarker(getUpdateInstallMarkerPath());
  } catch (error) {
    console.warn(
      `[desktop-updater] Failed to delete quarantined update install marker: ${formatErrorMessage(error)}`,
    );
  }
}

function processInstallMarkerOnStartup(): void {
  const filePath = getUpdateInstallMarkerPath();
  const readResult = readInstallMarker(filePath);
  if (readResult.status === "missing") {
    return;
  }
  if (readResult.status === "invalid") {
    quarantineInstallMarker(`invalid or unreadable: ${readResult.error}`);
    return;
  }

  const marker = readResult.marker;
  const nowIso = new Date().toISOString();
  const outcome = resolveInstallMarkerOutcome(marker, app.getVersion(), nowIso);
  if (outcome === "success") {
    console.info(
      `[desktop-updater] Update to ${marker.toVersion} installed successfully (from ${marker.fromVersion})`,
    );
    try {
      clearInstallMarker(filePath);
    } catch (error) {
      console.warn(
        `[desktop-updater] Failed to clear successful update install marker: ${formatErrorMessage(error)}`,
      );
    }
    clearLegacyUpdaterZipAfterVerifiedInstall();
    return;
  }
  if (outcome === "stale" || outcome === "invalid") {
    quarantineInstallMarker(outcome);
    return;
  }

  let consecutiveFailures = marker.consecutiveFailures;
  if (outcome === "failure") {
    consecutiveFailures += 1;
    const failedMarker: UpdateInstallMarker = {
      ...marker,
      phase: "failed",
      consecutiveFailures,
      lastFailureAt: nowIso,
    };
    try {
      writeInstallMarker(filePath, failedMarker);
    } catch (error) {
      console.error(
        `[desktop-updater] Failed to persist restart install failure: ${formatErrorMessage(error)}`,
      );
    }
  }

  automaticUpdateActivitySuppressed = true;
  const message = `Synara restarted, but update ${marker.toVersion} was not installed. Try again.`;
  setUpdateState(
    reduceDesktopUpdateStateOnInstallRestartFailure(
      updateState,
      marker.toVersion,
      consecutiveFailures,
      message,
    ),
  );
  console.error(
    `[desktop-updater] UPDATE INSTALL FAILED: still running ${app.getVersion()} after attempting ${marker.toVersion}; consecutive failures=${consecutiveFailures}. Automatic update checks are suppressed until the user retries.`,
  );
  void logMacUpdateDiagnostics("startup install verification failure");
}

// electron-updater can leave a same-version ZIP in `pending` after a restart or
// a failed install attempt. Clearing it prevents stale "ready" states.
async function clearPendingUpdateCache(reason: string): Promise<void> {
  const pendingDir = getPendingUpdateCacheDir();
  if (!pendingDir || updateDownloadInFlight) {
    return;
  }
  try {
    await FS.promises.rm(pendingDir, { recursive: true, force: true });
    console.info(`[desktop-updater] Cleared pending update cache (${reason}).`);
  } catch (error) {
    console.warn(
      `[desktop-updater] Failed to clear pending update cache (${reason}): ${formatErrorMessage(error)}`,
    );
  }
}

// Terminal updater events can arrive before downloadUpdate() settles; defer cache deletion
// until the updater has released its in-flight download bookkeeping.
function clearPendingUpdateCacheWhenSafe(reason: string): void {
  pendingUpdateCacheClearQueue.request(reason, updateDownloadInFlight, (safeReason) => {
    void clearPendingUpdateCache(safeReason);
  });
}

function clearUpdateBackgroundBlurTimer(): void {
  if (updateBackgroundBlurTimer) {
    clearTimeout(updateBackgroundBlurTimer);
    updateBackgroundBlurTimer = null;
  }
}

// Fail closed if electron-updater never emits a terminal check outcome.
function clearUpdateCheckTimeoutTimer(): void {
  if (updateCheckTimeoutTimer) {
    clearTimeout(updateCheckTimeoutTimer);
    updateCheckTimeoutTimer = null;
  }
}

function armUpdateCheckTimeout(reason: string): void {
  clearUpdateCheckTimeoutTimer();
  updateCheckTimeoutTimer = setTimeout(() => {
    updateCheckTimeoutTimer = null;
    if (updateState.status !== "checking") {
      return;
    }
    updateCheckInFlight = false;
    // electron-updater may never settle its own promise, so this is also where
    // anyone awaiting the check has to be released.
    settleActiveUpdateCheck?.();
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(
        updateState,
        "Timed out while checking for updates. Try again.",
        new Date().toISOString(),
      ),
    );
    console.error(`[desktop-updater] Update check timed out (${reason}).`);
  }, AUTO_UPDATE_CHECK_TIMEOUT_MS);
  updateCheckTimeoutTimer.unref();
}

function clearUpdateDownloadStallTimer(): void {
  if (updateDownloadStallTimer) {
    clearTimeout(updateDownloadStallTimer);
    updateDownloadStallTimer = null;
  }
}

function clearStalledDownloadCancellationSuppression(): void {
  stalledDownloadCancellationSuppressionsRemaining = 0;
  stalledDownloadCancellationSuppressionExpiresAtMs = 0;
}

function armStalledDownloadCancellationSuppression(): void {
  stalledDownloadCancellationSuppressionsRemaining += 1;
  stalledDownloadCancellationSuppressionExpiresAtMs =
    Date.now() + AUTO_UPDATE_STALLED_DOWNLOAD_CANCELLATION_SUPPRESSION_MS;
}

function isStalledDownloadCancellationSuppressionArmed(): boolean {
  if (stalledDownloadCancellationSuppressionsRemaining <= 0) {
    return false;
  }
  if (Date.now() <= stalledDownloadCancellationSuppressionExpiresAtMs) {
    return true;
  }
  clearStalledDownloadCancellationSuppression();
  return false;
}

function consumeStalledDownloadCancellationSuppression(): void {
  stalledDownloadCancellationSuppressionsRemaining = Math.max(
    0,
    stalledDownloadCancellationSuppressionsRemaining - 1,
  );
  if (stalledDownloadCancellationSuppressionsRemaining === 0) {
    stalledDownloadCancellationSuppressionExpiresAtMs = 0;
  }
}

// Bounds a silent updater download while allowing slow downloads that keep making progress.
function armUpdateDownloadStallTimer(reason: string): void {
  clearUpdateDownloadStallTimer();
  updateDownloadStallTimer = setTimeout(() => {
    updateDownloadStallTimer = null;
    if (!updateDownloadInFlight || updateState.status !== "downloading") {
      return;
    }

    const error = new Error(getDownloadStallTimeoutMessage(AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS));
    console.error(`[desktop-updater] ${error.message} (${reason}).`);
    armStalledDownloadCancellationSuppression();
    rejectUpdateDownloadStall?.(error);
    updateDownloadCancellationToken?.cancel();
  }, AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
  updateDownloadStallTimer.unref();
}

function updateDownloadStallTimerOnProgress(progress: DownloadProgressSample): void {
  if (!updateDownloadInFlight) {
    return;
  }
  if (!hasDownloadProgressAdvanced(lastUpdateDownloadProgressSample, progress)) {
    return;
  }
  lastUpdateDownloadProgressSample = {
    percent: progress.percent ?? null,
    transferred: progress.transferred ?? null,
  };
  armUpdateDownloadStallTimer(`download progress ${Math.floor(progress.percent ?? 0)}%`);
}

function isDesktopAppForegrounded(): boolean {
  return BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );
}

function markDesktopAppBackgrounded(): void {
  clearUpdateBackgroundBlurTimer();
  updateBackgroundBlurTimer = setTimeout(() => {
    updateBackgroundBlurTimer = null;
    if (isDesktopAppForegrounded()) {
      return;
    }
    updateBackgroundedAtMs = Date.now();
  }, 0);
}

function handleDesktopAppForegrounded(): void {
  clearUpdateBackgroundBlurTimer();
  clearUnreadNotificationBadge();
  const foregroundedAtMs = Date.now();
  const backgroundedAtMs = updateBackgroundedAtMs;
  updateBackgroundedAtMs = null;
  const shouldCheck = shouldCheckForUpdatesOnForeground({
    checkedAt: updateState.checkedAt,
    backgroundedAtMs,
    foregroundedAtMs,
    minBackgroundDurationMs: AUTO_UPDATE_FOREGROUND_RECHECK_MIN_BACKGROUND_MS,
    minIntervalMs: AUTO_UPDATE_FOREGROUND_RECHECK_MIN_INTERVAL_MS,
  });
  if (!shouldCheck) {
    return;
  }
  void checkForUpdates("foreground");
}

/**
 * Publishes the running check so a caller that needs its *outcome* — migration
 * recovery — can join it. `checkForUpdates` is a deliberate no-op while another
 * check holds the lock, and without this the caller would read the intermediate
 * "checking" state as a failed download.
 *
 * The returned finish is idempotent and only clears state it still owns, so the
 * check-timeout path can settle a stuck check without stranding a later one.
 */
function beginActiveUpdateCheck(): () => void {
  // Assigned by the executor, which runs before the constructor returns.
  let settle!: () => void;
  const check = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = (): void => {
    settle();
    if (activeUpdateCheck === check) {
      activeUpdateCheck = null;
      settleActiveUpdateCheck = null;
    }
  };
  activeUpdateCheck = check;
  settleActiveUpdateCheck = finish;
  return finish;
}

async function checkForUpdates(reason: string): Promise<void> {
  if (isQuitting || isUpdaterInstallPreparing || !updaterConfigured || updateCheckInFlight) return;
  if (automaticUpdateActivitySuppressed) {
    if (!isExplicitUpdateCheckReason(reason)) {
      console.info(
        `[desktop-updater] Skipping automatic update check (${reason}) after an unverified install failure.`,
      );
      return;
    }
    automaticUpdateActivitySuppressed = false;
    console.info(
      `[desktop-updater] User requested update recovery (${reason}); automatic checks are enabled for this session.`,
    );
    scheduleUpdatePoll();
  }
  if (
    updateState.status === "checking" ||
    updateState.status === "downloading" ||
    updateState.status === "downloaded"
  ) {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`,
    );
    return;
  }
  updateCheckInFlight = true;
  const finishCheck = beginActiveUpdateCheck();
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, new Date().toISOString()));
  armUpdateCheckTimeout(reason);
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    await autoUpdater.checkForUpdates();
  } catch (error: unknown) {
    clearUpdateCheckTimeoutTimer();
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(updateState, message, new Date().toISOString()),
    );
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
  } finally {
    updateCheckInFlight = false;
    finishCheck();
  }
}

async function downloadAvailableUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  if (
    updaterConfigured &&
    updateState.status === "error" &&
    updateState.errorContext === "install" &&
    updateState.downloadedVersion === null &&
    updateState.availableVersion !== null
  ) {
    await checkForUpdates("renderer");
    return { accepted: true, completed: false };
  }
  if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  if (!isKnownUpdateVersionNewer(updateState.availableVersion)) {
    await clearPendingUpdateCache("available version is not newer than current app");
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    console.info(
      `[desktop-updater] Ignoring stale available update ${updateState.availableVersion ?? "unknown"} for current ${app.getVersion()}.`,
    );
    return { accepted: false, completed: false };
  }
  updateDownloadInFlight = true;
  downloadedUpdateArtifact = null;
  downloadedUpdateIdentityTask = null;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
  // Keep existing cancellation suppressions across immediate retries; the old
  // updater cancellation can arrive after a new download has already started.
  lastUpdateDownloadProgressSample = null;
  const cancellationToken = new CancellationToken();
  updateDownloadCancellationToken = cancellationToken;
  const downloadStalled = new Promise<never>((_, reject) => {
    rejectUpdateDownloadStall = reject;
  });
  armUpdateDownloadStallTimer("download start");
  console.info("[desktop-updater] Downloading update...");

  // Track electron-updater's own download promise separately from the stall race.
  // When the stall timer wins the race it cancels this promise, but the updater
  // keeps its internal download promise set until that cancellation unwinds. We
  // observe its settlement here (so a late rejection can't surface as an unhandled
  // rejection) and wait on it before releasing the in-flight flag below.
  let updaterDownloadSettled = false;
  const updaterDownloadPromise = autoUpdater.downloadUpdate(cancellationToken);
  const updaterDownloadSettledPromise = updaterDownloadPromise.then(
    () => {
      updaterDownloadSettled = true;
    },
    () => {
      updaterDownloadSettled = true;
    },
  );

  try {
    await Promise.race([updaterDownloadPromise, downloadStalled]);
    const identityTask = downloadedUpdateIdentityTask;
    if (identityTask) {
      await identityTask;
    }
    return {
      accepted: true,
      completed: downloadedUpdateArtifact !== null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    clearUpdateDownloadStallTimer();
    // Hold the in-flight flag until the updater download actually settles, so an
    // immediate retry can't grab the still-cancelling promise (which would reject
    // as "cancelled"). Bounded so a stuck updater promise can't wedge updates.
    if (!updaterDownloadSettled) {
      await Promise.race([
        updaterDownloadSettledPromise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, AUTO_UPDATE_DOWNLOAD_SETTLE_TIMEOUT_MS).unref();
        }),
      ]);
    }
    if (updateDownloadCancellationToken === cancellationToken) {
      updateDownloadCancellationToken = null;
    }
    rejectUpdateDownloadStall = null;
    lastUpdateDownloadProgressSample = null;
    updateDownloadInFlight = false;
    const pendingCacheClearReason = pendingUpdateCacheClearQueue.consumeAfterDownload();
    if (pendingCacheClearReason) {
      await clearPendingUpdateCache(pendingCacheClearReason);
    }
  }
}

// Starts the automatic prepare step after a successful update check; install
// stays user-controlled so active agent work is not interrupted by a restart.
function prepareAvailableUpdateInBackground(reason: string): void {
  if (updateDownloadInFlight || updateState.status !== "available") {
    return;
  }
  const preparation = downloadAvailableUpdate()
    .then((result) => {
      if (result.accepted && result.completed) {
        console.info(`[desktop-updater] Background update download completed (${reason}).`);
      }
    })
    .catch((error) => {
      console.error(
        `[desktop-updater] Background update download crashed (${reason}): ${formatErrorMessage(error)}`,
      );
    })
    .finally(() => {
      if (activeUpdatePreparation === preparation) {
        activeUpdatePreparation = null;
      }
    });
  // Published so a caller that needs the download finished — migration
  // recovery — can await this one instead of racing a second download
  // against it.
  activeUpdatePreparation = preparation;
}

/**
 * Whether the recovery prompt can offer an in-place update.
 *
 * Deliberately permissive about the current status: the check has usually not
 * run yet at this point in startup, so "we do not know of an update" is not a
 * reason to hide the option. Only a completed check that found nothing newer
 * is, because then updating provably cannot repair anything.
 */
function canInstallUpdateFromRecovery(): boolean {
  return updaterConfigured && updateState.status !== "up-to-date";
}

/**
 * Drives check → download → install for an install whose database is wedged.
 *
 * This is the only recovery option that needs nothing from the user afterwards,
 * so it runs the whole updater sequence rather than stopping at "an update is
 * available". Resolves to a message to show in the next prompt when the update
 * could not be installed, or to null once the install handoff has started.
 */
async function installLatestUpdateForMigrationRecovery(): Promise<string | null> {
  if (!updaterConfigured) {
    return resolveAutoUpdateDisabledReason() ?? "Automatic updates are not available.";
  }

  if (updateState.status !== "downloaded") {
    // The automatic startup check is armed before this prompt appears, so one
    // may already be running. Joining it is what gets a real answer: starting a
    // second check here would return without doing anything and leave the
    // status at "checking", which reads as a download failure below.
    const inFlightCheck = activeUpdateCheck;
    if (inFlightCheck === null) {
      await checkForUpdates(UPDATE_CHECK_REASON_MIGRATION_RECOVERY);
    } else {
      await inFlightCheck;
    }
    // A successful check starts the download itself; await that one rather
    // than starting a competing transfer.
    const preparation = activeUpdatePreparation;
    if (preparation !== null) {
      await preparation;
    } else if (updateState.status === "available") {
      await downloadAvailableUpdate();
    }
  }

  if (updateState.status === "up-to-date") {
    return `Synara ${app.getVersion()} is already the newest release, so updating cannot repair this database.`;
  }
  if (updateState.status !== "downloaded") {
    return updateState.message ?? "The update could not be downloaded.";
  }

  await installDownloadedUpdate();
  // quitAndInstall never resolves — the process exits under it. A handoff that
  // silently fails is cleared by the install watchdog instead, and waiting for
  // that verdict is what keeps a failed install from leaving a live app with
  // no window and no way back to this prompt.
  await waitForMigrationRecoveryInstallHandoff();
  if (isUpdaterQuitAndInstallInFlight) {
    return null;
  }
  return updateState.message ?? "The downloaded update could not be installed.";
}

/**
 * Waits out the install watchdog window, which is the earliest a failed handoff
 * can be known: nothing else clears `isUpdaterQuitAndInstallInFlight`, so there
 * is nothing to poll for. A successful handoff exits the process well before
 * this resolves.
 */
async function waitForMigrationRecoveryInstallHandoff(): Promise<void> {
  if (!isUpdaterQuitAndInstallInFlight) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, AUTO_UPDATE_INSTALL_WATCHDOG_MS + 2_000).unref();
  });
}

async function runDownloadedUpdateInstall(
  preparationAttempt: UpdateInstallPreparationAttempt,
): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  const versionToInstall = updateState.downloadedVersion ?? updateState.availableVersion;
  if (!versionToInstall || !isKnownUpdateVersionNewer(versionToInstall)) {
    await clearPendingUpdateCache("downloaded version is not newer than current app");
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    console.info(
      `[desktop-updater] Ignoring stale downloaded update ${versionToInstall ?? "unknown"} for current ${app.getVersion()}.`,
    );
    return { accepted: false, completed: false };
  }

  const artifact =
    downloadedUpdateArtifact?.version === versionToInstall
      ? downloadedUpdateArtifact.identity
      : null;
  if (!artifact || !(await verifyUpdateArtifactIdentity(artifact))) {
    downloadedUpdateArtifact = null;
    await clearPendingUpdateCache("downloaded artifact identity is missing or changed");
    const message = "The downloaded update could not be reverified. Download it again.";
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Refusing install handoff: ${message}`);
    return { accepted: false, completed: false };
  }
  updateInstallPreparation.requireActive(preparationAttempt);

  const markerPath = getUpdateInstallMarkerPath();
  const existingMarkerResult = readInstallMarker(markerPath);
  const existingMarker =
    existingMarkerResult.status === "valid" &&
    existingMarkerResult.marker.toVersion === versionToInstall
      ? existingMarkerResult.marker
      : null;
  const marker = createUpdateInstallMarker({
    fromVersion: app.getVersion(),
    toVersion: versionToInstall,
    requestedAt: new Date().toISOString(),
    consecutiveFailures: existingMarker?.consecutiveFailures ?? 0,
    lastFailureAt: existingMarker?.lastFailureAt ?? null,
    artifact,
  });
  const handoffExpectation: UpdateInstallHandoffExpectation = {
    attemptId: marker.attemptId,
    artifact,
  };
  let markerWritten = false;
  let artifactInvalidated = false;
  try {
    isQuitting = true;
    clearUpdatePollTimer();
    await stopBackendAndWaitForExit();
    updateInstallPreparation.requireActive(preparationAttempt);
    await logMacUpdateDiagnostics("before install handoff");
    updateInstallPreparation.requireActive(preparationAttempt);
    if (!(await verifyUpdateArtifactIdentity(artifact))) {
      artifactInvalidated = true;
      downloadedUpdateArtifact = null;
      await clearPendingUpdateCache("downloaded artifact changed during install preparation");
      throw new Error(
        "The downloaded update changed during install preparation. Download it again.",
      );
    }
    updateInstallPreparation.requireActive(preparationAttempt);
    writeInstallMarker(markerPath, marker);
    markerWritten = true;
    if (!markInstallHandoffSync(markerPath, handoffExpectation)) {
      throw new Error("Durable update install marker changed before install handoff.");
    }
    activeUpdateInstallHandoff = handoffExpectation;
    isUpdaterQuitAndInstallInFlight = true;
    autoUpdater.quitAndInstall();
    updateInstallPreparation.requireActive(preparationAttempt);
    armInstallWatchdog();
    return { accepted: true, completed: false };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    clearUpdaterInstallInFlightAfterError();
    const consecutiveFailures = markerWritten
      ? recordInstallMarkerFailure(new Date().toISOString(), handoffExpectation)
      : updateState.installFailureCount;
    startBackend();
    scheduleUpdatePoll();
    setUpdateState({
      ...(artifactInvalidated
        ? reduceDesktopUpdateStateOnDownloadFailure(updateState, message)
        : reduceDesktopUpdateStateOnInstallFailure(updateState, message)),
      installFailureCount: consecutiveFailures,
    });
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    return { accepted: true, completed: false };
  }
}

async function installDownloadedUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") {
    return { accepted: false, completed: false };
  }
  const preparationAttempt = updateInstallPreparation.begin();
  if (preparationAttempt === null) {
    return { accepted: false, completed: false };
  }
  isUpdaterInstallPreparing = true;

  try {
    return await runDownloadedUpdateInstall(preparationAttempt);
  } finally {
    if (!isUpdaterQuitAndInstallInFlight && isUpdaterInstallPreparing) {
      clearUpdaterInstallInFlightAfterError();
    }
    updateInstallPreparation.release(preparationAttempt);
  }
}

async function recordDownloadedUpdateIdentity(info: UpdateDownloadedEvent): Promise<void> {
  clearUpdateDownloadStallTimer();
  if (!isUpdateVersionNewer(app.getVersion(), info.version)) {
    downloadedUpdateArtifact = null;
    clearPendingUpdateCacheWhenSafe("downloaded version is not newer than current app");
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    console.info(
      `[desktop-updater] Ignoring downloaded non-newer update ${info.version}; current version is ${app.getVersion()}.`,
    );
    return;
  }

  try {
    const identity = await fingerprintUpdateArtifact(info.downloadedFile);
    if (!isUpdateVersionNewer(app.getVersion(), info.version)) {
      downloadedUpdateArtifact = null;
      clearPendingUpdateCacheWhenSafe("downloaded version became stale during fingerprinting");
      setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
      return;
    }
    downloadedUpdateArtifact = { version: info.version, identity };
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
    console.info(
      `[desktop-updater] Update downloaded and fingerprinted: ${info.version} (${identity.size} bytes, sha512=${identity.sha512.slice(0, 16)}…).`,
    );
  } catch (error) {
    downloadedUpdateArtifact = null;
    clearPendingUpdateCacheWhenSafe("downloaded artifact fingerprint failed");
    const message = `The downloaded update could not be verified: ${formatErrorMessage(error)}`;
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] ${message}`);
  }
}

function configureAutoUpdater(): void {
  const appUpdateYml = readAppUpdateYml();
  configuredUpdaterCacheDirName = resolveElectronUpdaterCacheDirName(appUpdateYml, app.getName());
  const githubUpdateSource = resolveGitHubUpdateSource(appUpdateYml);
  const releaseUrl =
    githubUpdateSource === null ? null : buildGitHubReleasesPageUrl(githubUpdateSource);
  const enabled = shouldEnableAutoUpdates();
  setUpdateState({
    ...createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo),
    enabled,
    status: enabled ? "idle" : "disabled",
    releaseUrl,
  });
  processInstallMarkerOnStartup();
  if (!enabled) {
    configuredUpdaterCacheDirName = null;
    return;
  }
  updaterConfigured = true;
  hardenElectronUpdater(
    { BaseUpdater },
    autoUpdater,
    process.platform,
    app.isPackaged ? resolveEmbeddedWindowsPublisherSubjects() : null,
  );

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // The dedicated channel keeps the permanent compatibility release on the
  // default feed while Synara versions advance independently.
  autoUpdater.channel = SYNARA_DESKTOP_UPDATE_CHANNEL;
  autoUpdater.allowPrerelease = DESKTOP_UPDATE_ALLOW_PRERELEASE;
  autoUpdater.allowDowngrade = false;
  // Match electron-updater's native GitHub provider path; the packaged
  // app-update.yml owns the production feed, and generic feeds stay mock-only.
  // macOS release builds repack and validate the Squirrel update zip, then omit
  // the stale zip blockmap so ShipIt always installs the exact signed payload.
  autoUpdater.disableDifferentialDownload =
    process.platform === "darwin" || isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  // electron-updater has no working idle timeout on macOS (its socket timeout is
  // wired to a `socket` event Electron's net.request never emits) and never
  // resumes from a byte offset, so a stalled CDN transfer hangs for minutes
  // until TCP recovers on its own. installResumableUpdateDownloader replaces the
  // download transfer with a stall-aware, resumable one and installs a real idle
  // timeout, so an intermittent stall becomes a brief reconnect-and-resume
  // instead of a multi-minute freeze. Independent of the zip-validation fix.
  if (!installResumableUpdateDownloader(autoUpdater as unknown as ResumableDownloaderTarget)) {
    console.warn(
      "[desktop-updater] Could not install resumable update downloader; falling back to default transfer.",
    );
  }
  let lastLoggedDownloadMilestone = -1;

  if (isArm64HostRunningIntelBuild(desktopRuntimeInfo)) {
    console.info(
      "[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.",
    );
  }

  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    clearUpdateCheckTimeoutTimer();
    downloadedUpdateArtifact = null;
    if (!isUpdateVersionNewer(app.getVersion(), info.version)) {
      void clearPendingUpdateCache("available version is not newer than current app");
      setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
      lastLoggedDownloadMilestone = -1;
      console.info(
        `[desktop-updater] Ignoring non-newer update ${info.version}; current version is ${app.getVersion()}.`,
      );
      return;
    }
    setUpdateState(
      reduceDesktopUpdateStateOnUpdateAvailable(
        updateState,
        info.version,
        new Date().toISOString(),
      ),
    );
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
    prepareAvailableUpdateInBackground(`available ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    clearUpdateCheckTimeoutTimer();
    downloadedUpdateArtifact = null;
    void clearPendingUpdateCache("no newer update available");
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    clearUpdateCheckTimeoutTimer();
    const message = formatErrorMessage(error);
    const errorContext = resolveUpdaterErrorContext();
    if (
      isExpectedStalledDownloadCancellationError({
        suppressionArmed: isStalledDownloadCancellationSuppressionArmed(),
        errorContext,
        message,
      })
    ) {
      consumeStalledDownloadCancellationSuppression();
      console.warn("[desktop-updater] Ignored expected cancellation after stalled download.");
      return;
    }
    const failedHandoff = activeUpdateInstallHandoff;
    const installPreparationPending = clearUpdaterInstallInFlightAfterError({
      preservePendingPreparation: true,
    });
    if (errorContext === "download") {
      downloadedUpdateArtifact = null;
    }
    const installFailureCount =
      errorContext === "install"
        ? recordInstallMarkerFailure(new Date().toISOString(), failedHandoff)
        : updateState.installFailureCount;
    if (errorContext === "install" && !installPreparationPending) {
      startBackend();
      scheduleUpdatePoll();
    }
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext,
        canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
        installFailureCount,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    updateDownloadStallTimerOnProgress(progress);
    if (
      shouldBroadcastDownloadProgress(updateState, progress.percent) ||
      updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    const task = recordDownloadedUpdateIdentity(info);
    downloadedUpdateIdentityTask = task;
    const clearTask = () => {
      if (downloadedUpdateIdentityTask === task) downloadedUpdateIdentityTask = null;
    };
    void task.then(clearTask, clearTask);
  });

  clearUpdatePollTimer();

  if (automaticUpdateActivitySuppressed) {
    console.info(
      "[desktop-updater] Startup and periodic update checks suppressed after failed install verification.",
    );
    return;
  }

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  scheduleUpdatePoll();
}
// Builds process-local Node args so provider/tool children do not inherit Synara's heap guard.
function backendNodeArgs(): string[] {
  const configuredMaxOldSpaceMb =
    BACKEND_MAX_OLD_SPACE_ENV_KEYS.map((key) => process.env[key]).find(
      (value) => value !== undefined && value.trim().length > 0,
    ) ?? null;
  return resolveBackendNodeArgs({
    configuredMaxOldSpaceMb,
    existingNodeOptions: process.env.NODE_OPTIONS,
    totalMemoryBytes: OS.totalmem(),
  });
}

function backendEnv(): NodeJS.ProcessEnv {
  const servedStaticRoot = resolveServedStaticRoot();
  const env: NodeJS.ProcessEnv = {
    ...resolveBrowserHostPipeBackendEnv(
      process.env,
      browserHostPipeServer ? SYNARA_BROWSER_HOST_PIPE_PATH : null,
      browserHostPipeServer ? DESKTOP_BROWSER_HOST_CAPABILITY_FD : null,
    ),
    // Point the backend's HTTP static route at the same swap-immune snapshot the
    // synara:// protocol serves, so both surfaces survive app.asar being replaced.
    ...(servedStaticRoot?.snapshotted ? { SYNARA_STATIC_DIR: servedStaticRoot.dir } : {}),
    SYNARA_MODE: "desktop",
    SYNARA_NO_BROWSER: "1",
    SYNARA_PORT: String(backendPort),
    SYNARA_HOME: BASE_DIR,
    SYNARA_AUTH_TOKEN: backendAuthToken,
    SYNARA_DESKTOP_SHUTDOWN_TOKEN: DESKTOP_BACKEND_SHUTDOWN_TOKEN,
  };
  // The backend runs the same login-shell probe at startup and does not begin listening
  // until it returns, so an unmarked child serializes a second ~1s hydration behind ours.
  // Written explicitly in both directions: an inherited marker must never suppress a
  // probe when our own hydration failed and the child's PATH is the raw launch one.
  return applyShellEnvironmentHydrationMarker(env, shellEnvironmentSync.pathHydrated);
}

function scheduleBackendRestart(reason: string): void {
  const response = backendSupervision.respondToStartFailure({
    quitting: isQuitting,
    restartPending: restartTimer !== null,
    migrationRecoveryMarkerPresent: isDesktopMigrationRecoveryPending(),
  });

  switch (response.kind) {
    case "ignore":
      return;
    case "recover-migration":
      // The marker is written mid-session by the migration that just killed the
      // backend, so bootstrap's one-shot check never saw it. Recovery owns the
      // process from here; respawning would only repeat the failed migration.
      writeDesktopLogHeader(
        `migration recovery marker detected after backend failure reason=${sanitizeLogValue(reason)}`,
      );
      safeConsoleError(
        `[desktop] backend failed with a pending migration recovery (${reason}); opening recovery`,
      );
      void runMidSessionMigrationRecovery(reason);
      return;
    case "give-up":
      writeDesktopLogHeader(
        `backend supervision gave up failures=${response.failures} reason=${sanitizeLogValue(reason)}`,
      );
      safeConsoleError(
        `[desktop] backend failed to start ${response.failures} times in a row (${reason}); no further restarts will be attempted`,
      );
      presentBackendStartupGiveUp(reason);
      return;
    case "retry":
      safeConsoleError(
        `[desktop] backend exited unexpectedly (${reason}); restarting in ${response.delayMs}ms (attempt ${response.attempt}/${BACKEND_MAX_CONSECUTIVE_START_FAILURES})`,
      );
      restartTimer = setTimeout(() => {
        restartTimer = null;
        void restartBackendAfterCrash(reason);
      }, response.delayMs);
      return;
  }
}

// Runs the same recovery flow bootstrap uses, but for a marker that appeared while
// the app was already running. Shown once per app run — the policy owns that latch.
async function runMidSessionMigrationRecovery(reason: string): Promise<void> {
  const outcome = await handleDesktopMigrationRecovery();
  if (outcome !== "continue") return;

  // The marker vanished between the crash check and the recovery run (another
  // process cleared it), so fall back to the normal supervised restart.
  await restartBackendAfterCrash(reason);
}

function backendFailureDialogDetail(reason: string): string {
  const summary = summarizeBackendFailureOutput(lastBackendFailureDetail ?? "");
  const cause = summary.length > 0 ? summary : reason;
  return [
    cause,
    "Synara paused automatic restarts so a failing backend can't keep respawning in the background.",
    `Log file:\n${Path.join(LOG_DIR, BACKEND_LOG_FILE_NAME)}`,
  ].join("\n\n");
}

async function openDesktopLogDirectory(): Promise<void> {
  try {
    await FS.promises.mkdir(LOG_DIR, { recursive: true });
    const errorMessage = await shell.openPath(LOG_DIR);
    if (errorMessage.trim().length > 0) {
      throw new Error(errorMessage);
    }
  } catch (error) {
    safeConsoleError(`[desktop] failed to open log directory: ${formatErrorMessage(error)}`);
  }
}

/**
 * Replaces the eternal loading skeleton with a blocking, actionable window once
 * supervision stops respawning the backend.
 */
function presentBackendStartupGiveUp(reason: string): void {
  if (isQuitting || backendLifecycleDialogInFlight) return;

  const detail = backendFailureDialogDetail(reason);
  const task = (async () => {
    for (;;) {
      const result = await dialog.showMessageBox({
        type: "error",
        title: "Synara's backend didn't start",
        message: `Synara's backend failed to start ${BACKEND_MAX_CONSECUTIVE_START_FAILURES} times in a row.`,
        detail,
        buttons: ["Try again", "Open logs", "Quit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });

      if (result.response === 1) {
        await openDesktopLogDirectory();
        continue;
      }

      if (result.response === 0) {
        // A user-driven retry is a fresh lifecycle start, not another crash cycle.
        backendLifecycleDialogInFlight = null;
        await restartBackendAfterCrash("manual retry after backend startup failure", "lifecycle");
        return;
      }

      requestGracefulAppQuit("backend failed to start");
      return;
    }
  })().finally(() => {
    if (backendLifecycleDialogInFlight === task) {
      backendLifecycleDialogInFlight = null;
    }
  });
  backendLifecycleDialogInFlight = task;
}

function handleBackendStartupBlock(block: BackendStartupBlock): void {
  if (isQuitting || backendLifecycleDialogInFlight) return;

  const task = (async () => {
    if (block.kind === "migration-recovery-required") {
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "Synara needs to recover its database",
        message: "A database migration did not finish safely.",
        detail:
          "Restart Synara to open the verified backup recovery flow. Provider and chat processes will remain stopped until recovery completes.",
        buttons: ["Restart and recover", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) {
        app.relaunch();
        requestGracefulAppQuit("migration recovery required");
      } else {
        requestGracefulAppQuit("migration recovery declined");
      }
      return;
    }

    const processDetail =
      block.ownerPid === null
        ? "Another Synara server is already using this database."
        : `Another Synara server (process ${block.ownerPid}) is already using this database.`;
    const result = await dialog.showMessageBox({
      type: "warning",
      title: "Synara is already running elsewhere",
      message: "Your local Synara data is in use by another process.",
      detail: `${processDetail}\n\nStop the other Synara app or development server, then try again. Your data has not been changed.`,
      buttons: ["Try again", "Quit"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) {
      // Let a fast failed retry present the block again instead of racing this
      // dialog task's finalizer and leaving the window inert.
      backendLifecycleDialogInFlight = null;
      await restartBackendAfterCrash("database lifecycle lock retry", "lifecycle");
    } else {
      requestGracefulAppQuit("database lifecycle lock");
    }
  })().finally(() => {
    if (backendLifecycleDialogInFlight === task) {
      backendLifecycleDialogInFlight = null;
    }
  });
  backendLifecycleDialogInFlight = task;
}

async function restartBackendAfterCrash(
  reason: string,
  trigger: BackendStartTrigger = "crash-restart",
): Promise<void> {
  if (isQuitting || backendProcess) {
    return;
  }

  if (trigger === "lifecycle") {
    // Reset before reserving the port so a user-driven retry gets a full restart
    // budget even when the retry itself fails before the process is spawned.
    backendSupervision.reset();
  }

  cancelBackendReadinessWait();
  try {
    await reserveBackendEndpoint("backend restart");
  } catch (error) {
    scheduleBackendRestart(
      `failed to reserve restart port after ${reason}: ${formatErrorMessage(error)}`,
    );
    return;
  }

  startBackend(trigger);
  ensureInitialBackendWindowOpen(backendHttpUrl);
}

/**
 * "lifecycle" covers every deliberate start — bootstrap, a failed update install
 * handing the backend back, or a user-driven retry — and clears the crash backoff
 * and circuit breaker. Only the supervised crash path keeps the failure count.
 */
type BackendStartTrigger = "lifecycle" | "crash-restart";

function startBackend(trigger: BackendStartTrigger = "lifecycle"): void {
  if (isQuitting || backendProcess) return;
  // Recovery owns the database until it clears the marker. Callers that restart
  // the backend after an unrelated failure — a given-up update install, say —
  // must not hand it a database the user is being asked how to repair.
  if (desktopStartupBlockedForMigrationRecovery) {
    writeDesktopLogHeader("backend start suppressed while migration recovery is pending");
    return;
  }

  if (trigger === "lifecycle") {
    backendSupervision.reset();
  }

  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  const child = ChildProcess.spawn(process.execPath, [...backendNodeArgs(), backendEntry], {
    cwd: resolveBackendCwd(),
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    env: {
      ...backendEnv(),
      ELECTRON_RUN_AS_NODE: "1",
      SYNARA_SERVER_ENTRY: backendEntry,
    },
    // Keep output piped in every environment so startup blockers and readiness
    // are observable even when packaged log setup is unavailable. The fourth
    // pipe carries the browser-host capability and must never be inherited.
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const capabilityPipe = child.stdio[DESKTOP_BROWSER_HOST_CAPABILITY_FD];
  if (capabilityPipe && "end" in capabilityPipe) {
    capabilityPipe.on("error", (error) => {
      if (!isBrokenPipeError(error)) {
        safeConsoleError("[desktop] failed to deliver browser host capability", error);
      }
    });
    capabilityPipe.end(DESKTOP_BROWSER_HOST_CAPABILITY);
  } else {
    child.kill();
    scheduleBackendRestart("browser host capability pipe was unavailable");
    return;
  }
  const listeningDetector = new ServerListeningDetector();
  const startupBlockDetector = new BackendStartupBlockDetector();
  const outputTailDetector = new BackendOutputTailDetector();
  backendListeningDetector = listeningDetector;
  backendProcess = child;
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    writeBackendSessionBoundary("END", details);
  };
  writeBackendSessionBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`,
  );
  const backendLogDestination = backendLogSink;
  const backendOutputCapture = captureBackendProcessOutput({
    stdout: child.stdout,
    stderr: child.stderr,
    ...(backendLogDestination ? { writeLog: (chunk) => backendLogDestination.write(chunk) } : {}),
    writeStdout: (chunk) => {
      process.stdout.write(chunk);
    },
    writeStderr: (chunk) => {
      process.stderr.write(chunk);
    },
    detectors: [listeningDetector, startupBlockDetector, outputTailDetector],
  });

  // A successful spawn only proves that Electron created the process. Reset the
  // crash backoff and the circuit breaker after the backend actually listens;
  // otherwise a startup error becomes a permanent 500 ms restart loop.
  void listeningDetector.promise.then(
    () => {
      if (backendListeningDetector === listeningDetector) {
        backendSupervision.recordReadiness();
      }
    },
    () => undefined,
  );

  child.on("error", (error) => {
    if (backendListeningDetector === listeningDetector) {
      listeningDetector.fail(error);
      backendListeningDetector = null;
    }
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    lastBackendFailureDetail = error.message;
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    if (backendListeningDetector === listeningDetector) {
      listeningDetector.fail(
        new Error(
          `backend exited before logging readiness (code=${code ?? "null"} signal=${signal ?? "null"})`,
        ),
      );
      backendListeningDetector = null;
    }
    if (backendProcess === child) {
      backendProcess = null;
    }
    void backendOutputCapture.drained.then(() => {
      closeBackendSession(
        `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      if (isQuitting) return;
      const startupBlock = startupBlockDetector.read();
      if (startupBlock) {
        handleBackendStartupBlock(startupBlock);
        return;
      }
      const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
      lastBackendFailureDetail = outputTailDetector.read();
      scheduleBackendRestart(reason);
    });
  });
}

function takeBackendProcessForShutdown(): ChildProcess.ChildProcess | null {
  cancelBackendReadinessWait();
  backendListeningDetector = null;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  return child;
}

function stopBackend(): void {
  const child = takeBackendProcessForShutdown();
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, BACKEND_FORCE_KILL_DELAY_MS).unref();
  }
}

async function stopBackendAndWaitForExit(timeoutMs = BACKEND_SHUTDOWN_TIMEOUT_MS): Promise<void> {
  const child = takeBackendProcessForShutdown();
  if (!child) return;
  const backendChild = child;
  if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;

  if (process.platform === "win32") {
    const forceKillDelayMs = Math.min(BACKEND_FORCE_KILL_DELAY_MS, Math.max(0, timeoutMs - 500));
    try {
      const result = await stopWindowsBackendAndWait({
        child: backendChild,
        backendHttpUrl,
        shutdownToken: DESKTOP_BACKEND_SHUTDOWN_TOKEN,
        forceKillDelayMs,
        timeoutMs,
      });
      requireWindowsBackendExit(result);
    } catch (error) {
      backendProcess = retainLiveBackendAfterShutdownFailure(backendProcess, backendChild);
      throw error;
    }
    return;
  }

  const forceKillDelayMs = Math.min(BACKEND_FORCE_KILL_DELAY_MS, Math.max(0, timeoutMs - 500));
  try {
    await stopPosixBackendAndWait({
      child: backendChild,
      forceKillDelayMs,
      timeoutMs,
    });
  } catch (error) {
    backendProcess = retainLiveBackendAfterShutdownFailure(backendProcess, backendChild);
    throw error;
  }
}

async function disposeBrowserHostPipeServerForShutdown(reason: string): Promise<void> {
  const pipeServer = browserHostPipeServer;
  browserHostPipeServer = null;
  if (!pipeServer) return;

  try {
    await pipeServer.dispose();
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    writeDesktopLogHeader(`${reason} browser host pipe dispose failed message=${message}`);
    console.warn(`[desktop] Failed to dispose browser host pipe during ${reason}: ${message}`);
  }
}

// Keeps Electron alive long enough for backend finalizers to reap provider child processes.
async function shutdownDesktopRuntime(reason: string): Promise<void> {
  if (desktopShutdownPromise) {
    return desktopShutdownPromise;
  }

  isQuitting = true;
  writeDesktopLogHeader(`${reason} shutdown start`);
  const shutdown = runAfterDesktopShutdown(
    stopBackendAndWaitForExit(),
    async () => {
      clearUpdateBackgroundBlurTimer();
      clearUpdateCheckTimeoutTimer();
      clearUpdatePollTimer();
      cancelBackendReadinessWait();
      appSnapManager?.dispose();
      appSnapManager = null;
      await disposeBrowserHostPipeServerForShutdown(reason);
      browserManager.dispose();
      restoreStdIoCapture?.();
      desktopShutdownComplete = true;
      writeDesktopLogHeader(`${reason} shutdown complete`);
    },
    { runAfterShutdownFailure: true },
  );
  desktopShutdownPromise = shutdown;

  try {
    await shutdown;
  } catch (error) {
    if (desktopShutdownPromise === shutdown) {
      desktopShutdownPromise = null;
    }
    throw error;
  }
}

function requestGracefulAppQuit(reason: string): void {
  if (isUpdaterInstallPreparing) {
    writeDesktopLogHeader(`${reason} waiting for updater quit-and-install`);
    return;
  }

  void runAfterDesktopShutdown(shutdownDesktopRuntime(reason), () => app.quit()).catch(
    (error: unknown) => {
      const message = formatErrorMessage(error);
      writeDesktopLogHeader(`${reason} shutdown failed message=${message}`);
      console.warn(`[desktop] Shutdown failed during ${reason}: ${message}`);
      app.exit(1);
    },
  );
}

function registerIpcHandlers(): void {
  const storageSnapshotPath = resolveSynaraStorageSnapshotPath(app.getPath("userData"));

  ipcMain.removeAllListeners(IPC.storageMigration.read);
  ipcMain.on(IPC.storageMigration.read, (event: IpcMainEvent) => {
    event.returnValue = readSynaraStorageSnapshot(storageSnapshotPath);
  });

  ipcMain.removeHandler(IPC.storageMigration.acknowledge);
  ipcMain.handle(IPC.storageMigration.acknowledge, async () => {
    await acknowledgeSynaraStorageSnapshot(storageSnapshotPath);
  });

  ipcMain.removeAllListeners(IPC.wsUrl);
  ipcMain.on(IPC.wsUrl, (event: IpcMainEvent) => {
    // The backend port is reserved at runtime, so preload asks main for the
    // live URL instead of trusting build-time or inherited renderer env.
    event.returnValue =
      normalizeDesktopWsUrl(backendWsUrl) ?? resolveDesktopWsUrlFromEnv(process.env);
  });

  ipcMain.removeAllListeners(IPC.zoomFactor);
  ipcMain.on(IPC.zoomFactor, (event: IpcMainEvent) => {
    event.returnValue = event.sender.getZoomFactor();
  });

  ipcMain.removeHandler(IPC.pickFolder);
  ipcMain.handle(IPC.pickFolder, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(IPC.saveFile);
  ipcMain.handle(IPC.saveFile, async (_event, input: unknown) => {
    if (!isSaveFileInput(input)) {
      throw new Error("Invalid save file input.");
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const options = {
      defaultPath: input.defaultFilename,
      ...(input.filters ? { filters: input.filters } : {}),
    };
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return null;
    }

    await FS.promises.writeFile(result.filePath, input.contents, "utf8");
    return result.filePath;
  });

  ipcMain.removeHandler(IPC.confirm);
  ipcMain.handle(IPC.confirm, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(IPC.setTheme);
  ipcMain.handle(IPC.setTheme, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    nativeTheme.themeSource = theme;
  });

  ipcMain.removeHandler(IPC.contextMenu);
  ipcMain.handle(
    IPC.contextMenu,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter((item) => typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          separatorBefore: item.separatorBefore === true,
          destructive: item.destructive === true,
        }));
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = [];
        let hasInsertedDestructiveSeparator = false;
        for (const item of normalizedItems) {
          const shouldInsertSeparator =
            item.separatorBefore ||
            (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0);
          if (shouldInsertSeparator && template.length > 0) {
            template.push({ type: "separator" });
          }
          if (item.destructive) {
            hasInsertedDestructiveSeparator = true;
          }
          const itemOption: MenuItemConstructorOptions = {
            label: item.label,
            click: () => resolve(item.id),
          };
          if (item.destructive) {
            const destructiveIcon = getDestructiveMenuIcon();
            if (destructiveIcon) {
              itemOption.icon = destructiveIcon;
            }
          }
          template.push(itemOption);
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(IPC.openExternal);
  ipcMain.handle(IPC.openExternal, async (_event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl);
    if (!externalUrl) {
      return false;
    }

    try {
      await shell.openExternal(externalUrl);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(IPC.clipboardWriteImage);
  ipcMain.handle(IPC.clipboardWriteImage, async (_event, rawDataUrl: unknown) => {
    if (typeof rawDataUrl !== "string") {
      return false;
    }
    if (rawDataUrl.length > MAX_CLIPBOARD_IMAGE_DATA_URL_LENGTH) {
      return false;
    }

    const dataUrl = rawDataUrl.trim();
    if (!dataUrl.startsWith("data:image/png;base64,")) {
      return false;
    }

    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) {
      return false;
    }

    clipboard.writeImage(image);
    return true;
  });

  ipcMain.removeHandler(IPC.showInFolder);
  ipcMain.handle(IPC.showInFolder, async (_event, rawPath: unknown) => {
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      throw new Error("Missing folder path.");
    }
    const resolvedPath = Path.resolve(rawPath);

    let stats: FS.Stats;
    try {
      stats = await FS.promises.stat(resolvedPath);
    } catch {
      throw new Error(`Folder not found: ${resolvedPath}`);
    }

    if (stats.isDirectory()) {
      const errorMessage = await shell.openPath(resolvedPath);
      if (errorMessage.trim().length > 0) {
        throw new Error(errorMessage);
      }
      return;
    }

    shell.showItemInFolder(resolvedPath);
  });

  ipcMain.removeHandler(IPC.windowMinimize);
  ipcMain.handle(IPC.windowMinimize, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    window?.minimize();
  });

  ipcMain.removeHandler(IPC.windowToggleMaximize);
  ipcMain.handle(IPC.windowToggleMaximize, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!window) {
      return { isMaximized: false, isFullscreen: false };
    }
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    const state = getDesktopWindowState(window);
    window.webContents.send(IPC.windowState, state);
    return state;
  });

  ipcMain.removeHandler(IPC.windowClose);
  ipcMain.handle(IPC.windowClose, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    window?.close();
  });

  ipcMain.removeHandler(IPC.windowGetState);
  ipcMain.handle(IPC.windowGetState, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    return window ? getDesktopWindowState(window) : { isMaximized: false, isFullscreen: false };
  });

  ipcMain.removeHandler(IPC.updateGetState);
  ipcMain.handle(IPC.updateGetState, async () => updateState);

  ipcMain.removeHandler(IPC.updateCheck);
  ipcMain.handle(IPC.updateCheck, async () => {
    await checkForUpdates("renderer");
    return updateState;
  });

  ipcMain.removeHandler(IPC.updateDownload);
  ipcMain.handle(IPC.updateDownload, async () => {
    const result = await downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(IPC.updateInstall);
  ipcMain.handle(IPC.updateInstall, async () => {
    if (isQuitting) {
      return {
        accepted: false,
        completed: false,
        state: updateState,
      } satisfies DesktopUpdateActionResult;
    }
    const result = await installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(IPC.notificationsIsSupported);
  ipcMain.handle(IPC.notificationsIsSupported, async () => Notification.isSupported());

  ipcMain.removeHandler(IPC.notificationsShow);
  ipcMain.handle(
    IPC.notificationsShow,
    async (
      _event,
      input:
        | {
            title?: unknown;
            body?: unknown;
            silent?: unknown;
            threadId?: unknown;
          }
        | null
        | undefined,
    ) =>
      showDesktopNotification({
        title: typeof input?.title === "string" ? input.title : "",
        body: typeof input?.body === "string" ? input.body : "",
        silent: input?.silent === true,
        ...(typeof input?.threadId === "string" ? { threadId: input.threadId } : {}),
      }),
  );
  if (appSnapManager) {
    registerAppSnapIpcHandlers(ipcMain, appSnapManager);
  }
  registerDesktopVoiceTranscriptionHandler();
  startBrowserPerformanceLogging();
  registerBrowserIpcHandlers(ipcMain, browserManager);
}

function getIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

// macOS backs the translucent shell with window vibrancy, so the window is created
// transparent (`#00000000`) over the vibrancy material. Windows/Linux have no vibrancy:
// a transparent window there leaves backdrop-filter surfaces bleeding through and, on
// fractional DPI, rendering blurry. So off macOS we create an opaque window and skip the
// macOS-only options. The background tracks the OS light/dark appearance purely to avoid
// a bright flash before the renderer paints — the window is shown only after first paint
// (`show: false`), so this color is not expected to match a custom in-app theme exactly.
function getWindowMaterialOptions(): BrowserWindowConstructorOptions {
  if (process.platform !== "darwin") {
    return { backgroundColor: nativeTheme.shouldUseDarkColors ? "#181818" : "#ffffff" };
  }
  return {
    vibrancy: "under-window",
    // "followWindow" lets macOS drop vibrancy blending to inactive when the
    // window is backgrounded, so WindowServer stops continuously recompositing
    // it. "active" forced full-cost blending even when the app was unfocused.
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
  };
}

// macOS keeps native traffic lights inset into the renderer's top chrome. Windows
// uses a fully frameless shell and renderer-owned minimize/maximize/close controls,
// so the toolbar can occupy the top edge instead of sitting below a native title bar.
function getTitleBarOptions(): BrowserWindowConstructorOptions {
  if (process.platform === "win32") {
    return { frame: false };
  }
  if (process.platform !== "darwin") {
    return {};
  }
  return {
    titleBarStyle: "hiddenInset",
    // Derived from the shared chat-surface header geometry (@synara/shared/desktopChrome)
    // so the native lights and the renderer's leading toggle/arrow controls always share
    // the same vertical center. Tune the height/radius there, never the raw px here.
    trafficLightPosition: getMacTrafficLightPosition(),
  };
}

function createWindow(): BrowserWindow {
  const savedWindowState = readDesktopWindowState(DESKTOP_WINDOW_STATE_PATH);
  const primaryDisplay = screen.getPrimaryDisplay();
  const restoredBounds = savedWindowState
    ? resolveVisibleWindowBounds({
        savedBounds: savedWindowState.bounds,
        displayWorkAreas: [
          primaryDisplay.workArea,
          ...screen
            .getAllDisplays()
            .filter((display) => display.id !== primaryDisplay.id)
            .map((display) => display.workArea),
        ],
        minimumWidth: 840,
        minimumHeight: 620,
      })
    : { width: 1100, height: 780 };
  const window = new BrowserWindow({
    ...restoredBounds,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    ...getTitleBarOptions(),
    ...getWindowMaterialOptions(),
    webPreferences: {
      preload: Path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      // Let Chromium throttle renderer timers/rAF when the window is hidden.
      backgroundThrottling: true,
    },
  });
  browserManager.setWindow(window);
  attachDesktopZoomFactorSync(window);
  attachRendererCrashRecovery(window);
  attachDesktopPhysicalZoomShortcuts(window);

  const annotationGuestPreload = Path.join(__dirname, "guestPreload.js");
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const partition = params.partition;
    if (
      partition === undefined ||
      !hardenBrowserAnnotationWebviewPreferences({
        partition,
        expectedPartition: BROWSER_SESSION_PARTITION,
        preloadPath: annotationGuestPreload,
        webPreferences,
      })
    ) {
      event.preventDefault();
    }
  });

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    const menuTemplate: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuTemplate.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuTemplate.push({ label: "No suggestions", enabled: false });
      }
      menuTemplate.push({ type: "separator" });
    }

    if (params.mediaType === "image") {
      menuTemplate.push({
        label: "Copy Image",
        click: () => window.webContents.copyImageAt(params.x, params.y),
      });
      menuTemplate.push({ type: "separator" });
    }

    menuTemplate.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );

    Menu.buildFromTemplate(menuTemplate).popup({ window });
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  window.webContents.on("did-finish-load", () => {
    window.setTitle(APP_DISPLAY_NAME);
    emitUpdateState();
  });
  window.once("ready-to-show", () => {
    // Preserve the original first-launch behavior, then respect the state saved
    // by subsequent closes. Normal bounds are restored before maximizing so the
    // native restore control returns to the user's last windowed size.
    if (!savedWindowState || savedWindowState.isMaximized) {
      window.maximize();
    }
    window.show();
    emitDesktopWindowState(window);
  });

  window.on("maximize", () => emitDesktopWindowState(window));
  window.on("unmaximize", () => emitDesktopWindowState(window));
  window.on("enter-full-screen", () => emitDesktopWindowState(window));
  window.on("leave-full-screen", () => emitDesktopWindowState(window));
  window.on("close", (event) => {
    try {
      writeDesktopWindowState(DESKTOP_WINDOW_STATE_PATH, {
        version: 1,
        bounds: window.getNormalBounds(),
        isMaximized: window.isMaximized(),
      });
    } catch (error) {
      console.warn(`[desktop] Failed to persist window state: ${formatErrorMessage(error)}`);
    }

    if (
      shouldDeferDesktopWindowClose({
        platform: process.platform,
        shutdownComplete: desktopShutdownComplete,
        updaterHandoffActive: isUpdaterQuitAndInstallInFlight,
      })
    ) {
      event.preventDefault();
      requestGracefulAppQuit("window-close");
    }
  });

  if (isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(desktopIdentity.entryUrl);
  }

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
    browserManager.setWindow(null);
  });

  return window;
}

/**
 * Renderer crashes used to be entirely invisible to the main process: no listener, no
 * log line, no telemetry, and no way back — a renderer OOM kill just left the user
 * staring at a blank window. Recovery is deliberately narrow: only reasons the renderer
 * can actually come back from reload, and only a few times, because a deterministic
 * crash reloading forever is worse than one blank window.
 */
function attachRendererCrashRecovery(window: BrowserWindow): void {
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  const clearReloadTimer = (): void => {
    if (reloadTimer === null) return;
    clearTimeout(reloadTimer);
    reloadTimer = null;
  };

  window.webContents.on("render-process-gone", (_event, details) => {
    const description = `reason=${details.reason} exitCode=${details.exitCode}`;
    writeDesktopLogHeader(`renderer process gone ${description}`);
    safeConsoleError(`[desktop] renderer process gone (${description})`);

    const response = rendererCrashPolicy.respondToCrash({
      reason: details.reason,
      quitting: isQuitting,
      nowMs: Date.now(),
    });

    switch (response.kind) {
      case "ignore":
        return;
      case "reload":
        writeDesktopLogHeader(
          `renderer reload scheduled attempt=${response.attempt}/${RENDERER_MAX_AUTOMATIC_RELOADS} delayMs=${response.delayMs}`,
        );
        clearReloadTimer();
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          if (isQuitting || window.isDestroyed()) return;
          window.webContents.reload();
        }, response.delayMs);
        return;
      case "prompt":
        writeDesktopLogHeader(
          `renderer recovery prompt cause=${response.cause} crashes=${response.crashes}`,
        );
        presentRendererCrashRecovery(window, details.reason, response);
        return;
    }
  });

  // A hung renderer is not a crash — Chromium keeps the process alive — so it never
  // reaches the listener above. Logging both edges makes a freeze that the user
  // reports as "the app died" distinguishable from an actual crash in the same log.
  window.webContents.on("unresponsive", () => {
    writeDesktopLogHeader("renderer unresponsive");
  });
  window.webContents.on("responsive", () => {
    writeDesktopLogHeader("renderer responsive");
  });

  window.on("closed", clearReloadTimer);
}

/**
 * Replaces the blank window with a blocking, actionable one once automatic recovery
 * stops (or was never allowed for this crash reason).
 */
function presentRendererCrashRecovery(
  window: BrowserWindow,
  reason: string,
  response: Extract<RendererCrashResponse, { kind: "prompt" }>,
): void {
  if (isQuitting || rendererCrashDialogInFlight) return;

  const message =
    response.cause === "reload-budget-exhausted"
      ? `Synara's window crashed ${response.crashes} times in a row.`
      : "Synara's window stopped unexpectedly.";
  const detail = [
    `The window's renderer process exited (${reason}).`,
    response.cause === "reload-budget-exhausted"
      ? "Synara paused automatic reloads so a repeating crash can't keep reloading in the background."
      : "This exit reason repeats on reload, so Synara did not retry automatically.",
    `Log file:\n${Path.join(LOG_DIR, DESKTOP_LOG_FILE_NAME)}`,
  ].join("\n\n");

  const task = (async () => {
    for (;;) {
      const result = await dialog.showMessageBox({
        type: "error",
        title: "Synara's window stopped",
        message,
        detail,
        buttons: ["Reload", "Open logs", "Quit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });

      if (result.response === 1) {
        await openDesktopLogDirectory();
        continue;
      }

      if (result.response === 0) {
        // A user-driven reload is a fresh start, not a continuation of the streak.
        rendererCrashPolicy.reset();
        if (!window.isDestroyed()) {
          window.webContents.reload();
        }
        return;
      }

      requestGracefulAppQuit("renderer crashed");
      return;
    }
  })().finally(() => {
    if (rendererCrashDialogInFlight === task) {
      rendererCrashDialogInFlight = null;
    }
  });
  rendererCrashDialogInFlight = task;
}

function configureMediaPermissions(): void {
  const trustedMainRenderer = () => {
    const renderer = mainWindow?.webContents ?? null;
    return renderer && !renderer.isDestroyed() ? renderer : null;
  };
  const permissionTargets = [
    {
      targetSession: session.defaultSession,
      trustedRequester: trustedMainRenderer,
    },
    {
      // Browser pages are untrusted web origins. They must never inherit the
      // microphone grant used by Synara's own voice-composer renderer.
      targetSession: session.fromPartition(BROWSER_SESSION_PARTITION),
      trustedRequester: () => null,
    },
  ];

  for (const { targetSession, trustedRequester } of permissionTargets) {
    if (!targetSession) continue;

    targetSession.setPermissionCheckHandler((webContents, permission, origin, details) => {
      if (
        permission !== "media" ||
        !isTrustedMediaPermissionRequest(webContents, trustedRequester(), details, origin)
      ) {
        return false;
      }

      return process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("microphone") === "granted"
        : true;
    });

    targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (
        permission !== "media" ||
        !isTrustedMediaPermissionRequest(webContents, trustedRequester(), details)
      ) {
        callback(false);
        return;
      }

      if (process.platform === "darwin") {
        const status = systemPreferences.getMediaAccessStatus("microphone");
        if (status === "granted") {
          callback(true);
          return;
        }

        void systemPreferences
          .askForMediaAccess("microphone")
          .then(callback, () => callback(false));
        return;
      }

      callback(true);
    });
  }
}

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
if (hasSingleInstanceLock) {
  repairBrowserProfileBeforeElectronReady(userDataPath);
}

configureAppIdentity();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusMainWindow();
  });
}

async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");
  // Ahead of the recovery gate on purpose. A startup that blocks below returns
  // early, and every path that could ship the fix for whatever blocked it lives
  // after that return: an install wedged on a bad migration would be unable to
  // update out of it, which is exactly how 0.6.0 stranded its users. The
  // updater touches no database state, so configuring it first is safe.
  configureAutoUpdater();

  const migrationRecoveryOutcome = await handleDesktopMigrationRecovery();
  if (migrationRecoveryOutcome !== "continue") {
    return;
  }

  backendAuthToken = Crypto.randomBytes(24).toString("hex");
  await reserveBackendEndpoint("bootstrap");

  registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");
  try {
    await ensureBrowserHostPipeServer();
  } catch (error) {
    console.warn("[Synara browser] Failed to start browser host pipe", error);
  }
  startBackend();
  writeDesktopLogHeader("bootstrap backend start requested");

  if (isDevelopment) {
    void waitForBackendWindowReady(backendHttpUrl)
      .then((source) => {
        writeDesktopLogHeader(`bootstrap backend ready source=${source}`);
        if (!mainWindow) {
          mainWindow = createWindow();
          writeDesktopLogHeader("bootstrap main window created");
        }
      })
      .catch((error) => {
        if (isBackendReadinessAborted(error)) {
          return;
        }
        writeDesktopLogHeader(
          `bootstrap backend readiness warning message=${formatErrorMessage(error)}`,
        );
        console.warn("[desktop] backend readiness check timed out during dev bootstrap", error);
        if (!mainWindow) {
          mainWindow = createWindow();
          writeDesktopLogHeader("bootstrap main window created after readiness warning");
        }
      });
    return;
  }

  ensureInitialBackendWindowOpen(backendHttpUrl);
}

app.on("before-quit", (event) => {
  writeDesktopLogHeader("before-quit received");
  if (desktopShutdownComplete) {
    return;
  }

  if (isUpdaterQuitAndInstallInFlight) {
    // Electron's updater owns this quit; canceling it would turn install into a plain app quit.
    try {
      if (
        !activeUpdateInstallHandoff ||
        !markInstallHandoffSync(getUpdateInstallMarkerPath(), activeUpdateInstallHandoff)
      ) {
        throw new Error("Durable update install handoff no longer matches the active attempt.");
      }
    } catch (error) {
      event.preventDefault();
      const failedHandoff = activeUpdateInstallHandoff;
      clearUpdaterInstallInFlightAfterError();
      const consecutiveFailures = recordInstallMarkerFailure(
        new Date().toISOString(),
        failedHandoff,
      );
      startBackend();
      scheduleUpdatePoll();
      setUpdateState({
        ...reduceDesktopUpdateStateOnInstallFailure(
          updateState,
          "The downloaded update could not be handed to the installer safely.",
        ),
        installFailureCount: consecutiveFailures,
      });
      console.error(
        `[desktop-updater] Refused mismatched install handoff during quit: ${formatErrorMessage(error)}`,
      );
      return;
    }
    writeDesktopLogHeader("before-quit allowing updater quit-and-install");
    return;
  }

  if (isUpdaterInstallPreparing) {
    // Keep user/system quits from preempting the pending updater install with a plain app.quit().
    writeDesktopLogHeader("before-quit waiting for updater quit-and-install");
    event.preventDefault();
    return;
  }

  event.preventDefault();
  requestGracefulAppQuit("before-quit");
});

if (hasSingleInstanceLock) {
  app
    .whenReady()
    .then(() => {
      writeDesktopLogHeader("app ready");
      configureAppIdentity();
      applyLegacyMacDockIcon();
      refreshMacIconCacheOnVersionChange();
      configureMediaPermissions();
      initializeDesktopAppSnap();
      configureApplicationMenu();
      try {
        registerDesktopProtocol();
      } catch (error) {
        if (error instanceof BundleChangedDuringStartupError) {
          restartAfterStartupBundleSwap(error);
          return;
        }
        throw error;
      }
      startBundleSwapWatcher();
      void bootstrap().catch((error) => {
        handleFatalStartupError("bootstrap", error);
      });

      app.on("browser-window-blur", () => {
        markDesktopAppBackgrounded();
      });

      app.on("browser-window-focus", () => {
        handleDesktopAppForegrounded();
      });

      app.on("activate", () => {
        if (desktopStartupBlockedForMigrationRecovery || isQuitting) {
          return;
        }
        handleDesktopAppForegrounded();
        if (BrowserWindow.getAllWindows().length === 0) {
          if (!isDevelopment) {
            ensureInitialBackendWindowOpen(backendHttpUrl);
            return;
          }
          void waitForBackendWindowReady(backendHttpUrl)
            .catch((error) => {
              if (isBackendReadinessAborted(error)) {
                return;
              }
              console.warn(
                "[desktop] backend readiness check timed out during dev activate",
                error,
              );
            })
            .finally(() => {
              if (!mainWindow) {
                mainWindow = createWindow();
              }
            });
          return;
        }
        focusMainWindow();
      });
    })
    .catch((error) => {
      handleFatalStartupError("whenReady", error);
    });
}

// GPU, utility, and pepper process failures never reach the window's renderer listener,
// so without this they are invisible too. Chromium respawns these itself — the value is
// the log line that explains a sudden loss of GPU acceleration or a dead audio/network
// service. Clean exits are routine teardown, so they stay out of the log.
app.on("child-process-gone", (_event, details) => {
  if (details.reason === "clean-exit") return;
  const attributes = [
    `type=${details.type}`,
    `reason=${details.reason}`,
    `exitCode=${details.exitCode}`,
    ...(details.serviceName ? [`service=${details.serviceName}`] : []),
    ...(details.name ? [`name=${sanitizeLogValue(details.name)}`] : []),
  ].join(" ");
  writeDesktopLogHeader(`child process gone ${attributes}`);
  safeConsoleError(`[desktop] child process gone (${attributes})`);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("uncaughtException", (error: unknown) => {
    if (!isBrokenPipeError(error)) {
      throw error;
    }
    if (desktopShutdownPromise) return;
    writeDesktopLogHeader("EPIPE received");
    requestGracefulAppQuit("EPIPE");
  });

  process.on("SIGINT", () => {
    if (desktopShutdownPromise) return;
    writeDesktopLogHeader("SIGINT received");
    requestGracefulAppQuit("SIGINT");
  });

  process.on("SIGTERM", () => {
    if (desktopShutdownPromise) return;
    writeDesktopLogHeader("SIGTERM received");
    requestGracefulAppQuit("SIGTERM");
  });
}
