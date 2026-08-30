import { findNestedSourcePairs } from "@synara/shared/projectSources";
import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";

export function validateSourceListDraft(paths: ReadonlyArray<string>): {
  readonly warnings: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
} {
  const populatedPaths = paths.map((path) => path.trim()).filter(Boolean);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (populatedPaths.length === 0) errors.push("A project needs at least one source folder.");
  const seen = new Set<string>();
  for (const path of populatedPaths) {
    const normalized = normalizeWorkspaceRootForComparison(path);
    if (seen.has(normalized)) errors.push(`${path} is already in this project.`);
    seen.add(normalized);
  }
  for (const pair of findNestedSourcePairs(populatedPaths)) {
    warnings.push(
      `${pair.inner} is inside ${pair.outer}. Both stay available, but search results may overlap.`,
    );
  }
  return { warnings, errors };
}
