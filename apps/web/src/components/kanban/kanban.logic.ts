// FILE: kanban.logic.ts
// Purpose: Pure derivation of the kanban control-center board (columns, cards, ordering)
//          from sidebar thread summaries and composer draft snapshots.
// Layer: UI logic (no React, no stores) so the board math stays unit-testable.
// Exports: deriveKanbanColumn, buildKanbanBoard, ordering + drop-action helpers.

import type { ProjectId, ProviderKind, ThreadEnvironmentMode, ThreadId } from "@synara/contracts";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";
import {
  KANBAN_ATTENTION_LABELS,
  KANBAN_COLUMN_V2_LABELS,
  deriveKanbanAttention as deriveKanbanAttentionShared,
  deriveKanbanColumnV2 as deriveKanbanColumnV2Shared,
  hasKanbanLiveWork as hasKanbanLiveWorkShared,
  type KanbanAttentionFlag,
  type KanbanColumnV2Key,
  type KanbanThreadDerivationInput,
} from "@synara/shared/kanban";
import { isPendingThreadWorktree } from "@synara/shared/threadEnvironment";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import {
  canSessionAnswerPendingRequests,
  deriveActiveWorkStartedAt,
  hasLiveLatestTurn,
} from "../../session-logic";
import type { Project, SidebarThreadSummary } from "../../types";

/**
 * Web column vocabulary. The classic path speaks draft/inProgress/done; the v2
 * path (S1-P5) additionally renders `awaitingYou`. Classic derivation and label
 * maps stay untouched — this is vocabulary for the v2 boards only. `awaitingYou`
 * resolves from the shared v2 label map when a consumer spans both vocabularies.
 */
export type KanbanColumnKey = KanbanClassicColumnKey | "awaitingYou";

/** Classic 3-column vocabulary — `KANBAN_COLUMN_LABELS` stays scoped to it. */
export type KanbanClassicColumnKey = "draft" | "inProgress" | "done";

export const KANBAN_COLUMN_LABELS: Record<KanbanClassicColumnKey, string> = {
  draft: "Draft",
  inProgress: "In Progress",
  done: "Done",
};

/**
 * Display label for a kanban column, spanning both vocabularies. The classic map
 * stays scoped to the classic keys; the v2-specific label resolves from the
 * shared v2 map (`KANBAN_COLUMN_V2_LABELS`) so the copy never re-literalizes.
 */
export function resolveKanbanColumnLabel(column: KanbanColumnKey): string {
  if (column === "awaitingYou") {
    return KANBAN_COLUMN_V2_LABELS.awaitingYou;
  }
  return KANBAN_COLUMN_LABELS[column];
}

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
  /**
   * v2-path attention flags (failed / stuck / awaiting-approval / awaiting-input /
   * needs-review). Present only for v2 boards; classic cards never set it.
   */
  attention?: KanbanAttentionFlag[] | undefined;
  /**
   * v2-path red-pill copy for every `attention` flag (the renderer shows up to
   * two). Present only for v2 boards; undefined for classic so the classic pill
   * renderer is untouched.
   */
  attentionLabels?: string[] | undefined;
  /** needs-review (open PR per the live PR view) — set on v2-path thread cards. */
  needsReview?: boolean | undefined;
}

export interface KanbanProjectBoard {
  projectId: ProjectId;
  projectName: string;
  projectKind: Project["kind"];
  draft: KanbanCard[];
  inProgress: KanbanCard[];
  /** v2-path attention column — always present, empty in classic mode. */
  awaitingYou: KanbanCard[];
  done: KanbanCard[];
  totalCount: number;
  /**
   * Cards folded behind a per-column render cap (needs-review filter, S1-P8).
   * Classic/unfiltered boards never exceed their column arrays, so this is 0.
   */
  hiddenCount: number;
}

export interface KanbanBoard {
  projects: KanbanProjectBoard[];
  totalCount: number;
}

/**
 * v2-path board build options. The derivation and the injected now-tick make the
 * board attention-aware (awaiting-you column + attention pills); `needsReview`
 * scopes the per-card open-PR flag (S1-P8) and `isNeedsReviewActive` gates the
 * filtered view.
 */
export interface KanbanV2BuildOptions {
  /** Injected wall-clock tick (epoch ms) from the board hook for stuck staleness. */
  now: number;
  /** Per-thread open-PR view (S1-P8) — hidden when omitted. */
  needsReviewByThreadId?: Readonly<Record<string, boolean | undefined>>;
  /** Whether the needs-review filter is currently on (S1-P8). */
  isNeedsReviewActive?: boolean;
  /**
   * Drop the per-column needs-review render cap so the current v2 build renders
   * every card behind the fold. The reveal affordance drives this — the header
   * count stays the pre-cap total either way (H1).
   */
  uncapped?: boolean;
  /**
   * Durable last-activity stamp per thread (epoch ms), keyed by thread id. The
   * heartbeat takes the max of session/thread stamps and this so a busy-but-quiet
   * streaming turn never reads as stale even though `SidebarThreadSummary.updatedAt`
   * is frozen on the streaming hot path (F1). Sourced from the durable thread
   * shell's `updatedAt`, which advances per appended message.
   */
  lastActivityTimestampMsByThreadId?: Readonly<Record<string, number | null>>;
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
export function deriveKanbanColumn(thread: SidebarThreadSummary): KanbanClassicColumnKey {
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

/** Projection of a `SidebarThreadSummary` into the shared structural derivation input. */
function toKanbanThreadDerivationInput(
  thread: SidebarThreadSummary,
  lastActivityTimestampMs?: number | null,
): KanbanThreadDerivationInput {
  return {
    latestTurn: thread.latestTurn
      ? {
          state: thread.latestTurn.state,
          startedAt: thread.latestTurn.startedAt,
          completedAt: thread.latestTurn.completedAt,
        }
      : null,
    session: thread.session
      ? {
          status: thread.session.orchestrationStatus,
          updatedAt: thread.session.updatedAt,
          lastError: thread.session.lastError ?? null,
        }
      : null,
    // The thread stamp advances per appended message; the shared heartbeat takes
    // the later of it and `session.updatedAt` so a busy-but-quiet turn never
    // reads as stale (mirrors providerRuntimeReconciliation.projectedLifecycleAgeMs).
    threadUpdatedAt: thread.updatedAt ?? null,
    // `SidebarThreadSummary.updatedAt` freezes while the summary build is skipped
    // on the streaming hot path, so feed the durable last-activity stamp as well —
    // the heartbeat then stays live on every delta (F1).
    lastActivityTimestampMs: lastActivityTimestampMs ?? null,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasLiveTailWork: thread.hasLiveTailWork,
  };
}

/**
 * v2 clock-gate (C2): whether this thread could age into a stuck state, so the
 * board only ticks the wall clock while a live-work candidate exists. This is
 * the shared `hasKanbanLiveWork` over the same structural input the derivation
 * uses — one liveness definition for the gate and the column/attention math.
 * A wedged `starting` session, a running session with no settled turn, and a
 * live-tail-only thread all count as live, so they tick and can earn a stuck
 * pill; a fresh-but-idle thread does not.
 */
export function hasKanbanAttentionCandidate(
  thread: SidebarThreadSummary,
  lastActivityTimestampMs?: number | null,
): boolean {
  return hasKanbanLiveWorkShared(toKanbanThreadDerivationInput(thread, lastActivityTimestampMs));
}

/**
 * Needs-review pill refinement (H2): the pill and the on-card PR chip must never
 * contradict. The board seeds `needs-review` from `lastKnownPr` on first paint,
 * while the chip renders the live resolved PR row. When a live row exists (open /
 * merged / closed) it is the source of truth — a merged PR drops the pill; the
 * persisted `lastKnownPr` stays the seed only for rows the live lookup has not
 * resolved yet. Pure so the pill logic is unit-testable and identical on every
 * surface that renders attention pills.
 *
 * Operates on RAW flag identifiers (`KanbanAttentionFlag`), which is the domain
 * `card.attention` carries; display copy is mapped after refinement so the
 * comparison never drifts from the flag set.
 *
 * State contract: `undefined` means "not yet resolved" (keep the initial pill);
 * `null` means "live resolution settled with no open PR" (drop it); `"open" |
 * "closed" | "merged"` is the live row state.
 */
export function refineAttentionFlagsForLivePr(
  attentionFlags: readonly KanbanAttentionFlag[] | undefined,
  livePrState: "open" | "closed" | "merged" | null | undefined,
): KanbanAttentionFlag[] {
  if (!attentionFlags || attentionFlags.length === 0) {
    return [];
  }
  if (livePrState === undefined) {
    return [...attentionFlags];
  }
  const liveNeedsReview = livePrState === "open";
  return attentionFlags.filter((flag) => flag !== "needs-review" || liveNeedsReview);
}

/**
 * v2-path column adapter. The web ↔ shared mapping lives only here: it projects
 * the web thread summary into the shared structural input and delegates to
 * `@synara/shared/kanban`. `now` is the injected ticking clock from the board
 * hook (S1-P5); without it the derivation never consults staleness. Typed as the
 * shared `KanbanColumnV2Key` so `awaitingYou` cannot leak into the classic path.
 */
export function deriveKanbanColumnV2(
  thread: SidebarThreadSummary,
  now?: number,
  lastActivityTimestampMs?: number | null,
): KanbanColumnV2Key {
  const input = toKanbanThreadDerivationInput(thread, lastActivityTimestampMs);
  return now !== undefined
    ? deriveKanbanColumnV2Shared(input, { now })
    : deriveKanbanColumnV2Shared(input);
}

/**
 * v2-path attention projection for a thread card: the shared flag set plus the
 * display label map. `now` feeds the stuck staleness check. `needsReview` is the
 * per-thread open-PR view (S1-P8) that the shared module also turns into a pill.
 */
export function deriveKanbanCardAttention(
  thread: SidebarThreadSummary,
  opts: {
    now: number;
    needsReview?: boolean;
    lastActivityTimestampMs?: number | null;
  },
): { attention: KanbanAttentionFlag[]; attentionLabels: string[] } {
  const input = toKanbanThreadDerivationInput(thread, opts.lastActivityTimestampMs);
  const attention = deriveKanbanAttentionShared(input, {
    now: opts.now,
    needsReview: opts.needsReview ?? false,
  });
  return {
    attention,
    attentionLabels: attention.map((flag) => KANBAN_ATTENTION_LABELS[flag]),
  };
}

function resolveThreadCardTimestamp(
  thread: SidebarThreadSummary,
  column: KanbanColumnKey,
): string | null {
  if (column === "done" && thread.latestTurn?.completedAt) {
    return thread.latestTurn.completedAt;
  }
  if (column === "inProgress" || column === "awaitingYou") {
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
  v2?: KanbanV2BuildOptions,
): KanbanCard {
  const lastActivityTimestampMs = v2?.lastActivityTimestampMsByThreadId?.[thread.id] ?? null;
  const column = v2
    ? deriveKanbanColumnV2(thread, v2.now, lastActivityTimestampMs)
    : deriveKanbanColumn(thread);
  const composerDraft = resolveComposerDraft(composerDraftByThreadId, thread.id);
  const timestamp = resolveThreadCardTimestamp(thread, column);
  const threadProvider = isTerminal
    ? null
    : (thread.session?.provider ?? thread.modelSelection.provider);
  const attentionFields = v2
    ? deriveKanbanCardAttention(thread, {
        now: v2.now,
        needsReview: v2.needsReviewByThreadId?.[thread.id] ?? false,
        lastActivityTimestampMs,
      })
    : null;
  // In Progress cards and Awaiting-you cards whose reason is staleness (stuck)
  // are both live work: the elapsed label tracks their active stretch. Other
  // Awaiting-you reasons (pending/failed) center on the human, not the work.
  const isAwaitingStuck =
    column === "awaitingYou" && attentionFields?.attention.includes("stuck") === true;
  const activeWorkStartedAt =
    column === "inProgress" || isAwaitingStuck
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
    ...(v2
      ? {
          attention: attentionFields?.attention ?? [],
          attentionLabels: attentionFields?.attentionLabels ?? [],
          needsReview: v2.needsReviewByThreadId?.[thread.id] ?? false,
        }
      : {}),
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
 * Resolve whether an expired optimistic dispatch should surface a revert toast.
 * A thread that left the display set (gone from the board/sidebar projection)
 * while its dispatch was still on the wire cannot be confirmed as reverting
 * here — stay silent rather than claim a revert we can't verify (H5). A thread
 * that still derives In Progress (slow provider init) also stays silent: the
 * card is already correct from derived state, so a revert toast would be a lie.
 */
export function shouldToastForExpiredDispatch(thread: SidebarThreadSummary | undefined): boolean {
  return thread !== undefined && deriveKanbanColumn(thread) !== "inProgress";
}

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

interface KanbanProjectBuckets {
  draft: KanbanCard[];
  inProgress: KanbanCard[];
  awaitingYou: KanbanCard[];
  done: KanbanCard[];
}

const EMPTY_BUCKETS: KanbanProjectBuckets = {
  draft: [],
  inProgress: [],
  awaitingYou: [],
  done: [],
};

/** Rows per column kept in the v2 needs-review filtered view (S1-P8). */
export const KANBAN_NEEDS_REVIEW_CAP = 30;

export function buildKanbanBoard(
  input: BuildKanbanBoardInput,
  v2?: KanbanV2BuildOptions,
): KanbanBoard {
  const threadIds = new Set<string>();
  const cardsByProjectId = new Map<ProjectId, KanbanProjectBuckets>();
  const knownProjectIds = new Set<string>(input.projects.map((project) => project.id));
  const optimisticDispatchByThreadId = input.optimisticDispatchByThreadId ?? {};
  const handledOptimisticThreadIds = new Set<string>();

  const resolveBoardProjectId = (projectId: ProjectId): ProjectId =>
    input.projectIdAliases?.[projectId] ?? projectId;

  const bucketFor = (projectId: ProjectId): KanbanProjectBuckets => {
    let bucket = cardsByProjectId.get(projectId);
    if (!bucket) {
      bucket = { draft: [], inProgress: [], awaitingYou: [], done: [] };
      cardsByProjectId.set(projectId, bucket);
    }
    return bucket;
  };

  const needsReviewActive = v2?.isNeedsReviewActive === true;
  const cardPassesNeedsReviewFilter = (card: KanbanCard): boolean =>
    !needsReviewActive || card.needsReview === true;

  for (const thread of input.threads) {
    const boardProjectId = resolveBoardProjectId(thread.projectId);
    if (!knownProjectIds.has(boardProjectId)) {
      continue;
    }
    threadIds.add(thread.id);
    const bucket = bucketFor(boardProjectId);
    const isTerminal = input.terminalEntryThreadIds?.has(thread.id) ?? false;
    const card = buildThreadCard(thread, input.composerDraftByThreadId, isTerminal, v2);
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
    if (!cardPassesNeedsReviewFilter(card)) {
      continue;
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
    const bucket = cardsByProjectId.get(project.id) ?? EMPTY_BUCKETS;
    // In the needs-review filtered view (S1-P8) each column is capped at
    // KANBAN_NEEDS_REVIEW_CAP rows so live PR lookup stays bounded even on huge
    // boards. The unfiltered view is uncapped — attention surfaces every card.
    // When the user reveals the folded tail, the cap drops for this build so
    // every review card renders (H1).
    const cap = needsReviewActive && !v2?.uncapped ? KANBAN_NEEDS_REVIEW_CAP : Infinity;
    const draft = orderDraftCards(bucket.draft, input.draftOrderByProjectId[project.id]).slice(
      0,
      cap,
    );
    const inProgress = bucket.inProgress.toSorted(compareByRecencyDesc).slice(0, cap);
    const awaitingYou = bucket.awaitingYou.toSorted(compareByRecencyDesc).slice(0, cap);
    const done = bucket.done.toSorted(compareByRecencyDesc).slice(0, cap);
    // The header count is the true pre-cap total of cards matching the current
    // filter — the capped columns only narrow what renders (H1).
    const projectTotalCount =
      bucket.draft.length +
      bucket.inProgress.length +
      bucket.awaitingYou.length +
      bucket.done.length;
    totalCount += projectTotalCount;
    return {
      projectId: project.id,
      projectName: project.name,
      projectKind: project.kind,
      draft,
      inProgress,
      awaitingYou,
      done,
      totalCount: projectTotalCount,
      // v2 needs-review views expose the folded remainder behind their cap.
      hiddenCount: Math.max(
        0,
        bucket.draft.length -
          draft.length +
          (bucket.inProgress.length - inProgress.length) +
          (bucket.awaitingYou.length - awaitingYou.length) +
          (bucket.done.length - done.length),
      ),
    };
  });

  return { projects, totalCount };
}

/**
 * Whether the board-level needs-review reveal affordance renders (H1). It stays
 * reachable once the user has revealed the fold — a revealed board with no
 * hidden cards must still offer "Show fewer" so the fold can be re-closed even
 * after the filter count drops.
 */
export function shouldShowReviewFoldToggle(hasRevealed: boolean, hiddenCount: number): boolean {
  return hasRevealed || hiddenCount > 0;
}

/**
 * Button copy for the needs-review reveal: "Show N more" while there is a fold,
 * "Show fewer" once the tail is revealed.
 */
export function resolveReviewFoldToggleLabel(hasRevealed: boolean, hiddenCount: number): string {
  return hasRevealed ? "Show fewer" : `Show ${hiddenCount} more`;
}

const OVERVIEW_RENDER_CAP = 20;

/**
 * The capped card list an overview project column actually renders, plus the count folded
 * behind its "Show more" affordance. Shared with the board root so per-card data (PR
 * badges) is fetched for exactly the rendered set. The cap applies PER COLUMN before
 * flattening, so attention cards (In Progress / Awaiting you) are never pushed off the
 * visible window by a Done-heavy tail — the exact cards the attention-first overview
 * exists to surface (H3). Classic flattens In Progress → Draft → Done; v2 routes
 * Awaiting you after In Progress.
 */
export function overviewVisibleKanbanCards(
  board: KanbanProjectBoard,
  v2?: boolean,
): {
  visibleCards: KanbanCard[];
  hiddenCount: number;
} {
  const cappedDraft = board.draft.slice(0, OVERVIEW_RENDER_CAP);
  const cappedInProgress = board.inProgress.slice(0, OVERVIEW_RENDER_CAP);
  const cappedAwaitingYou = board.awaitingYou.slice(0, OVERVIEW_RENDER_CAP);
  const cappedDone = board.done.slice(0, OVERVIEW_RENDER_CAP);
  const visibleCards = v2
    ? [...cappedInProgress, ...cappedAwaitingYou, ...cappedDraft, ...cappedDone]
    : [...cappedInProgress, ...cappedDraft, ...cappedDone];
  const hiddenCount =
    board.draft.length -
    cappedDraft.length +
    (board.inProgress.length - cappedInProgress.length) +
    (board.awaitingYou.length - cappedAwaitingYou.length) +
    (board.done.length - cappedDone.length) +
    // Cards the needs-review filter already folded behind its 30-row column cap
    // are also invisible on the overview and must count toward its affordance.
    board.hiddenCount;
  return { visibleCards, hiddenCount };
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
