import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { BrowserTabId, BrowserUploadInput, BrowserUploadOutput } from "@synara/contracts";
import { app, type WebContents } from "electron";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { throwIfAborted } from "./cdpRuntime";
import { browserHostError } from "./hostErrors";
import { runBetterwright } from "./betterwrightRuntime";
import { betterwrightLocator } from "./betterwrightLocator";

const MAX_UPLOAD_FILE_BYTES = 2_147_483_647;
const DEFAULT_MAX_UPLOAD_INVOCATION_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_STAGED_UPLOAD_BYTES_PER_WEB_CONTENTS = 512 * 1024 * 1024;
const DEFAULT_MAX_STAGED_UPLOAD_DIRECTORIES_PER_WEB_CONTENTS = 64;
const DEFAULT_MAX_STAGED_UPLOAD_FILES_PER_WEB_CONTENTS = 512;
const UPLOAD_COPY_BUFFER_BYTES = 1024 * 1024;
const PRIVATE_RUNTIME_DIRECTORY = "private-runtime";
const STAGING_DIRECTORY_NAME = "browser-upload-staging";

export interface ResolvedWorkspaceUploadFile {
  readonly path: string;
  readonly name: string;
  readonly byteLength: number;
}

interface InspectedWorkspaceUploadFile extends ResolvedWorkspaceUploadFile {
  readonly status: Stats;
}

interface StagedWorkspaceUpload {
  readonly directory: string;
  readonly files: readonly ResolvedWorkspaceUploadFile[];
}

interface StagedUploadAccounting {
  readonly byteLength: number;
  readonly fileCount: number;
  cleanup: Promise<boolean> | undefined;
}

interface StagedUploadState {
  readonly directories: Map<string, StagedUploadAccounting>;
  root: Promise<string> | undefined;
  accountedBytes: number;
  accountedDirectories: number;
  accountedFiles: number;
  generation: number;
  destroyed: boolean;
  hasLifecycle: boolean;
}

interface StagedUploadReservation {
  readonly state: StagedUploadState;
  readonly byteLength: number;
  readonly fileCount: number;
  readonly generation: number;
  settled: boolean;
}

interface WorkspaceUploadTestConfiguration {
  readonly userDataRoot?: string;
  readonly maxInvocationBytes?: number;
  readonly maxStagedBytesPerWebContents?: number;
  readonly maxStagedDirectoriesPerWebContents?: number;
  readonly maxStagedFilesPerWebContents?: number;
}

const stagedUploads = new WeakMap<WebContents, StagedUploadState>();
let stagingBasePromise: Promise<string> | undefined;
const testConfigurations = new WeakMap<WebContents, WorkspaceUploadTestConfiguration>();
const testStagingBasePromises = new Map<string, Promise<string>>();

/** Test-only injection for a sandbox-safe fake Electron userData root and small quota fixtures. */
export const configureWorkspaceUploadForTests = (
  webContents: WebContents,
  configuration: WorkspaceUploadTestConfiguration,
): void => {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Workspace upload test configuration is only available under tests.");
  }
  testConfigurations.set(webContents, configuration);
};

function uploadError(
  code:
    | "BrowserUploadPathOutsideWorkspace"
    | "BrowserUploadWorkspaceUnavailable"
    | "BrowserUploadFileUnsupported",
): never {
  return browserHostError({ code });
}

const isBrowserHostError = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "browserError" in error);

const isContainedPath = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== "" &&
    !isAbsolute(pathFromRoot) &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`)
  );
};

const isSupportedRegularFile = (status: Stats): boolean =>
  status.isFile() && status.size >= 0 && status.size <= MAX_UPLOAD_FILE_BYTES;

const hasSameFileIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size;

const hasUnchangedFileContents = (before: Stats, after: Stats): boolean =>
  hasSameFileIdentity(before, after) &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs;

const inspectWorkspaceUploadFiles = async (
  workspaceRoot: string | null | undefined,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<{
  readonly canonicalRoot: string;
  readonly files: readonly InspectedWorkspaceUploadFile[];
}> => {
  throwIfAborted(signal);
  if (!workspaceRoot?.trim()) uploadError("BrowserUploadWorkspaceUnavailable");
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(workspaceRoot);
    const rootStatus = await stat(canonicalRoot);
    if (!rootStatus.isDirectory()) uploadError("BrowserUploadWorkspaceUnavailable");
  } catch (error) {
    if (isBrowserHostError(error)) throw error;
    uploadError("BrowserUploadWorkspaceUnavailable");
  }
  throwIfAborted(signal);
  const files: InspectedWorkspaceUploadFile[] = [];
  const seen = new Set<string>();
  for (const requestedPath of paths) {
    throwIfAborted(signal);
    const lexicalCandidate = resolve(canonicalRoot, requestedPath);
    if (!isContainedPath(canonicalRoot, lexicalCandidate)) {
      uploadError("BrowserUploadPathOutsideWorkspace");
    }
    let canonicalFile: string;
    try {
      canonicalFile = await realpath(lexicalCandidate);
    } catch {
      uploadError("BrowserUploadFileUnsupported");
    }
    if (!isContainedPath(canonicalRoot, canonicalFile)) {
      uploadError("BrowserUploadPathOutsideWorkspace");
    }
    let fileStatus: Stats;
    try {
      fileStatus = await stat(canonicalFile);
    } catch {
      uploadError("BrowserUploadFileUnsupported");
    }
    if (!isSupportedRegularFile(fileStatus)) uploadError("BrowserUploadFileUnsupported");
    if (seen.has(canonicalFile)) browserHostError({ code: "BrowserInputUnsupported" });
    seen.add(canonicalFile);
    files.push({
      path: canonicalFile,
      name: basename(canonicalFile),
      byteLength: fileStatus.size,
      status: fileStatus,
    });
  }
  if (files.length === 0) browserHostError({ code: "BrowserInputUnsupported" });
  return { canonicalRoot, files };
};

/**
 * Resolve both the workspace and every requested file through the filesystem.
 * Checking the lexical candidate and final real path prevents `..`, absolute
 * paths and symlink/junction escapes on every supported platform.
 */
export const resolveWorkspaceUploadFiles = async (
  workspaceRoot: string | null | undefined,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<readonly ResolvedWorkspaceUploadFile[]> => {
  const inspected = await inspectWorkspaceUploadFiles(workspaceRoot, paths, signal);
  return inspected.files.map(({ path, name, byteLength }) => ({ path, name, byteLength }));
};

const verifyPrivateDirectory = async (directory: string): Promise<void> => {
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    uploadError("BrowserUploadFileUnsupported");
  }
  if (process.getuid && before.uid !== process.getuid()) {
    uploadError("BrowserUploadFileUnsupported");
  }
  await chmod(directory, 0o700);
  const after = await lstat(directory);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    (process.platform !== "win32" && (after.mode & 0o077) !== 0)
  ) {
    uploadError("BrowserUploadFileUnsupported");
  }
};

const initializeStagingBase = async (userDataRoot: string): Promise<string> => {
  if (!userDataRoot?.trim()) uploadError("BrowserUploadFileUnsupported");

  const privateRuntimeRoot = join(resolve(userDataRoot), PRIVATE_RUNTIME_DIRECTORY);
  await mkdir(privateRuntimeRoot, { recursive: true, mode: 0o700 });
  await verifyPrivateDirectory(privateRuntimeRoot);

  // A prior process may have crashed while Chromium still held staged paths.
  // The application is single-instance per userData root, so replacing this
  // private subtree once per process deterministically removes those leftovers.
  const stagingBase = join(privateRuntimeRoot, STAGING_DIRECTORY_NAME);
  await rm(stagingBase, { recursive: true, force: true });
  await mkdir(stagingBase, { mode: 0o700 });
  await verifyPrivateDirectory(stagingBase);
  return realpath(stagingBase);
};

const getStagingBase = (webContents: WebContents): Promise<string> => {
  const testRoot = testConfigurations.get(webContents)?.userDataRoot;
  if (testRoot) {
    const key = resolve(testRoot);
    let promise = testStagingBasePromises.get(key);
    if (!promise) {
      promise = initializeStagingBase(key);
      testStagingBasePromises.set(key, promise);
    }
    return promise;
  }
  stagingBasePromise ??= initializeStagingBase(app.getPath("userData"));
  return stagingBasePromise;
};

const webContentsStagingRoot = async (webContents: WebContents): Promise<string> => {
  const stagingBase = await getStagingBase(webContents);
  const id = Number.isSafeInteger(webContents.id) ? webContents.id : "unknown";
  const directory = await mkdtemp(join(stagingBase, `webcontents-${id}-`));
  await verifyPrivateDirectory(directory);
  return directory;
};

const ensureStagingOutsideWorkspace = (canonicalRoot: string, stagingRoot: string): void => {
  if (
    canonicalRoot === stagingRoot ||
    isContainedPath(canonicalRoot, stagingRoot) ||
    isContainedPath(stagingRoot, canonicalRoot)
  ) {
    uploadError("BrowserUploadFileUnsupported");
  }
};

const invocationQuotaBytes = (webContents: WebContents): number =>
  testConfigurations.get(webContents)?.maxInvocationBytes ?? DEFAULT_MAX_UPLOAD_INVOCATION_BYTES;

const lifetimeQuotaBytes = (webContents: WebContents): number =>
  testConfigurations.get(webContents)?.maxStagedBytesPerWebContents ??
  DEFAULT_MAX_STAGED_UPLOAD_BYTES_PER_WEB_CONTENTS;

const lifetimeQuotaDirectories = (webContents: WebContents): number =>
  testConfigurations.get(webContents)?.maxStagedDirectoriesPerWebContents ??
  DEFAULT_MAX_STAGED_UPLOAD_DIRECTORIES_PER_WEB_CONTENTS;

const lifetimeQuotaFiles = (webContents: WebContents): number =>
  testConfigurations.get(webContents)?.maxStagedFilesPerWebContents ??
  DEFAULT_MAX_STAGED_UPLOAD_FILES_PER_WEB_CONTENTS;

const cumulativeUploadBytes = (
  webContents: WebContents,
  files: readonly InspectedWorkspaceUploadFile[],
): number => {
  let total = 0;
  const limit = invocationQuotaBytes(webContents);
  for (const file of files) {
    if (file.byteLength > limit - total) uploadError("BrowserUploadFileUnsupported");
    total += file.byteLength;
  }
  return total;
};

const releaseAccounting = (
  state: StagedUploadState,
  accounting: Pick<StagedUploadAccounting, "byteLength" | "fileCount">,
): void => {
  state.accountedBytes = Math.max(0, state.accountedBytes - accounting.byteLength);
  state.accountedDirectories = Math.max(0, state.accountedDirectories - 1);
  state.accountedFiles = Math.max(0, state.accountedFiles - accounting.fileCount);
};

const removeReservedDirectoryFromDisk = async (
  state: StagedUploadState,
  directory: string,
  accounting: Pick<StagedUploadAccounting, "byteLength" | "fileCount">,
): Promise<boolean> => {
  try {
    await rm(directory, { recursive: true, force: true });
    releaseAccounting(state, accounting);
    return true;
  } catch {
    // Keep failed removals charged. This intentionally fails closed: a later
    // upload cannot amplify disk or inode use merely because cleanup failed.
    return false;
  }
};

const removeRetainedDirectory = (
  state: StagedUploadState,
  directory: string,
  accounting: StagedUploadAccounting,
): Promise<boolean> => {
  if (accounting.cleanup) return accounting.cleanup;

  const cleanup = (async () => {
    try {
      await rm(directory, { recursive: true, force: true });
      if (state.directories.get(directory) === accounting) {
        state.directories.delete(directory);
        releaseAccounting(state, accounting);
      }
      return true;
    } catch {
      // Leave both the entry and its accounting in place so a later lifecycle
      // cleanup can retry without ever freeing quota for files still on disk.
      return false;
    }
  })();
  accounting.cleanup = cleanup;
  void cleanup.then((removed) => {
    if (!removed && accounting.cleanup === cleanup) accounting.cleanup = undefined;
  });
  return cleanup;
};

const cleanupRetainedDirectories = (state: StagedUploadState): Promise<void> => {
  return Promise.all(
    [...state.directories.entries()].map(([directory, accounting]) =>
      removeRetainedDirectory(state, directory, accounting),
    ),
  ).then(() => undefined);
};

const stagedUploadState = (webContents: WebContents): StagedUploadState => {
  let state = stagedUploads.get(webContents);
  if (state) return state;

  state = {
    directories: new Map(),
    root: undefined,
    accountedBytes: 0,
    accountedDirectories: 0,
    accountedFiles: 0,
    generation: 0,
    destroyed: false,
    hasLifecycle: false,
  };
  stagedUploads.set(webContents, state);

  const lifecycle = webContents as WebContents & {
    on?: (event: "did-navigate", listener: () => void) => void;
    once?: (event: "destroyed", listener: () => void) => void;
  };
  if (typeof lifecycle.on === "function" && typeof lifecycle.once === "function") {
    state.hasLifecycle = true;
    lifecycle.on("did-navigate", () => {
      state!.generation += 1;
      void cleanupRetainedDirectories(state!).catch(() => undefined);
    });
    lifecycle.once("destroyed", () => {
      state!.destroyed = true;
      state!.generation += 1;
      stagedUploads.delete(webContents);
      void cleanupRetainedDirectories(state!)
        .then(async () => {
          if (state!.root) await rm(await state!.root, { recursive: true, force: true });
        })
        .catch(() => undefined);
    });
  }
  return state;
};

const reserveStagedUpload = (
  webContents: WebContents,
  byteLength: number,
  fileCount: number,
): StagedUploadReservation => {
  if (webContents.isDestroyed()) {
    browserHostError({
      code: "BrowserRuntimeDisconnected",
      retryable: true,
      phase: "runtime",
      effectMayHaveCommitted: false,
    });
  }
  const state = stagedUploadState(webContents);
  if (
    byteLength > lifetimeQuotaBytes(webContents) - state.accountedBytes ||
    state.accountedDirectories >= lifetimeQuotaDirectories(webContents) ||
    fileCount > lifetimeQuotaFiles(webContents) - state.accountedFiles
  ) {
    uploadError("BrowserUploadFileUnsupported");
  }
  state.root ??= webContentsStagingRoot(webContents);
  state.accountedBytes += byteLength;
  state.accountedDirectories += 1;
  state.accountedFiles += fileCount;
  return { state, byteLength, fileCount, generation: state.generation, settled: false };
};

const releaseUnusedReservation = (reservation: StagedUploadReservation): void => {
  if (reservation.settled) return;
  reservation.settled = true;
  releaseAccounting(reservation.state, reservation);
};

const removeReservedDirectory = async (
  reservation: StagedUploadReservation,
  directory: string,
): Promise<void> => {
  if (reservation.settled) return;
  reservation.settled = true;
  await removeReservedDirectoryFromDisk(reservation.state, directory, reservation);
};

const retainReservedDirectory = (
  webContents: WebContents,
  reservation: StagedUploadReservation,
  directory: string,
): boolean => {
  const { state } = reservation;
  if (!state.hasLifecycle) return false;
  if (state.destroyed || state.generation !== reservation.generation || webContents.isDestroyed()) {
    browserHostError({
      code: "BrowserRuntimeDisconnected",
      retryable: true,
      phase: "runtime",
      effectMayHaveCommitted: false,
    });
  }
  reservation.settled = true;
  state.directories.set(directory, {
    byteLength: reservation.byteLength,
    fileCount: reservation.fileCount,
    cleanup: undefined,
  });
  return true;
};

const copyVerifiedFile = async (
  file: InspectedWorkspaceUploadFile,
  destination: string,
  signal?: AbortSignal,
): Promise<void> => {
  const safeOpenFlags =
    process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const source = await open(file.path, constants.O_RDONLY | safeOpenFlags);
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const openedStatus = await source.stat();
    if (!isSupportedRegularFile(openedStatus) || !hasSameFileIdentity(file.status, openedStatus)) {
      uploadError("BrowserUploadFileUnsupported");
    }

    // The descriptor, not the mutable workspace path, is the source of every
    // byte passed to Chromium. Rechecking the live path catches parent or final
    // component swaps that happened while the descriptor was being opened.
    const livePath = await realpath(file.path);
    const liveStatus = await stat(livePath);
    if (livePath !== file.path || !hasSameFileIdentity(openedStatus, liveStatus)) {
      uploadError("BrowserUploadFileUnsupported");
    }

    destinationHandle = await open(destination, "wx", 0o600);
    await destinationHandle.chmod(0o600);
    const buffer = Buffer.allocUnsafe(
      Math.max(1, Math.min(UPLOAD_COPY_BUFFER_BYTES, openedStatus.size)),
    );
    let sourcePosition = 0;
    while (sourcePosition < openedStatus.size) {
      throwIfAborted(signal);
      const expected = Math.min(buffer.byteLength, openedStatus.size - sourcePosition);
      const { bytesRead } = await source.read(buffer, 0, expected, sourcePosition);
      if (bytesRead === 0) uploadError("BrowserUploadFileUnsupported");
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          sourcePosition + written,
        );
        if (result.bytesWritten === 0) uploadError("BrowserUploadFileUnsupported");
        written += result.bytesWritten;
      }
      sourcePosition += bytesRead;
    }

    const finalSourceStatus = await source.stat();
    const destinationStatus = await destinationHandle.stat();
    if (
      !hasUnchangedFileContents(openedStatus, finalSourceStatus) ||
      !isSupportedRegularFile(destinationStatus) ||
      destinationStatus.size !== openedStatus.size
    ) {
      uploadError("BrowserUploadFileUnsupported");
    }
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
};

const stageWorkspaceUploadFiles = async (
  canonicalRoot: string,
  files: readonly InspectedWorkspaceUploadFile[],
  reservation: StagedUploadReservation,
  signal?: AbortSignal,
): Promise<StagedWorkspaceUpload> => {
  let directory: string | undefined;
  try {
    const stagingRoot = await reservation.state.root;
    if (!stagingRoot) uploadError("BrowserUploadFileUnsupported");
    ensureStagingOutsideWorkspace(canonicalRoot, stagingRoot);
    directory = await mkdtemp(join(stagingRoot, "upload-"));
    await verifyPrivateDirectory(directory);
    const stagedFiles: ResolvedWorkspaceUploadFile[] = [];
    for (const [index, file] of files.entries()) {
      throwIfAborted(signal);
      const fileDirectory = join(directory, String(index));
      await mkdir(fileDirectory, { mode: 0o700 });
      const stagedPath = join(fileDirectory, file.name);
      await copyVerifiedFile(file, stagedPath, signal);
      stagedFiles.push({ path: stagedPath, name: file.name, byteLength: file.byteLength });
    }
    return { directory, files: stagedFiles };
  } catch (error) {
    if (directory) {
      await removeReservedDirectory(reservation, directory);
    } else {
      releaseUnusedReservation(reservation);
    }
    throwIfAborted(signal);
    if (isBrowserHostError(error)) throw error;
    uploadError("BrowserUploadFileUnsupported");
  }
};

export const uploadBrowserFiles = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserUploadInput,
  workspaceRoot: string | null | undefined,
  signal?: AbortSignal,
): Promise<BrowserUploadOutput> => {
  let staged: StagedWorkspaceUpload | undefined;
  let untrackedStagingDirectory: string | undefined;
  let reservation: StagedUploadReservation | undefined;
  try {
    const inspected = await inspectWorkspaceUploadFiles(workspaceRoot, input.paths, signal);
    const uploadBytes = cumulativeUploadBytes(runtime.webContents, inspected.files);
    reservation = reserveStagedUpload(runtime.webContents, uploadBytes, inspected.files.length);
    staged = await stageWorkspaceUploadFiles(
      inspected.canonicalRoot,
      inspected.files,
      reservation,
      signal,
    );
    throwIfAborted(signal);

    // Retain the private staged copies before issuing the command. A failed CDP
    // response can still mean the effect committed, so once Chromium has seen
    // these paths they live until the document navigates or its WebContents is
    // destroyed. This path is isolated from workspace-sandboxed providers;
    // full-access mode is deliberately a trusted same-user filesystem mode.
    if (!retainReservedDirectory(runtime.webContents, reservation, staged.directory)) {
      untrackedStagingDirectory = staged.directory;
    }
    const filesForChromium = staged.files.map((file) => file.path);
    staged = undefined;
    const result = await runBetterwright<{ code?: "BrowserInputUnsupported" | "BrowserTargetNotFound" | "BrowserTargetAmbiguous" | "BrowserTargetNotEnabled" }>({
      home: join(app.getPath("userData"), "browser-engine"),
      contents: runtime.webContents,
      expectAgentInput: runtime.expectAgentInput,
      uploadFiles: filesForChromium,
      signal: signal ?? new AbortController().signal,
      timeoutMs: input.timeoutMs ?? 15_000,
      code: `const target = ${betterwrightLocator(input.target)};
const count = await target.count();
if (count !== 1) return {code: count === 0 ? "BrowserTargetNotFound" : "BrowserTargetAmbiguous"};
const details = await target.evaluate(element => ({
  file: element instanceof HTMLInputElement && element.type === "file",
  disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
  multiple: element.multiple === true
}));
if (!details.file || (!details.multiple && ${filesForChromium.length} !== 1)) return {code: "BrowserInputUnsupported"};
if (details.disabled) return {code: "BrowserTargetNotEnabled"};
await target.setInputFiles(${JSON.stringify(filesForChromium)});
return {};`,
    });
    if (result.code) browserHostError({ code: result.code, tabId: runtime.tabId as BrowserTabId });
    return {
      tabId: runtime.tabId as BrowserTabId,
      target: {},
      files: inspected.files.map(({ name, byteLength }) => ({ name, byteLength })),
    };
  } finally {
    if (staged && reservation) {
      await removeReservedDirectory(reservation, staged.directory);
    }
    if (untrackedStagingDirectory && reservation) {
      await removeReservedDirectory(reservation, untrackedStagingDirectory);
    } else if (reservation && !reservation.settled) {
      releaseUnusedReservation(reservation);
    }
    // Once the command was attempted, real Electron WebContents cleanup is
    // owned by its lifecycle because the selection may already have committed
    // despite a transport error. Synthetic runtimes without lifecycle events
    // cannot retain a usable selection and are cleaned here.
  }
};
