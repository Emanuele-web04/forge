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
  readonly createdAt?: string | undefined;
}

function parseHierarchyCreationMs(value: string | undefined): number {
  if (typeof value !== "string" || value.length === 0) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareHierarchyChildIds(
  leftId: string,
  rightId: string,
  creationMsByKey: ReadonlyMap<string, number>,
): number {
  const leftMs = creationMsByKey.get(leftId) ?? 0;
  const rightMs = creationMsByKey.get(rightId) ?? 0;
  if (leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  if (leftId < rightId) {
    return -1;
  }
  if (leftId > rightId) {
    return 1;
  }
  return 0;
}

export interface ThreadHierarchyIndex<T extends ThreadHierarchyNode> {
  /** First input occurrence wins; keyed by thread id. */
  readonly nodesById: ReadonlyMap<T["id"], T>;
  /** Direct children in creation order (createdAt asc, id asc); structurally valid links only. */
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
  // Creation times are parsed once so sibling sorting never re-parses dates.
  const declaredParentKey = new Map<string, string | null>();
  const declaredEdgeKind = new Map<string, ThreadHierarchyEdgeKind>();
  const creationMsByKey = new Map<string, number>();
  for (const id of orderedIds) {
    const thread = nodesById.get(id);
    if (!thread) {
      continue;
    }
    creationMsByKey.set(thread.id as string, parseHierarchyCreationMs(thread.createdAt));
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
      if (
        childProjectId !== null &&
        parentProjectId !== null &&
        childProjectId !== parentProjectId
      ) {
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
  // Direct siblings sort by creation time ascending, then id ascending with
  // code-unit comparison. Root order always follows stable input order.
  for (const childIds of childIdsByParentId.values()) {
    childIds.sort((left, right) =>
      compareHierarchyChildIds(left as string, right as string, creationMsByKey),
    );
  }
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

/** Direct children of a parent in creation order (empty when unknown). */
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

// Each open branch shows this many direct children first. "Show more" reveals
// all remaining direct children at once; the counter always shows the total.
export const SIDEBAR_THREAD_HIERARCHY_INITIAL_CHILD_COUNT = 5;

function normalizeHierarchyTotalCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeHierarchyMinimumCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeHierarchyRequestedCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return SIDEBAR_THREAD_HIERARCHY_INITIAL_CHILD_COUNT;
  }
  return Math.max(SIDEBAR_THREAD_HIERARCHY_INITIAL_CHILD_COUNT, Math.floor(value));
}

export interface ThreadChildPage {
  /** Children rendered: initial prefix, explicit request, or reveal minimum. */
  visibleCount: number;
  hasMoreChildren: boolean;
  hasLessChildren: boolean;
}

export function resolveThreadChildPage(input: {
  totalChildCount: number;
  requestedVisibleCount?: number | undefined;
  minimumVisibleCount?: number | undefined;
}): ThreadChildPage {
  const totalChildCount = normalizeHierarchyTotalCount(input.totalChildCount);
  const requestedCount = normalizeHierarchyRequestedCount(input.requestedVisibleCount);
  const requiredCount = normalizeHierarchyMinimumCount(input.minimumVisibleCount);
  const visibleCount = Math.min(totalChildCount, Math.max(requestedCount, requiredCount));
  const hasMoreChildren = totalChildCount > visibleCount;
  const hasLessChildren =
    visibleCount >
    Math.min(
      totalChildCount,
      Math.max(SIDEBAR_THREAD_HIERARCHY_INITIAL_CHILD_COUNT, requiredCount),
    );

  return {
    visibleCount,
    hasMoreChildren,
    hasLessChildren,
  };
}

export interface VisibleThreadChildren<T extends ThreadHierarchyNode> {
  visibleChildIds: T["id"][];
  hiddenChildIds: T["id"][];
  totalChildCount: number;
  hasMoreChildren: boolean;
  hasLessChildren: boolean;
  visibleCount: number;
}

/**
 * Which direct children of a parent render: the visible prefix 1..N where N
 * covers the explicit request and any revealed active-descendant position.
 * Explicit navigation to child 17 renders the prefix 1–17, never 1–5 plus 17.
 * Order always follows creation order; remaining ids are the actual hidden
 * suffix so "Show more" never repeats rows.
 */
export function resolveVisibleChildThreadIds<T extends ThreadHierarchyNode>(input: {
  index: ThreadHierarchyIndex<T>;
  parentId: T["id"];
  requestedVisibleCount?: number | undefined;
  minimumVisibleCount?: number | undefined;
  revealedThreadIds?: ReadonlySet<T["id"]> | undefined;
}): VisibleThreadChildren<T> {
  const childIds = getChildThreadIds(input.index, input.parentId);
  let requiredCount = normalizeHierarchyMinimumCount(input.minimumVisibleCount);
  for (let position = 0; position < childIds.length; position += 1) {
    const childId = childIds[position];
    if (childId !== undefined && input.revealedThreadIds?.has(childId)) {
      requiredCount = Math.max(requiredCount, position + 1);
    }
  }
  const page = resolveThreadChildPage({
    totalChildCount: childIds.length,
    requestedVisibleCount: input.requestedVisibleCount,
    minimumVisibleCount: requiredCount,
  });

  return {
    visibleChildIds: childIds.slice(0, page.visibleCount),
    hiddenChildIds: childIds.slice(page.visibleCount),
    totalChildCount: childIds.length,
    hasMoreChildren: page.hasMoreChildren,
    hasLessChildren: page.hasLessChildren,
    visibleCount: page.visibleCount,
  };
}

export interface BranchPagingState {
  hiddenCount: number;
  canShowLess: boolean;
}

/**
 * Paging-row state for a rendered branch, from what actually mounted. Returns
 * null when neither "Show more" nor "Show less" applies (0–5 children at the
 * initial prefix). Shared by every surface so the two controls cannot drift.
 */
export function resolveBranchPagingState(input: {
  totalChildCount: number;
  renderedDirectCount: number;
  requestedVisibleCount: number | undefined;
}): BranchPagingState | null {
  const requestedCount = normalizeHierarchyRequestedCount(input.requestedVisibleCount);
  const hiddenCount = Math.max(0, input.totalChildCount - input.renderedDirectCount);
  const canShowLess =
    requestedCount > SIDEBAR_THREAD_HIERARCHY_INITIAL_CHILD_COUNT &&
    input.renderedDirectCount > SIDEBAR_THREAD_HIERARCHY_INITIAL_CHILD_COUNT;
  if (hiddenCount <= 0 && !canShowLess) {
    return null;
  }
  return { hiddenCount, canShowLess };
}
