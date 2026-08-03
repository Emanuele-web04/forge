import {
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ModelSlug,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ProviderRequestKind,
  type RuntimeMode,
  type ServerProviderAuthStatus,
  type ThreadId as ThreadIdType,
} from "@synara/contracts";
import { normalizeModelSlug } from "@synara/shared/model";
import { buildSynaraBranchName } from "@synara/shared/git";
import { isGenericChatThreadTitle } from "@synara/shared/chatThreads";
import { isGenericTerminalThreadTitle } from "@synara/shared/terminalThreads";
import {
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type ThreadPrimarySurface,
  type TurnDiffSummary,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStepId,
} from "../types";
import { type DraftThreadState } from "../composerDraftStore";
import { Schema } from "effect";
import {
  filterTerminalContextsWithText,
  deriveDisplayedUserMessageState,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import { filterPastedTextsWithText, type PastedTextDraft } from "../lib/composerPastedText";
import {
  humanizeSubagentStatus,
  normalizeSubagentStatusKind,
  resolveSubagentPresentationForThread,
} from "../lib/subagentPresentation";
import {
  hasLiveTurnTailWork,
  isProviderFileEditWorkLogEntry,
  type WorkLogEntry,
} from "../session-logic";
import { localSubagentThreadId } from "./ChatView.selectors";
import type { ProviderModelOption } from "../providerModelOptions";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "synara:last-invoked-script-by-project";
export const DISMISSED_PROVIDER_HEALTH_BANNERS_KEY = "synara:dismissed-provider-health-banners";
export const PROMPT_HISTORY_MAX_ENTRIES = 100;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);
export const DismissedProviderHealthBannersSchema = Schema.Array(Schema.String);

export interface PendingFileUndo {
  readonly threadId: ThreadIdType;
  // A changes card can merge several turns; one Undo reverts all of them, so the
  // request only settles once every targeted turn has settled (or one failed).
  readonly turnCounts: readonly number[];
  readonly existingFailureActivityIds: readonly string[];
}

export function hasFileUndoSettled(input: {
  readonly pending: PendingFileUndo;
  readonly thread: Pick<Thread, "id" | "turnDiffSummaries" | "activities"> | null;
}): boolean {
  if (!input.thread || input.thread.id !== input.pending.threadId) {
    return false;
  }

  const targetTurnCounts = new Set(input.pending.turnCounts);
  const targetSummaries = input.thread.turnDiffSummaries.filter(
    (summary) =>
      summary.checkpointTurnCount !== undefined &&
      targetTurnCounts.has(summary.checkpointTurnCount),
  );
  if (
    targetSummaries.length > 0 &&
    targetSummaries.every((summary) => summary.files.length === 0)
  ) {
    return true;
  }

  const existingFailureActivityIdSet = new Set(input.pending.existingFailureActivityIds);
  return input.thread.activities.some((activity) => {
    if (
      activity.kind !== "checkpoint.revert.failed" ||
      existingFailureActivityIdSet.has(activity.id) ||
      typeof activity.payload !== "object" ||
      activity.payload === null ||
      !("turnCount" in activity.payload) ||
      typeof activity.payload.turnCount !== "number"
    ) {
      return false;
    }
    return targetTurnCounts.has(activity.payload.turnCount);
  });
}

/**
 * "Always allow" (acceptForSession) only auto-approves the live provider turn.
 * Because the client is the source of truth for runtime mode (it sends it with
 * every turn), a supervised thread must also flip to full-access so the choice
 * survives idle-stop and runtime restarts. Auto is different: its AI reviewer
 * remains the durable policy, while acceptForSession applies only to the current
 * live provider session. Returns the runtime mode to persist, or null when
 * nothing changes.
 */
export function resolveRuntimeModeAfterApprovalDecision(
  currentRuntimeMode: RuntimeMode,
  decision: ProviderApprovalDecision,
  requestKind?: ProviderRequestKind,
): RuntimeMode | null {
  // Permission-profile grants are narrower than a runtime-mode override.
  // Their acceptForSession decision is persisted by the provider for only
  // that permission set and must not silently broaden the whole thread.
  if (requestKind === "permissions") {
    return null;
  }
  if (decision === "acceptForSession" && currentRuntimeMode === "approval-required") {
    return "full-access";
  }
  return null;
}

export async function commitAfterRuntimeModePersistence(input: {
  currentRuntimeMode: RuntimeMode;
  nextRuntimeMode: RuntimeMode;
  persistRuntimeMode: (mode: RuntimeMode) => Promise<boolean>;
  commit: () => void;
}): Promise<boolean> {
  if (
    input.nextRuntimeMode !== input.currentRuntimeMode &&
    !(await input.persistRuntimeMode(input.nextRuntimeMode))
  ) {
    return false;
  }
  input.commit();
  return true;
}

export interface RuntimeModePersistenceQueue {
  syncAcknowledgedMode: (mode: RuntimeMode) => void;
  persist: (
    mode: RuntimeMode,
    operation: (currentMode: RuntimeMode, nextMode: RuntimeMode) => Promise<boolean>,
  ) => Promise<boolean>;
}

/**
 * Serializes access-mode writes for one thread. Equality is checked only when a
 * queued choice starts, after earlier choices have settled, so Auto → Full
 * access → Auto cannot drop the final Auto choice against a stale render.
 */
export function createRuntimeModePersistenceQueue(
  initialMode: RuntimeMode,
): RuntimeModePersistenceQueue {
  let acknowledgedMode = initialMode;
  let pendingCount = 0;
  let tail: Promise<void> = Promise.resolve();

  return {
    syncAcknowledgedMode(mode) {
      if (pendingCount === 0) {
        acknowledgedMode = mode;
      }
    },
    persist(mode, operation) {
      pendingCount += 1;
      const result = tail.then(async () => {
        if (mode === acknowledgedMode) {
          return true;
        }
        const persisted = await operation(acknowledgedMode, mode);
        if (persisted) {
          acknowledgedMode = mode;
        }
        return persisted;
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result.finally(() => {
        pendingCount -= 1;
      });
    },
  };
}

export function modelSelectionsEqual(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null) &&
    (left.provider !== "claudeAgent" ||
      right.provider !== "claudeAgent" ||
      left.supportsAutoMode === right.supportsAutoMode)
  );
}

/**
 * Runtime-mode validation uses the canonical thread model. Persist a changed
 * model first when enabling Auto, but downgrade from Auto first so an
 * incompatible replacement model is not rejected by the old policy.
 */
export async function persistModelSelectionBeforeRuntimeMode(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentRuntimeMode: RuntimeMode;
  nextRuntimeMode: RuntimeMode;
  persistModelSelection: (selection: ModelSelection) => Promise<unknown>;
  persistRuntimeMode: (mode: RuntimeMode) => Promise<unknown>;
}): Promise<void> {
  const nextModelSelection = input.nextModelSelection;
  const modelChanged =
    nextModelSelection !== undefined &&
    !modelSelectionsEqual(input.currentModelSelection, nextModelSelection);
  const runtimeChanged = input.currentRuntimeMode !== input.nextRuntimeMode;
  const downgradesFromAuto =
    input.currentRuntimeMode === "auto" && input.nextRuntimeMode !== "auto";

  if (runtimeChanged && downgradesFromAuto) {
    await input.persistRuntimeMode(input.nextRuntimeMode);
  }
  if (modelChanged && nextModelSelection !== undefined) {
    await input.persistModelSelection(nextModelSelection);
  }
  if (runtimeChanged && !downgradesFromAuto) {
    await input.persistRuntimeMode(input.nextRuntimeMode);
  }
}

export function shouldRenderProviderHealthBanner(input: {
  threadEntryPoint: ThreadPrimarySurface;
  terminalWorkspaceTerminalTabActive: boolean;
}): boolean {
  return input.threadEntryPoint === "chat" && !input.terminalWorkspaceTerminalTabActive;
}

// Big-paste cards are sent only by the normal chat path; non-chat composer flows
// read plain editor text, so they must let Lexical insert pasted text normally.
export function shouldEnableComposerPastedTextCollapse(input: {
  isComposerApprovalState: boolean;
  hasPendingUserInput: boolean;
  showPlanFollowUpPrompt: boolean;
}): boolean {
  return (
    !input.isComposerApprovalState && !input.hasPendingUserInput && !input.showPlanFollowUpPrompt
  );
}

export function buildComposerMenuSelectionKey(input: {
  menuOpen: boolean;
  picker: string | null;
  triggerKind: string | null;
  triggerQuery: string;
  items: readonly { id: string }[];
}): string | null {
  if (!input.menuOpen) {
    return null;
  }
  const sourceKey = input.picker
    ? `picker:${input.picker}`
    : `trigger:${input.triggerKind ?? "none"}:${input.triggerQuery}`;
  return `${sourceKey}\u001f${input.items.map((item) => item.id).join("\u001e")}`;
}

export function buildTranscriptAutoFollowSignal(input: {
  readonly messageCount: number;
  readonly tailKey: string;
}): string {
  return `${input.messageCount}\u001f${input.tailKey}`;
}

export function resolveThreadArtifactWorkspaceRoot(input: {
  readonly isStudioContainer: boolean;
  readonly projectCwd: string | null;
  readonly threadWorkspaceCwd: string | null;
}): string | null {
  if (input.threadWorkspaceCwd) {
    return input.threadWorkspaceCwd;
  }
  // A normal thread can expose project files while a requested worktree is
  // still being materialized. Studio has no equivalent project-root fallback:
  // its selected working directory is the artifact boundary.
  return input.isStudioContainer ? null : input.projectCwd;
}

export interface PromptHistoryNavigationState {
  index: number;
  draft: string;
}

export type PromptHistoryDirection = "older" | "newer";

// All cursor values in prompt history navigation are EXPANDED offsets — raw
// indices into the prompt string. Collapsed composer cursors (where inline
// token chips like mentions count as a single unit) must be expanded before
// calling in and collapsed again before being applied to composer state, or
// the line-boundary math below misfires on any prompt containing a chip.
export interface PromptHistoryNavigationResult {
  handled: boolean;
  prompt: string;
  expandedCursor: number;
  state: PromptHistoryNavigationState | null;
}

export function derivePromptHistoryFromMessages(
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "source" | "text">>,
  limit: number = PROMPT_HISTORY_MAX_ENTRIES,
): string[] {
  if (limit <= 0) {
    return [];
  }
  const history: string[] = [];
  for (let index = messages.length - 1; index >= 0 && history.length < limit; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user" || (message.source ?? "native") !== "native") {
      continue;
    }
    const prompt = deriveDisplayedUserMessageState(message.text, {
      hideImageOnlyBootstrapPrompt: true,
      messageId: message.id,
    }).copyText.trim();
    if (prompt.length === 0) {
      continue;
    }
    history.push(prompt);
  }
  return history;
}

export function promptStillMatchesActiveHistoryBrowse(input: {
  state: PromptHistoryNavigationState | null;
  history: readonly string[];
  nextPrompt: string;
  appliedPrompt: string | null;
}): boolean {
  if (input.state === null) {
    return false;
  }
  const activeEntry = input.history[input.state.index] ?? null;
  return input.nextPrompt === activeEntry || input.nextPrompt === input.appliedPrompt;
}

export function shouldHandlePromptHistoryNavigationKey(input: {
  key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash";
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  menuIsActive: boolean;
  hasActivePendingProgress: boolean;
  isComposerApprovalState: boolean;
  pendingUserInputCount: number;
}): boolean {
  return (
    (input.key === "ArrowUp" || input.key === "ArrowDown") &&
    !input.metaKey &&
    !input.ctrlKey &&
    !input.altKey &&
    !input.shiftKey &&
    !input.menuIsActive &&
    !input.hasActivePendingProgress &&
    !input.isComposerApprovalState &&
    input.pendingUserInputCount === 0
  );
}

// `expandedCursor` is a raw index into `prompt` (see PromptHistoryNavigationResult).
export function isComposerCursorOnFirstLine(prompt: string, expandedCursor: number): boolean {
  const boundedCursor = Math.max(0, Math.min(prompt.length, expandedCursor));
  const firstLineEnd = prompt.indexOf("\n");
  return firstLineEnd < 0 || boundedCursor <= firstLineEnd;
}

// `expandedCursor` is a raw index into `prompt` (see PromptHistoryNavigationResult).
export function isComposerCursorOnLastLine(prompt: string, expandedCursor: number): boolean {
  const boundedCursor = Math.max(0, Math.min(prompt.length, expandedCursor));
  const lastLineStart = prompt.lastIndexOf("\n") + 1;
  return boundedCursor >= lastLineStart;
}

function expandedCursorForPromptHistoryItem(
  prompt: string,
  direction: PromptHistoryDirection,
): number {
  if (direction === "older") {
    const firstLineEnd = prompt.indexOf("\n");
    return firstLineEnd < 0 ? prompt.length : firstLineEnd;
  }
  return prompt.length;
}

export function resolvePromptHistoryNavigation(input: {
  direction: PromptHistoryDirection;
  history: readonly string[];
  currentPrompt: string;
  currentExpandedCursor: number;
  selectionCollapsed: boolean;
  state: PromptHistoryNavigationState | null;
}): PromptHistoryNavigationResult {
  const notHandled = (
    state: PromptHistoryNavigationState | null,
  ): PromptHistoryNavigationResult => ({
    handled: false,
    prompt: input.currentPrompt,
    expandedCursor: input.currentExpandedCursor,
    state,
  });
  if (!input.selectionCollapsed || input.history.length === 0) {
    return notHandled(input.state);
  }
  // The active history entry the composer should still be showing. When it no
  // longer matches (history changed under us or the index fell out of range),
  // the browse lost its place: never keep navigating from a bogus index, and
  // never abandon the saved draft — restart from the newest entry when going
  // older, or restore the draft when going newer.
  const activeEntry = input.state ? input.history[input.state.index] : undefined;
  const stateIsStale =
    input.state !== null && (activeEntry === undefined || input.currentPrompt !== activeEntry);

  if (input.direction === "older") {
    if (!isComposerCursorOnFirstLine(input.currentPrompt, input.currentExpandedCursor)) {
      return notHandled(input.state);
    }
    const nextState: PromptHistoryNavigationState =
      input.state === null
        ? { index: 0, draft: input.currentPrompt }
        : stateIsStale
          ? { index: 0, draft: input.state.draft }
          : {
              ...input.state,
              index: Math.min(input.state.index + 1, input.history.length - 1),
            };
    const nextPrompt = input.history[nextState.index] ?? input.currentPrompt;
    return {
      handled: true,
      prompt: nextPrompt,
      expandedCursor: expandedCursorForPromptHistoryItem(nextPrompt, "older"),
      state: nextState,
    };
  }

  if (!input.state) {
    return notHandled(null);
  }
  const cursorCanNavigateNewer =
    isComposerCursorOnLastLine(input.currentPrompt, input.currentExpandedCursor) ||
    isComposerCursorOnFirstLine(input.currentPrompt, input.currentExpandedCursor);
  if (!cursorCanNavigateNewer) {
    return notHandled(input.state);
  }
  if (stateIsStale) {
    return {
      handled: true,
      prompt: input.state.draft,
      expandedCursor: input.state.draft.length,
      state: null,
    };
  }
  if (input.state.index > 0) {
    const nextState = {
      ...input.state,
      index: input.state.index - 1,
    };
    const nextPrompt = input.history[nextState.index] ?? input.currentPrompt;
    return {
      handled: true,
      prompt: nextPrompt,
      expandedCursor: expandedCursorForPromptHistoryItem(nextPrompt, "newer"),
      state: nextState,
    };
  }

  return {
    handled: true,
    prompt: input.state.draft,
    expandedCursor: input.state.draft.length,
    state: null,
  };
}

// Default-open policy for the Environment panel; render-time visibility is resolved separately.
// `settingsDefaultOpen` is the user preference (Settings → Environment panel). Landing,
// terminal-primary, and constrained layouts always start closed regardless of that setting.
export function resolveDefaultEnvironmentPanelOpen(input: {
  environmentEnabled: boolean;
  isCenteredEmptyLanding: boolean;
  isTerminalPrimarySurface: boolean;
  isConstrainedChatLayout: boolean;
  settingsDefaultOpen?: boolean;
}): boolean {
  const settingsDefaultOpen = input.settingsDefaultOpen ?? false;
  return (
    input.environmentEnabled &&
    settingsDefaultOpen &&
    !input.isCenteredEmptyLanding &&
    !input.isTerminalPrimarySurface &&
    !input.isConstrainedChatLayout
  );
}

// Build the ordered model list used by model.next / model.previous: favorites first
// (stable user order), then remaining discovered options. Returns null when cycling is
// a no-op (fewer than two selectable models).
export function resolveCycledModelSlug(input: {
  currentModel: string;
  options: ReadonlyArray<{ slug: string }>;
  favoriteSlugs?: ReadonlyArray<string>;
  direction: "next" | "previous";
}): string | null {
  const optionSlugs = new Set(
    input.options.map((option) => option.slug.trim()).filter((slug) => slug.length > 0),
  );
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (slug: string) => {
    const trimmed = slug.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };
  for (const favorite of input.favoriteSlugs ?? []) {
    if (optionSlugs.has(favorite.trim())) {
      push(favorite);
    }
  }
  for (const option of input.options) {
    push(option.slug);
  }
  if (ordered.length < 2) {
    return null;
  }
  const currentIndex = ordered.indexOf(input.currentModel.trim());
  if (currentIndex < 0) {
    return input.direction === "next" ? (ordered[0] ?? null) : (ordered.at(-1) ?? null);
  }
  const delta = input.direction === "next" ? 1 : -1;
  const nextIndex = (currentIndex + delta + ordered.length) % ordered.length;
  return ordered[nextIndex] ?? null;
}

export function resolveEnvironmentPanelOpen(input: {
  defaultOpen: boolean;
  userPreferenceOpen: boolean | null;
}): boolean {
  return input.userPreferenceOpen ?? input.defaultOpen;
}

export function resolveEnvironmentPanelPreferenceUpdate(input: {
  open: boolean;
  persist: boolean;
}): {
  userPreferenceOpen: boolean;
  settingsDefaultOpen: boolean | null;
} {
  return {
    userPreferenceOpen: input.open,
    settingsDefaultOpen: input.persist ? input.open : null,
  };
}

export function resolveEnvironmentPanelPreferenceAfterFirstSend(input: {
  isCenteredEmptyLanding: boolean;
  settingsDefaultOpen: boolean;
  currentPreferenceOpen: boolean | null;
}): boolean | null {
  if (!input.isCenteredEmptyLanding) {
    return input.currentPreferenceOpen;
  }
  return input.settingsDefaultOpen ? null : false;
}

export function resolveEnvironmentPanelVisible(input: {
  environmentEnabled: boolean;
  environmentPanelOpen: boolean;
}): boolean {
  return input.environmentEnabled && input.environmentPanelOpen;
}

// Normal project toolbars stay stable while repository discovery is pending. Studio folders are
// casual context, however, so they must opt into Git UI only after a positive repository result.
export function resolveGitRepoUiState(input: {
  isStudioContainer: boolean;
  queriedIsRepo: boolean | undefined;
}): boolean {
  return input.queriedIsRepo ?? !input.isStudioContainer;
}

// The composer live strip prefers the turn's computed diff (the
// `thread.turn-diff-completed` event) so it can show real per-file +/- stats.
// Before that lands, it falls back to mid-turn file-edit work-log activity so
// the strip can appear while the turn is running, but without a reviewable
// turn id. Once a turn diff exists, its empty file list is authoritative and
// must not be overwritten by tool metadata.
export function resolveActiveTurnLiveDiffState(input: {
  latestTurnId: TurnDiffSummary["turnId"] | null | undefined;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  workLogEntries?: ReadonlyArray<
    Pick<WorkLogEntry, "changedFiles" | "itemType" | "requestKind" | "turnId">
  >;
}): {
  turnId: TurnDiffSummary["turnId"] | null;
  fileCount: number | null;
  additions: number;
  deletions: number;
  hasChanges: boolean;
} {
  const summary = input.latestTurnId
    ? (input.turnDiffSummaries.find((entry) => entry.turnId === input.latestTurnId) ?? null)
    : null;
  const files = summary?.files ?? [];
  if (summary && files.length > 0) {
    return {
      turnId: summary.turnId,
      fileCount: files.length,
      additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
      deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
      hasChanges: true,
    };
  }
  if (summary) {
    return {
      turnId: null,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      hasChanges: false,
    };
  }

  // No diff totals yet: keep the strip visible from in-turn file-edit work so it
  // does not vanish between the first edit and the turn-diff-completed event.
  const workLogFilePaths = new Set<string>();
  let hasFileEditWork = false;
  if (input.latestTurnId) {
    for (const entry of input.workLogEntries ?? []) {
      if (entry.turnId !== input.latestTurnId || !isProviderFileEditWorkLogEntry(entry)) {
        continue;
      }
      hasFileEditWork = true;
      for (const filePath of entry.changedFiles ?? []) {
        workLogFilePaths.add(filePath);
      }
    }
  }

  if (hasFileEditWork && input.latestTurnId) {
    return {
      turnId: null,
      fileCount: workLogFilePaths.size > 0 ? workLogFilePaths.size : null,
      additions: 0,
      deletions: 0,
      hasChanges: true,
    };
  }

  return {
    turnId: null,
    fileCount: 0,
    additions: 0,
    deletions: 0,
    hasChanges: false,
  };
}

export type ThreadDetailHydration = "ready" | "loading" | "failed";

/**
 * A server thread's shell row alone cannot distinguish "no messages" from
 * "history not loaded yet", so an empty timeline only counts as a genuine empty
 * landing once the detail snapshot has been applied. Local draft threads have no
 * server detail to wait for and are always ready.
 */
export function resolveThreadDetailHydration(input: {
  readonly isServerThread: boolean;
  readonly hasTimelineEntries: boolean;
  readonly detailSyncState: "synced" | "failed" | null;
}): ThreadDetailHydration {
  if (!input.isServerThread || input.hasTimelineEntries || input.detailSyncState === "synced") {
    return "ready";
  }
  return input.detailSyncState === "failed" ? "failed" : "loading";
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: draftThread.entryPoint === "terminal" ? "New terminal" : "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    latestTurn: null,
    lastVisitedAt: draftThread.createdAt,
    envMode: draftThread.envMode,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    workingDirectory: draftThread.workingDirectory ?? null,
    lastKnownPr: draftThread.lastKnownPr ?? null,
    handoff: null,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function resolveActiveThreadTitle(input: {
  title: string;
  subagentTitle: string | null;
  isHomeChat: boolean;
  isEmpty: boolean;
}): string {
  if (input.subagentTitle) {
    return input.subagentTitle;
  }
  if (input.isHomeChat && input.isEmpty && isGenericChatThreadTitle(input.title)) {
    return "New Chat";
  }
  return input.title;
}

// Sidechats carry imported fork history for provider context, but their transcript should start
// visually clean so only new sidechat turns appear in the pane.
export function filterSidechatTranscriptMessages(
  messages: readonly ChatMessage[],
  isSidechat: boolean,
): ChatMessage[] {
  return isSidechat
    ? messages.filter((message) => message.source !== "fork-import")
    : [...messages];
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export function appendVoiceTranscriptToPrompt(
  currentPrompt: string,
  transcript: string,
): string | null {
  const trimmedTranscript = transcript.trim();
  if (trimmedTranscript.length === 0) {
    return null;
  }
  return currentPrompt.trim().length === 0
    ? trimmedTranscript
    : `${currentPrompt.replace(/\s+$/, "")}\n${trimmedTranscript}`;
}

export function sanitizeVoiceErrorMessage(message: string): string {
  const normalized = message.trim();
  if (normalized.length === 0) {
    return "The voice note could not be transcribed.";
  }

  const firstLine = normalized.split("\n")[0]?.trim() ?? normalized;
  const withoutInlineStack = firstLine.replace(/\s+at file:\/\/.*$/s, "").trim();
  const withoutRemoteMethodPrefix = withoutInlineStack.replace(
    /^Error invoking remote method ['"][^'"]+['"]:\s*/i,
    "",
  );
  const withoutRepeatedErrorPrefix = withoutRemoteMethodPrefix.replace(/^(Error:\s*)+/i, "").trim();

  return withoutRepeatedErrorPrefix.length > 0
    ? withoutRepeatedErrorPrefix
    : "The voice note could not be transcribed.";
}

export function isVoiceAuthExpiredMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("chatgpt login has expired") || normalized.includes("sign in again");
}

export function describeVoiceRecordingStartError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "The microphone could not be opened.";
  }

  const normalizedMessage = error.message.trim();
  const errorName = typeof error.name === "string" ? error.name : "";

  if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
    return "Microphone access was denied. Enable it in macOS Privacy & Security > Microphone for Synara, then try again.";
  }
  if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
    return "No microphone was found. Connect one and try again.";
  }
  if (errorName === "NotReadableError" || errorName === "TrackStartError") {
    return "The microphone is busy or unavailable right now. Close other audio apps and try again.";
  }
  if (errorName === "SecurityError") {
    return "Microphone access is blocked in this environment.";
  }
  if (normalizedMessage.length > 0) {
    return sanitizeVoiceErrorMessage(normalizedMessage);
  }

  return "The microphone could not be opened.";
}

export function deriveComposerVoiceState(input: {
  authStatus: ServerProviderAuthStatus | null | undefined;
  voiceTranscriptionAvailable: boolean | undefined;
  isRecording: boolean;
  isTranscribing: boolean;
}): {
  canRenderVoiceNotes: boolean;
  canStartVoiceNotes: boolean;
  showVoiceNotesControl: boolean;
} {
  const canRenderVoiceNotes = input.authStatus !== "unauthenticated";
  const canStartVoiceNotes = canRenderVoiceNotes && input.voiceTranscriptionAvailable !== false;

  return {
    canRenderVoiceNotes,
    canStartVoiceNotes,
    showVoiceNotesControl: canRenderVoiceNotes || input.isRecording || input.isTranscribing,
  };
}

export function shouldShowComposerModelBootstrapSkeleton(input: {
  selectedProvider: ProviderKind;
  selectedModel: string | null | undefined;
  persistedModelSelection: ModelSelection | null | undefined;
  draftModelSelection: ModelSelection | null | undefined;
  providerModelsLoading: boolean;
  requiresDiscoveredModels?: boolean;
}): boolean {
  if (input.requiresDiscoveredModels === true && input.providerModelsLoading) {
    return true;
  }

  const draftSelection = input.draftModelSelection;
  if (draftSelection && draftSelection.provider === input.selectedProvider) {
    return false;
  }

  const persistedSelection = input.persistedModelSelection;
  if (!persistedSelection) {
    return false;
  }

  if (persistedSelection.provider !== input.selectedProvider) {
    return true;
  }

  if (!input.providerModelsLoading) {
    return false;
  }

  const normalizedSelectedModel =
    normalizeModelSlug(input.selectedModel, input.selectedProvider) ?? input.selectedModel;
  const normalizedPersistedModel =
    normalizeModelSlug(persistedSelection.model, persistedSelection.provider) ??
    persistedSelection.model;

  return normalizedSelectedModel !== normalizedPersistedModel;
}

export function resolveCommittedProviderModel(input: {
  selectedModel: ModelSlug;
  availableOptions: ReadonlyArray<ProviderModelOption>;
  fallback: () => string;
}): string {
  const directRuntimeOption = input.availableOptions.find(
    (option) => option.slug === input.selectedModel,
  );
  return directRuntimeOption?.slug ?? input.fallback();
}

// Lets a pending custom binary path re-check a session that was already observed ready.
export function shouldConsumePendingCustomBinaryConfirmation(input: {
  sessionAlreadyChecked: boolean;
  pendingCustomBinaryPath: string | null | undefined;
}): boolean {
  return !input.sessionAlreadyChecked || Boolean(input.pendingCustomBinaryPath);
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

// Ordered client-side phases of the "New worktree" first-send setup. The
// labels surface verbatim in the transcript's transient setup row.
export const WORKTREE_SETUP_STEP_DEFINITIONS: ReadonlyArray<{
  id: WorktreeSetupStepId;
  label: string;
}> = [
  { id: "create-worktree", label: "Creating branch and worktree" },
  { id: "prepare-thread", label: "Linking thread workspace" },
  { id: "start-session", label: "Starting session" },
];

export interface WorktreeSetupSnapshotOptions {
  setupScriptName?: string | null;
}

export interface WorktreeSetupDispatchOptions extends WorktreeSetupSnapshotOptions {
  worktreeSetupStepId?: WorktreeSetupStepId;
  expectedUserMessageId?: ChatMessage["id"];
}

function worktreeSetupStepDefinitions(
  activeStepId: WorktreeSetupStepId,
  options?: WorktreeSetupSnapshotOptions,
): ReadonlyArray<{ id: WorktreeSetupStepId; label: string }> {
  const setupScriptName = options?.setupScriptName?.trim();
  const includeSetupStep = activeStepId === "run-setup-action" || Boolean(setupScriptName);
  if (!includeSetupStep) {
    return WORKTREE_SETUP_STEP_DEFINITIONS;
  }
  return [
    { id: "create-worktree", label: "Creating branch and worktree" },
    { id: "prepare-thread", label: "Linking thread workspace" },
    {
      id: "run-setup-action",
      label: setupScriptName ? `Running setup action: ${setupScriptName}` : "Running setup action",
    },
    { id: "start-session", label: "Starting session" },
  ];
}

// How long a failed setup step stays visible before the row is dismissed, so
// the error state can paint instead of being batched away with the reset.
export const WORKTREE_SETUP_ERROR_HOLD_MS = 1200;

export function createWorktreeSetupSnapshot(
  activeStepId: WorktreeSetupStepId,
  options?: WorktreeSetupSnapshotOptions,
): WorktreeSetupSnapshot {
  const stepDefinitions = worktreeSetupStepDefinitions(activeStepId, options);
  const activeIndex = stepDefinitions.findIndex((step) => step.id === activeStepId);
  return {
    steps: stepDefinitions.map((step, index) => ({
      ...step,
      status: index < activeIndex ? "done" : index === activeIndex ? "active" : "pending",
    })),
  };
}

export function failWorktreeSetupSnapshot(snapshot: WorktreeSetupSnapshot): WorktreeSetupSnapshot {
  if (!snapshot.steps.some((step) => step.status === "active")) {
    return snapshot;
  }
  return {
    steps: snapshot.steps.map((step) =>
      step.status === "active" ? { ...step, status: "error" } : step,
    ),
  };
}

export function worktreeSetupHasError(snapshot: WorktreeSetupSnapshot | null): boolean {
  return snapshot?.steps.some((step) => step.status === "error") ?? false;
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  worktreeSetup: WorktreeSetupSnapshot | null;
  expectedUserMessageId: ChatMessage["id"] | null;
  latestTurnTurnId: Thread["latestTurn"] extends infer T
    ? T extends { turnId: infer U }
      ? U | null
      : null
    : null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: Thread["session"] extends infer T
    ? T extends { orchestrationStatus: infer U }
      ? U | null
      : null
    : null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: WorktreeSetupDispatchOptions,
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    worktreeSetup: options?.worktreeSetupStepId
      ? createWorktreeSetupSnapshot(options.worktreeSetupStepId, options)
      : null,
    expectedUserMessageId: options?.expectedUserMessageId ?? null,
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

// Computes the next client-side dispatch marker while preserving in-flight setup
// progress and dropping failed setup rows that are only being held for display.
export function resolveNextLocalDispatchSnapshot(input: {
  current: LocalDispatchSnapshot | null;
  activeThread: Thread | undefined;
  options?: WorktreeSetupDispatchOptions;
}): LocalDispatchSnapshot {
  const worktreeSetupStepId = input.options?.worktreeSetupStepId;
  if (!input.current || worktreeSetupHasError(input.current.worktreeSetup)) {
    return createLocalDispatchSnapshot(input.activeThread, input.options);
  }

  if (!worktreeSetupStepId) {
    return input.current;
  }

  const alreadyActive = input.current.worktreeSetup?.steps.some(
    (step) => step.id === worktreeSetupStepId && step.status === "active",
  );
  return alreadyActive
    ? input.current
    : {
        ...input.current,
        worktreeSetup: createWorktreeSetupSnapshot(worktreeSetupStepId, input.options),
      };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  messages: readonly ChatMessage[];
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (
    input.phase === "running" ||
    input.hasPendingApproval ||
    input.hasPendingUserInput ||
    Boolean(input.threadError)
  ) {
    return true;
  }
  if (
    input.localDispatch.expectedUserMessageId !== null &&
    input.messages.some(
      (message) =>
        message.role === "user" && message.id === input.localDispatch?.expectedUserMessageId,
    )
  ) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const nextSessionOrchestrationStatus = session?.orchestrationStatus ?? null;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (latestTurnChanged) {
    return true;
  }

  if (input.localDispatch.sessionOrchestrationStatus !== nextSessionOrchestrationStatus) {
    if (
      input.localDispatch.sessionOrchestrationStatus === null &&
      nextSessionOrchestrationStatus === "ready"
    ) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Steering a provider without native mid-turn steering interrupts the live
 * turn and lets the server re-dispatch the steer text as a fresh turn.
 * Between the abort and the steered turn's start the thread briefly looks
 * idle, which would otherwise let the queued-composer auto-dispatch race the
 * steered turn (and fire every queued message at once). The gate holds
 * auto-dispatch through that gap.
 */
export interface QueuedSteerGate {
  /** The abort gap has been observed (phase left "running" after the steer). */
  sawInterruptGap: boolean;
  /** Epoch ms when the gap started; null while the original turn still runs. */
  gapStartedAt: number | null;
  /** Active turn id at steer time; a different live id means the steered turn started. */
  armedActiveTurnId: string | null;
}

/** Recovery bound: a healthy interrupt→steered-turn handoff takes ~1-2s. */
export const QUEUED_STEER_GATE_TIMEOUT_MS = 15_000;

export type QueuedSteerGateTransition =
  | { kind: "clear" }
  | { kind: "hold"; gate: QueuedSteerGate; expiresInMs: number | null };

export function resolveQueuedSteerGateTransition(input: {
  gate: QueuedSteerGate;
  phase: SessionPhase;
  sessionErrored: boolean;
  activeTurnId: string | null;
  now: number;
}): QueuedSteerGateTransition {
  if (input.phase === "disconnected" || input.sessionErrored) {
    // The steer will not produce a follow-up turn; release the queue.
    return { kind: "clear" };
  }
  if (input.phase === "running") {
    if (input.gate.sawInterruptGap) {
      // The steered turn is live; normal live-turn guards take over from here.
      return { kind: "clear" };
    }
    // A fast interrupt→steered-turn handoff may never render an idle gap: the
    // active turn id flipping while still "running" is the same signal.
    if (
      input.gate.armedActiveTurnId !== null &&
      input.activeTurnId !== null &&
      input.activeTurnId !== input.gate.armedActiveTurnId
    ) {
      return { kind: "clear" };
    }
    // Original turn still running (interrupt not processed yet): keep holding.
    return {
      kind: "hold",
      gate: {
        sawInterruptGap: false,
        gapStartedAt: null,
        armedActiveTurnId: input.gate.armedActiveTurnId ?? input.activeTurnId,
      },
      expiresInMs: null,
    };
  }
  const gapStartedAt = input.gate.gapStartedAt ?? input.now;
  const expiresInMs = QUEUED_STEER_GATE_TIMEOUT_MS - (input.now - gapStartedAt);
  if (expiresInMs <= 0) {
    // The steered turn never started (lost interrupt, provider failure that
    // didn't surface as a session error). Fail open so the queue can't stall.
    return { kind: "clear" };
  }
  return {
    kind: "hold",
    gate: {
      sawInterruptGap: true,
      gapStartedAt,
      armedActiveTurnId: input.gate.armedActiveTurnId,
    },
    expiresInMs,
  };
}

export const ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS = 180;

export function shouldStartActiveTurnLayoutGrace(options: {
  previousTurnLayoutLive: boolean;
  currentTurnLayoutLive: boolean;
  latestTurnStartedAt: string | null;
}): boolean {
  return (
    options.previousTurnLayoutLive &&
    !options.currentTurnLayoutLive &&
    options.latestTurnStartedAt !== null
  );
}

export function buildSuggestedWorktreeName(input: {
  associatedWorktreeBranch?: string | null;
  title?: string | null;
}): string {
  return buildSynaraBranchName(input.associatedWorktreeBranch ?? input.title);
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  fileCount: number;
  assistantSelectionCount: number;
  browserAnnotationCount: number;
  fileCommentCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  pastedTexts: ReadonlyArray<PastedTextDraft>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  sendablePastedTexts: PastedTextDraft[];
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const sendablePastedTexts = filterPastedTextsWithText(options.pastedTexts);
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    sendablePastedTexts,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      options.fileCount > 0 ||
      options.assistantSelectionCount > 0 ||
      options.browserAnnotationCount > 0 ||
      options.fileCommentCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      sendablePastedTexts.length > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function shouldRenderTerminalWorkspace(options: {
  presentationMode: "drawer" | "workspace";
  terminalOpen: boolean;
}): boolean {
  // The workspace shell should paint immediately; the terminal viewport gates the
  // backend attach until a valid cwd is available.
  return options.terminalOpen && options.presentationMode === "workspace";
}

export function resolveProjectScriptTerminalTarget(options: {
  baseTerminalId: string;
  createTerminalId: () => string;
  hasRunningTerminal: boolean;
  preferNewTerminal?: boolean | undefined;
  terminalOpen: boolean;
}): { shouldCreateNewTerminal: boolean; terminalId: string } {
  // Project scripts require their requested cwd/env before the command write;
  // live PTYs keep their launch context, so visible or running terminals get a new tab.
  const shouldCreateNewTerminal =
    Boolean(options.preferNewTerminal) || options.terminalOpen || options.hasRunningTerminal;

  return {
    shouldCreateNewTerminal,
    terminalId: shouldCreateNewTerminal ? options.createTerminalId() : options.baseTerminalId,
  };
}

export function shouldAutoDeleteTerminalThreadOnLastClose(options: {
  isLastTerminal: boolean;
  isServerThread: boolean;
  terminalEntryPoint: ThreadPrimarySurface;
  thread:
    | Pick<Thread, "activities" | "latestTurn" | "messages" | "proposedPlans" | "session" | "title">
    | null
    | undefined;
}): boolean {
  const { thread } = options;
  if (
    !options.isLastTerminal ||
    !options.isServerThread ||
    options.terminalEntryPoint !== "terminal" ||
    !thread
  ) {
    return false;
  }
  return (
    isGenericTerminalThreadTitle(thread.title) &&
    thread.messages.length === 0 &&
    thread.latestTurn === null &&
    thread.session === null &&
    thread.activities.length === 0 &&
    thread.proposedPlans.length === 0
  );
}

export interface ThreadBreadcrumb {
  threadId: ThreadIdType;
  title: string;
}

type ThreadBreadcrumbSource = Pick<
  Thread,
  "id" | "title" | "parentThreadId" | "subagentAgentId" | "subagentNickname" | "subagentRole"
> & {
  activities?: Thread["activities"];
};

export function buildThreadBreadcrumbs(
  threads: ReadonlyArray<ThreadBreadcrumbSource>,
  thread: Pick<Thread, "id" | "parentThreadId"> | null | undefined,
): ThreadBreadcrumb[] {
  if (!thread?.parentThreadId) {
    return [];
  }

  const threadById = new Map(threads.map((entry) => [entry.id, entry] as const));
  const breadcrumbs: ThreadBreadcrumb[] = [];
  const visited = new Set<ThreadIdType>();
  let currentParentId: ThreadIdType | null = thread.parentThreadId ?? null;

  while (currentParentId && !visited.has(currentParentId)) {
    visited.add(currentParentId);
    const parentThread = threadById.get(currentParentId);
    if (!parentThread) {
      break;
    }
    breadcrumbs.unshift({
      threadId: parentThread.id,
      title: parentThread.parentThreadId
        ? resolveSubagentPresentationForThread({ thread: parentThread, threads }).fullLabel
        : parentThread.title,
    });
    currentParentId = parentThread.parentThreadId ?? null;
  }

  return breadcrumbs;
}

function deriveSubagentStatus(thread: Thread | undefined): {
  isActive: boolean;
  label: string | undefined;
} {
  if (!thread) {
    return {
      isActive: false,
      label: undefined,
    };
  }

  if (thread.error || thread.session?.status === "error") {
    return {
      isActive: false,
      label: "Error",
    };
  }
  if (thread.session?.status === "connecting") {
    return {
      isActive: true,
      label: "Connecting",
    };
  }
  if (
    thread.session?.status === "running" ||
    hasLiveTurnTailWork({
      latestTurn: thread.latestTurn,
      messages: thread.messages,
      activities: thread.activities,
      session: thread.session,
    })
  ) {
    return {
      isActive: true,
      label: "Running",
    };
  }
  if (thread.session?.status === "closed") {
    return {
      isActive: false,
      label: "Closed",
    };
  }

  return {
    isActive: false,
    label: thread.session ? "Idle" : undefined,
  };
}

function humanizeSubagentRawStatus(rawStatus: string | undefined): string | undefined {
  return humanizeSubagentStatus(rawStatus);
}

// Terminal work-log statuses are authoritative over child-thread session state:
// a finished subagent's thread merely parks in an "Idle"/"Closed" session status,
// which must not mask Completed/Failed/Stopped. The per-agent rawStatus wins over
// the collab item's own status, which only covers the whole tool call.
function terminalSubagentStatusLabel(
  rawStatus: string | undefined,
  entryStatus: string | undefined,
): string | undefined {
  for (const candidate of rawStatus !== undefined ? [rawStatus] : [entryStatus]) {
    const statusKind = normalizeSubagentStatusKind(candidate);
    if (statusKind === "completed" || statusKind === "failed" || statusKind === "stopped") {
      return humanizeSubagentStatus(candidate);
    }
  }
  return undefined;
}

function resolveTimelineSubagentThread(input: {
  subagent: NonNullable<WorkLogEntry["subagents"]>[number];
  parentThreadId: ThreadIdType | null;
  threadById: ReadonlyMap<ThreadIdType, Thread>;
  threads: ReadonlyArray<Thread>;
}): Thread | undefined {
  const directThreadId = input.subagent.resolvedThreadId ?? input.subagent.threadId;
  if (directThreadId) {
    const directMatch = input.threadById.get(ThreadId.makeUnsafe(directThreadId));
    if (directMatch) {
      return directMatch;
    }
  }

  if (input.parentThreadId) {
    const providerThreadId = input.subagent.providerThreadId ?? input.subagent.threadId;
    const derivedLocalThreadId = localSubagentThreadId(input.parentThreadId, providerThreadId);
    const derivedLocalMatch = input.threadById.get(derivedLocalThreadId);
    if (derivedLocalMatch) {
      return derivedLocalMatch;
    }

    if (input.subagent.agentId) {
      const matchedByAgent = input.threads.find(
        (thread) =>
          thread.parentThreadId === input.parentThreadId &&
          thread.subagentAgentId === input.subagent.agentId,
      );
      if (matchedByAgent) {
        return matchedByAgent;
      }
    }
  }

  if (input.subagent.agentId) {
    return input.threads.find((thread) => thread.subagentAgentId === input.subagent.agentId);
  }

  return undefined;
}

export function enrichSubagentWorkEntries(
  workEntries: ReadonlyArray<WorkLogEntry>,
  threads: ReadonlyArray<Thread>,
  parentThreadId: ThreadIdType | null,
): WorkLogEntry[] {
  if (workEntries.length === 0) {
    return [];
  }

  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));

  return workEntries.map((entry) => {
    if ((entry.subagents?.length ?? 0) === 0) {
      return entry;
    }

    const subagents = entry.subagents!.map((subagent) => {
      const matchedThread = resolveTimelineSubagentThread({
        subagent,
        parentThreadId,
        threadById,
        threads,
      });
      const status = deriveSubagentStatus(matchedThread);
      const fallbackStatusLabel = humanizeSubagentRawStatus(subagent.rawStatus);
      const terminalStatusLabel = status.isActive
        ? undefined
        : terminalSubagentStatusLabel(subagent.rawStatus, entry.subagentAction?.status);
      const matchedPresentation =
        matchedThread !== undefined
          ? resolveSubagentPresentationForThread({ thread: matchedThread, threads })
          : null;
      const nextSubagent = Object.assign({}, subagent);
      if (matchedThread) {
        nextSubagent.resolvedThreadId = matchedThread.id;
      }
      if (matchedPresentation) {
        nextSubagent.title = matchedPresentation.fullLabel;
      }
      if (terminalStatusLabel ?? status.label ?? fallbackStatusLabel) {
        nextSubagent.statusLabel = terminalStatusLabel ?? status.label ?? fallbackStatusLabel;
      }
      if (status.isActive || fallbackStatusLabel === "Running") {
        nextSubagent.isActive = true;
      }
      return nextSubagent;
    });

    return {
      ...entry,
      subagents,
    };
  });
}
