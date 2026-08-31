import type { ProjectSource, ProjectSourceId } from "@synara/contracts";

import { deriveSourceLabels, sortProjectSources } from "./projectSources";

export interface RootBinding {
  readonly sourceId: ProjectSourceId;
  readonly sourcePath: string;
  readonly effectivePath: string;
  readonly isGitRepo: boolean;
  readonly isIsolated: boolean;
  readonly label: string;
}

export interface ThreadRoots {
  readonly primary: RootBinding;
  readonly extra: ReadonlyArray<RootBinding>;
}

export function allRoots(roots: ThreadRoots): ReadonlyArray<RootBinding> {
  return [roots.primary, ...roots.extra];
}

export function deriveThreadRoots(input: {
  readonly sources: ReadonlyArray<ProjectSource>;
  readonly primarySourceId: ProjectSourceId | null;
  readonly primaryWorktreePath?: string | null | undefined;
}): ThreadRoots | null {
  if (input.primarySourceId === null) return null;
  const orderedSources = sortProjectSources(input.sources, input.primarySourceId);
  if (orderedSources[0]?.id !== input.primarySourceId) return null;
  const labels = deriveSourceLabels(orderedSources.map((source) => source.path));
  const roots = orderedSources.map((source, index): RootBinding => {
    const isPrimary = source.id === input.primarySourceId;
    const effectivePath =
      isPrimary && input.primaryWorktreePath ? input.primaryWorktreePath : source.path;
    return {
      sourceId: source.id,
      sourcePath: source.path,
      effectivePath,
      isGitRepo: false,
      isIsolated: isPrimary && effectivePath !== source.path,
      label: labels[index]!,
    };
  });
  return { primary: roots[0]!, extra: roots.slice(1) };
}
