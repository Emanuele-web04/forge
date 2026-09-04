import type {
  ProjectId,
  PullRequestListEntry,
  PullRequestProjectContext,
  PullRequestProvider,
} from "@synara/contracts";

type ProjectAwarePullRequestEntry = Pick<
  PullRequestListEntry,
  "projectId" | "repository" | "number" | "isPinned"
> & {
  readonly provider?: PullRequestProvider | undefined;
  readonly projectTitle?: string | undefined;
  readonly headBranch?: string | undefined;
  readonly projectContexts?: ReadonlyArray<PullRequestProjectContext> | undefined;
};

type ProviderAwarePullRequestIdentity = {
  readonly provider?: PullRequestProvider | undefined;
  readonly repository: string;
  readonly number: number;
};

export function normalizePullRequestProvider(
  provider: PullRequestProvider | undefined,
): PullRequestProvider {
  return provider ?? "github";
}

/** Remote identity for a pull request. A PR belongs to a provider repository, not to each local
 * project or worktree that happens to have that repository checked out. */
export function pullRequestListRepositoryIdentity(
  entry: ProviderAwarePullRequestIdentity,
): string {
  return [
    normalizePullRequestProvider(entry.provider),
    entry.repository.trim().toLowerCase(),
    entry.number,
  ].join("\u0000");
}

export function pullRequestRemoteIdentityKey(input: ProviderAwarePullRequestIdentity): string {
  return pullRequestListRepositoryIdentity(input);
}

export function pullRequestProjectIdentityKey(
  input: ProviderAwarePullRequestIdentity & { readonly projectId: ProjectId | string },
): string {
  return `${input.projectId}\u0000${pullRequestRemoteIdentityKey(input)}`;
}

/** Project associations for a repository-level row, with a legacy fallback for older payloads. */
export function pullRequestListProjectContexts(
  entry: ProjectAwarePullRequestEntry,
): PullRequestProjectContext[] {
  if (entry.projectContexts && entry.projectContexts.length > 0) {
    return [...entry.projectContexts];
  }
  return [
    {
      projectId: entry.projectId,
      projectTitle: entry.projectTitle ?? String(entry.projectId),
      isPinned: entry.isPinned ?? false,
    },
  ];
}

export function pullRequestListEntryHasProject(
  entry: ProjectAwarePullRequestEntry,
  projectId: ProjectId,
): boolean {
  return pullRequestListProjectContexts(entry).some((context) => context.projectId === projectId);
}

export function pullRequestListProjectPin(
  entry: ProjectAwarePullRequestEntry,
  projectId: ProjectId,
): boolean | null {
  return (
    pullRequestListProjectContexts(entry).find((context) => context.projectId === projectId)
      ?.isPinned ?? null
  );
}

function mergeProjectContexts(
  entries: readonly ProjectAwarePullRequestEntry[],
): PullRequestProjectContext[] {
  const byProjectId = new Map<ProjectId, PullRequestProjectContext>();
  for (const entry of entries) {
    for (const context of pullRequestListProjectContexts(entry)) {
      const existing = byProjectId.get(context.projectId);
      byProjectId.set(
        context.projectId,
        existing ? { ...context, isPinned: existing.isPinned || context.isPinned } : context,
      );
    }
  }
  return [...byProjectId.values()].toSorted(
    (left, right) =>
      left.projectTitle.localeCompare(right.projectTitle) ||
      left.projectId.localeCompare(right.projectId),
  );
}

function preferredProjectContext(
  entry: Pick<PullRequestListEntry, "headBranch">,
  contexts: readonly PullRequestProjectContext[],
  preferredProjectId: ProjectId | undefined,
): PullRequestProjectContext {
  const explicitlyPreferred = preferredProjectId
    ? contexts.find((context) => context.projectId === preferredProjectId)
    : undefined;
  if (explicitlyPreferred) return explicitlyPreferred;

  const normalizedHeadBranch = entry.headBranch.trim().toLowerCase();
  return (
    contexts.find(
      (context) => context.projectTitle.trim().toLowerCase() === normalizedHeadBranch,
    ) ?? contexts[0]!
  );
}

/** Collapse project/worktree fan-out into one visible row per remote PR while retaining every
 * local project association. The chosen top-level project is only the context used to open the
 * detail panel; remote identity and aggregate pin state remain repository-level. */
export function coalescePullRequestListEntries(
  entries: readonly PullRequestListEntry[],
  options: { readonly preferredProjectId?: ProjectId | undefined } = {},
): PullRequestListEntry[] {
  const entriesByIdentity = new Map<string, PullRequestListEntry[]>();
  for (const entry of entries) {
    const identity = pullRequestListRepositoryIdentity(entry);
    const group = entriesByIdentity.get(identity);
    if (group) group.push(entry);
    else entriesByIdentity.set(identity, [entry]);
  }

  return [...entriesByIdentity.values()].map((group) => {
    const first = group[0]!;
    const contexts = mergeProjectContexts(group);
    const preferred = preferredProjectContext(first, contexts, options.preferredProjectId);
    return {
      ...first,
      projectId: preferred.projectId,
      projectTitle: preferred.projectTitle,
      projectContexts: contexts,
      isPinned: contexts.some((context) => context.isPinned),
      viewerReviewRequested: group.some((entry) => entry.viewerReviewRequested),
    };
  });
}

/** Update one project-owned pin inside an aggregate row without changing its selected context. */
export function updatePullRequestListEntryProjectPin<T extends ProjectAwarePullRequestEntry>(
  entry: T,
  projectId: ProjectId,
  isPinned: boolean,
): T {
  if (!pullRequestListEntryHasProject(entry, projectId)) return entry;
  if (!entry.projectContexts || entry.projectContexts.length === 0) {
    return entry.projectId === projectId ? ({ ...entry, isPinned } as T) : entry;
  }
  const projectContexts = entry.projectContexts.map((context) =>
    context.projectId === projectId ? { ...context, isPinned } : context,
  );
  return {
    ...entry,
    projectContexts,
    isPinned: projectContexts.some((context) => context.isPinned),
  } as T;
}
