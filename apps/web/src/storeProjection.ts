// FILE: storeProjection.ts
// Purpose: Owns normalized slice writes, sidebar projections, and snapshot integration.
// Exports: Pure projection transitions used by the facade and orchestration reducer.

import {
  type EnvironmentId,
  type MessageId,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationSpaceShell,
  type ThreadId,
  type TurnId,
} from "@synara/contracts";
import { deriveThreadSummaryMetadata } from "@synara/shared/threadSummary";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import {
  localThreadDetailResumeCursors,
  threadDetailResumeCursors,
} from "./threadDetailResumeCursors";
import { getThreadFromState, getThreadsFromState } from "./threadDerivation";
import {
  arraysShallowEqual,
  capThreadActivities,
  dedupeActivitiesById,
  deepEqualJson,
  mapProjects,
  mapSpaces,
  mergeReadModelThreadDetailWithLiveHotPath,
  normalizeProject,
  normalizeSpace,
  normalizeThreadFromReadModel,
  normalizeThreadShellSnapshot,
  recordsShallowEqual,
  resolveThreadSidebarMetadata,
  threadSessionsEqual,
  threadShellsEqual,
  threadTurnStatesEqual,
  type ProjectNormalizationInput,
} from "./storeNormalization";
import {
  projectCwdKey,
  rememberProjectLocalNames,
  rememberProjectUiState,
} from "./storePersistence";
import {
  EMPTY_ACTIVITY_BY_THREAD,
  EMPTY_ACTIVITY_IDS_BY_THREAD,
  EMPTY_MESSAGE_BY_THREAD,
  EMPTY_MESSAGE_IDS_BY_THREAD,
  EMPTY_PROPOSED_PLAN_BY_THREAD,
  EMPTY_PROPOSED_PLAN_IDS_BY_THREAD,
  EMPTY_THREAD_IDS,
  EMPTY_THREAD_SESSION_BY_ID,
  EMPTY_THREAD_SHELL_BY_ID,
  EMPTY_THREAD_TURN_STATE_BY_ID,
  EMPTY_TURN_DIFF_BY_THREAD,
  EMPTY_TURN_DIFF_IDS_BY_THREAD,
  type AppState,
  type ThreadDetailSyncState,
} from "./storeState";
import type {
  ChatMessage,
  Project,
  Space,
  SidebarThreadSummary,
  Thread,
  ThreadSession,
  ThreadShell,
  ThreadTurnState,
} from "./types";

type ReadModelThread = OrchestrationReadModel["threads"][number];
export type ProjectMatchPolicy = "id-only" | "id-or-cwd";

function toThreadShell(thread: Thread): ThreadShell {
  return {
    id: thread.id,
    codexThreadId: thread.codexThreadId,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    error: thread.error,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt ?? null,
    settledAt: thread.settledAt ?? null,
    updatedAt: thread.updatedAt,
    isPinned: thread.isPinned ?? false,
    envMode: thread.envMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    workingDirectory: thread.workingDirectory ?? null,
    associatedWorktreePath: thread.associatedWorktreePath ?? null,
    associatedWorktreeBranch: thread.associatedWorktreeBranch ?? null,
    associatedWorktreeRef: thread.associatedWorktreeRef ?? null,
    createBranchFlowCompleted: thread.createBranchFlowCompleted ?? false,
    parentThreadId: thread.parentThreadId ?? null,
    creationSource: thread.creationSource ?? null,
    sourceThreadId: thread.sourceThreadId ?? null,
    subagentAgentId: thread.subagentAgentId ?? null,
    subagentNickname: thread.subagentNickname ?? null,
    subagentRole: thread.subagentRole ?? null,
    forkSourceThreadId: thread.forkSourceThreadId ?? null,
    sidechatSourceThreadId: thread.sidechatSourceThreadId ?? null,
    lastKnownPr: thread.lastKnownPr ?? null,
    handoff: thread.handoff ?? null,
    ...(thread.pinnedMessages !== undefined ? { pinnedMessages: thread.pinnedMessages } : {}),
    ...(thread.threadMarkers !== undefined ? { threadMarkers: thread.threadMarkers } : {}),
    ...(thread.notes !== undefined ? { notes: thread.notes } : {}),
    ...(thread.latestUserMessageAt !== undefined
      ? { latestUserMessageAt: thread.latestUserMessageAt }
      : {}),
    ...(thread.hasPendingApprovals !== undefined
      ? { hasPendingApprovals: thread.hasPendingApprovals }
      : {}),
    ...(thread.hasPendingUserInput !== undefined
      ? { hasPendingUserInput: thread.hasPendingUserInput }
      : {}),
    ...(thread.hasActionableProposedPlan !== undefined
      ? { hasActionableProposedPlan: thread.hasActionableProposedPlan }
      : {}),
    ...(thread.pendingInteractions !== undefined
      ? { pendingInteractions: thread.pendingInteractions }
      : {}),
    ...(thread.lastVisitedAt !== undefined ? { lastVisitedAt: thread.lastVisitedAt } : {}),
  };
}
function toThreadTurnState(thread: Thread): ThreadTurnState {
  return {
    latestTurn: thread.latestTurn,
    ...(thread.pendingSourceProposedPlan
      ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
      : {}),
  };
}

interface NormalizedSlice<TId extends string, TValue> {
  readonly ids: TId[];
  readonly byId: Record<TId, TValue>;
}

/**
 * Builds the `{ ids, byId }` pair for one thread-scoped detail slice, reusing the previous
 * containers by reference whenever they are still correct.
 *
 * Two things matter for the streaming hot path (a delta rewrites one of up to 2k messages):
 * - `ids` only changes when the order or membership changes, so it is reused by reference. That
 *   keeps the outer `...ByThreadId` record from being re-spread and keeps `collectByIds`' cache
 *   and every selector comparing slice identity from invalidating.
 * - `byId` is rebuilt in one keyed pass rather than copied from the previous record. Copying a
 *   ~2k-key dictionary object (`{ ...previous }`) measures ~5x slower in V8 than building a fresh
 *   object with the same keys, and ~4x slower than this loop.
 */
function buildNormalizedSlice<TId extends string, TValue>(
  items: readonly TValue[],
  getId: (item: TValue) => TId,
  previousItems: readonly TValue[] | undefined,
  previousIds: TId[] | undefined,
  previousById: Record<TId, TValue> | undefined,
): NormalizedSlice<TId, TValue> {
  let reusableIds: TId[] | undefined;
  if (
    previousItems !== undefined &&
    previousIds !== undefined &&
    previousById !== undefined &&
    previousItems.length === items.length &&
    previousIds.length === items.length
  ) {
    // Object identity proves a slot is untouched with a pointer compare, so a no-op rewrite of the
    // array (same contents, new reference) costs a scan instead of a rebuild.
    let firstChangedIndex = -1;
    for (let index = 0; index < items.length; index += 1) {
      if (previousItems[index] !== items[index]) {
        firstChangedIndex = index;
        break;
      }
    }
    if (firstChangedIndex < 0) {
      return { ids: previousIds, byId: previousById };
    }
    // Everything before the first changed slot is identical, so only the tail can have reordered.
    reusableIds = previousIds;
    for (let index = firstChangedIndex; index < items.length; index += 1) {
      if (previousIds[index] !== getId(items[index]!)) {
        reusableIds = undefined;
        break;
      }
    }
  }

  const byId = {} as Record<TId, TValue>;
  if (reusableIds !== undefined) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      byId[getId(item)] = item;
    }
    return { ids: reusableIds, byId };
  }

  const ids: TId[] = new Array<TId>(items.length);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const id = getId(item);
    ids[index] = id;
    byId[id] = item;
  }
  return { ids, byId };
}

const messageId = (message: ChatMessage): MessageId => message.id;
const activityId = (activity: Thread["activities"][number]): string => activity.id;
const proposedPlanId = (plan: Thread["proposedPlans"][number]): string => plan.id;
const turnDiffId = (summary: Thread["turnDiffSummaries"][number]): TurnId => summary.turnId;

export function upsertProject(
  state: AppState,
  incoming: ProjectNormalizationInput,
  matchPolicy: ProjectMatchPolicy,
): AppState {
  if (state.deletedProjectIdsById?.[incoming.id] !== undefined) {
    return state;
  }
  const existingProject =
    state.projects.find((project) => project.id === incoming.id) ??
    (matchPolicy === "id-or-cwd"
      ? state.projects.find(
          (project) => projectCwdKey(project.cwd) === projectCwdKey(incoming.workspaceRoot),
        )
      : undefined);
  const nextProject = normalizeProject(incoming, existingProject);

  if (existingProject) {
    if (existingProject === nextProject) {
      return state;
    }
    return {
      ...state,
      projects: state.projects.map((project) =>
        project.id === existingProject.id ? nextProject : project,
      ),
    };
  }

  return {
    ...state,
    projects: [...state.projects, nextProject],
  };
}

export function upsertSpace(
  state: AppState,
  incoming: OrchestrationReadModel["spaces"][number] | OrchestrationSpaceShell,
): AppState {
  const existing = state.spaces.find((space) => space.id === incoming.id);
  const nextSpace = normalizeSpace(incoming, existing);
  if (existing === nextSpace) return state;
  const spaces = existing
    ? state.spaces.map((space) => (space.id === incoming.id ? nextSpace : space))
    : [...state.spaces, nextSpace];
  return {
    ...state,
    spaces: spaces.toSorted(
      (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
    ),
  };
}

export function removeSpace(
  state: AppState,
  spaceId: Space["id"],
  assignmentUpdatedAt?: string,
): AppState {
  const spaces = state.spaces.filter((space) => space.id !== spaceId);
  let projectsChanged = false;
  const projects = state.projects.map((project) => {
    if ((project.spaceId ?? null) !== spaceId) return project;
    projectsChanged = true;
    return {
      ...project,
      spaceId: null,
      ...(assignmentUpdatedAt !== undefined
        ? {
            updatedAt:
              project.updatedAt && project.updatedAt > assignmentUpdatedAt
                ? project.updatedAt
                : assignmentUpdatedAt,
          }
        : {}),
    };
  });
  if (spaces.length === state.spaces.length && !projectsChanged) return state;
  return { ...state, spaces, projects: projectsChanged ? projects : state.projects };
}

export function applySpaceOrder(
  state: AppState,
  orderedSpaceIds: ReadonlyArray<Space["id"]>,
  updatedAt?: string,
): AppState {
  const orderById = new Map(orderedSpaceIds.map((spaceId, index) => [spaceId, index] as const));
  const spaces = state.spaces
    .map((space) => {
      const sortOrder = orderById.get(space.id);
      return sortOrder === undefined || sortOrder === space.sortOrder
        ? space
        : { ...space, sortOrder, ...(updatedAt !== undefined ? { updatedAt } : {}) };
    })
    .toSorted((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  return arraysShallowEqual(spaces, state.spaces) ? state : { ...state, spaces };
}

function sidebarThreadSummariesEqual(
  left: SidebarThreadSummary | undefined,
  right: SidebarThreadSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.modelSelection === right.modelSelection &&
    left.interactionMode === right.interactionMode &&
    left.envMode === right.envMode &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    (left.workingDirectory ?? null) === (right.workingDirectory ?? null) &&
    (left.associatedWorktreePath ?? null) === (right.associatedWorktreePath ?? null) &&
    (left.associatedWorktreeBranch ?? null) === (right.associatedWorktreeBranch ?? null) &&
    (left.associatedWorktreeRef ?? null) === (right.associatedWorktreeRef ?? null) &&
    left.session === right.session &&
    left.createdAt === right.createdAt &&
    (left.archivedAt ?? null) === (right.archivedAt ?? null) &&
    (left.settledAt ?? null) === (right.settledAt ?? null) &&
    left.updatedAt === right.updatedAt &&
    (left.isPinned ?? false) === (right.isPinned ?? false) &&
    left.latestTurn === right.latestTurn &&
    left.lastVisitedAt === right.lastVisitedAt &&
    (left.parentThreadId ?? null) === (right.parentThreadId ?? null) &&
    (left.subagentAgentId ?? null) === (right.subagentAgentId ?? null) &&
    (left.subagentNickname ?? null) === (right.subagentNickname ?? null) &&
    (left.subagentRole ?? null) === (right.subagentRole ?? null) &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan &&
    left.hasLiveTailWork === right.hasLiveTailWork &&
    (left.forkSourceThreadId ?? null) === (right.forkSourceThreadId ?? null) &&
    (left.sidechatSourceThreadId ?? null) === (right.sidechatSourceThreadId ?? null) &&
    deepEqualJson(left.lastKnownPr ?? null, right.lastKnownPr ?? null) &&
    (left.handoff ?? null) === (right.handoff ?? null)
  );
}

function buildSidebarThreadSummary(
  thread: Thread,
  previous?: SidebarThreadSummary,
): SidebarThreadSummary {
  const metadata = resolveThreadSidebarMetadata(thread);
  const nextSummary: SidebarThreadSummary = {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    interactionMode: thread.interactionMode,
    envMode: thread.envMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    workingDirectory: thread.workingDirectory ?? null,
    associatedWorktreePath: thread.associatedWorktreePath ?? null,
    associatedWorktreeBranch: thread.associatedWorktreeBranch ?? null,
    associatedWorktreeRef: thread.associatedWorktreeRef ?? null,
    session: thread.session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt ?? null,
    settledAt: thread.settledAt ?? null,
    updatedAt: thread.updatedAt,
    isPinned: thread.isPinned ?? false,
    latestTurn: thread.latestTurn,
    lastVisitedAt: thread.lastVisitedAt,
    parentThreadId: thread.parentThreadId ?? null,
    subagentAgentId: thread.subagentAgentId ?? null,
    subagentNickname: thread.subagentNickname ?? null,
    subagentRole: thread.subagentRole ?? null,
    latestUserMessageAt: metadata.latestUserMessageAt,
    hasPendingApprovals: metadata.hasPendingApprovals,
    hasPendingUserInput: metadata.hasPendingUserInput,
    hasActionableProposedPlan: metadata.hasActionableProposedPlan,
    hasLiveTailWork: metadata.hasLiveTailWork,
    forkSourceThreadId: thread.forkSourceThreadId ?? null,
    sidechatSourceThreadId: thread.sidechatSourceThreadId ?? null,
    lastKnownPr: thread.lastKnownPr ?? null,
    handoff: thread.handoff ?? null,
  };
  if (previous && sidebarThreadSummariesEqual(previous, nextSummary)) {
    return previous;
  }
  return nextSummary;
}

/**
 * The thread-id registry a full resync should install, reusing the previous array when it already
 * says the same thing.
 *
 * Both full-sync paths used to seed `threadIds: []` and let `ensureThreadRegistered` append id by
 * id. That copied the whole array once per thread — quadratic memory traffic in the thread count —
 * and, worse, guaranteed a brand-new array reference on every single snapshot even when not one id
 * had moved. Every consumer memoizing on `state.threadIds` therefore recomputed on each snapshot,
 * and the "nothing changed" fast path in `syncServerReadModel` could never fire, because its
 * identity check on this exact field always failed.
 *
 * Seeding the finished order up front makes the loop's `ensureThreadRegistered` calls no-ops, so
 * the reference survives whenever the set and the order of threads survive.
 */
function reuseThreadIdRegistry(
  previous: ThreadId[] | undefined,
  nextThreadIds: ReadonlySet<ThreadId>,
): ThreadId[] {
  if (previous && previous.length === nextThreadIds.size) {
    let index = 0;
    let identical = true;
    for (const threadId of nextThreadIds) {
      if (previous[index] !== threadId) {
        identical = false;
        break;
      }
      index += 1;
    }
    if (identical) {
      return previous;
    }
  }
  return [...nextThreadIds];
}

function ensureThreadRegistered(state: AppState, threadId: ThreadId): AppState {
  const threadIds = state.threadIds ?? EMPTY_THREAD_IDS;
  if (threadIds.includes(threadId)) {
    return state;
  }
  return {
    ...state,
    threadIds: [...threadIds, threadId],
  };
}

function retainThreadScopedRecord<T>(
  record: Record<ThreadId, T> | undefined,
  nextThreadIds: ReadonlySet<ThreadId>,
): Record<ThreadId, T> {
  if (!record) {
    return {};
  }
  let changed = false;
  const nextRecord: Record<ThreadId, T> = {};
  for (const [threadId, value] of Object.entries(record) as [ThreadId, T][]) {
    if (!nextThreadIds.has(threadId)) {
      changed = true;
      continue;
    }
    nextRecord[threadId] = value;
  }
  return changed ? nextRecord : record;
}

/**
 * The per-entry "keep the object already stored, or take the new one" rule for the three
 * thread-keyed shell slices.
 *
 * Both writers below need it: `writeThreadShellProjection` upserts a single thread into the
 * existing records, `rebuildThreadShellRecords` builds all three from scratch for a snapshot.
 * Keeping the rule in one place is what makes their outputs comparable — a thread that did not
 * actually change has to yield the same object either way, or a snapshot arriving after an event
 * would swap references that consumers memoize on for no reason.
 */
function resolveShellEntry(previous: ThreadShell | undefined, next: ThreadShell): ThreadShell {
  return previous !== undefined && threadShellsEqual(previous, next) ? previous : next;
}

/**
 * `undefined` here means "store no key at all", not "store `undefined`".
 *
 * A thread without a session is represented by an absent key rather than an explicit `null`, so the
 * event path and the snapshot path agree on the record's shape and not just on what it says — two
 * records that differ only in that detail compare unequal and force a needless rebuild downstream.
 * `threadDerivation` reads both back as `null`.
 */
function resolveSessionEntry(
  previous: ThreadSession | null | undefined,
  next: ThreadSession | null,
): ThreadSession | undefined {
  if (next === null) {
    return undefined;
  }
  return previous != null && threadSessionsEqual(previous, next) ? previous : next;
}

function resolveTurnStateEntry(
  previous: ThreadTurnState | undefined,
  next: ThreadTurnState,
): ThreadTurnState {
  return previous !== undefined && threadTurnStatesEqual(previous, next) ? previous : next;
}

function writeThreadShellProjection(
  state: AppState,
  nextThread: {
    shell: ThreadShell;
    session: ThreadSession | null;
    turnState: ThreadTurnState;
  },
): AppState {
  const threadId = nextThread.shell.id;
  let nextState = ensureThreadRegistered(state, threadId);

  const previousShellById = nextState.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID;
  const shell = resolveShellEntry(previousShellById[threadId], nextThread.shell);
  if (shell !== previousShellById[threadId]) {
    nextState = {
      ...nextState,
      threadShellById: { ...previousShellById, [threadId]: shell },
    };
  }

  const previousSessionById = nextState.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID;
  const previousSession = previousSessionById[threadId];
  const session = resolveSessionEntry(previousSession, nextThread.session);
  if (session !== previousSession) {
    const threadSessionById = { ...previousSessionById };
    if (session === undefined) {
      delete threadSessionById[threadId];
    } else {
      threadSessionById[threadId] = session;
    }
    nextState = { ...nextState, threadSessionById };
  }

  const previousTurnStateById = nextState.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID;
  const turnState = resolveTurnStateEntry(previousTurnStateById[threadId], nextThread.turnState);
  if (turnState !== previousTurnStateById[threadId]) {
    nextState = {
      ...nextState,
      threadTurnStateById: { ...previousTurnStateById, [threadId]: turnState },
    };
  }

  return nextState;
}

/**
 * Rebuilds the three thread-keyed shell records for a full snapshot in a single pass.
 *
 * `writeThreadShellProjection` is the right shape for a single upserted thread, but a full snapshot
 * used to run it once per thread against records this function had just emptied. Every equality
 * guard therefore failed by construction, so each of the three records was re-spread for every
 * thread: O(n²) property copies per snapshot. Measured on this projection, a snapshot cost 1.3 ms at
 * 200 threads, 59.5 ms at 1000 and 418 ms at 2000 — the last two are a visible main-thread stall on
 * every shell push. Accumulating into three plain objects and comparing once at the end brings the
 * same work to 0.26 ms / 2.4 ms / 4.0 ms.
 *
 * Each entry goes through the same `resolve*Entry` rule the per-thread writer uses, so the two
 * paths cannot drift: a thread that did not change keeps the object already stored, and a thread
 * without a session leaves no key behind. Reusing the previous object per entry is also what lets
 * the whole record be returned by reference when a snapshot changes nothing.
 */
function rebuildThreadShellRecords(
  state: AppState,
  snapshotThreads: readonly OrchestrationShellSnapshot["threads"][number][],
  /** Threads owned by other environments, carried over untouched. */
  foreignThreadIds: ReadonlySet<ThreadId> = new Set(),
): {
  threadShellById: Record<ThreadId, ThreadShell>;
  threadSessionById: Record<ThreadId, ThreadSession | null>;
  threadTurnStateById: Record<ThreadId, ThreadTurnState>;
} {
  const previousShellById = state.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID;
  const previousSessionById = state.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID;
  const previousTurnStateById = state.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID;

  const threadShellById = {} as Record<ThreadId, ThreadShell>;
  const threadSessionById = {} as Record<ThreadId, ThreadSession | null>;
  const threadTurnStateById = {} as Record<ThreadId, ThreadTurnState>;

  // These records are rebuilt from scratch, so another environment's rows have
  // to be copied forward explicitly or this snapshot would erase them.
  for (const threadId of foreignThreadIds) {
    const shell = previousShellById[threadId];
    if (shell) threadShellById[threadId] = shell;
    const session = previousSessionById[threadId];
    if (session !== undefined) threadSessionById[threadId] = session;
    const turnState = previousTurnStateById[threadId];
    if (turnState) threadTurnStateById[threadId] = turnState;
  }

  for (const thread of snapshotThreads) {
    const next = normalizeThreadShellSnapshot(thread, getThreadFromState(state, thread.id));
    const threadId = next.shell.id;

    threadShellById[threadId] = resolveShellEntry(previousShellById[threadId], next.shell);

    const session = resolveSessionEntry(previousSessionById[threadId], next.session);
    if (session !== undefined) {
      threadSessionById[threadId] = session;
    }

    threadTurnStateById[threadId] = resolveTurnStateEntry(
      previousTurnStateById[threadId],
      next.turnState,
    );
  }

  return {
    threadShellById: recordsShallowEqual(previousShellById, threadShellById)
      ? previousShellById
      : threadShellById,
    threadSessionById: recordsShallowEqual(previousSessionById, threadSessionById)
      ? previousSessionById
      : threadSessionById,
    threadTurnStateById: recordsShallowEqual(previousTurnStateById, threadTurnStateById)
      ? previousTurnStateById
      : threadTurnStateById,
  };
}

function writeThreadDetailSyncState(
  state: AppState,
  threadId: ThreadId,
  syncState: ThreadDetailSyncState,
): AppState {
  if (state.threadDetailSyncById?.[threadId] === syncState) {
    return state;
  }
  return {
    ...state,
    threadDetailSyncById: {
      ...(state.threadDetailSyncById ?? {}),
      [threadId]: syncState,
    },
  };
}

function clearThreadDetailSyncState(state: AppState, threadId: ThreadId): AppState {
  // Single-thread detail-wipe choke point: every transition that removes or
  // invalidates a thread's cached detail (removeThreadState, eviction, sync
  // failure reset) funnels through here, so this is where the resume-cursor
  // invariant is enforced — wiped detail must never leave a cursor that would
  // let a resubscribe gap-replay on top of missing history. The full-sync
  // paths cover their bulk invalidations separately: the shell snapshot prunes
  // with `retain`, the read-model resync retains its own threads and clears
  // their cursors.
  localThreadDetailResumeCursors().clear(threadId);
  if (
    state.threadDetailSyncById === undefined ||
    !Object.hasOwn(state.threadDetailSyncById, threadId)
  ) {
    return state;
  }
  const { [threadId]: _removed, ...threadDetailSyncById } = state.threadDetailSyncById;
  return { ...state, threadDetailSyncById };
}

export function markThreadDetailSyncFailedInClientState(
  state: AppState,
  threadId: ThreadId,
): AppState {
  // Applied detail outranks a late stream failure: keep rendering the data we have.
  if (state.threadDetailSyncById?.[threadId] === "synced") {
    return state;
  }
  return writeThreadDetailSyncState(state, threadId, "failed");
}

export function clearThreadDetailSyncFailureInClientState(
  state: AppState,
  threadId: ThreadId,
): AppState {
  if (state.threadDetailSyncById?.[threadId] !== "failed") {
    return state;
  }
  return clearThreadDetailSyncState(state, threadId);
}

function writeThreadState(state: AppState, nextThread: Thread, previousThread?: Thread): AppState {
  const nextShell = toThreadShell(nextThread);
  const nextTurnState = toThreadTurnState(nextThread);
  const previousShell = state.threadShellById?.[nextThread.id];
  const previousTurnState = state.threadTurnStateById?.[nextThread.id];

  let nextState = ensureThreadRegistered(state, nextThread.id);

  if (!threadShellsEqual(previousShell, nextShell)) {
    nextState = {
      ...nextState,
      threadShellById: {
        ...(nextState.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID),
        [nextThread.id]: nextShell,
      },
    };
  }

  if (!threadSessionsEqual(previousThread?.session ?? null, nextThread.session)) {
    nextState = {
      ...nextState,
      threadSessionById: {
        ...(nextState.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID),
        [nextThread.id]: nextThread.session,
      },
    };
  }

  if (!threadTurnStatesEqual(previousTurnState, nextTurnState)) {
    nextState = {
      ...nextState,
      threadTurnStateById: {
        ...(nextState.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID),
        [nextThread.id]: nextTurnState,
      },
    };
  }

  if (previousThread?.messages !== nextThread.messages) {
    const previousIds = nextState.messageIdsByThreadId?.[nextThread.id];
    const previousById = nextState.messageByThreadId?.[nextThread.id];
    const slice = buildNormalizedSlice(
      nextThread.messages,
      messageId,
      previousThread?.messages,
      previousIds,
      previousById,
    );
    if (slice.ids !== previousIds) {
      nextState = {
        ...nextState,
        messageIdsByThreadId: {
          ...(nextState.messageIdsByThreadId ?? EMPTY_MESSAGE_IDS_BY_THREAD),
          [nextThread.id]: slice.ids,
        },
      };
    }
    if (slice.byId !== previousById) {
      nextState = {
        ...nextState,
        messageByThreadId: {
          ...(nextState.messageByThreadId ?? EMPTY_MESSAGE_BY_THREAD),
          [nextThread.id]: slice.byId,
        },
      };
    }
  }

  if (previousThread?.activities !== nextThread.activities) {
    const activities = capThreadActivities(dedupeActivitiesById(nextThread.activities));
    const previousIds = nextState.activityIdsByThreadId?.[nextThread.id];
    const previousById = nextState.activityByThreadId?.[nextThread.id];
    const slice = buildNormalizedSlice(
      activities,
      activityId,
      previousThread?.activities,
      previousIds,
      previousById,
    );
    if (slice.ids !== previousIds) {
      nextState = {
        ...nextState,
        activityIdsByThreadId: {
          ...(nextState.activityIdsByThreadId ?? EMPTY_ACTIVITY_IDS_BY_THREAD),
          [nextThread.id]: slice.ids,
        },
      };
    }
    if (slice.byId !== previousById) {
      nextState = {
        ...nextState,
        activityByThreadId: {
          ...(nextState.activityByThreadId ?? EMPTY_ACTIVITY_BY_THREAD),
          [nextThread.id]: slice.byId,
        },
      };
    }
  }

  if (previousThread?.proposedPlans !== nextThread.proposedPlans) {
    const previousIds = nextState.proposedPlanIdsByThreadId?.[nextThread.id];
    const previousById = nextState.proposedPlanByThreadId?.[nextThread.id];
    const slice = buildNormalizedSlice(
      nextThread.proposedPlans,
      proposedPlanId,
      previousThread?.proposedPlans,
      previousIds,
      previousById,
    );
    if (slice.ids !== previousIds) {
      nextState = {
        ...nextState,
        proposedPlanIdsByThreadId: {
          ...(nextState.proposedPlanIdsByThreadId ?? EMPTY_PROPOSED_PLAN_IDS_BY_THREAD),
          [nextThread.id]: slice.ids,
        },
      };
    }
    if (slice.byId !== previousById) {
      nextState = {
        ...nextState,
        proposedPlanByThreadId: {
          ...(nextState.proposedPlanByThreadId ?? EMPTY_PROPOSED_PLAN_BY_THREAD),
          [nextThread.id]: slice.byId,
        },
      };
    }
  }

  if (previousThread?.turnDiffSummaries !== nextThread.turnDiffSummaries) {
    const previousIds = nextState.turnDiffIdsByThreadId?.[nextThread.id];
    const previousById = nextState.turnDiffSummaryByThreadId?.[nextThread.id];
    const slice = buildNormalizedSlice(
      nextThread.turnDiffSummaries,
      turnDiffId,
      previousThread?.turnDiffSummaries,
      previousIds,
      previousById,
    );
    if (slice.ids !== previousIds) {
      nextState = {
        ...nextState,
        turnDiffIdsByThreadId: {
          ...(nextState.turnDiffIdsByThreadId ?? EMPTY_TURN_DIFF_IDS_BY_THREAD),
          [nextThread.id]: slice.ids,
        },
      };
    }
    if (slice.byId !== previousById) {
      nextState = {
        ...nextState,
        turnDiffSummaryByThreadId: {
          ...(nextState.turnDiffSummaryByThreadId ?? EMPTY_TURN_DIFF_BY_THREAD),
          [nextThread.id]: slice.byId,
        },
      };
    }
  }

  return nextState;
}

function removeThreadState(state: AppState, threadId: ThreadId): AppState {
  const { [threadId]: _removedShell, ...threadShellById } =
    state.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID;
  const { [threadId]: _removedSession, ...threadSessionById } =
    state.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID;
  const { [threadId]: _removedTurnState, ...threadTurnStateById } =
    state.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID;
  const { [threadId]: _removedMessageIds, ...messageIdsByThreadId } =
    state.messageIdsByThreadId ?? EMPTY_MESSAGE_IDS_BY_THREAD;
  const { [threadId]: _removedMessages, ...messageByThreadId } =
    state.messageByThreadId ?? EMPTY_MESSAGE_BY_THREAD;
  const { [threadId]: _removedActivityIds, ...activityIdsByThreadId } =
    state.activityIdsByThreadId ?? EMPTY_ACTIVITY_IDS_BY_THREAD;
  const { [threadId]: _removedActivities, ...activityByThreadId } =
    state.activityByThreadId ?? EMPTY_ACTIVITY_BY_THREAD;
  const { [threadId]: _removedPlanIds, ...proposedPlanIdsByThreadId } =
    state.proposedPlanIdsByThreadId ?? EMPTY_PROPOSED_PLAN_IDS_BY_THREAD;
  const { [threadId]: _removedPlans, ...proposedPlanByThreadId } =
    state.proposedPlanByThreadId ?? EMPTY_PROPOSED_PLAN_BY_THREAD;
  const { [threadId]: _removedDiffIds, ...turnDiffIdsByThreadId } =
    state.turnDiffIdsByThreadId ?? EMPTY_TURN_DIFF_IDS_BY_THREAD;
  const { [threadId]: _removedDiffs, ...turnDiffSummaryByThreadId } =
    state.turnDiffSummaryByThreadId ?? EMPTY_TURN_DIFF_BY_THREAD;
  const { [threadId]: _removedSummary, ...sidebarThreadSummaryById } =
    state.sidebarThreadSummaryById;
  const nextThreadIds = (state.threadIds ?? EMPTY_THREAD_IDS).filter((id) => id !== threadId);

  if (
    nextThreadIds === state.threadIds &&
    sidebarThreadSummaryById === state.sidebarThreadSummaryById
  ) {
    return clearThreadDetailSyncState(state, threadId);
  }

  return clearThreadDetailSyncState(
    {
      ...state,
      threadIds: nextThreadIds,
      threadShellById,
      threadSessionById,
      threadTurnStateById,
      messageIdsByThreadId,
      messageByThreadId,
      activityIdsByThreadId,
      activityByThreadId,
      proposedPlanIdsByThreadId,
      proposedPlanByThreadId,
      turnDiffIdsByThreadId,
      turnDiffSummaryByThreadId,
      sidebarThreadSummaryById,
    },
    threadId,
  );
}

export function evictThreadDetailFromClientState(state: AppState, threadId: ThreadId): AppState {
  const detailRecords = [
    state.messageIdsByThreadId,
    state.messageByThreadId,
    state.activityIdsByThreadId,
    state.activityByThreadId,
    state.proposedPlanIdsByThreadId,
    state.proposedPlanByThreadId,
    state.turnDiffIdsByThreadId,
    state.turnDiffSummaryByThreadId,
  ];
  const hasNormalizedDetail = detailRecords.some(
    (record) => record !== undefined && Object.hasOwn(record, threadId),
  );
  if (!hasNormalizedDetail) {
    // A sync flag without normalized detail is stale; clear it so hydration restarts cleanly.
    return clearThreadDetailSyncState(state, threadId);
  }

  const { [threadId]: _removedMessageIds, ...messageIdsByThreadId } =
    state.messageIdsByThreadId ?? EMPTY_MESSAGE_IDS_BY_THREAD;
  const { [threadId]: _removedMessages, ...messageByThreadId } =
    state.messageByThreadId ?? EMPTY_MESSAGE_BY_THREAD;
  const { [threadId]: _removedActivityIds, ...activityIdsByThreadId } =
    state.activityIdsByThreadId ?? EMPTY_ACTIVITY_IDS_BY_THREAD;
  const { [threadId]: _removedActivities, ...activityByThreadId } =
    state.activityByThreadId ?? EMPTY_ACTIVITY_BY_THREAD;
  const { [threadId]: _removedPlanIds, ...proposedPlanIdsByThreadId } =
    state.proposedPlanIdsByThreadId ?? EMPTY_PROPOSED_PLAN_IDS_BY_THREAD;
  const { [threadId]: _removedPlans, ...proposedPlanByThreadId } =
    state.proposedPlanByThreadId ?? EMPTY_PROPOSED_PLAN_BY_THREAD;
  const { [threadId]: _removedDiffIds, ...turnDiffIdsByThreadId } =
    state.turnDiffIdsByThreadId ?? EMPTY_TURN_DIFF_IDS_BY_THREAD;
  const { [threadId]: _removedDiffs, ...turnDiffSummaryByThreadId } =
    state.turnDiffSummaryByThreadId ?? EMPTY_TURN_DIFF_BY_THREAD;

  return clearThreadDetailSyncState(
    {
      ...state,
      messageIdsByThreadId,
      messageByThreadId,
      activityIdsByThreadId,
      activityByThreadId,
      proposedPlanIdsByThreadId,
      proposedPlanByThreadId,
      turnDiffIdsByThreadId,
      turnDiffSummaryByThreadId,
    },
    threadId,
  );
}

/**
 * Sequence at (or after) which a deletion is guaranteed to be reflected in server snapshots.
 * When the deletion arrives as a domain event we know it exactly; for optimistic client-side
 * deletes we only have a lower bound — the delete cannot have been recorded before the newest
 * snapshot we have already integrated, so `shellSnapshotSequence + 1` is safe. Re-deleting keeps
 * the highest known sequence, because retiring later is always the safe direction.
 */
function nextTombstoneSequence<TId extends string>(
  tombstones: Record<TId, number> | undefined,
  id: TId,
  state: AppState,
  deletedAtSequence: number | undefined,
  /**
   * The environment whose sequence space this tombstone lives in. Derived from
   * the row's owner rather than assumed local: a remote row's tombstone must be
   * stamped against ITS server's fence, or it would be compared against a
   * counter it has no relationship to when retirement runs.
   */
  environmentId: EnvironmentId = LOCAL_ENVIRONMENT_ID,
): number {
  const candidate = deletedAtSequence ?? snapshotFenceFor(state, environmentId) + 1;
  const existing = tombstones?.[id];
  return existing === undefined ? candidate : Math.max(existing, candidate);
}

/**
 * Retires tombstones the late-snapshot guard no longer needs.
 *
 * A tombstone only has to survive until an authoritative snapshot generated at or after the
 * deletion proves the row is gone. Snapshots older than that can still carry the deleted row, so
 * they must never retire it; that is what keeps the resurrection guard intact.
 */
function retireDeletionTombstones<TId extends string>(
  tombstones: Record<TId, number> | undefined,
  snapshotSequence: number,
  presentIds: ReadonlySet<string>,
  /**
   * Ids this snapshot's environment actually owns. A tombstone is recorded in
   * ONE environment's sequence space, so comparing it against another server's
   * counter is meaningless — a remote server idling at sequence 5000 would
   * retire a local tombstone written at 101 purely because 5000 >= 101, and
   * because a remote snapshot never lists local ids the "still present" check
   * passes too. The next local snapshot then resurrects a thread the user
   * deleted. Restricting retirement to the sending environment's own ids makes
   * that unrepresentable.
   */
  retirableIds: ReadonlySet<string>,
): Record<TId, number> | undefined {
  if (tombstones === undefined) {
    return tombstones;
  }
  let retiredAny = false;
  const retained = {} as Record<TId, number>;
  for (const [id, deletedAtSequence] of Object.entries(tombstones) as [TId, number][]) {
    if (retirableIds.has(id) && snapshotSequence >= deletedAtSequence && !presentIds.has(id)) {
      retiredAny = true;
      continue;
    }
    retained[id] = deletedAtSequence;
  }
  return retiredAny ? retained : tombstones;
}

/**
 * True when `snapshotSequence` predates the newest snapshot we have already integrated.
 *
 * Such a snapshot can still carry rows deleted after it was generated, and the tombstone that
 * would have filtered them may already have been retired by the newer snapshot — at which point
 * the row silently comes back. The tombstone map cannot tell "never deleted" from "deleted and
 * already confirmed gone", so the whole stale payload has to be rejected before it is merged.
 */
function isStaleSnapshot(
  state: AppState,
  snapshotSequence: number,
  environmentId: EnvironmentId,
): boolean {
  // Compared only against the same environment's high-water mark: sequences from
  // different servers are unrelated counters, and a shared one would reject a
  // second server's first snapshot as "stale".
  return snapshotSequence < snapshotFenceFor(state, environmentId);
}

/**
 * The high-water snapshot sequence for one environment.
 *
 * The local environment reads `shellSnapshotSequence` rather than carrying a
 * duplicate entry in the per-environment map. Two fields holding the same fact
 * can drift, and they did: any caller that reset `shellSnapshotSequence` alone
 * (every store reset written before this map existed, including the browser
 * suite's) left a stale local fence behind that silently rejected the next
 * snapshot as out of date. Keeping one source of truth per environment makes
 * that class of bug unrepresentable — the map holds remote environments only.
 */
function snapshotFenceFor(state: AppState, environmentId: EnvironmentId): number {
  if (environmentId === LOCAL_ENVIRONMENT_ID) return state.shellSnapshotSequence ?? 0;
  return state.shellSnapshotSequenceByEnvironmentId?.[environmentId] ?? 0;
}

/**
 * Records an environment's new high-water mark. Local advances
 * `shellSnapshotSequence`; remote environments advance their map entry.
 */
function advanceSnapshotFence(
  state: AppState,
  environmentId: EnvironmentId,
  snapshotSequence: number,
): Pick<AppState, "shellSnapshotSequence" | "shellSnapshotSequenceByEnvironmentId"> {
  if (environmentId === LOCAL_ENVIRONMENT_ID) {
    return {
      shellSnapshotSequence: Math.max(state.shellSnapshotSequence ?? 0, snapshotSequence),
      ...(state.shellSnapshotSequenceByEnvironmentId
        ? { shellSnapshotSequenceByEnvironmentId: state.shellSnapshotSequenceByEnvironmentId }
        : {}),
    };
  }
  const previous = state.shellSnapshotSequenceByEnvironmentId ?? {};
  return {
    ...(state.shellSnapshotSequence === undefined
      ? {}
      : { shellSnapshotSequence: state.shellSnapshotSequence }),
    shellSnapshotSequenceByEnvironmentId: {
      ...previous,
      [environmentId]: Math.max(previous[environmentId] ?? 0, snapshotSequence),
    },
  };
}

/**
 * Ownership map after a snapshot: this environment claims the threads it just
 * reported, threads it no longer reports lose their entry, and other
 * environments' claims are preserved. Local-owned threads are left unmapped so
 * the single-server store keeps an empty record and its existing identity.
 */
function nextEnvironmentIdByThreadId(
  state: AppState,
  environmentId: EnvironmentId,
  ownedThreadIds: ReadonlySet<ThreadId>,
  survivingThreadIds: ReadonlySet<ThreadId>,
): Record<string, string> {
  const previous = state.environmentIdByThreadId ?? {};
  const next: Record<string, string> = {};
  for (const [threadId, owner] of Object.entries(previous)) {
    if (survivingThreadIds.has(threadId as ThreadId) && owner !== environmentId) {
      next[threadId] = owner;
    }
  }
  if (environmentId !== LOCAL_ENVIRONMENT_ID) {
    for (const threadId of ownedThreadIds) {
      next[threadId] = environmentId;
    }
  }
  return recordsShallowEqual(previous, next) ? previous : next;
}

/**
 * Ownership map after a snapshot, for projects. Exactly the thread rule above:
 * the sending environment claims what it reported, drops what it no longer
 * reports, and never touches another environment's claims. Local-owned projects
 * stay unmapped so a single-server store keeps an empty record.
 */
function nextEnvironmentIdByProjectId(
  state: AppState,
  environmentId: EnvironmentId,
  ownedProjectIds: ReadonlySet<string>,
  survivingProjectIds: ReadonlySet<string>,
): Record<string, string> {
  const previous = state.environmentIdByProjectId ?? {};
  const next: Record<string, string> = {};
  for (const [projectId, owner] of Object.entries(previous)) {
    if (survivingProjectIds.has(projectId) && owner !== environmentId) {
      next[projectId] = owner;
    }
  }
  if (environmentId !== LOCAL_ENVIRONMENT_ID) {
    for (const projectId of ownedProjectIds) {
      next[projectId] = environmentId;
    }
  }
  return recordsShallowEqual(previous, next) ? previous : next;
}

/**
 * Projects the store holds for environments other than `environmentId`.
 *
 * The counterpart to `threadIdsOutsideEnvironment`, and the reason it exists:
 * `projects` was rebuilt from the incoming snapshot alone, so every
 * environment's snapshot deleted every other environment's projects — leaving
 * their threads present but pointing at projects no longer in the store.
 */
function projectIdsOutsideEnvironment(
  state: AppState,
  environmentId: EnvironmentId,
): ReadonlySet<string> {
  const ownerByProjectId = state.environmentIdByProjectId ?? {};
  const foreign = new Set<string>();
  for (const project of state.projects ?? []) {
    const owner = ownerByProjectId[project.id] ?? LOCAL_ENVIRONMENT_ID;
    if (owner !== environmentId) foreign.add(project.id);
  }
  return foreign;
}

/** Threads the store holds for environments other than `environmentId`. */
function threadIdsOutsideEnvironment(
  state: AppState,
  environmentId: EnvironmentId,
): ReadonlySet<ThreadId> {
  const ownerByThreadId = state.environmentIdByThreadId ?? {};
  const foreign = new Set<ThreadId>();
  for (const threadId of state.threadIds ?? EMPTY_THREAD_IDS) {
    const owner = ownerByThreadId[threadId] ?? LOCAL_ENVIRONMENT_ID;
    if (owner !== environmentId) foreign.add(threadId);
  }
  return foreign;
}

/**
 * Clears one environment's shell snapshot fence.
 *
 * The fence is generation-sensitive state exactly like a resume cursor: it is a
 * high-water mark in a journal's sequence space, and a replacement server may
 * serve a journal whose sequences restart low. Keeping it across a generation
 * change makes every snapshot from the new server look stale, so the store
 * silently rejects them and keeps rendering content the server no longer holds
 * — a sidebar that is not merely frozen but wrong, with no error surfaced.
 *
 * Only the fence: on a generation change a fresh snapshot is already in flight,
 * and accepting it prunes the stale rows naturally. Dropping the rows here as
 * well would blank the sidebar for the round trip and buy nothing.
 */
export function clearEnvironmentShellFence(
  state: AppState,
  environmentId: EnvironmentId,
): AppState {
  if (environmentId === LOCAL_ENVIRONMENT_ID) {
    return state.shellSnapshotSequence === 0 ? state : { ...state, shellSnapshotSequence: 0 };
  }
  const previous = state.shellSnapshotSequenceByEnvironmentId ?? {};
  if (!(environmentId in previous)) return state;
  const { [environmentId]: _dropped, ...rest } = previous;
  return { ...state, shellSnapshotSequenceByEnvironmentId: rest };
}

/**
 * Drops an environment entirely: its fence and the rows it owned.
 *
 * Teardown differs from a generation change in the one way that matters — no
 * snapshot is coming. Rows left behind would keep showing threads attributed to
 * a server that is gone, and nothing would ever prune them, so they are dropped
 * here rather than waiting for a sync that never arrives.
 */
export function discardEnvironmentProjection(
  state: AppState,
  environmentId: EnvironmentId,
): AppState {
  const survivingThreadIds = threadIdsOutsideEnvironment(state, environmentId);
  const withoutFence = clearEnvironmentShellFence(state, environmentId);
  const ownerByThreadId = withoutFence.environmentIdByThreadId ?? {};
  const nextOwnerByThreadId: Record<string, string> = {};
  for (const [threadId, owner] of Object.entries(ownerByThreadId)) {
    if (owner !== environmentId) nextOwnerByThreadId[threadId] = owner;
  }
  return {
    ...withoutFence,
    threadIds: reuseThreadIdRegistry(withoutFence.threadIds, survivingThreadIds),
    threadShellById: retainThreadScopedRecord(withoutFence.threadShellById, survivingThreadIds),
    threadSessionById: retainThreadScopedRecord(withoutFence.threadSessionById, survivingThreadIds),
    threadTurnStateById: retainThreadScopedRecord(
      withoutFence.threadTurnStateById,
      survivingThreadIds,
    ),
    sidebarThreadSummaryById: retainThreadScopedRecord(
      withoutFence.sidebarThreadSummaryById,
      survivingThreadIds,
    ),
    environmentIdByThreadId: nextOwnerByThreadId,
  };
}

/**
 * Drops thread/project tombstones that `snapshot` has authoritatively confirmed absent.
 *
 * The sequence guard here only keeps retirement honest; it is not what stops a stale snapshot from
 * resurrecting a row. That is `isStaleSnapshot`, applied before any merge happens.
 */
function retireConfirmedDeletionTombstones(
  state: AppState,
  snapshotSequence: number,
  presentThreadIds: ReadonlySet<string>,
  presentProjectIds: ReadonlySet<string>,
  environmentId: EnvironmentId = LOCAL_ENVIRONMENT_ID,
): AppState {
  if (snapshotSequence < snapshotFenceFor(state, environmentId)) {
    return state;
  }
  // Only this environment's own rows may be retired. A tombstone belongs to the
  // sequence space of the server that recorded the deletion; another server's
  // counter says nothing about it. Ownership is "mapped to me, or unmapped and
  // I am local" — the same default the ownership maps use everywhere else.
  const threadOwner = state.environmentIdByThreadId ?? {};
  const projectOwner = state.environmentIdByProjectId ?? {};
  const ownsThread = (id: string) =>
    (threadOwner[id as ThreadId] ?? LOCAL_ENVIRONMENT_ID) === environmentId;
  const ownsProject = (id: string) => (projectOwner[id] ?? LOCAL_ENVIRONMENT_ID) === environmentId;
  const retirableThreadIds = new Set(
    Object.keys(state.deletedThreadIdsById ?? {}).filter(ownsThread),
  );
  const retirableProjectIds = new Set(
    Object.keys(state.deletedProjectIdsById ?? {}).filter(ownsProject),
  );
  const deletedThreadIdsById = retireDeletionTombstones(
    state.deletedThreadIdsById,
    snapshotSequence,
    presentThreadIds,
    retirableThreadIds,
  );
  const deletedProjectIdsById = retireDeletionTombstones(
    state.deletedProjectIdsById,
    snapshotSequence,
    presentProjectIds,
    retirableProjectIds,
  );
  if (
    deletedThreadIdsById === state.deletedThreadIdsById &&
    deletedProjectIdsById === state.deletedProjectIdsById
  ) {
    return state;
  }
  return {
    ...state,
    ...(deletedThreadIdsById !== undefined ? { deletedThreadIdsById } : {}),
    ...(deletedProjectIdsById !== undefined ? { deletedProjectIdsById } : {}),
  };
}

export function removeDeletedThreadFromClientState(
  state: AppState,
  threadId: ThreadId,
  deletedAtSequence?: number,
): AppState {
  const sequence = nextTombstoneSequence(
    state.deletedThreadIdsById,
    threadId,
    state,
    deletedAtSequence,
    (state.environmentIdByThreadId?.[threadId] as EnvironmentId | undefined) ??
      LOCAL_ENVIRONMENT_ID,
  );
  const deletedThreadIdsById =
    state.deletedThreadIdsById?.[threadId] === sequence
      ? state.deletedThreadIdsById
      : {
          ...(state.deletedThreadIdsById ?? {}),
          [threadId]: sequence,
        };
  const nextState = removeThreadState(state, threadId);
  return nextState.deletedThreadIdsById === deletedThreadIdsById
    ? nextState
    : {
        ...nextState,
        deletedThreadIdsById,
      };
}

function removeProjectState(state: AppState, projectId: Project["id"]): AppState {
  const threadIds = new Set<ThreadId>();
  for (const shell of Object.values(state.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID)) {
    if (shell.projectId === projectId) {
      threadIds.add(shell.id);
    }
  }

  const nextProjects = state.projects.some((project) => project.id === projectId)
    ? state.projects.filter((project) => project.id !== projectId)
    : state.projects;
  const nextState = [...threadIds].reduce((currentState, threadId) => {
    return removeThreadState(currentState, threadId);
  }, state);

  if (nextProjects === state.projects && nextState === state) {
    return state;
  }

  return nextProjects === nextState.projects
    ? nextState
    : {
        ...nextState,
        projects: nextProjects,
      };
}

export function removeDeletedProjectFromClientState(
  state: AppState,
  projectId: Project["id"],
  deletedAtSequence?: number,
): AppState {
  const sequence = nextTombstoneSequence(
    state.deletedProjectIdsById,
    projectId,
    state,
    deletedAtSequence,
    (state.environmentIdByProjectId?.[projectId] as EnvironmentId | undefined) ??
      LOCAL_ENVIRONMENT_ID,
  );
  const deletedProjectIdsById =
    state.deletedProjectIdsById?.[projectId] === sequence
      ? state.deletedProjectIdsById
      : {
          ...(state.deletedProjectIdsById ?? {}),
          [projectId]: sequence,
        };
  const nextState = removeProjectState(state, projectId);
  return nextState.deletedProjectIdsById === deletedProjectIdsById
    ? nextState
    : {
        ...nextState,
        deletedProjectIdsById,
      };
}

function commitThreadProjection(
  state: AppState,
  threadId: ThreadId,
  options?: {
    updateSidebarSummary?: boolean;
  },
): AppState {
  const nextThread = getThreadFromState(state, threadId);
  if (!nextThread) {
    return state;
  }

  const shouldUpdateSidebarSummary = options?.updateSidebarSummary ?? true;

  const previousSummary = state.sidebarThreadSummaryById[threadId];
  const nextSummary =
    shouldUpdateSidebarSummary || previousSummary === undefined
      ? buildSidebarThreadSummary(nextThread, previousSummary)
      : previousSummary;

  if (nextSummary === previousSummary) {
    return state;
  }

  return {
    ...state,
    sidebarThreadSummaryById:
      nextSummary === previousSummary || nextSummary === undefined
        ? state.sidebarThreadSummaryById
        : {
            ...state.sidebarThreadSummaryById,
            [threadId]: nextSummary,
          },
  };
}

function deriveThreadStateSignals(
  thread: Thread,
): Pick<
  Thread,
  | "latestUserMessageAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
> {
  const metadata = deriveThreadSummaryMetadata({
    messages: thread.messages,
    activities: thread.activities,
    proposedPlans: thread.proposedPlans,
    latestTurn: thread.latestTurn,
  });
  const actionableInteractions = thread.pendingInteractions?.filter(
    (interaction) => interaction.status === "pending" || interaction.status === "retryable",
  );
  return {
    latestUserMessageAt: metadata.latestUserMessageAt,
    hasPendingApprovals:
      actionableInteractions?.some((interaction) => interaction.interactionKind === "approval") ??
      metadata.hasPendingApprovals,
    hasPendingUserInput:
      actionableInteractions?.some((interaction) => interaction.interactionKind === "userInput") ??
      metadata.hasPendingUserInput,
    hasActionableProposedPlan: metadata.hasActionableProposedPlan,
  };
}

function withDerivedThreadStateSignals(thread: Thread): Thread {
  const nextSignals = deriveThreadStateSignals(thread);
  if (
    thread.latestUserMessageAt === nextSignals.latestUserMessageAt &&
    thread.hasPendingApprovals === nextSignals.hasPendingApprovals &&
    thread.hasPendingUserInput === nextSignals.hasPendingUserInput &&
    thread.hasActionableProposedPlan === nextSignals.hasActionableProposedPlan
  ) {
    return thread;
  }
  return {
    ...thread,
    ...nextSignals,
  };
}

export function applyThreadUpdate(
  state: AppState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
  options?: {
    recomputeSummarySignals?: boolean;
    updateSidebarSummary?: boolean;
  },
): AppState {
  const currentThread = getThreadFromState(state, threadId);
  if (!currentThread) {
    return state;
  }
  const updatedThread =
    options?.recomputeSummarySignals === false
      ? updater(currentThread)
      : withDerivedThreadStateSignals(updater(currentThread));
  if (updatedThread === currentThread) {
    return state;
  }
  return commitThreadProjection(writeThreadState(state, updatedThread, currentThread), threadId, {
    updateSidebarSummary: options?.updateSidebarSummary ?? true,
  });
}

export function syncServerShellSnapshot(
  state: AppState,
  snapshot: OrchestrationShellSnapshot,
  environmentId: EnvironmentId = LOCAL_ENVIRONMENT_ID,
): AppState {
  if (isStaleSnapshot(state, snapshot.snapshotSequence, environmentId)) {
    return state;
  }
  // A snapshot is authoritative only for its own server, so every prune below is
  // widened with the threads owned by other environments. Without this, each
  // environment's snapshot would delete the others' threads from the sidebar.
  const foreignThreadIds = threadIdsOutsideEnvironment(state, environmentId);
  rememberProjectUiState(state.projects);
  rememberProjectLocalNames(state.projects);
  const deletedProjectIdsById = state.deletedProjectIdsById ?? {};
  const deletedThreadIdsById = state.deletedThreadIdsById ?? {};
  const snapshotThreads = snapshot.threads.filter(
    (thread) =>
      deletedProjectIdsById[thread.projectId] === undefined &&
      deletedThreadIdsById[thread.id] === undefined,
  );
  const snapshotProjects = snapshot.projects.filter(
    (project) => deletedProjectIdsById[project.id] === undefined,
  );
  // Projects and spaces get the same treatment as threads: a snapshot is
  // authoritative only for its own server, so the other environments' projects
  // are carried through rather than rebuilt away. Without this, the FIRST
  // cross-environment snapshot already deletes the other's projects while its
  // threads survive — rows pointing at projects no longer in the store.
  const foreignProjectIds = projectIdsOutsideEnvironment(state, environmentId);
  const foreignProjects = (state.projects ?? []).filter((project) =>
    foreignProjectIds.has(project.id),
  );
  const ownedProjectIds = new Set(snapshotProjects.map((project) => project.id));
  const localProjects = mapProjects(snapshotProjects, state.projects);
  // Identity-stable on a no-op resync; see the read-model path for the reasoning.
  const projects =
    foreignProjects.length === 0 ? localProjects : [...localProjects, ...foreignProjects];
  // Spaces are scoped through their projects: a space no surviving project
  // references has nothing left to render, and the incoming snapshot has no
  // authority over another server's spaces.
  const survivingSpaceIds = new Set<string>(
    projects.flatMap((project) => (project.spaceId ? [String(project.spaceId)] : [])),
  );
  const foreignSpaces = (state.spaces ?? []).filter(
    (space) =>
      survivingSpaceIds.has(space.id) &&
      !(snapshot.spaces ?? []).some((incoming) => incoming.id === space.id),
  );
  const localSpaces = mapSpaces(snapshot.spaces ?? [], state.spaces ?? []);
  const spaces = foreignSpaces.length === 0 ? localSpaces : [...localSpaces, ...foreignSpaces];
  const ownedThreadIds = new Set(snapshotThreads.map((thread) => thread.id));
  const nextThreadIds = new Set([...ownedThreadIds, ...foreignThreadIds]);
  // The retains below prune detail slices down to the surviving threads; any
  // resume cursor for a pruned thread must fall with its detail. Scoped to this
  // environment's cursor space and its own threads — another environment's
  // cursors are indexed by its own journal and are not this snapshot's business.
  threadDetailResumeCursors(environmentId).retain(ownedThreadIds);

  const normalizedState: AppState = {
    ...state,
    threadIds: reuseThreadIdRegistry(state.threadIds, nextThreadIds),
    ...rebuildThreadShellRecords(state, snapshotThreads, foreignThreadIds),
    environmentIdByThreadId: nextEnvironmentIdByThreadId(
      state,
      environmentId,
      ownedThreadIds,
      nextThreadIds,
    ),
    environmentIdByProjectId: nextEnvironmentIdByProjectId(
      state,
      environmentId,
      ownedProjectIds,
      new Set([...ownedProjectIds, ...foreignProjectIds]),
    ),
    messageIdsByThreadId: retainThreadScopedRecord(state.messageIdsByThreadId, nextThreadIds),
    messageByThreadId: retainThreadScopedRecord(state.messageByThreadId, nextThreadIds),
    activityIdsByThreadId: retainThreadScopedRecord(state.activityIdsByThreadId, nextThreadIds),
    activityByThreadId: retainThreadScopedRecord(state.activityByThreadId, nextThreadIds),
    proposedPlanIdsByThreadId: retainThreadScopedRecord(
      state.proposedPlanIdsByThreadId,
      nextThreadIds,
    ),
    proposedPlanByThreadId: retainThreadScopedRecord(state.proposedPlanByThreadId, nextThreadIds),
    turnDiffIdsByThreadId: retainThreadScopedRecord(state.turnDiffIdsByThreadId, nextThreadIds),
    turnDiffSummaryByThreadId: retainThreadScopedRecord(
      state.turnDiffSummaryByThreadId,
      nextThreadIds,
    ),
    threadDetailSyncById: retainThreadScopedRecord(state.threadDetailSyncById, nextThreadIds),
  };

  const threads = getThreadsFromState(normalizedState);
  const nextSidebarThreadSummaryById = Object.fromEntries(
    threads.map((thread) => [
      thread.id,
      buildSidebarThreadSummary(thread, state.sidebarThreadSummaryById[thread.id]),
    ]),
  ) as Record<string, SidebarThreadSummary>;
  const sidebarThreadSummaryById = recordsShallowEqual(
    state.sidebarThreadSummaryById,
    nextSidebarThreadSummaryById,
  )
    ? state.sidebarThreadSummaryById
    : nextSidebarThreadSummaryById;

  return retireConfirmedDeletionTombstones(
    {
      ...normalizedState,
      ...advanceSnapshotFence(state, environmentId, snapshot.snapshotSequence),
      spaces,
      projects,
      sidebarThreadSummaryById,
      // Hydration means the LOCAL server's data has arrived, not that any
      // server's has. Every consumer is local-scoped UI, and three of them
      // PRUNE on it: pinned projects, pinned threads and recent views. A remote
      // snapshot landing first would flip this true while local rows are still
      // absent, and those pruners would drop pins whose targets simply have not
      // loaded — deleting user data that no later snapshot restores, because
      // the pruned set is what gets persisted.
      threadsHydrated:
        environmentId === LOCAL_ENVIRONMENT_ID ? true : (state.threadsHydrated ?? false),
    },
    snapshot.snapshotSequence,
    new Set(snapshot.threads.map((thread) => thread.id)),
    new Set(snapshot.projects.map((project) => project.id)),
    environmentId,
  );
}

function syncServerThreadDetailWithOptions(
  state: AppState,
  thread: ReadModelThread,
  options?: {
    updateSidebarSummary?: boolean;
  },
): AppState {
  const previousThread = getThreadFromState(state, thread.id);
  const nextThreadDetail = options
    ? mergeReadModelThreadDetailWithLiveHotPath(thread, previousThread)
    : thread;
  return writeThreadDetailSyncState(
    commitThreadProjection(
      writeThreadState(
        state,
        normalizeThreadFromReadModel(nextThreadDetail, previousThread),
        previousThread,
      ),
      thread.id,
      {
        updateSidebarSummary: false,
      },
    ),
    thread.id,
    "synced",
  );
}

export function syncServerThreadDetail(state: AppState, thread: ReadModelThread): AppState {
  if (
    state.deletedProjectIdsById?.[thread.projectId] !== undefined ||
    state.deletedThreadIdsById?.[thread.id] !== undefined
  ) {
    return removeThreadState(state, thread.id);
  }
  return syncServerThreadDetailWithOptions(state, thread);
}

export function syncServerThreadDetailHotPath(state: AppState, thread: ReadModelThread): AppState {
  if (
    state.deletedProjectIdsById?.[thread.projectId] !== undefined ||
    state.deletedThreadIdsById?.[thread.id] !== undefined
  ) {
    return removeThreadState(state, thread.id);
  }
  return syncServerThreadDetailWithOptions(state, thread, { updateSidebarSummary: false });
}

export function applyShellEvent(state: AppState, event: OrchestrationShellStreamEvent): AppState {
  switch (event.kind) {
    case "space-upserted":
      return upsertSpace(state, event.space);
    case "space-removed":
      return removeSpace(state, event.spaceId, event.updatedAt);
    case "space-order-updated":
      return applySpaceOrder(state, event.orderedSpaceIds);
    case "project-upserted":
      return upsertProject(state, event.project, "id-or-cwd");
    case "project-removed":
      return removeDeletedProjectFromClientState(state, event.projectId, event.sequence);
    case "thread-upserted": {
      if (
        state.deletedProjectIdsById?.[event.thread.projectId] !== undefined ||
        state.deletedThreadIdsById?.[event.thread.id] !== undefined
      ) {
        return removeThreadState(state, event.thread.id);
      }
      const nextState = writeThreadShellProjection(
        state,
        normalizeThreadShellSnapshot(event.thread, getThreadFromState(state, event.thread.id)),
      );
      return commitThreadProjection(nextState, event.thread.id);
    }
    case "thread-removed":
      // Shell removals can be retryable draft rollbacks; explicit delete reconciliation owns tombstones.
      return removeThreadState(state, event.threadId);
  }
}

/**
 * Full read-model sync. Local-only: it is served by the page's own server
 * (bootstrap and local-state repair), so it owns the local environment's
 * sequence space and prunes only local threads.
 */
export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  if (isStaleSnapshot(state, readModel.snapshotSequence, LOCAL_ENVIRONMENT_ID)) {
    return state;
  }
  const foreignThreadIds = threadIdsOutsideEnvironment(state, LOCAL_ENVIRONMENT_ID);
  rememberProjectUiState(state.projects);
  rememberProjectLocalNames(state.projects);
  const deletedProjectIdsById = state.deletedProjectIdsById ?? {};
  const deletedThreadIdsById = state.deletedThreadIdsById ?? {};
  // Ids the server still reports as live at this snapshot sequence; anything else is either
  // absent or server-side soft-deleted, which is what lets a tombstone retire safely.
  const livePresentThreadIds = new Set<string>(
    readModel.threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
  );
  const livePresentProjectIds = new Set<string>(
    readModel.projects.filter((project) => project.deletedAt === null).map((project) => project.id),
  );
  const spaces = mapSpaces(
    (readModel.spaces ?? []).filter((space) => space.deletedAt === null),
    state.spaces ?? [],
  );
  // Same carryover as the shell path: this read model is authoritative for the
  // local server only, so remote environments' projects survive it. Without
  // this, "Repair local state" and desktop bootstrap recovery delete every
  // remote project while leaving their threads behind.
  const foreignProjectIds = projectIdsOutsideEnvironment(state, LOCAL_ENVIRONMENT_ID);
  const foreignProjects = (state.projects ?? []).filter((project) =>
    foreignProjectIds.has(project.id),
  );
  const localProjects = mapProjects(
    readModel.projects.filter(
      (project) => project.deletedAt === null && deletedProjectIdsById[project.id] === undefined,
    ),
    state.projects,
  );
  // Reuse the previous array when nothing moved: `mapProjects` already returns
  // its input on a no-op resync, and re-spreading it would churn identity for
  // every selector downstream.
  const projects =
    foreignProjects.length === 0 ? localProjects : [...localProjects, ...foreignProjects];
  const nextThreads = readModel.threads
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        deletedProjectIdsById[thread.projectId] === undefined &&
        deletedThreadIdsById[thread.id] === undefined,
    )
    .map((thread) => {
      const existing = getThreadFromState(state, thread.id);
      return normalizeThreadFromReadModel(thread, existing);
    });
  const localThreadIds = new Set(nextThreads.map((thread) => thread.id));
  // Threads on other servers are outside this read model's authority and must
  // survive its prunes.
  const nextThreadIds = new Set([...localThreadIds, ...foreignThreadIds]);
  // This full resync (including the "Repair local state" action) prunes detail
  // slices down to the read model's threads; any resume cursor for a pruned
  // thread must fall with its detail or a later resubscribe would gap-replay
  // on top of history this prune just discarded.
  localThreadDetailResumeCursors().retain(localThreadIds);
  // A surviving thread's detail is replaced wholesale by this read model, so a
  // cursor ahead of the replacement would resume past history the new detail
  // does not contain. Drop them all: the next subscribe takes a snapshot and
  // re-establishes one that matches what is actually cached.
  //
  // Upstream simplified this pair to a bare `resetThreadDetailResumeCursors()`
  // when every cursor was local. It cannot be that here: a reset would also
  // drop cursors for threads on OTHER environments, which this read model has
  // no authority over, so the retain/clear pair is scoped to local threads.
  localThreadDetailResumeCursors().clearMany([...localThreadIds]);
  let normalizedState: AppState = {
    ...state,
    threadIds: reuseThreadIdRegistry(state.threadIds, nextThreadIds),
    threadShellById: retainThreadScopedRecord(state.threadShellById, nextThreadIds),
    threadSessionById: retainThreadScopedRecord(state.threadSessionById, nextThreadIds),
    threadTurnStateById: retainThreadScopedRecord(state.threadTurnStateById, nextThreadIds),
    messageIdsByThreadId: retainThreadScopedRecord(state.messageIdsByThreadId, nextThreadIds),
    messageByThreadId: retainThreadScopedRecord(state.messageByThreadId, nextThreadIds),
    activityIdsByThreadId: retainThreadScopedRecord(state.activityIdsByThreadId, nextThreadIds),
    activityByThreadId: retainThreadScopedRecord(state.activityByThreadId, nextThreadIds),
    proposedPlanIdsByThreadId: retainThreadScopedRecord(
      state.proposedPlanIdsByThreadId,
      nextThreadIds,
    ),
    proposedPlanByThreadId: retainThreadScopedRecord(state.proposedPlanByThreadId, nextThreadIds),
    turnDiffIdsByThreadId: retainThreadScopedRecord(state.turnDiffIdsByThreadId, nextThreadIds),
    turnDiffSummaryByThreadId: retainThreadScopedRecord(
      state.turnDiffSummaryByThreadId,
      nextThreadIds,
    ),
    threadDetailSyncById: retainThreadScopedRecord(state.threadDetailSyncById, nextThreadIds),
  };
  for (const thread of nextThreads) {
    // Read-model threads carry full detail (messages, activities), so they are synced by definition.
    // The previous thread is a cache hit here (it was already materialized above) and lets the
    // slice writer reuse untouched ids/records instead of rebuilding them.
    normalizedState = writeThreadDetailSyncState(
      writeThreadState(normalizedState, thread, getThreadFromState(state, thread.id)),
      thread.id,
      "synced",
    );
  }
  const threads = getThreadsFromState(normalizedState);
  const nextSidebarThreadSummaryById = Object.fromEntries(
    threads.map((thread) => [
      thread.id,
      buildSidebarThreadSummary(thread, state.sidebarThreadSummaryById[thread.id]),
    ]),
  ) as Record<string, SidebarThreadSummary>;
  const sidebarThreadSummaryById = recordsShallowEqual(
    state.sidebarThreadSummaryById,
    nextSidebarThreadSummaryById,
  )
    ? state.sidebarThreadSummaryById
    : nextSidebarThreadSummaryById;
  if (
    spaces === state.spaces &&
    projects === state.projects &&
    sidebarThreadSummaryById === state.sidebarThreadSummaryById &&
    normalizedState.threadIds === state.threadIds &&
    normalizedState.threadShellById === state.threadShellById &&
    normalizedState.threadSessionById === state.threadSessionById &&
    normalizedState.threadTurnStateById === state.threadTurnStateById &&
    normalizedState.messageIdsByThreadId === state.messageIdsByThreadId &&
    normalizedState.messageByThreadId === state.messageByThreadId &&
    normalizedState.activityIdsByThreadId === state.activityIdsByThreadId &&
    normalizedState.activityByThreadId === state.activityByThreadId &&
    normalizedState.proposedPlanIdsByThreadId === state.proposedPlanIdsByThreadId &&
    normalizedState.proposedPlanByThreadId === state.proposedPlanByThreadId &&
    normalizedState.turnDiffIdsByThreadId === state.turnDiffIdsByThreadId &&
    normalizedState.turnDiffSummaryByThreadId === state.turnDiffSummaryByThreadId &&
    normalizedState.threadDetailSyncById === state.threadDetailSyncById &&
    state.threadsHydrated
  ) {
    // Nothing to merge, but the snapshot is still authoritative at its own sequence. Recording it
    // keeps `shellSnapshotSequence` honest, which is what later optimistic deletes derive their
    // tombstone lower bound from — otherwise a tombstone created after this point could be retired
    // by a snapshot that predates the deletion.
    const advanced =
      readModel.snapshotSequence > (state.shellSnapshotSequence ?? 0)
        ? {
            ...state,
            shellSnapshotSequence: readModel.snapshotSequence,
          }
        : state;
    return retireConfirmedDeletionTombstones(
      advanced,
      readModel.snapshotSequence,
      livePresentThreadIds,
      livePresentProjectIds,
    );
  }
  return retireConfirmedDeletionTombstones(
    {
      ...normalizedState,
      shellSnapshotSequence: Math.max(state.shellSnapshotSequence ?? 0, readModel.snapshotSequence),
      spaces,
      projects,
      sidebarThreadSummaryById,
      threadsHydrated: true,
    },
    readModel.snapshotSequence,
    livePresentThreadIds,
    livePresentProjectIds,
  );
}
