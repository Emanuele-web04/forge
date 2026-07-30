// FILE: storeState.ts
// Purpose: Defines the normalized web-store state shape and stable empty slice sentinels.
// Exports: AppState, its initial value, and immutable empty normalized records.

import type { MessageId, ThreadId, TurnId } from "@synara/contracts";

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

export interface AppState {
  /**
   * Highest authoritative snapshot integrated for the local server, and the
   * sole fence for it — the per-environment map below deliberately does not
   * carry a local entry. Optimistic project/space deletes also derive their
   * tombstone sequence from this value.
   */
  shellSnapshotSequence?: number;
  /**
   * Highest snapshot integrated per REMOTE environment. Snapshot sequences are
   * per-server SQLite autoincrement values, so comparing one environment's
   * sequence against another's is meaningless: two servers both emitting
   * snapshot 1 are unrelated events, and a single shared counter would make the
   * second look stale and drop it.
   *
   * The local server is excluded on purpose. Duplicating its fence here once
   * caused a silent hydration failure: resets that predate this field zero
   * `shellSnapshotSequence` alone, leaving a stale local entry behind that
   * rejected every later snapshot. One source of truth per environment.
   */
  shellSnapshotSequenceByEnvironmentId?: Record<string, number>;
  /**
   * Owning environment per thread. Absent means the local server, so existing
   * single-server state needs no migration. A snapshot may only prune threads
   * belonging to the environment that sent it.
   */
  environmentIdByThreadId?: Record<ThreadId, string>;
  spaces: Space[];
  projects: Project[];
  sidebarThreadSummaryById: Record<string, SidebarThreadSummary>;
  threadsHydrated: boolean;
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
   */
  deletedProjectIdsById?: Record<Project["id"], number>;
  deletedThreadIdsById?: Record<ThreadId, number>;
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

export const initialState: AppState = {
  shellSnapshotSequence: 0,
  shellSnapshotSequenceByEnvironmentId: {},
  environmentIdByThreadId: {},
  spaces: [],
  projects: [],
  sidebarThreadSummaryById: {},
  threadsHydrated: false,
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
