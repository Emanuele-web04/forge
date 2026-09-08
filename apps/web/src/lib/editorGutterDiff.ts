import type { FileDiffMetadata } from "@pierre/diffs/react";

import { getRenderablePatch, resolveDiffEntryByPath, resolveFileDiffPath } from "./diffRendering";

export type EditorGutterChangeKind = "added" | "modified" | "deleted";

export interface EditorGutterChangeRange {
  kind: EditorGutterChangeKind;
  startLine: number;
  endLine: number;
}

function findFileDiffForPath(
  patch: string | undefined,
  filePath: string | null,
): FileDiffMetadata | null {
  if (!filePath) {
    return null;
  }
  const renderable = getRenderablePatch(patch);
  if (!renderable || renderable.kind !== "files") {
    return null;
  }
  const filesByPath = new Map<string, FileDiffMetadata>();
  for (const file of renderable.files) {
    const path = resolveFileDiffPath(file);
    if (path.length > 0) {
      filesByPath.set(path, file);
    }
  }
  return resolveDiffEntryByPath(filesByPath, filePath) ?? null;
}

function appendGutterRange(ranges: EditorGutterChangeRange[], next: EditorGutterChangeRange): void {
  const previous = ranges.at(-1);
  if (previous) {
    if (previous.kind === "deleted" && next.kind === "deleted") {
      if (previous.startLine === next.startLine) {
        return;
      }
    } else if (previous.kind === next.kind && next.startLine === previous.endLine + 1) {
      previous.endLine = next.endLine;
      return;
    }
  }
  ranges.push(next);
}

export function extractEditorGutterChanges(
  patch: string | undefined,
  filePath: string | null,
): { ranges: EditorGutterChangeRange[]; wholeFileAddition: boolean } {
  const file = findFileDiffForPath(patch, filePath);
  if (!file) {
    return { ranges: [], wholeFileAddition: false };
  }
  const ranges: EditorGutterChangeRange[] = [];
  for (const hunk of file.hunks) {
    let line = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        line += content.lines;
        continue;
      }
      if (content.additions > 0) {
        appendGutterRange(ranges, {
          kind: content.deletions > 0 ? "modified" : "added",
          startLine: line,
          endLine: line + content.additions - 1,
        });
        line += content.additions;
        continue;
      }
      if (content.deletions > 0) {
        const anchorLine = Math.max(line - 1, 0);
        appendGutterRange(ranges, { kind: "deleted", startLine: anchorLine, endLine: anchorLine });
      }
    }
  }
  return { ranges, wholeFileAddition: file.type === "new" };
}
