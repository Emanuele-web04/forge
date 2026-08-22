// FILE: forkThreadTitle.ts
// Purpose: Assign stable, lineage-wide sequence titles to forked threads.
// Layer: Orchestration domain helper

interface ForkLineageThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly forkSourceThreadId?: string | null | undefined;
  readonly sidechatSourceThreadId?: string | null | undefined;
}

interface LineageRoot {
  readonly thread: ForkLineageThread;
  readonly complete: boolean;
}

const FORK_VERSION_SUFFIX = /^(.*) \((\d+)\)$/;

function findLineageRoot(
  source: ForkLineageThread,
  threadsById: ReadonlyMap<string, ForkLineageThread>,
): LineageRoot {
  const visited = new Set<string>([source.id]);
  let current = source;

  while (current.forkSourceThreadId) {
    const parent = threadsById.get(current.forkSourceThreadId);
    if (!parent || parent.projectId !== source.projectId || visited.has(parent.id)) {
      return { thread: current, complete: false };
    }
    visited.add(parent.id);
    current = parent;
  }

  return { thread: current, complete: true };
}

function parseForkVersion(title: string): { readonly baseTitle: string; readonly version: number } {
  const match = FORK_VERSION_SUFFIX.exec(title);
  if (!match) {
    return { baseTitle: title, version: 1 };
  }

  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 2) {
    return { baseTitle: title, version: 1 };
  }

  return { baseTitle: match[1]!, version };
}

export function buildForkThreadTitle(
  source: ForkLineageThread,
  projectThreads: readonly ForkLineageThread[],
): string {
  const threadsById = new Map(projectThreads.map((thread) => [thread.id, thread]));
  const sourceRoot = findLineageRoot(source, threadsById);
  const fallbackTitle = parseForkVersion(source.title);
  const lineageTitle = sourceRoot.complete
    ? parseForkVersion(sourceRoot.thread.title)
    : fallbackTitle;
  const family = projectThreads.filter((thread) => {
    if (thread.projectId !== source.projectId || thread.sidechatSourceThreadId) {
      return false;
    }
    const root = findLineageRoot(thread, threadsById);
    return root.complete && sourceRoot.complete && root.thread.id === sourceRoot.thread.id;
  });
  const latestNamedVersion = family.reduce((latest, thread) => {
    const candidate = parseForkVersion(thread.title);
    return candidate.baseTitle === lineageTitle.baseTitle
      ? Math.max(latest, candidate.version)
      : latest;
  }, lineageTitle.version);
  const nextVersion = Math.max(2, family.length + 1, latestNamedVersion + 1);

  return `${lineageTitle.baseTitle} (${nextVersion})`;
}
