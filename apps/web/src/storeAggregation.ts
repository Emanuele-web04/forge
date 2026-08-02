// FILE: storeAggregation.ts
// Purpose: Route writes to one environment record and recompute the cross-environment view.
// Layer: Web store
// Exports: environment accessors, the local-environment selector, and the aggregate recomputation.

import type { EnvironmentId, MessageId, ThreadId, TurnId } from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { arraysShallowEqual, recordsShallowEqual } from "./storeNormalization";
import {
  EMPTY_THREAD_IDS,
  initialEnvironmentState,
  type AggregatedView,
  type AppState,
  type EnvironmentState,
} from "./storeState";
import type { Project, Space, SidebarThreadSummary, ThreadShell } from "./types";

const EMPTY_SPACES: Space[] = [];
Object.freeze(EMPTY_SPACES);
const EMPTY_PROJECTS: Project[] = [];
Object.freeze(EMPTY_PROJECTS);

/**
 * One environment's slice, or a stable empty one.
 *
 * Never returns `undefined`: a read for an environment that has not connected
 * yet is an empty environment, not a missing one, so every reader can treat the
 * result uniformly instead of re-deriving "absent means local" at each site —
 * which is precisely the defaulting rule the old ownership side tables spread
 * across seven call sites.
 */
export function selectEnvironment(
  state: AppState,
  environmentId: EnvironmentId = LOCAL_ENVIRONMENT_ID,
): EnvironmentState {
  return state.environmentById[environmentId] ?? initialEnvironmentState;
}

/**
 * The local server's slice.
 *
 * The explicit spelling for local-scoped UI. Consumers that prune persisted
 * user state on hydration (pinned projects, pinned threads, recent views) must
 * read the LOCAL environment's `threadsHydrated`, and calling this is how that
 * intent is stated structurally rather than through a conditional that a later
 * edit can quietly drop.
 */
export function selectLocalEnvironment(state: AppState): EnvironmentState {
  return selectEnvironment(state, LOCAL_ENVIRONMENT_ID);
}

/**
 * Replaces one environment's slice and recomputes the aggregate.
 *
 * The only writer. Because a transition can reach exactly one record through
 * it, a projection cannot touch a second environment's rows even by mistake —
 * the property the flat store could not offer.
 */
export function withEnvironment(
  state: AppState,
  environmentId: EnvironmentId,
  nextEnvironment: EnvironmentState,
): AppState {
  const previous = state.environmentById[environmentId];
  if (previous === nextEnvironment) {
    return state;
  }
  return withAggregatedView({
    ...state,
    environmentById: { ...state.environmentById, [environmentId]: nextEnvironment },
  });
}

/** Applies a pure transition to one environment's slice. */
export function updateEnvironment(
  state: AppState,
  environmentId: EnvironmentId,
  update: (environment: EnvironmentState) => EnvironmentState,
): AppState {
  return withEnvironment(state, environmentId, update(selectEnvironment(state, environmentId)));
}

/** Drops an environment's slice entirely and recomputes the aggregate. */
export function withoutEnvironment(state: AppState, environmentId: EnvironmentId): AppState {
  if (!(environmentId in state.environmentById)) {
    return state;
  }
  const { [environmentId]: _dropped, ...environmentById } = state.environmentById;
  return withAggregatedView({ ...state, environmentById });
}

/**
 * Environment records in a stable order: local first, then the rest by id.
 *
 * Order has to be deterministic or every aggregate below would churn its array
 * identity whenever a `Record` enumeration changed, re-rendering the sidebar for
 * nothing. Local leads because it is the environment the user's own rows live
 * in and the one existing single-server ordering expects.
 */
function orderedEnvironmentEntries(
  state: AppState,
): ReadonlyArray<readonly [string, EnvironmentState]> {
  const entries = Object.entries(state.environmentById);
  if (entries.length <= 1) {
    return entries;
  }
  return entries.toSorted(([left], [right]) => {
    if (left === right) return 0;
    if (left === LOCAL_ENVIRONMENT_ID) return -1;
    if (right === LOCAL_ENVIRONMENT_ID) return 1;
    return left < right ? -1 : 1;
  });
}

/**
 * Concatenates one array-valued slice across environments.
 *
 * List-level merge, which is the whole design: each input array was already
 * reduced INSIDE its own environment, so nothing here inspects a sequence or a
 * cursor — it appends already-final values. Single-environment stores get the
 * source array back by reference, so the common case adds no identity churn.
 */
function concatAcrossEnvironments<T>(
  environments: ReadonlyArray<readonly [string, EnvironmentState]>,
  select: (environment: EnvironmentState) => readonly T[] | undefined,
  previous: readonly T[] | undefined,
  empty: T[],
  /**
   * Identity for de-duplication, when the list holds ids two environments can
   * legitimately share. Omitted for lists whose values are objects that cannot
   * collide meaningfully.
   */
  identity?: (value: T) => string,
): T[] {
  let only: readonly T[] | undefined;
  let merged: T[] | undefined;
  const seen = identity ? new Set<string>() : undefined;
  // Keeps the first environment's copy, matching the record merge and the
  // ownership lookups. Without it a shared id appeared TWICE in `threadIds`,
  // so the sidebar rendered the row twice and every `flatMap` over it produced
  // a duplicate.
  const take = (values: readonly T[]): T[] => {
    if (!seen || !identity) return [...values];
    const kept: T[] = [];
    for (const value of values) {
      const key = identity(value);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(value);
    }
    return kept;
  };
  for (const [, environment] of environments) {
    const values = select(environment);
    if (!values || values.length === 0) continue;
    if (merged) {
      merged.push(...take(values));
      continue;
    }
    if (only) {
      merged = [...take(only), ...take(values)];
      continue;
    }
    only = values;
  }
  const next = merged ?? only;
  if (!next) {
    return arraysShallowEqual(previous, empty) ? (previous as T[]) : empty;
  }
  // Reuse the previous array whenever the contents are identical: selectors all
  // over the app memoize on these references.
  return arraysShallowEqual(previous, next) ? (previous as T[]) : (next as T[]);
}

/**
 * Merges one record-valued slice across environments, FIRST WINS.
 *
 * Ids are server-issued UUIDs and normally unique, but two servers can hold the
 * same one — a clone, or a restore from another server's backup, sharing
 * database identifiers. The precedence therefore has to be pinned, and pinned
 * to the SAME rule `environmentIdForThread` / `environmentIdForProject` use,
 * which return the first owner in this same order.
 *
 * They disagreed before: merging was last-wins while ownership was first-found,
 * so a colliding thread rendered the remote's row while a delete on it wrote a
 * tombstone into the LOCAL environment's sequence space — one server's data
 * spliced onto another's identity, the exact class this store shape exists to
 * exclude. One rule, used by both, is what keeps "what you see" and "what you
 * act on" the same environment.
 *
 * This does not make ids globally unique; it makes a collision resolve
 * consistently and locally-first. A colliding row from a later environment is
 * hidden rather than interleaved.
 */
function mergeAcrossEnvironments<T>(
  environments: ReadonlyArray<readonly [string, EnvironmentState]>,
  select: (environment: EnvironmentState) => Record<string, T> | undefined,
  previous: Record<string, T> | undefined,
): Record<string, T> {
  let only: Record<string, T> | undefined;
  let merged: Record<string, T> | undefined;
  for (const [, environment] of environments) {
    const record = select(environment);
    if (!record) continue;
    if (merged) {
      // First wins: an earlier environment's entry is not overwritten.
      for (const [key, value] of Object.entries(record)) {
        if (!Object.hasOwn(merged, key)) merged[key] = value;
      }
      continue;
    }
    if (only) {
      merged = { ...record, ...only };
      continue;
    }
    if (Object.keys(record).length === 0) continue;
    only = record;
  }
  const next = merged ?? only ?? {};
  return previous && recordsShallowEqual(previous, next) ? previous : next;
}

/**
 * Recomputes the derived cross-environment view from the environment records.
 *
 * Runs after every write. Each field is merged independently and reuses its
 * previous reference when nothing changed, so a transition touching one
 * environment's messages does not invalidate the sidebar's project list.
 *
 * Two fields are pointedly NOT merged. `threadsHydrated` and
 * `shellSnapshotSequence` are read from the LOCAL environment alone: the first
 * gates pruners that delete persisted user state, and the second is a fence in
 * the local server's sequence space that means nothing next to another
 * server's counter.
 */
export function withAggregatedView(state: AppState): AppState {
  const environments = orderedEnvironmentEntries(state);
  const local = selectLocalEnvironment(state);

  const aggregate: AggregatedView = {
    threadsHydrated: local.threadsHydrated,
    ...(local.shellSnapshotSequence === undefined
      ? {}
      : { shellSnapshotSequence: local.shellSnapshotSequence }),
    spaces: concatAcrossEnvironments<Space>(
      environments,
      (environment) => environment.spaces,
      state.spaces,
      EMPTY_SPACES,
      (space) => space.id,
    ),
    projects: concatAcrossEnvironments<Project>(
      environments,
      (environment) => environment.projects,
      state.projects,
      EMPTY_PROJECTS,
      (project) => project.id,
    ),
    threadIds: concatAcrossEnvironments<ThreadId>(
      environments,
      (environment) => environment.threadIds,
      state.threadIds,
      EMPTY_THREAD_IDS,
      (threadId) => threadId,
    ),
    sidebarThreadSummaryById: mergeAcrossEnvironments<SidebarThreadSummary>(
      environments,
      (environment) => environment.sidebarThreadSummaryById,
      state.sidebarThreadSummaryById,
    ),
    threadShellById: mergeAcrossEnvironments<ThreadShell>(
      environments,
      (environment) => environment.threadShellById,
      state.threadShellById,
    ),
    threadSessionById: mergeAcrossEnvironments(
      environments,
      (environment) => environment.threadSessionById,
      state.threadSessionById,
    ),
    threadTurnStateById: mergeAcrossEnvironments(
      environments,
      (environment) => environment.threadTurnStateById,
      state.threadTurnStateById,
    ),
    messageIdsByThreadId: mergeAcrossEnvironments<MessageId[]>(
      environments,
      (environment) => environment.messageIdsByThreadId,
      state.messageIdsByThreadId,
    ),
    messageByThreadId: mergeAcrossEnvironments(
      environments,
      (environment) => environment.messageByThreadId,
      state.messageByThreadId,
    ),
    activityIdsByThreadId: mergeAcrossEnvironments<string[]>(
      environments,
      (environment) => environment.activityIdsByThreadId,
      state.activityIdsByThreadId,
    ),
    activityByThreadId: mergeAcrossEnvironments(
      environments,
      (environment) => environment.activityByThreadId,
      state.activityByThreadId,
    ),
    proposedPlanIdsByThreadId: mergeAcrossEnvironments<string[]>(
      environments,
      (environment) => environment.proposedPlanIdsByThreadId,
      state.proposedPlanIdsByThreadId,
    ),
    proposedPlanByThreadId: mergeAcrossEnvironments(
      environments,
      (environment) => environment.proposedPlanByThreadId,
      state.proposedPlanByThreadId,
    ),
    turnDiffIdsByThreadId: mergeAcrossEnvironments<TurnId[]>(
      environments,
      (environment) => environment.turnDiffIdsByThreadId,
      state.turnDiffIdsByThreadId,
    ),
    turnDiffSummaryByThreadId: mergeAcrossEnvironments(
      environments,
      (environment) => environment.turnDiffSummaryByThreadId,
      state.turnDiffSummaryByThreadId,
    ),
    threadDetailSyncById: mergeAcrossEnvironments(
      environments,
      (environment) => environment.threadDetailSyncById,
      state.threadDetailSyncById,
    ),
    deletedProjectIdsById: mergeAcrossEnvironments<number>(
      environments,
      (environment) => environment.deletedProjectIdsById,
      state.deletedProjectIdsById,
    ),
    deletedThreadIdsById: mergeAcrossEnvironments<number>(
      environments,
      (environment) => environment.deletedThreadIdsById,
      state.deletedThreadIdsById,
    ),
  };

  return { ...state, ...aggregate };
}

/**
 * The environment whose record holds `threadId`, or `null` when NO record does.
 *
 * The honest answer, kept separate from `environmentIdForThread` because that
 * one cannot express "nobody has this". Answering LOCAL for an unknown thread
 * is right for a thread being read and wrong for one being CREATED:
 * `thread.create` carries a brand-new id no snapshot has reported, so a caller
 * that must fall back to another key (the owning project) has to be able to
 * tell "owned by local" from "unknown". Collapsing the two is what sent a
 * remote project's new thread to the user's laptop.
 */
export function findEnvironmentIdForThread(
  state: AppState,
  threadId: ThreadId,
): EnvironmentId | null {
  // Same order the aggregate merges in, so the environment that OWNS a
  // colliding id is the one whose row is on screen. Scanning in raw `Record`
  // order while the merge took the last writer meant a shared id rendered one
  // server's row and routed writes to another's.
  for (const [environmentId, environment] of orderedEnvironmentEntries(state)) {
    if (environment.threadShellById?.[threadId]) {
      return environmentId as EnvironmentId;
    }
  }
  return null;
}

/**
 * The environment that owns a thread, or the local one when no record claims it.
 *
 * Ownership is positional now, so this is a lookup over the records rather than
 * a side table that a write can forget to maintain. Used by the few transitions
 * that receive only a thread id and must find its home before writing.
 */
export function environmentIdForThread(state: AppState, threadId: ThreadId): EnvironmentId {
  return findEnvironmentIdForThread(state, threadId) ?? LOCAL_ENVIRONMENT_ID;
}

/** The environment whose record holds `projectId`, or `null` when none does. */
export function findEnvironmentIdForProject(
  state: AppState,
  projectId: Project["id"],
): EnvironmentId | null {
  // First-wins in aggregate order; see `findEnvironmentIdForThread`.
  for (const [environmentId, environment] of orderedEnvironmentEntries(state)) {
    if (environment.projects.some((project) => project.id === projectId)) {
      return environmentId as EnvironmentId;
    }
  }
  return null;
}

/** The environment that owns a project, or the local one when no record claims it. */
export function environmentIdForProject(state: AppState, projectId: Project["id"]): EnvironmentId {
  return findEnvironmentIdForProject(state, projectId) ?? LOCAL_ENVIRONMENT_ID;
}

/**
 * Whether the LOCAL server's own rows have loaded.
 *
 * The selector for consumers that PRUNE persisted user state on hydration —
 * pinned projects, pinned threads and recent views. They must not run until the
 * local environment has reported, because a pruner running against rows that
 * have merely not arrived deletes pins whose targets exist, and the pruned set
 * is what gets persisted.
 *
 * `AppState.threadsHydrated` already reads the local record and nothing else,
 * so this is not a different value — it is the name that says which environment
 * the caller means, so a reader does not have to know that the aggregate
 * declines to merge this field.
 */
export function selectLocalThreadsHydrated(state: AppState): boolean {
  return selectLocalEnvironment(state).threadsHydrated;
}
