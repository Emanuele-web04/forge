// FILE: workspaceFileOpener.ts
// Purpose: Context + helpers that let file references rendered deep in the
//          chat tree (markdown links, mention chips, work-log rows) open in an
//          in-app workspace file viewer (right-dock file pane or editor pane)
//          instead of an external editor.
// Layer: Web UI helpers
// Exports: WorkspaceFileOpenerContext, useWorkspaceFileOpener,
//          resolveWorkspaceFileOpenTarget, resolveScratchPreviewFileOpenTarget,
//          resolveDockFileOpenTarget,
//          openWorkspaceFileReference, prefetchWorkspaceFile

import { isSupportedLocalPreviewFilePath } from "@synara/shared/localPreviewFiles";
import {
  isLocalAbsolutePath,
  isWorkspaceRelativePathSafe,
  workspaceRelativePathOf,
} from "@synara/shared/path";
import { isScratchWorkspacePath } from "@synara/shared/threadWorkspace";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import { openInPreferredEditor } from "../editorPreferences";
import { readNativeApi } from "../nativeApi";
import { projectReadFileQueryOptions } from "./projectReactQuery";

export interface WorkspaceFileOpener {
  /**
   * Opens a file referenced in the chat. Returns true when the reference was
   * handled by an in-app viewer; false tells the caller to fall back to the
   * external editor (path outside the workspace, no viewer on this surface).
   */
  openFile: (path: string) => boolean;
  /** Optional hover warm-up for the file contents + syntax highlighter. */
  prefetchFile?: (path: string) => void;
}

export const WorkspaceFileOpenerContext = createContext<WorkspaceFileOpener | null>(null);

export function useWorkspaceFileOpener(): WorkspaceFileOpener | null {
  return useContext(WorkspaceFileOpenerContext);
}

// Trailing `:line` / `:line:col` suffix carried by resolved markdown file links.
// The in-app viewer previews whole files, so the position is dropped.
const FILE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const SYNARA_PUBLIC_ASSET_PATH_PREFIXES = [
  "/central-icons-reversed/",
  "/central-icons-fill/",
] as const;
const SYNARA_WEB_PUBLIC_WORKSPACE_DIR = "apps/web/public";

function resolveSynaraPublicAssetOpenTarget(path: string, workspaceRoot: string | null) {
  if (!workspaceRoot) {
    return null;
  }
  const normalizedPath = path.replace(/\\/g, "/");
  if (!SYNARA_PUBLIC_ASSET_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))) {
    return null;
  }
  const relativePath = `${SYNARA_WEB_PUBLIC_WORKSPACE_DIR}${normalizedPath}`;
  return isWorkspaceRelativePathSafe(relativePath) ? relativePath : null;
}

/**
 * Maps a chat file reference (workspace-relative, or absolute as produced by
 * `resolveMarkdownFileLinkTarget`, optionally with a `:line:col` suffix) to the
 * workspace-relative path the file-read RPC expects. Returns null when the
 * reference points outside the workspace.
 */
export function resolveWorkspaceFileOpenTarget(
  rawPath: string,
  workspaceRoot: string | null,
): string | null {
  const withoutPosition = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (withoutPosition.length === 0) {
    return null;
  }
  if (isWorkspaceRelativePathSafe(withoutPosition)) {
    return withoutPosition;
  }
  if (!workspaceRoot) {
    return null;
  }
  const workspaceRelativePath = workspaceRelativePathOf(withoutPosition, workspaceRoot);
  if (workspaceRelativePath) {
    return workspaceRelativePath;
  }
  // CentralIcon assets are linked in chat as Vite root URLs
  // (`/central-icons-...`) but the file viewer needs the repo path.
  return resolveSynaraPublicAssetOpenTarget(withoutPosition, workspaceRoot);
}

/**
 * Out-of-workspace fallback for surfaces that can preview binary files: a
 * session that starts before its chat workspace exists runs in a scratch
 * directory under the OS temp dir, and the agent references those files by
 * absolute path. Images and PDFs stream through the allowlisted local-image
 * route (which also serves the scratch root), so they can still open in-app.
 * Anything else returns null — the text file-read RPC only accepts
 * workspace-relative paths, so those references fall back to the external
 * editor.
 */
export function resolveScratchPreviewFileOpenTarget(rawPath: string): string | null {
  const withoutPosition = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (!isScratchWorkspacePath(withoutPosition)) {
    return null;
  }
  return isSupportedLocalPreviewFilePath(withoutPosition) ? withoutPosition : null;
}

// Right-dock file panes can show workspace files plus absolute local paths.
// Relative paths still require a workspace; absolute paths are read as-is.
export function resolveDockFileOpenTarget(
  rawPath: string,
  workspaceRoot: string | null,
): string | null {
  const withoutPosition = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (withoutPosition.length === 0) {
    return null;
  }
  const workspaceTarget = workspaceRoot
    ? resolveWorkspaceFileOpenTarget(rawPath, workspaceRoot)
    : null;
  if (workspaceTarget) {
    return workspaceTarget;
  }
  if (isLocalAbsolutePath(withoutPosition)) {
    return withoutPosition;
  }
  return resolveScratchPreviewFileOpenTarget(rawPath);
}

/**
 * Shared activation path for clickable file references: try the surface's
 * in-app viewer first, fall back to the preferred external editor when the
 * reference isn't viewable in-app (path outside the workspace, no opener).
 * Pass a null opener to force the external editor (e.g. meta/ctrl-click).
 */
export function openWorkspaceFileReference(opener: WorkspaceFileOpener | null, path: string): void {
  if (opener?.openFile(path)) {
    return;
  }
  const api = readNativeApi();
  if (api) {
    void openInPreferredEditor(api, path).catch(() => undefined);
  } else {
    console.warn("Native API not found. Unable to open file in editor.");
  }
}

/**
 * Hover warm-up so the file pane opens instantly: file contents go through the
 * shared React Query cache, and the matching Shiki highlighter loads in the
 * background. The highlighter module is imported dynamically so chat-adjacent
 * chunks don't pull Shiki eagerly.
 */
export function prefetchWorkspaceFile(
  queryClient: QueryClient,
  workspaceRoot: string,
  relativePath: string,
): void {
  // Images and PDFs stream through the local-image HTTP route, so there is no
  // text read to warm and no syntax highlighter to load.
  if (isSupportedLocalPreviewFilePath(relativePath)) {
    return;
  }
  // Bare filenames (no directory) usually do not exist at the workspace root and
  // make the read RPC fall back to a tracked-index lookup, which can build the
  // workspace index. Skip warming those on hover so a pointer sweep over many
  // such references never triggers repeated index builds; the click-to-open
  // path still resolves them on demand.
  if (!relativePath.includes("/")) {
    return;
  }
  void queryClient.prefetchQuery(projectReadFileQueryOptions({ cwd: workspaceRoot, relativePath }));
  void import("./syntaxHighlighting")
    .then((module) =>
      module.getSyntaxHighlighterPromise(module.getSyntaxLanguageForPath(relativePath)),
    )
    .catch(() => undefined);
}
