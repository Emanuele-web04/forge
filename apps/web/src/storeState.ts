// FILE: storeState.ts
// Purpose: Defines the environment-keyed web-store state shape and stable empty slice sentinels.
// Exports: EnvironmentState, AppState, their initial values, and immutable empty normalized records.

import type { MessageId, ThreadId, TurnId } from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
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

/**
 * Per-thread detail hydration status. Absence means "idle": no detail snapshot
 * has been applied yet, so shell-only threads must not be treated as empty.
 */
export type ThreadDetailSyncState = "synced" | "failed";

/**
 * Everything one server owns.
 *
 * This is the unit of ownership in the store, and ownership is POSITIONAL: a
 * thread belongs to the environment whose record holds it, so there is no
 * side table to keep in step and no site that can forget to filter. Every
 * collection here was previously a flat, globally-shared map paired with an
 * `environmentIdBy*Id` lookup, and seven separate call sites read one of them
 * without applying the filter its siblings applied — a stale shell fence, two
 * snapshot paths that deleted other servers' projects and spaces, two tombstone
 * maps compared against a foreign server's sequence, and a hydration flag any
 * server could set. Keying by environment makes each of those unrepresentable
 * rather than merely fixed.
 *
 * The corollary is the rule the aggregation layer enforces: sequences, cursors
 * and fences are only ever compared INSIDE one of these records. Cross-server
 * combination happens at the list level, over already-reduced values.
 */
export interface EnvironmentState {
  /**
   * Never present. This is a nominal boundary, not a field.
   *
   * `AppState` structurally contains every field below, so without this it is
   * assignable to `EnvironmentState` and `updateEnvironment(state, id, () =>
   * state)` type-checks — nesting the whole store inside one environment
   * record and mixing every server's fences and tombstones together. Declaring
   * the one field `AppState` has and an environment must not makes that
   * assignment a type error instead of a runtime corruption caught only by
   * tests.
   */
  environmentById?: never;
  /**
   * Highest authoritative snapshot integrated for THIS environment, and the
   * sole fence for it. Snapshot sequences are per-server SQLite autoincrement
   * values, so comparing one environment's sequence against another's is
   * meaningless: two servers both emitting snapshot 1 are unrelated events, and
   * a shared counter would make the second look stale and drop it. Living
   * inside the environment record is what makes that comparison impossible to
   * write by accident. Optimistic project/space deletes also derive their
   * tombstone sequence from this value.
   */
  shellSnapshotSequence?: number;
  /**
   * True once THIS environment's own snapshot has arrived.
   *
   * Per-environment by construction, because the consumers that read it PRUNE
   * on it: pinned projects, pinned threads and recent views. A shared flag let
   * a remote snapshot landing first mark the store hydrated while local rows
   * were still absent, and those pruners then dropped pins whose targets simply
   * had not loaded — deleting user data no later snapshot restores, because the
   * pruned set is what gets persisted. Local-scoped UI must read the local
   * environment's flag; `selectLocalEnvironment` is how it says so.
   */
  threadsHydrated: boolean;
  spaces: Space[];
  projects: Project[];
  sidebarThreadSummaryById: Record<string, SidebarThreadSummary>;
  threadIds?: ThreadId[];
  threadShellById?: Record<ThreadId, ThreadShell>;
  threadSessionById?: Record<ThreadId, ThreadSession | null>;
  threadTurnStateById?: Record<ThreadId, ThreadTurnState>;
  messageIdsByThreadId?: Record<ThreadId, MessageId[]>;
  messageByThreadId?: Record<ThreadId, Record<MessageId, ChatMessage>>;
  activityIdsByThreadId?: Record<ThreadId, string[]>;
  activityByThreadId?: Record<ThreadId, Record<string, Thread["activities"][number]>>;
  proposedPlanIdsByThreadId?: Record<ThreadId, string[]>;
  proposedPlanByThreadId?: Record<ThreadId, Record<string, Thread["proposedPlans"][number]>>;
  turnDiffIdsByThreadId?: Record<ThreadId, TurnId[]>;
  turnDiffSummaryByThreadId?: Record<ThreadId, Record<TurnId, Thread["turnDiffSummaries"][number]>>;
  threadDetailSyncById?: Record<ThreadId, ThreadDetailSyncState>;
  /**
   * Deletion tombstones, keyed by id, valued by the snapshot sequence at (or after) which the
   * deletion is guaranteed to be visible server-side. They stop a snapshot generated before the
   * delete from resurrecting the row; `syncServerShellSnapshot` / `syncServerReadModel` retire an
   * entry once an authoritative snapshot at or after that sequence no longer lists the id, so the
   * maps cannot grow for the lifetime of the tab.
   *
   * Both live inside the environment record because the sequence they carry is
   * only meaningful in THIS server's sequence space. Held globally, a remote
   * server idling at sequence 5000 retired a local tombstone written at 101
   * purely because 5000 >= 101, and the next local snapshot resurrected a
   * thread the user had deleted.
   */
  deletedProjectIdsById?: Record<Project["id"], number>;
  deletedThreadIdsById?: Record<ThreadId, number>;
}

/**
 * Cross-environment view of the store, derived from `environmentById`.
 *
 * Read-only by contract: nothing writes these directly. They are recomputed
 * from the environment records after every transition by
 * `withAggregatedView` (see `storeAggregation.ts`), which concatenates
 * already-reduced per-environment values. That is the only place two servers'
 * data meets, and it meets as LISTS — no sequence, cursor or fence is ever
 * compared across records, which is what makes the four ownership bugs this
 * shape replaced unrepresentable rather than merely fixed.
 *
 * `threadsHydrated` and `shellSnapshotSequence` are deliberately NOT merged:
 * both are local-server facts, and both are taken from the local environment
 * alone. See `EnvironmentState` for why a shared hydration flag deleted user
 * pins.
 */
export interface AggregatedView {
  shellSnapshotSequence?: number;
  threadsHydrated: boolean;
  spaces: Space[];
  projects: Project[];
  sidebarThreadSummaryById: Record<string, SidebarThreadSummary>;
  threadIds?: ThreadId[];
  threadShellById?: Record<ThreadId, ThreadShell>;
  threadSessionById?: Record<ThreadId, ThreadSession | null>;
  threadTurnStateById?: Record<ThreadId, ThreadTurnState>;
  messageIdsByThreadId?: Record<ThreadId, MessageId[]>;
  messageByThreadId?: Record<ThreadId, Record<MessageId, ChatMessage>>;
  activityIdsByThreadId?: Record<ThreadId, string[]>;
  activityByThreadId?: Record<ThreadId, Record<string, Thread["activities"][number]>>;
  proposedPlanIdsByThreadId?: Record<ThreadId, string[]>;
  proposedPlanByThreadId?: Record<ThreadId, Record<string, Thread["proposedPlans"][number]>>;
  turnDiffIdsByThreadId?: Record<ThreadId, TurnId[]>;
  turnDiffSummaryByThreadId?: Record<ThreadId, Record<TurnId, Thread["turnDiffSummaries"][number]>>;
  threadDetailSyncById?: Record<ThreadId, ThreadDetailSyncState>;
  deletedProjectIdsById?: Record<Project["id"], number>;
  deletedThreadIdsById?: Record<ThreadId, number>;
}

/**
 * The whole client store: one record per connected environment, plus the
 * derived cross-environment view the UI renders from.
 *
 * `environmentById` is the single source of truth. Every write goes through one
 * environment record; the aggregate is recomputed from those records afterwards
 * and never written to directly.
 */
export interface AppState extends AggregatedView {
  environmentById: Record<string, EnvironmentState>;
}

// These references are shared by selectors and projection writes. Keep them stable
// so empty fallbacks cannot create render loops or needless outer-record churn.
export const EMPTY_THREAD_IDS: ThreadId[] = [];
Object.freeze(EMPTY_THREAD_IDS);
export const EMPTY_THREAD_SHELL_BY_ID: Record<ThreadId, ThreadShell> = {};
export const EMPTY_THREAD_SESSION_BY_ID: Record<ThreadId, ThreadSession | null> = {};
export const EMPTY_THREAD_TURN_STATE_BY_ID: Record<ThreadId, ThreadTurnState> = {};
export const EMPTY_MESSAGE_IDS_BY_THREAD: Record<ThreadId, MessageId[]> = {};
export const EMPTY_MESSAGE_BY_THREAD: Record<ThreadId, Record<MessageId, ChatMessage>> = {};
export const EMPTY_ACTIVITY_IDS_BY_THREAD: Record<ThreadId, string[]> = {};
export const EMPTY_ACTIVITY_BY_THREAD: Record<
  ThreadId,
  Record<string, Thread["activities"][number]>
> = {};
export const EMPTY_PROPOSED_PLAN_IDS_BY_THREAD: Record<ThreadId, string[]> = {};
export const EMPTY_PROPOSED_PLAN_BY_THREAD: Record<
  ThreadId,
  Record<string, Thread["proposedPlans"][number]>
> = {};
export const EMPTY_TURN_DIFF_IDS_BY_THREAD: Record<ThreadId, TurnId[]> = {};
export const EMPTY_TURN_DIFF_BY_THREAD: Record<
  ThreadId,
  Record<TurnId, Thread["turnDiffSummaries"][number]>
> = {};

/**
 * A fresh environment slice.
 *
 * Frozen because it doubles as the "environment not connected yet" sentinel
 * returned by `selectEnvironment`; a reader that mutated it would corrupt every
 * other unconnected environment's view.
 */
export const initialEnvironmentState: EnvironmentState = {
  shellSnapshotSequence: 0,
  threadsHydrated: false,
  spaces: [],
  projects: [],
  sidebarThreadSummaryById: {},
  threadIds: [],
  threadShellById: {},
  threadSessionById: {},
  threadTurnStateById: {},
  messageIdsByThreadId: {},
  messageByThreadId: {},
  activityIdsByThreadId: {},
  activityByThreadId: {},
  proposedPlanIdsByThreadId: {},
  proposedPlanByThreadId: {},
  turnDiffIdsByThreadId: {},
  turnDiffSummaryByThreadId: {},
  threadDetailSyncById: {},
  deletedProjectIdsById: {},
  deletedThreadIdsById: {},
};
Object.freeze(initialEnvironmentState);

/**
 * A store holding only the local environment.
 *
 * The local slice is seeded rather than left absent so a single-server session
 * — every existing user — starts from exactly the state the flat store used to
 * hold. Nothing about this shape is persisted, so no migration is involved:
 * `storePersistence` records project cwds, expansion and local names only, and
 * rebuilds from the first snapshot either way.
 */
export const initialState: AppState = {
  environmentById: { [LOCAL_ENVIRONMENT_ID]: initialEnvironmentState },
  shellSnapshotSequence: 0,
  threadsHydrated: false,
  spaces: [],
  projects: [],
  sidebarThreadSummaryById: {},
  threadIds: [],
  threadShellById: {},
  threadSessionById: {},
  threadTurnStateById: {},
  messageIdsByThreadId: {},
  messageByThreadId: {},
  activityIdsByThreadId: {},
  activityByThreadId: {},
  proposedPlanIdsByThreadId: {},
  proposedPlanByThreadId: {},
  turnDiffIdsByThreadId: {},
  turnDiffSummaryByThreadId: {},
  threadDetailSyncById: {},
  deletedProjectIdsById: {},
  deletedThreadIdsById: {},
};
