// FILE: sidebarThreadHierarchy.ts
// Purpose: Pure shared parent/child thread hierarchy index used by both sidebars.
// Layer: Sidebar model (no React, no storage, no runtime logic in contracts).
// Exports: thread hierarchy index builder, ancestor/child/count accessors, and
// the shared per-branch child pagination model (structure only; expansion state
// lives in Sidebar.uiState.ts and is wired to views by Sidebar.tsx).

export type ThreadHierarchyEdgeKind = "subagent" | "batch";

export interface ThreadHierarchyNode {
  readonly id: string;
  readonly parentThreadId?: string | null | undefined;
  readonly sourceThreadId?: string | null | undefined;
  readonly gatewayOperationId?: string | null | undefined;
  readonly projectId?: string | null | undefined;
}

export interface ThreadHierarchyIndex<T extends ThreadHierarchyNode> {
  /** First input occurrence wins; keyed by thread id. */
  readonly nodesById: ReadonlyMap<T["id"], T>;
  /** Direct children in stable input order; structurally valid links only. */
  readonly childIdsByParentId: ReadonlyMap<T["id"], readonly T["id"][]>;
  /** Root ids in stable input order. */
  readonly rootIds: readonly T["id"][];
  /** Root id for every visible node (roots map to themselves). */
  readonly rootIdByThreadId: ReadonlyMap<T["id"], T["id"]>;
  /** Nesting depth for every visible node (roots are 0). */
  readonly depthByThreadId: ReadonlyMap<T["id"], number>;
  /** Valid parent link for every visible non-root node. */
  readonly parentIdByThreadId: ReadonlyMap<T["id"], T["id"]>;
  /** Edge kind per visible non-root node: provider-native subagent vs batch. */
  readonly edgeKindByThreadId: ReadonlyMap<T["id"], ThreadHierarchyEdgeKind>;
  /**
   * Ids excluded from the forest: orphans (parent absent from the snapshot),
   * cross-project links, self-references, cycles, duplicates beyond the first
   * occurrence, and every descendant of those. A hidden subtree reappears
   * automatically when a later snapshot provides its valid parent.
   */
  readonly hiddenThreadIds: ReadonlySet<T["id"]>;
}

function readParentLink<T extends ThreadHierarchyNode>(
  thread: T,
): { readonly parentId: string; readonly kind: ThreadHierarchyEdgeKind } | null {
  const parentThreadId =
    typeof thread.parentThreadId === "string" && thread.parentThreadId.length > 0
      ? thread.parentThreadId
      : null;
  if (parentThreadId !== null) {
    return { parentId: parentThreadId, kind: "subagent" };
  }
  const sourceThreadId =
    typeof thread.sourceThreadId === "string" && thread.sourceThreadId.length > 0
      ? thread.sourceThreadId
      : null;
  if (sourceThreadId !== null) {
    return { parentId: sourceThreadId, kind: "batch" };
  }
  return null;
}

/**
 * Build the thread forest in O(n) with a single pass plus memoized ancestor
 * walks. Two edge kinds create kinship, frontend-only and unified:
 * - `parentThreadId` → provider-native subagent (`subagent`)
 * - `sourceThreadId` (batches from `synara_create_threads`) → nested batch (`batch`)
 * `parentThreadId` wins when both are present. `forkSourceThreadId`,
 * `sidechatSourceThreadId` and a lone `gatewayOperationId` never create
 * kinship, so unrelated batches stay roots. Links are valid only within
 * the same project; every traversal is iterative and cycle-guarded so
 * self-references, cycles, duplicates and abnormal depth cannot loop or
 * overflow the stack.
 */
export function buildThreadHierarchyIndex<T extends ThreadHierarchyNode>(
  threads: readonly T[],
): ThreadHierarchyIndex<T> {
  const nodesById = new Map<T["id"], T>();
  const idByKey = new Map<string, T["id"]>();
  const orderedIds: T["id"][] = [];
  for (const thread of threads) {
    const key = thread.id as string;
    if (idByKey.has(key)) {
      // Deterministic duplicate handling: keep the first occurrence only.
      continue;
    }
    idByKey.set(key, thread.id);
    nodesById.set(thread.id, thread);
    orderedIds.push(thread.id);
  }

  // Declared parent key per node (null = root candidate). Self-references and
  // missing parents are resolved during the visibility walk below.
  const declaredParentKey = new Map<string, string | null>();
  const declaredEdgeKind = new Map<string, ThreadHierarchyEdgeKind>();
  for (const id of orderedIds) {
    const thread = nodesById.get(id);
    if (!thread) {
      continue;
    }
    const link = readParentLink(thread);
    declaredParentKey.set(thread.id as string, link?.parentId ?? null);
    if (link) {
      declaredEdgeKind.set(thread.id as string, link.kind);
    }
  }

  // A node is visible when walking its declared parent chain reaches a root
  // candidate without crossing an absent parent, a project mismatch, or a
  // cycle. Results are memoized so the whole pass stays O(n).
  const visibilityByKey = new Map<string, boolean>();
  const isVisibleKey = (startKey: string): boolean => {
    const path: string[] = [];
    const pathSet = new Set<string>();
    let currentKey: string | null = startKey;
    let result = false;
    while (currentKey !== null) {
      const known = visibilityByKey.get(currentKey);
      if (known !== undefined) {
        result = known;
        break;
      }
      if (pathSet.has(currentKey)) {
        // Cycle safety net: hide the component instead of looping.
        result = false;
        break;
      }
      const thread = nodesById.get(idByKey.get(currentKey) as T["id"]);
      if (!thread) {
        result = false;
        break;
      }
      pathSet.add(currentKey);
      path.push(currentKey);
      const parentKey: string | null = declaredParentKey.get(currentKey) ?? null;
      if (parentKey === null || parentKey === currentKey) {
        // No parent (root candidate) or self-reference (hidden).
        result = parentKey === null;
        break;
      }
      const parentId = idByKey.get(parentKey);
      const parent = parentId === undefined ? undefined : nodesById.get(parentId);
      if (!parent) {
        // Orphan: the parent is absent (archived, deleted, filtered) from
        // this snapshot. The subtree stays hidden instead of promoting.
        result = false;
        break;
      }
      const childProjectId = thread.projectId ?? null;
      const parentProjectId = parent.projectId ?? null;
      if (childProjectId !== null && parentProjectId !== null && childProjectId !== parentProjectId) {
        // Kinship is valid only within the same project.
        result = false;
        break;
      }
      currentKey = parentKey;
    }
    for (const key of path) {
      visibilityByKey.set(key, result);
    }
    return result;
  };

  const childIdsByParentId = new Map<T["id"], T["id"][]>();
  const rootIdByThreadId = new Map<T["id"], T["id"]>();
  const depthByThreadId = new Map<T["id"], number>();
  const parentIdByThreadId = new Map<T["id"], T["id"]>();
  const edgeKindByThreadId = new Map<T["id"], ThreadHierarchyEdgeKind>();
  const hiddenThreadIds = new Set<T["id"]>();
  const rootIds: T["id"][] = [];

  for (const id of orderedIds) {
    const key = id as string;
    if (!isVisibleKey(key)) {
      hiddenThreadIds.add(id);
      continue;
    }
    const parentKey = declaredParentKey.get(key) ?? null;
    const parentId = parentKey === null ? undefined : idByKey.get(parentKey);
    if (parentId === undefined) {
      rootIds.push(id);
      continue;
    }
    parentIdByThreadId.set(id, parentId);
    const edgeKind = declaredEdgeKind.get(key);
    if (edgeKind) {
      edgeKindByThreadId.set(id, edgeKind);
    }
    const siblings = childIdsByParentId.get(parentId);
    if (siblings) {
      siblings.push(id);
    } else {
      childIdsByParentId.set(parentId, [id]);
    }
  }

  // Breadth-first propagation of root ids and depths from the roots. The
  // forest is a DAG of valid links, but the visited guard keeps this
  // iterative walk bounded even if the input was adversarial.
  const visitedKeys = new Set<string>();
  const queue: T["id"][] = [];
  for (const rootId of rootIds) {
    rootIdByThreadId.set(rootId, rootId);
    depthByThreadId.set(rootId, 0);
    visitedKeys.add(rootId as string);
    queue.push(rootId);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const parentId = queue[head] as T["id"];
    const parentDepth = depthByThreadId.get(parentId) ?? 0;
    const parentRootId = rootIdByThreadId.get(parentId) ?? parentId;
    const childIds = childIdsByParentId.get(parentId) ?? [];
    for (const childId of childIds) {
      const childKey = childId as string;
      if (visitedKeys.has(childKey)) {
        continue;
      }
      visitedKeys.add(childKey);
      rootIdByThreadId.set(childId, parentRootId);
      depthByThreadId.set(childId, parentDepth + 1);
      queue.push(childId);
    }
  }

  return {
    nodesById,
    childIdsByParentId,
    rootIds,
    rootIdByThreadId,
    depthByThreadId,
    parentIdByThreadId,
    edgeKindByThreadId,
    hiddenThreadIds,
  };
}

/** Direct children of a parent in stable input order (empty when unknown). */
export function getChildThreadIds<T extends ThreadHierarchyNode>(
  index: ThreadHierarchyIndex<T>,
  parentId: T["id"],
): readonly T["id"][] {
  return index.childIdsByParentId.get(parentId) ?? [];
}

/**
 * Number of direct children available for a parent, including children hidden
 * by collapse or pagination. Archived and filtered threads are already out of
 * the snapshot, so they never count. Grandchildren count on their own parent.
 */
export function getDirectChildThreadCount<T extends ThreadHierarchyNode>(
  index: ThreadHierarchyIndex<T>,
  parentId: T["id"],
): number {
  return getChildThreadIds(index, parentId).length;
}

/** Root id for a visible node (roots map to themselves; undefined when hidden). */
export function getRootThreadId<T extends ThreadHierarchyNode>(
  index: ThreadHierarchyIndex<T>,
  threadId: T["id"],
): T["id"] | undefined {
  return index.rootIdByThreadId.get(threadId);
}

/** Nesting depth for a visible node (roots are 0; hidden nodes report 0). */
export function getThreadDepth<T extends ThreadHierarchyNode>(
  index: ThreadHierarchyIndex<T>,
  threadId: T["id"],
): number {
  return index.depthByThreadId.get(threadId) ?? 0;
}

/** Edge kind for a visible non-root node (undefined for roots/hidden). */
export function getThreadEdgeKind<T extends ThreadHierarchyNode>(
  index: ThreadHierarchyIndex<T>,
  threadId: T["id"],
): ThreadHierarchyEdgeKind | undefined {
  return index.edgeKindByThreadId.get(threadId);
}

/** True when the link is a nested batch (sourceThreadId), false for subagents/roots. */
export function isBatchThreadEdge<T extends ThreadHierarchyNode>(
  index: ThreadHierarchyIndex<T>,
  threadId: T["id"],
): boolean {
  return index.edgeKindByThreadId.get(threadId) === "batch";
}

/**
 * Ancestor ids from the nearest parent up to the root. Iterative with a
 * visited guard, so adversarial snapshots cannot loop it. Returns [] for
 * roots and hidden nodes.
 */
export function getAncestorThreadIds<T extends ThreadHierarchyNode>(
  index: ThreadHierarchyIndex<T>,
  threadId: T["id"],
): T["id"][] {
  const ancestors: T["id"][] = [];
  const seen = new Set<string>([threadId as string]);
  let current = index.parentIdByThreadId.get(threadId);
  while (current !== undefined) {
    const key = current as string;
    if (seen.has(key)) {
      break;
    }
    seen.add(key);
    ancestors.push(current);
    if (ancestors.length > index.nodesById.size) {
      break;
    }
    current = index.parentIdByThreadId.get(current);
  }
  return ancestors;
}

/**
 * Ancestors plus the thread itself, for transient active-descendant reveals.
 * Empty when the thread is not a visible node of the index.
 */
export function collectRevealThreadIds<T extends ThreadHierarchyNode>(
  index: ThreadHierarchyIndex<T>,
  threadId: T["id"] | undefined,
): Set<T["id"]> {
  const revealed = new Set<T["id"]>();
  if (threadId === undefined || !index.nodesById.has(threadId)) {
    return revealed;
  }
  if (index.hiddenThreadIds.has(threadId)) {
    return revealed;
  }
  revealed.add(threadId);
  for (const ancestorId of getAncestorThreadIds(index, threadId)) {
    revealed.add(ancestorId);
  }
  return revealed;
}

// Each open branch shows this many direct children first, then pages forward
// in steps of the same size. The counter always shows the total.
export const SIDEBAR_THREAD_HIERARCHY_CHILD_PAGE_SIZE = 20;

export interface ThreadChildPage {
  /** Requested extra pages clamped to what the child count can consume. */
  effectiveExtraPages: number;
  /** Children rendered: initial page plus extra pages. */
  visibleCount: number;
  hasMoreChildren: boolean;
  hasLessChildren: boolean;
}

export function resolveThreadChildPage(input: {
  totalChildCount: number;
  requestedExtraPages: number;
}): ThreadChildPage {
  const totalChildCount = Math.max(0, Math.floor(input.totalChildCount));
  const requestedExtraPages = Number.isFinite(input.requestedExtraPages)
    ? Math.max(0, Math.floor(input.requestedExtraPages))
    : 0;
  const hiddenBeyondInitial = Math.max(0, totalChildCount - SIDEBAR_THREAD_HIERARCHY_CHILD_PAGE_SIZE);
  const maxExtraPages =
    SIDEBAR_THREAD_HIERARCHY_CHILD_PAGE_SIZE > 0
      ? Math.ceil(hiddenBeyondInitial / SIDEBAR_THREAD_HIERARCHY_CHILD_PAGE_SIZE)
      : 0;
  const effectiveExtraPages = Math.min(requestedExtraPages, maxExtraPages);
  const visibleCount =
    SIDEBAR_THREAD_HIERARCHY_CHILD_PAGE_SIZE +
    effectiveExtraPages * SIDEBAR_THREAD_HIERARCHY_CHILD_PAGE_SIZE;

  return {
    effectiveExtraPages,
    visibleCount,
    hasMoreChildren: totalChildCount > visibleCount,
    hasLessChildren: effectiveExtraPages > 0,
  };
}

export interface VisibleThreadChildren<T extends ThreadHierarchyNode> {
  visibleChildIds: T["id"][];
  hiddenChildIds: T["id"][];
  totalChildCount: number;
  hasMoreChildren: boolean;
  hasLessChildren: boolean;
  effectiveExtraPages: number;
}

/**
 * Which direct children of a parent render: the current page slice plus any
 * revealed ids (the active-descendant path) even when they fall outside the
 * page. Order always follows the stable input order; remaining ids are
 * computed from actually hidden children so "Show more" never repeats rows.
 */
export function resolveVisibleChildThreadIds<T extends ThreadHierarchyNode>(input: {
  index: ThreadHierarchyIndex<T>;
  parentId: T["id"];
  requestedExtraPages?: number | undefined;
  revealedThreadIds?: ReadonlySet<T["id"]> | undefined;
}): VisibleThreadChildren<T> {
  const childIds = getChildThreadIds(input.index, input.parentId);
  const page = resolveThreadChildPage({
    totalChildCount: childIds.length,
    requestedExtraPages: input.requestedExtraPages ?? 0,
  });
  const pageIds = new Set(childIds.slice(0, page.visibleCount));
  if (input.revealedThreadIds) {
    for (const childId of childIds) {
      if (input.revealedThreadIds.has(childId)) {
        pageIds.add(childId);
      }
    }
  }
  const visibleChildIds = childIds.filter((childId) => pageIds.has(childId));
  const hiddenChildIds = childIds.filter((childId) => !pageIds.has(childId));

  return {
    visibleChildIds,
    hiddenChildIds,
    totalChildCount: childIds.length,
    hasMoreChildren: hiddenChildIds.length > 0,
    hasLessChildren: page.hasLessChildren,
    effectiveExtraPages: page.effectiveExtraPages,
  };
}
