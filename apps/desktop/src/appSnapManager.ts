// FILE: appSnapManager.ts
// Purpose: Owns the macOS AppSnap helper lifecycle, permission state, and pending captures.
// Layer: Desktop main-process service
// Depends on: A signed Swift helper plus narrow filesystem/process adapters.

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type DesktopAppSnapCapture,
  type DesktopAppSnapErrorEvent,
  type DesktopAppSnapPermission,
  type DesktopAppSnapPlatform,
  type DesktopAppSnapShortcut,
  type DesktopAppSnapShortcutAvailability,
  type DesktopAppSnapShortcutUpdateResult,
  type DesktopAppSnapState,
} from "@synara/contracts";
import {
  DEFAULT_APP_SNAP_SHORTCUT,
  appSnapShortcutAccelerator,
  appSnapShortcutSystemConflict,
  isAppSnapShortcut,
  sameAppSnapShortcut,
} from "@synara/shared/appSnapShortcut";

const MAX_PENDING_CAPTURES = PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
const MAX_HELPER_STDERR_CHARS = 4_096;
const MAX_PENDING_CAPTURE_METADATA_BYTES = 512 * 1024;
const PENDING_CAPTURE_STORAGE_VERSION = 1;
const PENDING_CAPTURE_FILE_PATTERN = /^pending-([a-f0-9]{64})\.json$/;
const PENDING_CAPTURE_IMAGE_PATTERN = /^pending-([a-f0-9]{64})\.png$/;
const HELPER_CAPTURE_IMAGE_PATTERN =
  /^appsnap-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type AppSnapHelperProcess = ChildProcess.ChildProcessByStdio<Writable | null, Readable, Readable>;

interface PendingAppSnapCaptureRecord {
  capture: DesktopAppSnapCapture;
  imagePath: string;
  metadataPath: string;
}

interface StoredPendingAppSnapCapture {
  version: typeof PENDING_CAPTURE_STORAGE_VERSION;
  id: string;
  capturedAt: string;
  name: string;
  mimeType: "image/png";
  sizeBytes: number;
  sourceAppName: string | null;
  sourceBundleIdentifier: string | null;
  sourceAppIconDataUrl: string | null;
  sourceWindowTitle: string | null;
}

type AppSnapHelperMessage =
  | {
      type: "permissions";
      inputMonitoring: "granted" | "denied";
      screenRecording: "granted" | "denied";
    }
  | { type: "ready" }
  | { type: "triggered"; id: string; capturedAt?: string }
  | {
      type: "captured";
      id: string;
      capturedAt?: string;
      path: string;
      name: string;
      sourceAppName?: string | null;
      sourceBundleIdentifier?: string | null;
      sourceAppIconDataUrl?: string | null;
      sourceWindowTitle?: string | null;
    }
  | {
      type: "error";
      id?: string;
      code: string;
      message: string;
      capturedAt?: string;
    };

export interface DesktopAppSnapManagerOptions {
  platform: NodeJS.Platform;
  helperPath: string;
  captureDirectory: string;
  excludedBundleId: string;
  onState: (state: DesktopAppSnapState) => void;
  onCaptured: (capture: DesktopAppSnapCapture) => void;
  onError: (error: DesktopAppSnapErrorEvent, focusApp: boolean) => void;
  now?: () => Date;
  spawn?: typeof ChildProcess.spawn;
  shortcutRegistry?: {
    register: (accelerator: string, callback: () => void) => boolean;
    unregister: (accelerator: string) => void;
  };
}

function normalizeDate(value: unknown, fallback: Date): string {
  if (typeof value !== "string") return fallback.toISOString();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback.toISOString();
}

function normalizeOptionalText(value: unknown, maxLength = 512): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

function normalizeAppIconDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256_000) return null;
  return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

function pendingCaptureStorageKey(captureId: string): string {
  return Crypto.createHash("sha256").update(captureId).digest("hex");
}

function pendingCaptureStoragePaths(
  captureDirectory: string,
  captureId: string,
): { imagePath: string; metadataPath: string } {
  const key = pendingCaptureStorageKey(captureId);
  const basePath = Path.join(captureDirectory, `pending-${key}`);
  return {
    imagePath: `${basePath}.png`,
    metadataPath: `${basePath}.json`,
  };
}

function toStoredPendingCapture(capture: DesktopAppSnapCapture): StoredPendingAppSnapCapture {
  return {
    version: PENDING_CAPTURE_STORAGE_VERSION,
    id: capture.id,
    capturedAt: capture.capturedAt,
    name: capture.name,
    mimeType: "image/png",
    sizeBytes: capture.sizeBytes,
    sourceAppName: capture.sourceAppName,
    sourceBundleIdentifier: capture.sourceBundleIdentifier,
    sourceAppIconDataUrl: capture.sourceAppIconDataUrl,
    sourceWindowTitle: capture.sourceWindowTitle,
  };
}

function parseStoredPendingCapture(value: unknown): StoredPendingAppSnapCapture | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = normalizeOptionalText(candidate.id, 128);
  const name = normalizeOptionalText(candidate.name, 240);
  const capturedAt = normalizeOptionalText(candidate.capturedAt, 128);
  const sizeBytes = candidate.sizeBytes;
  if (
    candidate.version !== PENDING_CAPTURE_STORAGE_VERSION ||
    !id ||
    !name ||
    !capturedAt ||
    !Number.isFinite(Date.parse(capturedAt)) ||
    candidate.mimeType !== "image/png" ||
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
  ) {
    return null;
  }
  return {
    version: PENDING_CAPTURE_STORAGE_VERSION,
    id,
    capturedAt: new Date(capturedAt).toISOString(),
    name,
    mimeType: "image/png",
    sizeBytes,
    sourceAppName: normalizeOptionalText(candidate.sourceAppName),
    sourceBundleIdentifier: normalizeOptionalText(candidate.sourceBundleIdentifier),
    sourceAppIconDataUrl: normalizeAppIconDataUrl(candidate.sourceAppIconDataUrl),
    sourceWindowTitle: normalizeOptionalText(candidate.sourceWindowTitle),
  };
}

async function readRegularFile(
  filePath: string,
  maximumBytes: number,
  expectedBytes?: number,
): Promise<Buffer> {
  const file = await FS.promises.open(
    filePath,
    FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW | FS.constants.O_NONBLOCK,
  );
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error("Expected a regular file.");
    if (stats.size <= 0) throw new Error("The file is empty.");
    if (stats.size > maximumBytes) throw new Error("The file is larger than allowed.");
    if (expectedBytes !== undefined && stats.size !== expectedBytes) {
      throw new Error("The file size does not match its metadata.");
    }
    const bytes = await file.readFile();
    if (bytes.length !== stats.size) throw new Error("The file changed while it was read.");
    return bytes;
  } finally {
    await file.close();
  }
}

async function readValidatedPendingPng(filePath: string, expectedBytes?: number): Promise<Buffer> {
  const bytes = await readRegularFile(filePath, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, expectedBytes);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("The file is not a valid PNG image.");
  }
  return bytes;
}

async function writePrivateFileAtomically(filePath: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Crypto.randomUUID()}`;
  try {
    await FS.promises.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await FS.promises.rename(temporaryPath, filePath);
    await FS.promises.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await FS.promises.unlink(temporaryPath).catch(() => undefined);
  }
}

function isPermission(value: unknown): value is "granted" | "denied" {
  return value === "granted" || value === "denied";
}

export function desktopAppSnapPlatform(platform: NodeJS.Platform): DesktopAppSnapPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return "other";
}

export function parseAppSnapHelperMessage(line: string): AppSnapHelperMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;

  if (
    value.type === "permissions" &&
    isPermission(value.inputMonitoring) &&
    isPermission(value.screenRecording)
  ) {
    return {
      type: "permissions",
      inputMonitoring: value.inputMonitoring,
      screenRecording: value.screenRecording,
    };
  }
  if (value.type === "ready") return { type: "ready" };
  if (value.type === "triggered" && typeof value.id === "string" && value.id.length > 0) {
    return {
      type: "triggered",
      id: value.id,
      ...(typeof value.capturedAt === "string" ? { capturedAt: value.capturedAt } : {}),
    };
  }
  if (
    value.type === "captured" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.name === "string"
  ) {
    return {
      type: "captured",
      id: value.id,
      path: value.path,
      name: value.name,
      ...(typeof value.capturedAt === "string" ? { capturedAt: value.capturedAt } : {}),
      ...(typeof value.sourceAppName === "string" || value.sourceAppName === null
        ? { sourceAppName: value.sourceAppName }
        : {}),
      ...(typeof value.sourceBundleIdentifier === "string" || value.sourceBundleIdentifier === null
        ? { sourceBundleIdentifier: value.sourceBundleIdentifier }
        : {}),
      ...(typeof value.sourceAppIconDataUrl === "string" || value.sourceAppIconDataUrl === null
        ? { sourceAppIconDataUrl: value.sourceAppIconDataUrl }
        : {}),
      ...(typeof value.sourceWindowTitle === "string" || value.sourceWindowTitle === null
        ? { sourceWindowTitle: value.sourceWindowTitle }
        : {}),
    };
  }
  if (
    value.type === "error" &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    value.message.length > 0
  ) {
    return {
      type: "error",
      code: value.code,
      message: value.message,
      ...(typeof value.id === "string" && value.id.length > 0 ? { id: value.id } : {}),
      ...(typeof value.capturedAt === "string" ? { capturedAt: value.capturedAt } : {}),
    };
  }
  return null;
}

export function isPathInsideDirectory(directory: string, candidate: string): boolean {
  const relative = Path.relative(Path.resolve(directory), Path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith(`..${Path.sep}`) && relative !== "..";
}

function permissionRequiredMessage(
  inputMonitoring: DesktopAppSnapPermission,
  screenRecording: DesktopAppSnapPermission,
): string {
  const missing: string[] = [];
  if (inputMonitoring !== "granted") missing.push("Input Monitoring");
  if (screenRecording !== "granted") missing.push("Screen Recording");
  return `Allow ${missing.join(" and ")} in macOS System Settings, then try again.`;
}

function isPermissionErrorCode(code: string): boolean {
  return (
    code === "input-monitoring-required" ||
    code === "screen-recording-required" ||
    code === "permission-required"
  );
}

function isBenignCaptureErrorCode(code: string): boolean {
  return code === "capture_in_progress" || code === "capture-in-progress";
}

export class DesktopAppSnapManager {
  readonly #options: Required<Pick<DesktopAppSnapManagerOptions, "now" | "spawn">> &
    Omit<DesktopAppSnapManagerOptions, "now" | "spawn">;
  readonly #platform: DesktopAppSnapPlatform;
  #enabled = false;
  #inputMonitoringPermission: DesktopAppSnapPermission = "unknown";
  #screenRecordingPermission: DesktopAppSnapPermission = "unknown";
  #status: DesktopAppSnapState["status"];
  #message: string | null;
  #watchProcess: AppSnapHelperProcess | null = null;
  #watchOutputLines: Readline.Interface | null = null;
  #watchReconcilePromise: Promise<void> | null = null;
  #watchReconcileRequested = false;
  #permissionProcess: AppSnapHelperProcess | null = null;
  #permissionCommandQueue: Promise<void> = Promise.resolve();
  #disposed = false;
  #intentionalWatchStop = false;
  #pendingCaptures: PendingAppSnapCaptureRecord[] = [];
  #pendingCapturesLoadPromise: Promise<void> | null = null;
  #captureReadQueue: Promise<void> = Promise.resolve();
  #shortcut: DesktopAppSnapShortcut = DEFAULT_APP_SNAP_SHORTCUT;
  #registeredAccelerator: string | null = null;

  constructor(options: DesktopAppSnapManagerOptions) {
    this.#options = {
      ...options,
      now: options.now ?? (() => new Date()),
      spawn: options.spawn ?? ChildProcess.spawn,
    };
    this.#platform = desktopAppSnapPlatform(options.platform);
    this.#status = this.#platform === "macos" ? "disabled" : "unsupported";
    this.#message =
      this.#platform === "macos" ? null : "AppSnap is available only in the macOS desktop app.";
  }

  getState(): DesktopAppSnapState {
    return {
      platform: this.#platform,
      supported: this.#platform === "macos",
      enabled: this.#enabled,
      status: this.#status,
      shortcut: this.#platform === "macos" ? this.#shortcut : null,
      inputMonitoringPermission: this.#inputMonitoringPermission,
      screenRecordingPermission: this.#screenRecordingPermission,
      message: this.#message,
    };
  }

  async refreshState(): Promise<DesktopAppSnapState> {
    if (this.#platform !== "macos" || this.#disposed) return this.getState();
    if (!(await this.#runPermissionCommand("--check-permissions"))) return this.getState();
    await this.#reconcileWatchProcess();
    return this.getState();
  }

  async setEnabled(enabled: boolean): Promise<DesktopAppSnapState> {
    if (this.#platform !== "macos" || this.#disposed) return this.getState();
    this.#enabled = enabled;
    if (!enabled) {
      this.#stopWatchProcess();
      this.#releaseShortcutReservation();
      this.#setState("disabled", null);
      return this.getState();
    }
    if (!(await this.#runPermissionCommand("--check-permissions"))) return this.getState();
    await this.#reconcileWatchProcess();
    return this.getState();
  }

  checkShortcut(shortcut: unknown): DesktopAppSnapShortcutAvailability {
    if (this.#platform !== "macos") {
      return { available: false, reason: "AppSnap shortcuts are available only on macOS." };
    }
    if (!isAppSnapShortcut(shortcut)) {
      return {
        available: false,
        reason: "Choose one modifier and one supported keyboard key.",
      };
    }
    if (shortcut.kind === "both-option-keys") {
      return { available: true, reason: null };
    }
    const systemConflict = appSnapShortcutSystemConflict(shortcut);
    if (systemConflict) {
      return { available: false, reason: systemConflict };
    }

    const accelerator = appSnapShortcutAccelerator(shortcut);
    if (this.#registeredAccelerator === accelerator) {
      return { available: true, reason: null };
    }
    const registry = this.#options.shortcutRegistry;
    if (!registry) {
      return { available: false, reason: "Global shortcut checks are unavailable." };
    }
    try {
      if (!registry.register(accelerator, () => undefined)) {
        return {
          available: false,
          reason: "macOS or another app is already using this shortcut.",
        };
      }
      registry.unregister(accelerator);
      return { available: true, reason: null };
    } catch {
      return { available: false, reason: "macOS could not register this shortcut." };
    }
  }

  /**
   * Adopts any well-formed shortcut, even one the availability probe rejects:
   * a persisted chord that another app grabbed since last launch must surface
   * as an error state from reconciliation, not silently keep the old chord.
   */
  async setShortcut(shortcut: unknown): Promise<DesktopAppSnapShortcutUpdateResult> {
    const availability = this.checkShortcut(shortcut);
    if (
      this.#platform !== "macos" ||
      !isAppSnapShortcut(shortcut) ||
      sameAppSnapShortcut(this.#shortcut, shortcut)
    ) {
      return { state: this.getState(), availability };
    }

    this.#stopWatchProcess();
    this.#releaseShortcutReservation();
    this.#shortcut = shortcut;
    if (this.#enabled) await this.#reconcileWatchProcess();
    this.#emitState();
    return { state: this.getState(), availability };
  }

  async requestPermissions(): Promise<DesktopAppSnapState> {
    if (this.#platform !== "macos" || this.#disposed) return this.getState();
    if (!(await this.#runPermissionCommand("--request-permissions"))) return this.getState();
    await this.#reconcileWatchProcess();
    return this.getState();
  }

  async listPendingCaptures(): Promise<DesktopAppSnapCapture[]> {
    await this.#ensurePendingCapturesLoaded();
    return this.#pendingCaptures.map(({ capture }) => ({
      ...capture,
      bytes: new Uint8Array(capture.bytes),
    }));
  }

  async acknowledgeCapture(captureId: string): Promise<void> {
    if (captureId.trim().length === 0) return;
    await this.#ensurePendingCapturesLoaded();
    const matchingRecords = this.#pendingCaptures.filter(({ capture }) => capture.id === captureId);
    for (const record of matchingRecords) {
      await this.#deletePendingCaptureFiles(record);
    }
    this.#pendingCaptures = this.#pendingCaptures.filter(({ capture }) => capture.id !== captureId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopWatchProcess();
    this.#releaseShortcutReservation();
    this.#permissionProcess?.kill("SIGTERM");
    this.#permissionProcess = null;
    this.#pendingCaptures = [];
  }

  async #ensurePendingCapturesLoaded(): Promise<void> {
    if (!this.#pendingCapturesLoadPromise) {
      this.#pendingCapturesLoadPromise = this.#loadPendingCaptures();
    }
    const loadPromise = this.#pendingCapturesLoadPromise;
    try {
      await loadPromise;
    } catch (error) {
      if (this.#pendingCapturesLoadPromise === loadPromise) {
        this.#pendingCapturesLoadPromise = null;
      }
      throw error;
    }
  }

  async #loadPendingCaptures(): Promise<void> {
    await FS.promises.mkdir(this.#options.captureDirectory, { recursive: true, mode: 0o700 });
    await FS.promises.chmod(this.#options.captureDirectory, 0o700).catch(() => undefined);
    const entries = await FS.promises.readdir(this.#options.captureDirectory);
    const records: PendingAppSnapCaptureRecord[] = [];
    const metadataStorageKeys = new Set(
      entries.flatMap((entry) => PENDING_CAPTURE_FILE_PATTERN.exec(entry)?.[1] ?? []),
    );

    for (const entry of entries) {
      const imageStorageKey = PENDING_CAPTURE_IMAGE_PATTERN.exec(entry)?.[1];
      if (!imageStorageKey || metadataStorageKeys.has(imageStorageKey)) continue;
      await FS.promises
        .unlink(Path.join(this.#options.captureDirectory, entry))
        .catch(() => undefined);
    }

    for (const entry of entries) {
      const match = PENDING_CAPTURE_FILE_PATTERN.exec(entry);
      if (!match) continue;
      const storageKey = match[1];
      const metadataPath = Path.join(this.#options.captureDirectory, entry);
      const imagePath = Path.join(this.#options.captureDirectory, `pending-${storageKey}.png`);
      try {
        const metadataBytes = await readRegularFile(
          metadataPath,
          MAX_PENDING_CAPTURE_METADATA_BYTES,
        );
        const stored = parseStoredPendingCapture(JSON.parse(metadataBytes.toString("utf8")));
        if (!stored || pendingCaptureStorageKey(stored.id) !== storageKey) {
          throw new Error("Pending AppSnap metadata is invalid.");
        }
        const bytes = await readValidatedPendingPng(imagePath, stored.sizeBytes);
        records.push({
          capture: {
            id: stored.id,
            capturedAt: stored.capturedAt,
            name: stored.name,
            mimeType: stored.mimeType,
            sizeBytes: bytes.byteLength,
            bytes: new Uint8Array(bytes),
            sourceAppName: stored.sourceAppName,
            sourceBundleIdentifier: stored.sourceBundleIdentifier,
            sourceAppIconDataUrl: stored.sourceAppIconDataUrl,
            sourceWindowTitle: stored.sourceWindowTitle,
          },
          imagePath,
          metadataPath,
        });
      } catch (error) {
        console.warn(
          `[desktop-appsnap] Removing unreadable pending capture ${entry}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await FS.promises.unlink(imagePath).catch(() => undefined);
        await FS.promises.unlink(metadataPath).catch(() => undefined);
      }
    }

    // The helper writes its PNG before Electron can durably create the
    // pending pair. Recover that original after a crash in the narrow gap.
    for (const entry of entries) {
      const captureId = HELPER_CAPTURE_IMAGE_PATTERN.exec(entry)?.[1];
      if (!captureId) continue;
      const helperImagePath = Path.join(this.#options.captureDirectory, entry);
      if (records.some((record) => record.capture.id === captureId)) {
        await FS.promises.unlink(helperImagePath).catch(() => undefined);
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await readValidatedPendingPng(helperImagePath);
      } catch (error) {
        console.warn(
          `[desktop-appsnap] Removing unreadable helper capture ${entry}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await FS.promises.unlink(helperImagePath).catch(() => undefined);
        continue;
      }

      const capturedAt = this.#options.now().toISOString();
      const capture: DesktopAppSnapCapture = {
        id: captureId,
        capturedAt,
        name: entry,
        mimeType: "image/png",
        sizeBytes: bytes.byteLength,
        bytes: new Uint8Array(bytes),
        sourceAppName: null,
        sourceBundleIdentifier: null,
        sourceAppIconDataUrl: null,
        sourceWindowTitle: null,
      };
      try {
        records.push(await this.#persistPendingCapture(capture));
        await FS.promises.unlink(helperImagePath).catch(() => undefined);
      } catch (error) {
        // Keep the helper image as the recovery source for the next startup.
        console.warn(
          `[desktop-appsnap] Could not recover helper capture ${entry}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    records.sort(
      (left, right) =>
        Date.parse(left.capture.capturedAt) - Date.parse(right.capture.capturedAt) ||
        left.capture.id.localeCompare(right.capture.id),
    );
    const overflow = records.slice(0, Math.max(0, records.length - MAX_PENDING_CAPTURES));
    for (const record of overflow) {
      await this.#deletePendingCaptureFiles(record).catch((error) =>
        console.warn("[desktop-appsnap] Could not remove an overflow pending capture", error),
      );
    }
    this.#pendingCaptures = records.slice(-MAX_PENDING_CAPTURES);
  }

  async #persistPendingCapture(
    capture: DesktopAppSnapCapture,
  ): Promise<PendingAppSnapCaptureRecord> {
    const paths = pendingCaptureStoragePaths(this.#options.captureDirectory, capture.id);
    await writePrivateFileAtomically(paths.imagePath, capture.bytes);
    try {
      const metadata = Buffer.from(`${JSON.stringify(toStoredPendingCapture(capture))}\n`, "utf8");
      if (metadata.byteLength > MAX_PENDING_CAPTURE_METADATA_BYTES) {
        throw new Error("Pending AppSnap metadata exceeds its storage limit.");
      }
      await writePrivateFileAtomically(paths.metadataPath, metadata);
    } catch (error) {
      await FS.promises.unlink(paths.imagePath).catch(() => undefined);
      throw error;
    }
    return { capture, ...paths };
  }

  async #deletePendingCaptureFiles(record: PendingAppSnapCaptureRecord): Promise<void> {
    await FS.promises.unlink(record.imagePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await FS.promises.unlink(record.metadataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  #emitState(): void {
    this.#options.onState(this.getState());
  }

  #setState(status: DesktopAppSnapState["status"], message: string | null): void {
    const changed = this.#status !== status || this.#message !== message;
    this.#status = status;
    this.#message = message;
    if (changed) this.#emitState();
  }

  async #reconcileWatchProcess(): Promise<void> {
    this.#watchReconcileRequested = true;
    if (this.#watchReconcilePromise) {
      await this.#watchReconcilePromise;
      if (this.#watchReconcileRequested) {
        await this.#reconcileWatchProcess();
      }
      return;
    }
    const reconcilePromise = (async () => {
      while (this.#watchReconcileRequested) {
        this.#watchReconcileRequested = false;
        await this.#reconcileWatchProcessOnce();
      }
    })();
    let trackedPromise: Promise<void>;
    trackedPromise = reconcilePromise.finally(() => {
      if (this.#watchReconcilePromise === trackedPromise) {
        this.#watchReconcilePromise = null;
      }
    });
    this.#watchReconcilePromise = trackedPromise;
    await trackedPromise;
    if (this.#watchReconcileRequested) {
      await this.#reconcileWatchProcess();
    }
  }

  async #reconcileWatchProcessOnce(): Promise<void> {
    if (this.#disposed || this.#platform !== "macos") return;
    if (!this.#enabled) {
      this.#stopWatchProcess();
      this.#releaseShortcutReservation();
      this.#setState("disabled", null);
      return;
    }
    if (
      this.#inputMonitoringPermission !== "granted" ||
      this.#screenRecordingPermission !== "granted"
    ) {
      this.#stopWatchProcess();
      this.#releaseShortcutReservation();
      this.#setState(
        "permission-required",
        permissionRequiredMessage(this.#inputMonitoringPermission, this.#screenRecordingPermission),
      );
      return;
    }
    if (!FS.existsSync(this.#options.helperPath)) {
      this.#stopWatchProcess();
      this.#releaseShortcutReservation();
      this.#setState("error", "The AppSnap native helper is missing from this desktop build.");
      return;
    }
    if (this.#shortcut.kind === "key-chord" && !this.#reserveShortcut(this.#shortcut)) {
      this.#stopWatchProcess();
      this.#setState("error", "The AppSnap shortcut is already used by macOS or another app.");
      return;
    }
    if (this.#shortcut.kind === "both-option-keys") this.#releaseShortcutReservation();
    if (this.#watchProcess) return;
    try {
      await FS.promises.mkdir(this.#options.captureDirectory, { recursive: true, mode: 0o700 });
      await FS.promises.chmod(this.#options.captureDirectory, 0o700).catch(() => undefined);
      if (
        this.#disposed ||
        !this.#enabled ||
        this.#watchProcess ||
        this.#inputMonitoringPermission !== "granted" ||
        this.#screenRecordingPermission !== "granted"
      ) {
        if (!this.#watchProcess) this.#releaseShortcutReservation();
        return;
      }
      this.#startWatchProcess();
    } catch (error) {
      this.#releaseShortcutReservation();
      this.#setState(
        "error",
        `Could not start AppSnap: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #startWatchProcess(): void {
    this.#intentionalWatchStop = false;
    this.#setState("starting", null);
    // Key chords are detected by Electron's reserved accelerator; the helper
    // only captures on demand, driven by "trigger" lines on its stdin.
    const shortcutArguments = this.#shortcut.kind === "key-chord" ? ["--external-trigger"] : [];
    const child = this.#options.spawn(
      this.#options.helperPath,
      [
        "--watch",
        "--output-dir",
        this.#options.captureDirectory,
        "--excluded-bundle-id",
        this.#options.excludedBundleId,
        ...shortcutArguments,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    // A helper that dies mid-write must not surface as an unhandled stream error.
    child.stdin?.on("error", () => undefined);
    this.#watchProcess = child;
    this.#watchOutputLines = this.#wireHelperOutput(child, (message) =>
      this.#handleWatchMessage(child, message),
    );
    child.once("error", (error) => {
      if (this.#watchProcess !== child) return;
      this.#watchProcess = null;
      this.#watchOutputLines?.close();
      this.#watchOutputLines = null;
      this.#releaseShortcutReservation();
      const message = `Could not start AppSnap: ${error.message}`;
      this.#setState("error", message);
      this.#emitCaptureError("helper-stopped", message, undefined, false);
    });
    child.once("exit", (code, signal) => {
      if (this.#watchProcess !== child) return;
      this.#watchProcess = null;
      this.#watchOutputLines?.close();
      this.#watchOutputLines = null;
      if (this.#disposed || this.#intentionalWatchStop || !this.#enabled) return;
      this.#releaseShortcutReservation();
      const message = `The AppSnap helper stopped unexpectedly (${signal ?? `exit ${code ?? "unknown"}`}).`;
      this.#setState("error", message);
      this.#emitCaptureError("helper-stopped", message, undefined, false);
    });
  }

  #stopWatchProcess(): void {
    const child = this.#watchProcess;
    this.#watchProcess = null;
    this.#watchOutputLines?.close();
    this.#watchOutputLines = null;
    if (!child) return;
    this.#intentionalWatchStop = true;
    child.kill("SIGTERM");
  }

  #reserveShortcut(shortcut: Extract<DesktopAppSnapShortcut, { kind: "key-chord" }>): boolean {
    const accelerator = appSnapShortcutAccelerator(shortcut);
    if (this.#registeredAccelerator === accelerator) return true;
    const registry = this.#options.shortcutRegistry;
    if (!registry) return false;
    try {
      if (!registry.register(accelerator, () => this.#handleShortcutTrigger())) return false;
      this.#registeredAccelerator = accelerator;
      return true;
    } catch {
      return false;
    }
  }

  #handleShortcutTrigger(): void {
    if (this.#disposed || !this.#enabled) return;
    try {
      this.#watchProcess?.stdin?.write("trigger\n");
    } catch {
      // The helper exit handler owns recovery; a lost trigger is acceptable.
    }
  }

  #releaseShortcutReservation(): void {
    const accelerator = this.#registeredAccelerator;
    this.#registeredAccelerator = null;
    if (!accelerator) return;
    try {
      this.#options.shortcutRegistry?.unregister(accelerator);
    } catch {
      // Electron may already have cleared global shortcuts during app shutdown.
    }
  }

  #wireHelperOutput(
    child: AppSnapHelperProcess,
    onMessage: (message: AppSnapHelperMessage) => void,
  ): Readline.Interface {
    const lines = Readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = parseAppSnapHelperMessage(line);
      if (message) onMessage(message);
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length >= MAX_HELPER_STDERR_CHARS) return;
      stderr = `${stderr}${chunk}`.slice(0, MAX_HELPER_STDERR_CHARS);
    });
    child.once("close", (code) => {
      const diagnostic = stderr.trim();
      if (code !== 0 && diagnostic.length > 0) {
        console.warn(`[desktop-appsnap] Native helper: ${diagnostic}`);
      }
    });
    return lines;
  }

  async #runPermissionCommand(
    command: "--check-permissions" | "--request-permissions",
  ): Promise<boolean> {
    const run = this.#permissionCommandQueue.then(() => this.#executePermissionCommand(command));
    this.#permissionCommandQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async #executePermissionCommand(
    command: "--check-permissions" | "--request-permissions",
  ): Promise<boolean> {
    if (this.#disposed || this.#platform !== "macos") return false;
    if (!FS.existsSync(this.#options.helperPath)) {
      this.#setState("error", "The AppSnap native helper is missing from this desktop build.");
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      let child: AppSnapHelperProcess;
      try {
        child = this.#options.spawn(this.#options.helperPath, [command], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        this.#setState(
          "error",
          `Could not inspect AppSnap permissions: ${error instanceof Error ? error.message : String(error)}`,
        );
        resolve(false);
        return;
      }
      this.#permissionProcess = child;
      let receivedPermissions = false;
      let reportedError: string | null = null;
      let spawnFailed = false;
      this.#wireHelperOutput(child, (message) => {
        if (message.type === "permissions") {
          receivedPermissions = true;
          this.#inputMonitoringPermission = message.inputMonitoring;
          this.#screenRecordingPermission = message.screenRecording;
          this.#emitState();
        } else if (message.type === "error") {
          reportedError = message.message;
        }
      });
      child.once("error", (error) => {
        spawnFailed = true;
        if (this.#permissionProcess === child) this.#permissionProcess = null;
        this.#setState("error", `Could not inspect AppSnap permissions: ${error.message}`);
        resolve(false);
      });
      child.once("close", () => {
        if (this.#permissionProcess === child) this.#permissionProcess = null;
        if (this.#disposed) {
          resolve(false);
          return;
        }
        if (!receivedPermissions && !spawnFailed) {
          this.#setState(
            "error",
            reportedError ?? "The AppSnap helper did not report its permission state.",
          );
        }
        resolve(receivedPermissions);
      });
    });
  }

  #handleWatchMessage(child: AppSnapHelperProcess, message: AppSnapHelperMessage): void {
    if (this.#disposed || this.#watchProcess !== child) return;
    if (message.type === "ready") {
      // `ready` only proves the event tap installed, i.e. Input Monitoring.
      // Screen Recording state is owned by permission checks and capture errors.
      this.#inputMonitoringPermission = "granted";
      this.#setState("ready", null);
      return;
    }
    if (message.type === "permissions") {
      this.#inputMonitoringPermission = message.inputMonitoring;
      this.#screenRecordingPermission = message.screenRecording;
      this.#emitState();
      return;
    }
    if (message.type === "triggered") {
      console.info(`[desktop-appsnap] Option chord triggered (${message.id}).`);
      return;
    }
    if (message.type === "captured") {
      this.#captureReadQueue = this.#captureReadQueue
        .then(() => this.#consumeCapture(message))
        .catch((error) => {
          this.#emitCaptureError(
            "capture-read-failed",
            error instanceof Error ? error.message : "Could not read the captured AppSnap.",
            message.capturedAt,
            true,
          );
        });
      return;
    }

    if (message.code === "event_tap_disabled" || message.code === "event-tap-disabled") {
      console.warn(`[desktop-appsnap] ${message.message}`);
      return;
    }

    console.warn(`[desktop-appsnap] Helper error ${message.code}: ${message.message}`);

    if (message.code === "input-monitoring-required") {
      this.#inputMonitoringPermission = "denied";
    }
    if (message.code === "screen-recording-required") {
      this.#screenRecordingPermission = "denied";
    }
    if (isPermissionErrorCode(message.code)) {
      this.#stopWatchProcess();
      this.#releaseShortcutReservation();
      this.#setState(
        "permission-required",
        permissionRequiredMessage(this.#inputMonitoringPermission, this.#screenRecordingPermission),
      );
    }
    // Benign overlap errors surface as a toast without yanking Synara to the
    // foreground while the user is still working in the captured app.
    this.#emitCaptureError(
      message.code,
      message.message,
      message.capturedAt,
      !isBenignCaptureErrorCode(message.code),
    );
  }

  async #consumeCapture(
    message: Extract<AppSnapHelperMessage, { type: "captured" }>,
  ): Promise<void> {
    const capturePath = Path.resolve(message.path);
    if (!isPathInsideDirectory(this.#options.captureDirectory, capturePath)) {
      throw new Error("The AppSnap helper returned a capture outside its private directory.");
    }

    await this.#ensurePendingCapturesLoaded();
    const bytes = await readValidatedPendingPng(capturePath);
    const now = this.#options.now();
    const capture: DesktopAppSnapCapture = {
      id: normalizeOptionalText(message.id, 128) ?? Crypto.randomUUID(),
      capturedAt: normalizeDate(message.capturedAt, now),
      name:
        normalizeOptionalText(message.name, 240) ??
        `AppSnap-${now.toISOString().replace(/[:.]/g, "-")}.png`,
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      bytes: new Uint8Array(bytes),
      sourceAppName: normalizeOptionalText(message.sourceAppName),
      sourceBundleIdentifier: normalizeOptionalText(message.sourceBundleIdentifier),
      sourceAppIconDataUrl: normalizeAppIconDataUrl(message.sourceAppIconDataUrl),
      sourceWindowTitle: normalizeOptionalText(message.sourceWindowTitle),
    };
    const pendingRecord = await this.#persistPendingCapture(capture);
    // Only delete the helper's temporary file once the pending copy durably
    // owns the capture; deleting it earlier would destroy the only on-disk
    // copy when persistence fails transiently.
    await FS.promises.unlink(capturePath).catch(() => undefined);
    const nextPendingCaptures = [
      ...this.#pendingCaptures.filter((entry) => entry.capture.id !== capture.id),
      pendingRecord,
    ];
    const discardedRecord =
      nextPendingCaptures.length > MAX_PENDING_CAPTURES ? nextPendingCaptures[0] : null;
    this.#pendingCaptures = nextPendingCaptures.slice(-MAX_PENDING_CAPTURES);
    if (discardedRecord) {
      await this.#deletePendingCaptureFiles(discardedRecord).catch((error) =>
        console.warn("[desktop-appsnap] Could not delete an overflow pending capture", error),
      );
      this.#emitCaptureError(
        "pending-capture-overflow",
        `Synara could retain only the latest ${MAX_PENDING_CAPTURES} AppSnaps while the composer was unavailable. The oldest capture was discarded.`,
        discardedRecord.capture.capturedAt,
        false,
      );
    }
    this.#options.onCaptured(capture);
  }

  #emitCaptureError(
    code: string,
    message: string,
    capturedAt: string | undefined,
    focusApp: boolean,
  ): void {
    this.#options.onError(
      {
        code: normalizeOptionalText(code, 128) ?? "capture-failed",
        message: normalizeOptionalText(message, 1_000) ?? "AppSnap capture failed.",
        capturedAt: normalizeDate(capturedAt, this.#options.now()),
      },
      focusApp,
    );
  }
}
