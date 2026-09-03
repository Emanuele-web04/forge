// FILE: localImageFiles.ts
// Purpose: Resolves local preview-file (image/PDF) requests without exposing arbitrary files.
// Layer: Server HTTP utility
// Exports: local image route constants and allowlisted path resolver
// Depends on: fs realpath/stat, Codex generated image roots, safe preview extensions

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LOCAL_IMAGE_ROUTE_PATH,
  isSupportedLocalImagePath,
  isSupportedLocalPreviewFilePath,
} from "@synara/shared/localPreviewFiles";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";

import { resolveCodexGeneratedImagesRoots } from "./codexGeneratedImages.ts";

export { LOCAL_IMAGE_ROUTE_PATH };

export interface ResolvedLocalPreviewFile {
  readonly path: string;
  readonly fileName: string;
  /** From the allowlist stat, so responses can set Content-Length without re-statting. */
  readonly sizeBytes: number;
}

export interface LocalPreviewGrantResult {
  readonly grant: string;
  readonly expiresAt: string;
}

const LOCAL_PREVIEW_GRANT_TTL_MS = 2 * 60 * 1000;
const localPreviewGrantByToken = new Map<string, { realFilePath: string; expiresAtMs: number }>();

function pruneExpiredPreviewGrants(nowMs = Date.now()): void {
  for (const [token, grant] of localPreviewGrantByToken) {
    if (grant.expiresAtMs <= nowMs) {
      localPreviewGrantByToken.delete(token);
    }
  }
}

function hasValidPreviewGrant(input: {
  readonly token: string | null | undefined;
  readonly realFilePath: string;
}): boolean {
  return resolveLocalPreviewGrantRealPath({ token: input.token }) === input.realFilePath;
}

export function resolveLocalPreviewGrantRealPath(input: {
  readonly token: string | null | undefined;
}): string | null {
  const token = input.token?.trim();
  if (!token) {
    return null;
  }
  const nowMs = Date.now();
  pruneExpiredPreviewGrants(nowMs);
  const grant = localPreviewGrantByToken.get(token);
  return grant !== undefined && grant.expiresAtMs > nowMs ? grant.realFilePath : null;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function realpathOrNull(candidate: string | undefined): Promise<string | null> {
  if (!candidate) {
    return null;
  }
  try {
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

async function findGitRoot(startPath: string): Promise<string | null> {
  let current = path.resolve(startPath);
  while (true) {
    try {
      const stat = await fs.stat(path.join(current, ".git"));
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // Keep walking until we hit the filesystem root.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function temporaryDirectoryRoots(): Promise<string[]> {
  const candidates = [
    os.tmpdir(),
    process.env.TMPDIR,
    process.platform === "darwin" ? "/tmp" : undefined,
  ];
  const roots = await Promise.all(Array.from(new Set(candidates)).map(realpathOrNull));
  return Array.from(new Set(roots.filter((root): root is string => root !== null)));
}

async function resolveWorkspaceRoot(cwd: string | null): Promise<string | null> {
  if (!cwd) {
    return null;
  }
  const realCwd = await realpathOrNull(cwd);
  if (!realCwd) {
    return null;
  }
  const gitRoot = await findGitRoot(realCwd);
  return (gitRoot ? await realpathOrNull(gitRoot) : realCwd) ?? null;
}

export async function resolveAllowedLocalPreviewFile(input: {
  readonly requestedPath: string | null;
  readonly cwd: string | null;
  readonly codexHomePath?: string;
  readonly scratchWorkspacesRoot?: string;
  readonly allowAbsoluteLocalPreviewFile?: boolean;
  readonly previewGrant?: string | null;
}): Promise<ResolvedLocalPreviewFile | null> {
  const requestedPath = input.requestedPath?.trim();
  if (
    !requestedPath ||
    requestedPath.includes("\0") ||
    !isSupportedLocalPreviewFilePath(requestedPath)
  ) {
    return null;
  }

  const resolvedRequestedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(input.cwd ?? process.cwd(), requestedPath);
  const realFilePath = await realpathOrNull(resolvedRequestedPath);
  if (!realFilePath || !isSupportedLocalPreviewFilePath(realFilePath)) {
    return null;
  }

  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat?.isFile()) {
    return null;
  }
  const resolved: ResolvedLocalPreviewFile = {
    path: realFilePath,
    fileName: path.basename(realFilePath),
    sizeBytes: stat.size,
  };

  // The workspace check covers the common case (file previews), so resolve it
  // first and skip the broader root lookups entirely when it passes.
  const workspaceRoot = await resolveWorkspaceRoot(input.cwd);
  if (workspaceRoot !== null && isPathInside(realFilePath, workspaceRoot)) {
    return resolved;
  }

  // Sessions that start before a project workspace exists run in per-thread
  // scratch directories. Files agents create there are workspace-equivalent,
  // so every preview type is servable from the configured private root. Keep
  // the former temp roots readable for threads created before this migration.
  const tempRoots = await temporaryDirectoryRoots();
  const configuredScratchRoot = await realpathOrNull(input.scratchWorkspacesRoot);
  const scratchWorkspaceRoots = [
    ...(configuredScratchRoot ? [configuredScratchRoot] : []),
    ...tempRoots.map((root) => path.join(root, SCRATCH_WORKSPACES_DIRNAME)),
  ];
  if (scratchWorkspaceRoots.some((root) => isPathInside(realFilePath, root))) {
    return resolved;
  }

  // The in-app file panel may intentionally preview an absolute local path
  // supplied by the agent (for example a file in Downloads). Keep this opt-in
  // so other callers retain the narrower workspace/generated-image allowlist.
  if (
    input.allowAbsoluteLocalPreviewFile === true &&
    path.isAbsolute(requestedPath) &&
    hasValidPreviewGrant({ token: input.previewGrant, realFilePath })
  ) {
    return resolved;
  }

  // The generated-image and temp-dir roots exist for agent-produced images in
  // chat markdown; keep them image-only so they never serve documents.
  if (!isSupportedLocalImagePath(realFilePath)) {
    return null;
  }
  const generatedImagesRoots = await Promise.all(
    resolveCodexGeneratedImagesRoots(input.codexHomePath).map(realpathOrNull),
  ).then((roots) => roots.filter((root): root is string => root !== null));
  const allowed =
    generatedImagesRoots.some((root) => isPathInside(realFilePath, root)) ||
    tempRoots.some((root) => isPathInside(realFilePath, root));
  return allowed ? resolved : null;
}

export async function createLocalPreviewGrant(input: {
  readonly requestedPath: string;
}): Promise<LocalPreviewGrantResult> {
  const requestedPath = input.requestedPath.trim();
  if (!requestedPath || requestedPath.includes("\0") || !path.isAbsolute(requestedPath)) {
    throw new Error("Only absolute local files can be granted.");
  }

  const realFilePath = await realpathOrNull(path.resolve(requestedPath));
  if (!realFilePath) {
    throw new Error("Preview file not found.");
  }
  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error("Preview path is not a file.");
  }

  const expiresAtMs = Date.now() + LOCAL_PREVIEW_GRANT_TTL_MS;
  const grant = crypto.randomUUID();
  localPreviewGrantByToken.set(grant, { realFilePath, expiresAtMs });
  pruneExpiredPreviewGrants();
  return { grant, expiresAt: new Date(expiresAtMs).toISOString() };
}
