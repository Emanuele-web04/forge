// FILE: kanban.logic.ts
// Purpose: Pure derivation of the kanban control-center board (columns, cards, ordering)
//          from sidebar thread summaries and composer draft snapshots.
// Layer: UI logic (no React, no stores) so the board math stays unit-testable.
// Exports: deriveKanbanColumn, buildKanbanBoard, ordering + drop-action helpers.

import type { ProjectId, ProviderKind, ThreadEnvironmentMode, ThreadId } from "@synara/contracts";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";
import { isPendingThreadWorktree } from "@synara/shared/threadEnvironment";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import {
  canSessionAnswerPendingRequests,
  deriveActiveWorkStartedAt,
  hasLiveLatestTurn,
} from "../../session-logic";
import type { Project, SidebarThreadSummary } from "../../types";

export type KanbanColumnKey = "draft" | "inProgress" | "done";

export const KANBAN_COLUMN_LABELS: Record<KanbanColumnKey, string> = {
  draft: "Draft",
  inProgress: "In Progress",
  done: "Done",
};

export const KANBAN_FALLBACK_DRAFT_TITLE = "New thread";

/** Pending composer content for one thread, projected from the composer draft store. */
export interface KanbanComposerDraftSnapshot {
  prompt: string;
  /** Files, images, terminal contexts, or references attached to the composer draft. */
  hasAttachments: boolean;
  provider: ProviderKind | null;
}

type KanbanComposerDraftSource = Pick<
  ComposerThreadDraftState,
  | "prompt"
  | "files"
  | "images"
  | "persistedAttachments"
  | "terminalContexts"
  | "assistantSelections"
  | "fileComments"
  | "activeProvider"
> &
  Partial<Pick<ComposerThreadDraftState, "browserAnnotations">>;

/** Shared projection so the board build and the drop-time dispatch re-check agree. */
export function buildKanbanComposerDraftSnapshot(
  draft: KanbanComposerDraftSource | null | undefined,
): KanbanComposerDraftSnapshot | null {
  if (!draft) {
    return null;
  }
  return {
    prompt: draft.prompt,
    hasAttachments:
      draft.images.length > 0 ||
      draft.files.length > 0 ||
      draft.persistedAttachments.length > 0 ||
      draft.terminalContexts.some((context) => context.text.trim().length > 0) ||
      draft.assistantSelections.length > 0 ||
      (draft.browserAnnotations?.length ?? 0) > 0 ||
      draft.fileComments.length > 0,
    provider: draft.activeProvider,
  };
}

/**
 * A draft dropped on In Progress whose first runtime signal has not arrived yet.
 * Provider session init can take seconds (e.g. Cursor), so the board shows the
 * card In Progress optimistically until runtime state settles or the entry expires.
 */
export interface KanbanOptimisticDispatchSnapshot {
  projectId: ProjectId;
  /** Display title for the window where neither thread nor composer prompt exists. */
  title: string;
  provider: ProviderKind | null;
  /** latestTurn.turnId at dispatch time; any different (or first) turn settles the entry. */
  baselineTurnId: string | null;
  /** Epoch ms of the drop — recency sort key and expiry baseline. */
  droppedAtMs: number;
}

/**
 * Value equality for the projected composer-draft map. The composer store churns
 * on fields the board never reads (selections, modes, focus); keeping the
 * projection's identity stable when its content is unchanged spares the board
 * a rebuild per irrelevant store write.
 */
export function areKanbanComposerDraftSnapshotsEqual(
  left: Readonly<Record<string, KanbanComposerDraftSnapshot>>,
  right: Readonly<Record<string, KanbanComposerDraftSnapshot>>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  for (const key of leftKeys) {
    const leftSnapshot = left[key];
    const rightSnapshot = right[key];
    if (
      !leftSnapshot ||
      !rightSnapshot ||
      leftSnapshot.prompt !== rightSnapshot.prompt ||
      leftSnapshot.hasAttachments !== rightSnapshot.hasAttachments ||
      leftSnapshot.provider !== rightSnapshot.provider
    ) {
      return false;
    }
  }
  return true;
}

/** Local-only (unpromoted) draft thread, projected from the composer draft store. */
export interface KanbanDraftThreadSnapshot {
  threadId: ThreadId;
  projectId: ProjectId;
  createdAt: string;
  branch: string | null;
  envMode?: ThreadEnvironmentMode | null;
  worktreePath?: string | null;
}

export interface KanbanCard {
  /**
   * Unique drag/render identity. Distinct from threadId because a settled thread
   * with an unsent composer prompt yields an extra draft card alongside its done card.
   */
  cardId: string;
  threadId: ThreadId;
  projectId: ProjectId;
  column: KanbanColumnKey;
  title: string;
  provider: ProviderKind | null;
  /** Terminal-first thread — renders the terminal glyph instead of a provider icon. */
  isTerminal: boolean;
  branch: string | null;
  /** Environment intent for the local/worktree badge; mirrored from the thread or draft. */
  envMode: ThreadEnvironmentMode | null;
  worktreePath: string | null;
  /** Backing summary; null for local-only draft threads that have not been promoted yet. */
  thread: SidebarThreadSummary | null;
  /** Trimmed composer prompt a draft card dispatches when dropped on In Progress. */
  draftPrompt: string;
  /** Prompt carries attachments the board cannot dispatch — open the chat instead. */
  draftHasAttachments: boolean;
  /** Milliseconds used for recency ordering within a column. */
  sortTimestamp: number;
  /** ISO timestamp rendered on the card; null when the card has no activity yet. */
  timestamp: string | null;
  /** ISO timestamp used for live "Worked for" labels on In Progress cards. */
  activeWorkStartedAt: string | null;
  /** Shown In Progress ahead of runtime state — renders the "Starting…" affordance. */
  isOptimisticDispatch: boolean;
}

export interface KanbanProjectBoard {
  projectId: ProjectId;
  projectName: string;
  projectKind: Project["kind"];
  draft: KanbanCard[];
  inProgress: KanbanCard[];
  done: KanbanCard[];
  totalCount: number;
}

export interface KanbanBoard {
  projects: KanbanProjectBoard[];
  totalCount: number;
}

export interface BuildKanbanBoardInput {
  projects: readonly Pick<Project, "id" | "kind" | "name">[];
  threads: readonly SidebarThreadSummary[];
  draftThreads: readonly KanbanDraftThreadSnapshot[];
  composerDraftByThreadId: Readonly<Record<string, KanbanComposerDraftSnapshot | undefined>>;
  /** Manual draft-column card order per project (kanban UI store). */
  draftOrderByProjectId: Readonly<Record<string, readonly string[] | undefined>>;
  /**
   * Maps a thread's stored projectId to the board it should appear on. Used to fold
   * duplicate home chat-container projects into the one canonical "Chats" board;
   * cards keep their true projectId so dispatch still targets the real project.
   */
  projectIdAliases?: Readonly<Record<string, ProjectId | undefined>>;
  /** Threads whose terminal entryPoint is "terminal" (terminal-first, not provider chats). */
  terminalEntryThreadIds?: ReadonlySet<string>;
  /** Dispatched drops still waiting for their first runtime signal (kanban UI store). */
  optimisticDispatchByThreadId?: Readonly<
    Record<string, KanbanOptimisticDispatchSnapshot | undefined>
  >;
}

export function kanbanThreadCardId(threadId: ThreadId): string {
  return `thread:${threadId}`;
}

export function kanbanDraftCardId(threadId: ThreadId): string {
  return `draft:${threadId}`;
}

/** Draft-only cards clear composer/draft state; thread cards still use thread actions. */
export function isKanbanDraftOnlyCard(
  card: Pick<KanbanCard, "cardId" | "threadId" | "column">,
): boolean {
  return card.column === "draft" && card.cardId === kanbanDraftCardId(card.threadId);
}

function toSortableTimestamp(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Status is purely derived from runtime state — kanban columns never override it.
 * Mirrors the sidebar status pill: approvals/input/live work and active sessions
 * count as In Progress; a thread that never ran a turn is a Draft; settled
 * threads land in Done.
 */
export function deriveKanbanColumn(thread: SidebarThreadSummary): KanbanColumnKey {
  // Pending requests whose session died (crash, close) are unanswerable — they
  // must not pin the thread to In Progress forever.
  const hasActionablePendingRequests =
    (thread.hasPendingApprovals || thread.hasPendingUserInput) &&
    canSessionAnswerPendingRequests(thread.session);
  if (hasActionablePendingRequests || thread.hasLiveTailWork) {
    return "inProgress";
  }
  // A requested turn that has not produced startedAt yet is still live work.
  if (thread.latestTurn?.state === "running") {
    return "inProgress";
  }
  if (hasLiveLatestTurn(thread.latestTurn, thread.session)) {
    return "inProgress";
  }
  if (thread.session?.status === "connecting") {
    return "inProgress";
  }
  if (thread.session?.status === "running" && thread.latestTurn === null) {
    return "inProgress";
  }
  if (thread.latestTurn === null) {
    return "draft";
  }
  return "done";
}

function resolveThreadCardTimestamp(
  thread: SidebarThreadSummary,
  column: KanbanColumnKey,
): string | null {
  if (column === "done" && thread.latestTurn?.completedAt) {
    return thread.latestTurn.completedAt;
  }
  if (column === "inProgress") {
    const liveTimestamp = thread.latestTurn?.startedAt ?? thread.latestTurn?.requestedAt ?? null;
    if (liveTimestamp) {
      return liveTimestamp;
    }
  }
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt ?? null;
}

function resolveComposerDraft(
  composerDraftByThreadId: BuildKanbanBoardInput["composerDraftByThreadId"],
  threadId: ThreadId,
): { prompt: string; hasAttachments: boolean; provider: ProviderKind | null } {
  const snapshot = composerDraftByThreadId[threadId];
  return {
    prompt: snapshot?.prompt.trim() ?? "",
    hasAttachments: snapshot?.hasAttachments ?? false,
    provider: snapshot?.provider ?? null,
  };
}

function buildThreadCard(
  thread: SidebarThreadSummary,
  composerDraftByThreadId: BuildKanbanBoardInput["composerDraftByThreadId"],
  isTerminal: boolean,
): KanbanCard {
  const column = deriveKanbanColumn(thread);
  const composerDraft = resolveComposerDraft(composerDraftByThreadId, thread.id);
  const timestamp = resolveThreadCardTimestamp(thread, column);
  const threadProvider = isTerminal
    ? null
    : (thread.session?.provider ?? thread.modelSelection.provider);
  const activeWorkStartedAt =
    column === "inProgress"
      ? deriveActiveWorkStartedAt(thread.latestTurn, thread.session, timestamp)
      : null;
  return {
    cardId: kanbanThreadCardId(thread.id),
    threadId: thread.id,
    projectId: thread.projectId,
    column,
    title: thread.title,
    provider:
      column === "draft" && composerDraft.provider ? composerDraft.provider : threadProvider,
    isTerminal,
    branch: thread.branch,
    envMode: thread.envMode ?? null,
    worktreePath: thread.worktreePath,
    thread,
    draftPrompt: column === "draft" ? composerDraft.prompt : "",
    draftHasAttachments: column === "draft" ? composerDraft.hasAttachments : false,
    sortTimestamp: toSortableTimestamp(timestamp) ?? Number.NEGATIVE_INFINITY,
    timestamp,
    activeWorkStartedAt,
    isOptimisticDispatch: false,
  };
}

/**
 * A settled thread with an unsent composer prompt also surfaces that prompt as a
 * draft card ("drafted prompt per chat"); dropping it on In Progress dispatches a
 * new turn on the existing thread.
 */
function buildUnsentPromptCard(
  thread: SidebarThreadSummary,
  composerDraftByThreadId: BuildKanbanBoardInput["composerDraftByThreadId"],
  isTerminal: boolean,
): KanbanCard | null {
  const composerDraft = resolveComposerDraft(composerDraftByThreadId, thread.id);
  if (composerDraft.prompt.length === 0 && !composerDraft.hasAttachments) {
    return null;
  }
  const titleSeed = composerDraft.prompt.length > 0 ? composerDraft.prompt : "Attached references";
  const threadProvider = isTerminal
    ? null
    : (thread.session?.provider ?? thread.modelSelection.provider);
  return {
    cardId: kanbanDraftCardId(thread.id),
    threadId: thread.id,
    projectId: thread.projectId,
    column: "draft",
    title: buildPromptThreadTitleFallback(titleSeed),
    provider: composerDraft.provider ?? threadProvider,
    isTerminal,
    branch: thread.branch,
    envMode: thread.envMode ?? null,
    worktreePath: thread.worktreePath,
    thread,
    draftPrompt: composerDraft.prompt,
    draftHasAttachments: composerDraft.hasAttachments,
    sortTimestamp:
      toSortableTimestamp(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt) ??
      Number.NEGATIVE_INFINITY,
    timestamp: thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt ?? null,
    activeWorkStartedAt: null,
    isOptimisticDispatch: false,
  };
}

function buildLocalDraftCard(
  draftThread: KanbanDraftThreadSnapshot,
  composerDraftByThreadId: BuildKanbanBoardInput["composerDraftByThreadId"],
): KanbanCard {
  const composerDraft = resolveComposerDraft(composerDraftByThreadId, draftThread.threadId);
  return {
    cardId: kanbanDraftCardId(draftThread.threadId),
    threadId: draftThread.threadId,
    projectId: draftThread.projectId,
    column: "draft",
    title:
      composerDraft.prompt.length > 0
        ? buildPromptThreadTitleFallback(composerDraft.prompt)
        : composerDraft.hasAttachments
          ? "Attached references"
          : KANBAN_FALLBACK_DRAFT_TITLE,
    provider: composerDraft.provider,
    isTerminal: false,
    branch: draftThread.branch,
    envMode: draftThread.envMode ?? null,
    worktreePath: draftThread.worktreePath ?? null,
    thread: null,
    draftPrompt: composerDraft.prompt,
    draftHasAttachments: composerDraft.hasAttachments,
    sortTimestamp: toSortableTimestamp(draftThread.createdAt) ?? Number.NEGATIVE_INFINITY,
    timestamp: draftThread.createdAt,
    activeWorkStartedAt: null,
    isOptimisticDispatch: false,
  };
}

/**
 * Re-homes a draft/done card into In Progress for the optimistic dispatch window.
 * The drafted prompt is already consumed by the dispatch, so draft affordances drop;
 * the drop time becomes the recency key so fresh dispatches sort on top.
 */
function forceOptimisticInProgressCard(
  card: KanbanCard,
  entry: KanbanOptimisticDispatchSnapshot,
): KanbanCard {
  return {
    ...card,
    column: "inProgress",
    isOptimisticDispatch: true,
    title:
      card.title === KANBAN_FALLBACK_DRAFT_TITLE && entry.title.length > 0
        ? entry.title
        : card.title,
    draftPrompt: "",
    draftHasAttachments: false,
    sortTimestamp: entry.droppedAtMs,
    timestamp: null,
    activeWorkStartedAt: new Date(entry.droppedAtMs).toISOString(),
  };
}

/**
 * Promotion-gap card: the local draft is already promoted (and its composer prompt
 * cleared) but the durable thread has not reached the client store yet. Built purely
 * from the dispatch snapshot so the task never vanishes mid-flight.
 */
function buildSyntheticOptimisticCard(
  threadId: ThreadId,
  entry: KanbanOptimisticDispatchSnapshot,
): KanbanCard {
  return {
    cardId: kanbanThreadCardId(threadId),
    threadId,
    projectId: entry.projectId,
    column: "inProgress",
    title: entry.title,
    provider: entry.provider,
    isTerminal: false,
    branch: null,
    envMode: null,
    worktreePath: null,
    thread: null,
    draftPrompt: "",
    draftHasAttachments: false,
    sortTimestamp: entry.droppedAtMs,
    timestamp: null,
    activeWorkStartedAt: new Date(entry.droppedAtMs).toISOString(),
    isOptimisticDispatch: true,
  };
}

export type KanbanOptimisticDispatchOutcome = "pending" | "settled" | "failed";

/**
 * How runtime state relates to an optimistic dispatch:
 * - "settled": the dispatch produced visible runtime state — the thread derives
 *   In Progress, or a turn other than the dispatch-time baseline exists (covers
 *   turns that settle faster than the board observes the running state).
 * - "failed": the provider reported a session error after the drop without ever
 *   producing a turn — revert the card now instead of waiting for expiry.
 * - "pending": no signal yet; keep the overlay.
 */
export function resolveOptimisticDispatchOutcome(
  entry: Pick<KanbanOptimisticDispatchSnapshot, "baselineTurnId" | "droppedAtMs">,
  thread: SidebarThreadSummary,
): KanbanOptimisticDispatchOutcome {
  if ((thread.latestTurn?.turnId ?? null) !== entry.baselineTurnId) {
    return "settled";
  }
  // A "connecting" session is the pre-init signal the server now emits before
  // the provider spawns. It must NOT settle the entry: provider init can still
  // fail, and settling here would skip the "failed" toast when the error event
  // follows. The board already renders the card In Progress from derived state
  // during this window, so the entry has no visual effect — it only keeps
  // watching for the failure.
  if (deriveKanbanColumn(thread) === "inProgress" && thread.session?.status !== "connecting") {
    return "settled";
  }
  // A session that errored or closed after the drop without producing a turn
  // means the dispatch never started (provider failure, manual stop mid-init) —
  // revert now instead of waiting out the expiry window. The timestamp guard
  // keeps stale terminal states from an earlier run from reverting a fresh
  // dispatch: only transitions at/after the drop count.
  const sessionStatus = thread.session?.status;
  if (sessionStatus === "error" || sessionStatus === "closed") {
    const endedAtMs = Date.parse(thread.session?.updatedAt ?? "");
    if (Number.isFinite(endedAtMs) && endedAtMs >= entry.droppedAtMs) {
      return "failed";
    }
  }
  return "pending";
}

function compareByRecencyDesc(left: KanbanCard, right: KanbanCard): number {
  if (right.sortTimestamp !== left.sortTimestamp) {
    return right.sortTimestamp > left.sortTimestamp ? 1 : -1;
  }
  return right.cardId.localeCompare(left.cardId);
}

/**
 * Applies the persisted manual order to recency-sorted draft cards. Cards present
 * in the manual order keep that relative order and lead the column; unknown cards
 * (created after the last manual drag) keep their recency order behind them.
 */
export function orderDraftCards(
  cards: readonly KanbanCard[],
  manualOrder: readonly string[] | undefined,
): KanbanCard[] {
  const recencySorted = cards.toSorted(compareByRecencyDesc);
  if (!manualOrder || manualOrder.length === 0) {
    return recencySorted;
  }
  const manualIndexByCardId = new Map<string, number>();
  for (const [index, cardId] of manualOrder.entries()) {
    if (!manualIndexByCardId.has(cardId)) {
      manualIndexByCardId.set(cardId, index);
    }
  }
  return recencySorted.toSorted((left, right) => {
    const leftIndex = manualIndexByCardId.get(left.cardId);
    const rightIndex = manualIndexByCardId.get(right.cardId);
    if (leftIndex !== undefined && rightIndex !== undefined) {
      return leftIndex - rightIndex;
    }
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return 0;
  });
}

/** Reorders the visible draft column after a drag; returns null when nothing moved. */
export function reorderDraftCardIds(
  visibleCardIds: readonly string[],
  activeCardId: string,
  overCardId: string,
): string[] | null {
  const fromIndex = visibleCardIds.indexOf(activeCardId);
  const toIndex = visibleCardIds.indexOf(overCardId);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
    return null;
  }
  const next = [...visibleCardIds];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) {
    return null;
  }
  next.splice(toIndex, 0, moved);
  return next;
}

export function buildKanbanBoard(input: BuildKanbanBoardInput): KanbanBoard {
  const threadIds = new Set<string>();
  const cardsByProjectId = new Map<
    ProjectId,
    { draft: KanbanCard[]; inProgress: KanbanCard[]; done: KanbanCard[] }
  >();
  const knownProjectIds = new Set<string>(input.projects.map((project) => project.id));
  const optimisticDispatchByThreadId = input.optimisticDispatchByThreadId ?? {};
  const handledOptimisticThreadIds = new Set<string>();

  const resolveBoardProjectId = (projectId: ProjectId): ProjectId =>
    input.projectIdAliases?.[projectId] ?? projectId;

  const bucketFor = (projectId: ProjectId) => {
    let bucket = cardsByProjectId.get(projectId);
    if (!bucket) {
      bucket = { draft: [], inProgress: [], done: [] };
      cardsByProjectId.set(projectId, bucket);
    }
    return bucket;
  };

  for (const thread of input.threads) {
    const boardProjectId = resolveBoardProjectId(thread.projectId);
    if (!knownProjectIds.has(boardProjectId)) {
      continue;
    }
    threadIds.add(thread.id);
    const bucket = bucketFor(boardProjectId);
    const isTerminal = input.terminalEntryThreadIds?.has(thread.id) ?? false;
    const card = buildThreadCard(thread, input.composerDraftByThreadId, isTerminal);
    const optimisticEntry = optimisticDispatchByThreadId[thread.id];
    if (optimisticEntry) {
      handledOptimisticThreadIds.add(thread.id);
      if (card.column !== "inProgress") {
        // A drop already dispatched this thread's prompt; show it In Progress while
        // the first runtime signal is in flight and suppress its draft/done duplicates
        // so the board matches the state the dispatch is about to produce.
        bucket.inProgress.push(forceOptimisticInProgressCard(card, optimisticEntry));
        continue;
      }
    }
    bucket[card.column].push(card);
    if (card.column === "done") {
      const unsentPromptCard = buildUnsentPromptCard(
        thread,
        input.composerDraftByThreadId,
        isTerminal,
      );
      if (unsentPromptCard) {
        bucket.draft.push(unsentPromptCard);
      }
    }
  }

  for (const draftThread of input.draftThreads) {
    const boardProjectId = resolveBoardProjectId(draftThread.projectId);
    // Skip drafts that were already promoted into real threads or live in unknown projects.
    if (threadIds.has(draftThread.threadId) || !knownProjectIds.has(boardProjectId)) {
      continue;
    }
    const optimisticEntry = optimisticDispatchByThreadId[draftThread.threadId];
    // Only drafts with actual content earn a card; projects accumulate empty
    // sticky drafts from routine navigation and those are pure noise here. A
    // dispatched draft is exempt — the dispatch clears the composer prompt before
    // the durable thread arrives, and the card must survive that gap.
    const composerDraft = resolveComposerDraft(input.composerDraftByThreadId, draftThread.threadId);
    if (!optimisticEntry && composerDraft.prompt.length === 0 && !composerDraft.hasAttachments) {
      continue;
    }
    const card = buildLocalDraftCard(draftThread, input.composerDraftByThreadId);
    if (optimisticEntry) {
      handledOptimisticThreadIds.add(draftThread.threadId);
      bucketFor(boardProjectId).inProgress.push(
        forceOptimisticInProgressCard(card, optimisticEntry),
      );
      continue;
    }
    bucketFor(boardProjectId).draft.push(card);
  }

  // Promotion gap: the draft snapshot is gone (promoted, composer cleared) but the
  // durable thread has not reached the store yet — synthesize the In Progress card.
  for (const [threadId, optimisticEntry] of Object.entries(optimisticDispatchByThreadId)) {
    if (!optimisticEntry || handledOptimisticThreadIds.has(threadId)) {
      continue;
    }
    const boardProjectId = resolveBoardProjectId(optimisticEntry.projectId);
    if (!knownProjectIds.has(boardProjectId)) {
      continue;
    }
    bucketFor(boardProjectId).inProgress.push(
      buildSyntheticOptimisticCard(threadId as ThreadId, optimisticEntry),
    );
  }

  let totalCount = 0;
  const projects = input.projects.map((project): KanbanProjectBoard => {
    const bucket = cardsByProjectId.get(project.id) ?? { draft: [], inProgress: [], done: [] };
    const draft = orderDraftCards(bucket.draft, input.draftOrderByProjectId[project.id]);
    const inProgress = bucket.inProgress.toSorted(compareByRecencyDesc);
    const done = bucket.done.toSorted(compareByRecencyDesc);
    const projectTotalCount = draft.length + inProgress.length + done.length;
    totalCount += projectTotalCount;
    return {
      projectId: project.id,
      projectName: project.name,
      projectKind: project.kind,
      draft,
      inProgress,
      done,
      totalCount: projectTotalCount,
    };
  });

  return { projects, totalCount };
}

/** Overview project columns list cards In Progress → Draft → Done. */
export function flattenProjectBoardForOverview(board: KanbanProjectBoard): KanbanCard[] {
  return [...board.inProgress, ...board.draft, ...board.done];
}

const OVERVIEW_RENDER_CAP = 20;

/**
 * The capped card list an overview project column actually renders, plus the count folded
 * behind its "Show more" affordance. Shared with the board root so per-card data (PR
 * badges) is fetched for exactly the rendered set.
 */
export function overviewVisibleKanbanCards(board: KanbanProjectBoard): {
  visibleCards: KanbanCard[];
  hiddenCount: number;
} {
  const cards = flattenProjectBoardForOverview(board);
  const visibleCards =
    cards.length > OVERVIEW_RENDER_CAP ? cards.slice(0, OVERVIEW_RENDER_CAP) : cards;
  return { visibleCards, hiddenCount: cards.length - visibleCards.length };
}

export type KanbanDraftOpenThreadReason = "not-draft" | "empty" | "worktree-pending";
export type KanbanDraftDropAction = "dispatch" | "open-thread";

/** Explains why a draft card must fall back to the canonical chat composer flow. */
export function resolveKanbanDraftOpenThreadReason(
  card: KanbanCard,
): KanbanDraftOpenThreadReason | null {
  if (card.column !== "draft") {
    return "not-draft";
  }
  if (card.draftPrompt.length === 0 && !card.draftHasAttachments) {
    return "empty";
  }
  if (isPendingThreadWorktree({ envMode: card.envMode, worktreePath: card.worktreePath })) {
    return "worktree-pending";
  }
  return null;
}

/**
 * Resolves what dropping a draft card on In Progress should do: dispatch the
 * drafted prompt, or open the chat when the board cannot dispatch it faithfully
 * (no prompt, or worktree preflight that only the composer owns).
 */
export function resolveDraftDropAction(card: KanbanCard): KanbanDraftDropAction {
  return resolveKanbanDraftOpenThreadReason(card) ? "open-thread" : "dispatch";
}
