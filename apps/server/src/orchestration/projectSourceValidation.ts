import { isAbsolute } from "node:path";

import type { ProjectSourceId, ProjectSourceInput } from "@synara/contracts";
import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";

export function validateProjectSources(
  sources: ReadonlyArray<ProjectSourceInput>,
  primarySourceId: ProjectSourceId,
): string | null {
  if (sources.length === 0) return "A project needs at least one source folder.";
  const seenPaths = new Set<string>();
  for (const source of sources) {
    if (!isAbsolute(source.path)) return `Source folder must be an absolute path: ${source.path}`;
    const normalized = normalizeWorkspaceRootForComparison(source.path, {
      platform: process.platform,
    });
    if (seenPaths.has(normalized)) return `Duplicate source folder: ${source.path}`;
    seenPaths.add(normalized);
  }
  return sources.some((source) => source.id === primarySourceId)
    ? null
    : "The primary source folder must be one of the project's source folders.";
}
