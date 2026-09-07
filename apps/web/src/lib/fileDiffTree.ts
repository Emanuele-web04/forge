// FILE: fileDiffTree.ts
// Purpose: Build a nested, path-compressed folder/file tree from a flat list of
//          parsed file diffs so review surfaces can render a compact explorer
//          without each one re-implementing flat-to-tree conversion. The editor
//          explorer lazy-fetches one directory level at a time from the backend,
//          so it never needed this; in-memory diff lists do.
// Layer: Web diff utilities
// Depends on: diffRendering path helpers.

import type { FileDiffMetadata } from "@pierre/diffs/react";

import { compareDiffPaths, resolveFileDiffPath } from "./diffRendering";

export interface FileDiffTreeFileNode {
  kind: "file";
  /** Leaf name (the final path segment). */
  name: string;
  /** Full repo-relative path, used as the selection id and React key. */
  path: string;
  fileDiff: FileDiffMetadata;
}

export interface FileDiffTreeDirectoryNode {
  kind: "directory";
  /** Display name; compressed chains render as `parent/child`. */
  name: string;
  /** Full repo-relative directory path (no trailing slash), used as the key. */
  path: string;
  children: FileDiffTreeNode[];
}

export type FileDiffTreeNode = FileDiffTreeDirectoryNode | FileDiffTreeFileNode;

interface MutableDirectory {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory>;
  files: FileDiffTreeFileNode[];
}

function createDirectory(name: string, path: string): MutableDirectory {
  return { name, path, directories: new Map(), files: [] };
}

// Collapse single-child directory chains (e.g. `server` → `src` becomes
// `server/src`) so deep, unbranched paths stay compact — the same affordance
// VS Code and GitHub use. Children are already finalized, so a single merge per
// level is sufficient; the loop is defensive.
function compressDirectory(node: FileDiffTreeDirectoryNode): FileDiffTreeDirectoryNode {
  let current = node;
  while (current.children.length === 1) {
    const onlyChild = current.children[0];
    if (!onlyChild || onlyChild.kind !== "directory") {
      break;
    }
    current = {
      kind: "directory",
      name: `${current.name}/${onlyChild.name}`,
      path: onlyChild.path,
      children: onlyChild.children,
    };
  }
  return current;
}

function finalizeDirectory(directory: MutableDirectory): FileDiffTreeNode[] {
  const directories: FileDiffTreeDirectoryNode[] = [];
  for (const child of directory.directories.values()) {
    directories.push(
      compressDirectory({
        kind: "directory",
        name: child.name,
        path: child.path,
        children: finalizeDirectory(child),
      }),
    );
  }
  // Directories first, then files, matching the editor explorer ordering.
  const sortedDirectories = directories.toSorted((left, right) =>
    compareDiffPaths(left.name, right.name),
  );
  const sortedFiles = directory.files.toSorted((left, right) =>
    compareDiffPaths(left.name, right.name),
  );
  return [...sortedDirectories, ...sortedFiles];
}

/**
 * Convert a flat list of parsed file diffs into a sorted, path-compressed tree
 * of directory and file nodes. Pure and side-effect free.
 */
export function buildFileDiffTree(files: ReadonlyArray<FileDiffMetadata>): FileDiffTreeNode[] {
  const root = createDirectory("", "");
  for (const fileDiff of files) {
    const path = resolveFileDiffPath(fileDiff);
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      continue;
    }
    const fileName = segments[segments.length - 1] as string;
    let directory = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as string;
      const childPath = directory.path ? `${directory.path}/${segment}` : segment;
      let child = directory.directories.get(segment);
      if (!child) {
        child = createDirectory(segment, childPath);
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push({ kind: "file", name: fileName, path, fileDiff });
  }
  return finalizeDirectory(root);
}
