// FILE: scratchWorkspaces.ts
// Purpose: Per-thread scratch working directories for provider sessions that
//          start before any project workspace exists (e.g. a chat's first
//          turn). The root stays in the user's cache so it is outside project
//          ancestry and outside temporary directories writable by agents.
// Layer: Server filesystem utility
// Exports: ensureIsolatedScratchWorkspace

import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type { ThreadId } from "@synara/contracts";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";
import { ensurePrivateDirectorySync } from "./privatePathPermissions";

function scratchOwnerSegment(homeDirectory = homedir()): string {
  const owner =
    typeof process.getuid === "function" ? `uid:${String(process.getuid())}` : homeDirectory;
  return createHash("sha256").update(owner).digest("hex").slice(0, 16);
}

function scratchCacheRoot(homeDirectory: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Caches", "synara");
  if (platform === "win32") {
    return path.join(homeDirectory, "AppData", "Local", "Synara", "Cache");
  }
  return path.join(homeDirectory, ".cache", "synara");
}

export function resolveScratchWorkspacesRoot(
  options: {
    readonly homeDirectory?: string;
    readonly platform?: NodeJS.Platform;
  } = {},
): string {
  const homeDirectory = options.homeDirectory ?? homedir();
  const ownerContainer = path.join(
    scratchCacheRoot(homeDirectory, options.platform ?? process.platform),
    `.synara-${scratchOwnerSegment(homeDirectory)}`,
  );
  return path.join(ownerContainer, SCRATCH_WORKSPACES_DIRNAME);
}

function scratchWorkspaceSegment(threadId: ThreadId): string {
  const raw = String(threadId);
  const safePrefix = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/g, "")
    .slice(0, 64);
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${safePrefix || "thread"}-${digest}`;
}

function isOwnedRealDirectory(directoryPath: string): boolean {
  try {
    const stat = lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return typeof process.getuid !== "function" || stat.uid === process.getuid();
  } catch (cause) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw cause;
  }
}

function openOwnedDirectoryDescriptor(directoryPath: string): number | undefined {
  if (process.platform === "win32") return isOwnedRealDirectory(directoryPath) ? -1 : undefined;
  let descriptor: number;
  try {
    descriptor = openSync(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (cause) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException).code ?? "")) {
      return undefined;
    }
    throw cause;
  }
  const stat = fstatSync(descriptor);
  if (
    !stat.isDirectory() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    closeSync(descriptor);
    return undefined;
  }
  return descriptor;
}

function ensurePrivateScratchRoot(workspaceRoot: string): void {
  if (workspaceRoot === resolveScratchWorkspacesRoot()) {
    const ownerContainer = path.dirname(workspaceRoot);
    ensurePrivateDirectorySync(path.dirname(ownerContainer));
    ensurePrivateDirectorySync(ownerContainer);
  }
  ensurePrivateDirectorySync(workspaceRoot);
}

function repairOwnedScratchWorkspace(workspacePath: string): string | undefined {
  const descriptor = openOwnedDirectoryDescriptor(workspacePath);
  if (descriptor === undefined) return undefined;
  if (descriptor === -1) return workspacePath;
  try {
    const openedStat = fstatSync(descriptor);
    fchmodSync(descriptor, 0o700);
    const currentStat = lstatSync(workspacePath);
    if (
      !currentStat.isDirectory() ||
      currentStat.isSymbolicLink() ||
      currentStat.dev !== openedStat.dev ||
      currentStat.ino !== openedStat.ino
    ) {
      return undefined;
    }
    return workspacePath;
  } catch (cause) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException).code ?? "")) {
      return undefined;
    }
    throw cause;
  } finally {
    closeSync(descriptor);
  }
}

function secureOwnedLegacyRoot(legacyWorkspaceRoot: string): boolean {
  const descriptor = openOwnedDirectoryDescriptor(legacyWorkspaceRoot);
  if (descriptor === undefined) return false;
  if (descriptor === -1) return true;
  try {
    const openedStat = fstatSync(descriptor);
    const writableByOtherUsers = (openedStat.mode & 0o022) !== 0;
    const hasStickyBit = (openedStat.mode & 0o1000) !== 0;
    if (writableByOtherUsers && !hasStickyBit) {
      // Keep legacy multi-user access, but prevent other users from replacing
      // an owned workspace entry between validation and provider startup.
      fchmodSync(descriptor, (openedStat.mode & 0o7777) | 0o1000);
    }
    const currentStat = lstatSync(legacyWorkspaceRoot);
    return (
      currentStat.isDirectory() &&
      !currentStat.isSymbolicLink() &&
      currentStat.dev === openedStat.dev &&
      currentStat.ino === openedStat.ino
    );
  } catch (cause) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw cause;
  } finally {
    closeSync(descriptor);
  }
}

function repairLegacyScratchWorkspace(
  legacyWorkspaceRoot: string,
  workspaceSegment: string,
): string | undefined {
  if (!secureOwnedLegacyRoot(legacyWorkspaceRoot)) return undefined;
  const legacyWorkspaceDir = path.join(legacyWorkspaceRoot, workspaceSegment);
  return repairOwnedScratchWorkspace(legacyWorkspaceDir);
}

function ensurePrivateScratchWorkspace(workspaceRoot: string, workspaceSegment: string): string {
  ensurePrivateScratchRoot(workspaceRoot);
  const workspaceDir = path.join(workspaceRoot, workspaceSegment);
  ensurePrivateDirectorySync(workspaceDir);
  return workspaceDir;
}

export function ensureIsolatedScratchWorkspace(
  threadId: ThreadId,
  workspaceRoot = resolveScratchWorkspacesRoot(),
  legacyWorkspaceRoot?: string,
): string {
  const defaultWorkspaceRoot = resolveScratchWorkspacesRoot();
  const workspaceSegment = scratchWorkspaceSegment(threadId);
  const legacyRoot =
    legacyWorkspaceRoot ??
    (workspaceRoot === defaultWorkspaceRoot
      ? path.join(tmpdir(), SCRATCH_WORKSPACES_DIRNAME)
      : undefined);
  if (legacyRoot) {
    const repairedLegacyWorkspace = repairLegacyScratchWorkspace(legacyRoot, workspaceSegment);
    if (repairedLegacyWorkspace) return repairedLegacyWorkspace;
  }
  return ensurePrivateScratchWorkspace(workspaceRoot, workspaceSegment);
}

export function resolveScratchWorkspaceCwd(
  threadId: ThreadId,
  persistedCwd?: string,
  roots: {
    readonly workspaceRoot?: string;
    readonly legacyWorkspaceRoot?: string;
  } = {},
): string {
  const workspaceRoot = roots.workspaceRoot ?? resolveScratchWorkspacesRoot();
  const legacyWorkspaceRoot =
    roots.legacyWorkspaceRoot ?? path.join(tmpdir(), SCRATCH_WORKSPACES_DIRNAME);
  const workspaceSegment = scratchWorkspaceSegment(threadId);
  if (!persistedCwd) {
    return ensureIsolatedScratchWorkspace(threadId, workspaceRoot, legacyWorkspaceRoot);
  }

  const privateWorkspace = path.join(workspaceRoot, workspaceSegment);
  if (path.resolve(persistedCwd) === path.resolve(privateWorkspace)) {
    return ensurePrivateScratchWorkspace(workspaceRoot, workspaceSegment);
  }

  const legacyWorkspace = path.join(legacyWorkspaceRoot, workspaceSegment);
  if (path.resolve(persistedCwd) === path.resolve(legacyWorkspace)) {
    return (
      repairLegacyScratchWorkspace(legacyWorkspaceRoot, workspaceSegment) ??
      ensurePrivateScratchWorkspace(workspaceRoot, workspaceSegment)
    );
  }

  return persistedCwd;
}
