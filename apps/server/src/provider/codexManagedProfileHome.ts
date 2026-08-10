import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  PRIVATE_FILE_MODE,
  ensurePrivateDirectorySync,
  supportsPosixPermissions,
} from "../privatePathPermissions";

const STORAGE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const MANAGED_CODEX_PROFILE_ROOT_MARKER = ".synara-provider-profile-root";
const MANAGED_CODEX_CONFIG =
  `project_root_markers = ["${MANAGED_CODEX_PROFILE_ROOT_MARKER}"]\n` +
  'model_provider = "openai"\n' +
  'forced_login_method = "chatgpt"\n' +
  'cli_auth_credentials_store = "file"\n' +
  'mcp_oauth_credentials_store = "file"\n';

export interface CodexManagedProfileHome {
  readonly codexHomePath: string;
  readonly codexSqliteHomePath: string;
}

export function isCodexProfileStorageKey(value: string): boolean {
  return STORAGE_KEY_PATTERN.test(value);
}

/**
 * Materializes an empty, server-owned Codex home. This function intentionally
 * has no source-home input: managed profiles never inspect, link, or copy a
 * user's legacy Codex state.
 */
export function materializeCodexManagedProfileHome(input: {
  readonly profilesRoot: string;
  readonly storageKey: string;
  readonly platform?: NodeJS.Platform;
}): Readonly<CodexManagedProfileHome> {
  if (!isCodexProfileStorageKey(input.storageKey)) {
    throw new Error("Invalid managed Codex profile storage key.");
  }

  const platform = input.platform ?? process.platform;
  const codexProfilesRoot = path.join(input.profilesRoot, "codex");
  const profileRoot = path.join(codexProfilesRoot, input.storageKey);
  const codexHomePath = path.join(profileRoot, "home");
  const codexSqliteHomePath = path.join(profileRoot, "sqlite");

  for (const directoryPath of [
    input.profilesRoot,
    codexProfilesRoot,
    profileRoot,
    codexHomePath,
    codexSqliteHomePath,
  ]) {
    ensurePrivateDirectorySync(directoryPath, platform);
    const stat = fs.lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Managed Codex storage path is not a real directory.");
    }
  }
  reconcileManagedFile({
    filePath: path.join(profileRoot, MANAGED_CODEX_PROFILE_ROOT_MARKER),
    contents: "",
    label: "profile root marker",
    platform,
  });
  reconcileManagedFile({
    filePath: path.join(codexHomePath, "config.toml"),
    contents: MANAGED_CODEX_CONFIG,
    label: "config",
    platform,
  });
  inspectManagedCodexAuthFile(codexHomePath, platform);

  return Object.freeze({ codexHomePath, codexSqliteHomePath });
}

function reconcileManagedFile(input: {
  readonly filePath: string;
  readonly contents: string;
  readonly label: string;
  readonly platform: NodeJS.Platform;
}): void {
  if (existingManagedFileIsCanonical(input)) return;
  const temporaryPath = `${input.filePath}.${process.pid}.${randomUUID()}.tmp`;
  const { platform } = input;
  const noFollowFlag = platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  try {
    const descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
      PRIVATE_FILE_MODE,
    );
    try {
      if (supportsPosixPermissions(platform)) fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
      fs.writeFileSync(descriptor, input.contents, "utf8");
      fs.fsyncSync(descriptor);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) {
        throw new Error(`Managed Codex ${input.label} is not a regular file.`);
      }
    } finally {
      fs.closeSync(descriptor);
    }
    const temporaryStat = fs.lstatSync(temporaryPath);
    if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()) {
      throw new Error(
        `Managed Codex ${input.label} temporary path is not a regular file.`,
      );
    }
    fs.renameSync(temporaryPath, input.filePath);
    syncDirectoryIfSupported(path.dirname(input.filePath), platform);
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // The rename already established the durable target. A best-effort
      // cleanup failure for the now-absent temporary path is harmless.
    }
  }
}

function existingManagedFileIsCanonical(input: {
  readonly filePath: string;
  readonly contents: string;
  readonly label: string;
  readonly platform: NodeJS.Platform;
}): boolean {
  const { filePath, platform } = input;
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`Managed Codex ${input.label} is not a regular file.`);
  }
  const noFollowFlag = platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag);
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    const currentPathStat = fs.lstatSync(filePath);
    if (
      !descriptorStat.isFile() ||
      descriptorStat.nlink !== 1 ||
      !currentPathStat.isFile() ||
      currentPathStat.isSymbolicLink() ||
      currentPathStat.nlink !== 1 ||
      (supportsPosixPermissions(platform) &&
        (descriptorStat.dev !== currentPathStat.dev ||
          descriptorStat.ino !== currentPathStat.ino))
    ) {
      throw new Error(`Managed Codex ${input.label} is not a stable regular file.`);
    }
    if (supportsPosixPermissions(platform)) fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    if (descriptorStat.size !== Buffer.byteLength(input.contents)) return false;
    return fs.readFileSync(descriptor, "utf8") === input.contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectoryIfSupported(directoryPath: string, platform: NodeJS.Platform): void {
  if (!supportsPosixPermissions(platform)) return;
  const descriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    try {
      fs.fsyncSync(descriptor);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw cause;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertManagedCodexAuthFilePrivate(
  codexHomePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const descriptor = openManagedCodexAuthFile(codexHomePath, platform, false);
  fs.closeSync(descriptor);
}

export function syncManagedCodexAuthState(
  codexHomePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const descriptor = openManagedCodexAuthFile(codexHomePath, platform, true);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  assertManagedCodexAuthFilePrivate(codexHomePath, platform);
  syncDirectoryIfSupported(codexHomePath, platform);
}

export function syncManagedCodexLoggedOutState(
  codexHomePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (inspectManagedCodexAuthFile(codexHomePath, platform)) {
    throw new Error("Managed Codex authentication remained after logout.");
  }
  syncDirectoryIfSupported(codexHomePath, platform);
}

function openManagedCodexAuthFile(
  codexHomePath: string,
  platform: NodeJS.Platform,
  writableOnWindows: boolean,
): number {
  const authPath = path.join(codexHomePath, "auth.json");
  const pathStat = fs.lstatSync(authPath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error("Managed Codex authentication is not a regular file.");
  }
  const noFollowFlag = platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  const accessFlag = platform === "win32" && writableOnWindows
    ? fs.constants.O_RDWR
    : fs.constants.O_RDONLY;
  const descriptor = fs.openSync(authPath, accessFlag | noFollowFlag);
  try {
    const stat = fs.fstatSync(descriptor);
    const currentPathStat = fs.lstatSync(authPath);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !currentPathStat.isFile() ||
      currentPathStat.isSymbolicLink() ||
      currentPathStat.nlink !== 1 ||
      (supportsPosixPermissions(platform) &&
        (stat.dev !== currentPathStat.dev || stat.ino !== currentPathStat.ino))
    ) {
      throw new Error("Managed Codex authentication is not a stable regular file.");
    }
    if (supportsPosixPermissions(platform) && (stat.mode & 0o077) !== 0) {
      throw new Error("Managed Codex authentication is not private.");
    }
    return descriptor;
  } catch (cause) {
    fs.closeSync(descriptor);
    throw cause;
  }
}

export function assertExistingManagedCodexAuthFilePrivate(
  codexHomePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  inspectManagedCodexAuthFile(codexHomePath, platform);
}

export function inspectManagedCodexAuthFile(
  codexHomePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    assertManagedCodexAuthFilePrivate(codexHomePath, platform);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}
