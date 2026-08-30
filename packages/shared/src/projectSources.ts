import type { ProjectSource, ProjectSourceId } from "@synara/contracts";

import { isWorkspaceRootWithin, normalizeWorkspaceRootForComparison } from "./threadWorkspace";

const segmentsOf = (path: string): ReadonlyArray<string> =>
  normalizeWorkspaceRootForComparison(path)
    .split("/")
    .filter((segment) => segment.length > 0);

export function deriveSourceLabels(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const allSegments = paths.map(segmentsOf);
  const labels = allSegments.map((segments) => segments.at(-1) ?? "/");

  for (let depth = 1; depth < 8; depth += 1) {
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    if ([...counts.values()].every((count) => count === 1)) break;

    let changed = false;
    for (let index = 0; index < labels.length; index += 1) {
      if ((counts.get(labels[index]!) ?? 0) <= 1) continue;
      const segments = allSegments[index]!;
      if (segments.length <= depth) continue;
      labels[index] = segments.slice(-(depth + 1)).join("/");
      changed = true;
    }
    if (!changed) break;
  }

  return labels;
}

export function findNestedSourcePairs(
  paths: ReadonlyArray<string>,
): ReadonlyArray<{ readonly outer: string; readonly inner: string }> {
  const pairs: Array<{ readonly outer: string; readonly inner: string }> = [];
  for (const outer of paths) {
    for (const inner of paths) {
      if (outer !== inner && isWorkspaceRootWithin(inner, outer)) pairs.push({ outer, inner });
    }
  }
  return pairs;
}

export function sortProjectSources(
  sources: ReadonlyArray<ProjectSource>,
  primarySourceId: ProjectSourceId,
): ReadonlyArray<ProjectSource> {
  return [...sources].sort((left, right) => {
    if (left.id === primarySourceId) return -1;
    if (right.id === primarySourceId) return 1;
    return left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);
  });
}
