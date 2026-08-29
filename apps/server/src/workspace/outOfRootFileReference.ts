// FILE: outOfRootFileReference.ts
// Purpose: Locate a chat file reference that does not exist under its thread's
//          workspace root. Agents sometimes emit paths relative to an ancestor of
//          the workspace (e.g. `Claude/Outbox/note.md` for a thread rooted at
//          `~/Documents/Claude/Skills`), so the naive root join points at a file
//          that was never there. This walks the root's ancestor directories —
//          bounded to the user's home directory — and returns the canonical path
//          of the first real file match, or null.
// Layer: Server workspace helper
// Depends on: fs realpath/stat, realPathContainment, shared path safety checks.
//
// This module only LOCATES files; it never reads them. Reading a located
// out-of-root file still requires a preview grant, so the workspace root
// containment enforced by WorkspaceFileSystem stays intact.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isWorkspaceRelativePathSafe } from "@synara/shared/path";

import { isContainedPath } from "./realPathContainment";

// Home-to-root nesting is shallow in practice; the cap only guards a
// pathologically deep workspace path from turning into a long stat loop.
const MAX_ANCESTOR_WALK_DEPTH = 32;

async function realpathOrNull(candidate: string): Promise<string | null> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

async function statIsFileOrNull(candidate: string): Promise<boolean> {
  const stat = await fs.stat(candidate).catch(() => null);
  return stat?.isFile() ?? false;
}

function isMissingPathError(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Resolves a workspace-relative reference that is missing under the workspace
 * root against the root's ancestor directories, nearest first, up to and
 * including the home directory. Returns the canonical absolute path of the
 * first ancestor candidate that is a regular file (still inside the home
 * directory after symlink resolution), or null when:
 * - the reference is unsafe (absolute, `.`/`..` segments, null bytes),
 * - the workspace root is missing or outside the home directory,
 * - a file or directory already exists at the in-root join (reading it failed
 *   for a non-relocation reason, e.g. binary contents), or
 * - no ancestor candidate exists.
 */
export async function resolveOutOfRootFileReference(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly homeDir: string;
}): Promise<string | null> {
  const relativePath = input.relativePath.trim();
  if (relativePath.includes("\0") || !isWorkspaceRelativePathSafe(relativePath)) {
    return null;
  }
  const [realHome, realRoot] = await Promise.all([
    realpathOrNull(input.homeDir),
    realpathOrNull(input.workspaceRoot),
  ]);
  if (!realHome || !realRoot || !isContainedPath(realHome, realRoot)) {
    return null;
  }

  const segments = relativePath.split(/[\\/]/);
  const inRootCandidate = path.join(realRoot, ...segments);
  const inRootStat = await fs.stat(inRootCandidate).catch((cause: unknown) => {
    // Only a genuinely missing path permits ancestor relocation. Permission,
    // symlink-loop, and other filesystem failures belong to the original
    // workspace read and must not silently select a different file.
    if (!isMissingPathError(cause)) {
      return false;
    }
    return null;
  });
  if (inRootStat === false) {
    return null;
  }
  if (inRootStat !== null) {
    return null;
  }

  let ancestor = path.dirname(realRoot);
  for (
    let depth = 0;
    depth < MAX_ANCESTOR_WALK_DEPTH && isContainedPath(realHome, ancestor);
    depth += 1
  ) {
    const candidate = path.join(ancestor, ...segments);
    const realCandidate = await realpathOrNull(candidate);
    if (
      realCandidate !== null &&
      isContainedPath(realHome, realCandidate) &&
      (await statIsFileOrNull(realCandidate))
    ) {
      return realCandidate;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    ancestor = parent;
  }
  return null;
}
