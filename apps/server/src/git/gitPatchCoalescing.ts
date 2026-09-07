// Helpers for combining a tracked `git diff` with synthesized untracked-file
// patches into one patch with a single entry per path.

const PATCH_HEADER_PATTERN = /^diff --git a\/(.+?) b\/(.+)$/;

// Content lines always carry a `+`, `-`, space, `@@`, or `\` prefix, so a line
// starting with `diff --git` is always a file boundary.
export function splitGitPatchSegments(patch: string): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      segments.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    segments.push(current.join("\n"));
  }
  return segments.filter((segment) => segment.trim().length > 0);
}

export function removePatchSegmentsForPaths(patch: string, paths: ReadonlySet<string>): string {
  if (paths.size === 0 || patch.length === 0) {
    return patch;
  }
  return splitGitPatchSegments(patch)
    .filter((segment) => {
      const header = segment.split("\n", 1)[0] ?? "";
      const match = PATCH_HEADER_PATTERN.exec(header);
      return match === null || !paths.has(match[2] ?? "");
    })
    .map((segment) => (segment.endsWith("\n") ? segment : `${segment}\n`))
    .join("");
}

export interface RecreatedFileDiff {
  patch: string;
  insertions: number;
  deletions: number;
}

/**
 * Rebuilds a `git diff --no-index <copy of the base blob> <file>` result as an
 * in-place modification of `filePath`, so the temporary copy's path never
 * reaches the client. Returns null when git emitted no text hunks (binary).
 */
export function buildRecreatedFileDiff(
  noIndexPatch: string,
  filePath: string,
): RecreatedFileDiff | null {
  const lines = noIndexPatch.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk === -1) {
    return null;
  }
  const hunkLines = lines.slice(firstHunk);
  let insertions = 0;
  let deletions = 0;
  for (const line of hunkLines) {
    if (line.startsWith("+")) insertions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  const header = `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n`;
  return { patch: header + hunkLines.join("\n"), insertions, deletions };
}
