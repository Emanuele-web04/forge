// FILE: folderDrop.ts
// Purpose: Pure helpers for accepting an OS folder drop (Create Project dialog, onboarding).
// Layer: Web domain helper (no React)
// Exports: isFileDrag, resolveDroppedFolder, DroppedFolderResult

import { isDroppedComposerDirectory, resolveDroppedFileAbsolutePath } from "./composerDropPaths";

export type DroppedFolderResult = { readonly path: string } | { readonly error: string };

export function isFileDrag(event: globalThis.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/** Resolves the first dropped item to an absolute folder path, or a user-facing error. */
export function resolveDroppedFolder(dataTransfer: DataTransfer): DroppedFolderResult | null {
  const item = Array.from(dataTransfer.items).find((entry) => entry.kind === "file");
  const file = item?.getAsFile() ?? dataTransfer.files[0] ?? null;
  if (!item || !file) return null;
  if (!isDroppedComposerDirectory(item)) {
    return { error: "Drop a folder, not a file." };
  }
  const absolutePath = resolveDroppedFileAbsolutePath(file);
  if (!absolutePath) {
    return { error: "Could not read the folder's path. Use browse or type it instead." };
  }
  return { path: absolutePath };
}
