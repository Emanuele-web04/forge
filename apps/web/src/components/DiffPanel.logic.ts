// FILE: DiffPanel.logic.ts
// Purpose: Resolve the thread context the diff panel should use across server-backed and local draft chats.
// Exports: resolveDiffPanelThread, diff view source helpers
// Depends on: ChatView.logic draft-thread normalization.

import { type ModelSelection, type ThreadId, type TurnId } from "@synara/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/react";

import type { DraftThreadState } from "../composerDraftStore";
import type { RepoDiffScope } from "../repoDiffScopeStore";
import { REPO_DIFF_SCOPE_LABELS, resolveRepoDiffScopeLabel } from "../repoDiffScopeStore";
import { hasLiveTurnTailWork, isLatestTurnSettled } from "../session-logic";
import { buildLocalDraftThread } from "./ChatView.logic";
import { buildFileDiffRenderKey, resolveFileDiffPath } from "../lib/diffRendering";
import type { ChatMessage, Thread } from "../types";

export type DiffViewKind = "repo" | "turn";

/** Distinguishes all-turns vs last-turn when no specific turn id is selected. */
export type DiffPanelTurnScopeIntent = "all" | "last";

export type DiffPanelViewSource =
  | { kind: "repo"; scope: RepoDiffScope }
  | { kind: "turn"; turnId: TurnId | null };

export type DiffPanelRepoScopeOption = Exclude<RepoDiffScope, "ref">;

export type DiffPanelScopePickerValue =
  | DiffPanelRepoScopeOption
  | `ref:${string}`
  | "allTurns"
  | "lastTurn";

export const DIFF_PANEL_PICKER_SCOPE_OPTIONS: ReadonlyArray<DiffPanelRepoScopeOption> = [
  "workingTree",
  "unstaged",
  "staged",
  "branch",
];

export const DIFF_PANEL_COMPARE_REF_VALUE_PREFIX = "ref:";

export function buildDiffPanelCompareRefValue(ref: string): `ref:${string}` {
  return `${DIFF_PANEL_COMPARE_REF_VALUE_PREFIX}${ref}`;
}

export function parseDiffPanelCompareRefValue(value: string): string | null {
  if (!value.startsWith(DIFF_PANEL_COMPARE_REF_VALUE_PREFIX)) {
    return null;
  }
  const ref = value.slice(DIFF_PANEL_COMPARE_REF_VALUE_PREFIX.length).trim();
  return ref.length > 0 ? ref : null;
}

export function isDiffPanelRepoScopeOption(value: string): value is DiffPanelRepoScopeOption {
  return (
    value === "workingTree" || value === "unstaged" || value === "staged" || value === "branch"
  );
}

// Reuse the chat-view draft fallback so diff surfaces keep working before the first server turn exists.
export function resolveDiffPanelThread(input: {
  threadId: ThreadId | null | undefined;
  serverThread: Thread | undefined;
  draftThread: DraftThreadState | null | undefined;
  fallbackModelSelection: ModelSelection;
}): Thread | undefined {
  if (input.serverThread) {
    return input.serverThread;
  }
  if (!input.threadId || !input.draftThread) {
    return undefined;
  }

  return buildLocalDraftThread(
    input.threadId,
    input.draftThread,
    input.fallbackModelSelection,
    null,
  );
}

export function resolveInitialDiffViewKind(selectedTurnId: TurnId | null): DiffViewKind {
  return selectedTurnId === null ? "repo" : "turn";
}

/** Relaxed cadence for the open review pane — git invalidation handles turn boundaries. */
export const DIFF_PANEL_REPO_LIVE_REFETCH_INTERVAL_MS = 10_000;

export function resolveDiffPanelRepoLiveRefresh(input: {
  latestTurn: Thread["latestTurn"];
  session: Thread["session"];
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "streaming" | "turnId">>;
  activities: Thread["activities"];
}): boolean {
  if (!input.latestTurn?.startedAt) {
    return false;
  }

  const hasLiveTail = hasLiveTurnTailWork({
    latestTurn: input.latestTurn,
    messages: input.messages,
    activities: input.activities,
    session: input.session,
  });

  return !isLatestTurnSettled(input.latestTurn, input.session) || hasLiveTail;
}

export function resolveDiffPanelRepoLiveRefetchIntervalMs(input: {
  queriesEnabled: boolean;
  liveRefreshEnabled: boolean;
  diffViewKind: DiffViewKind;
  shouldPollRepoDiff: boolean;
}): number | false {
  if (
    !input.queriesEnabled ||
    !input.liveRefreshEnabled ||
    input.diffViewKind !== "repo" ||
    !input.shouldPollRepoDiff
  ) {
    return false;
  }
  return DIFF_PANEL_REPO_LIVE_REFETCH_INTERVAL_MS;
}

/** Gate expensive git/diff fetches so a hidden or collapsed review pane stays idle. */
export function resolveDiffPanelQueriesEnabled(input: {
  diffOpen: boolean;
  queriesEnabled?: boolean;
}): boolean {
  return input.diffOpen && (input.queriesEnabled ?? true);
}

export function resolveDiffPanelScopeCountQueriesEnabled(input: {
  queriesEnabled: boolean;
  scopePickerOpen: boolean;
}): boolean {
  return input.queriesEnabled && input.scopePickerOpen;
}

export function resolveDiffPanelGitStatusQueriesEnabled(input: {
  queriesEnabled: boolean;
  activeCwd: string | null;
  diffViewKind: DiffViewKind;
}): boolean {
  return input.queriesEnabled && input.activeCwd !== null && input.diffViewKind === "repo";
}

export function resolveDiffPanelScopeFileCounts(input: {
  viewSource: DiffPanelViewSource;
  activeScopeFileCount: number | undefined;
  scopePickerOpen: boolean;
  pickerScopeCounts: Partial<Record<RepoDiffScope, number>>;
}): Partial<Record<RepoDiffScope, number>> {
  if (input.scopePickerOpen) {
    return input.pickerScopeCounts;
  }
  if (
    input.viewSource.kind === "repo" &&
    typeof input.activeScopeFileCount === "number" &&
    input.activeScopeFileCount > 0
  ) {
    return { [input.viewSource.scope]: input.activeScopeFileCount };
  }
  return {};
}

export function resolveDiffPanelViewSource(input: {
  diffViewKind: DiffViewKind;
  repoDiffScope: RepoDiffScope;
  selectedTurnId: TurnId | null;
}): DiffPanelViewSource {
  if (input.diffViewKind === "turn") {
    return { kind: "turn", turnId: input.selectedTurnId };
  }
  return { kind: "repo", scope: input.repoDiffScope };
}

export function resolveDiffPanelPickerLabel(
  source: DiffPanelViewSource,
  turnScopeIntent?: DiffPanelTurnScopeIntent,
  compareRef?: string | null,
): string {
  if (source.kind === "turn") {
    if (source.turnId !== null) {
      return "Turn diff";
    }
    return turnScopeIntent === "last" ? "Last turn" : "All turns";
  }
  if (source.scope === "ref") {
    return resolveRepoDiffScopeLabel("ref", compareRef ?? null);
  }
  return REPO_DIFF_SCOPE_LABELS[source.scope];
}

export function resolveSelectedTurnSummary<T extends { turnId: TurnId }>(
  selectedTurnId: TurnId | null,
  orderedTurnDiffSummaries: ReadonlyArray<T>,
): T | undefined {
  if (!selectedTurnId) {
    return undefined;
  }
  return orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId);
}

export function isStaleDiffTurnSelection(
  selectedTurnId: TurnId | null,
  orderedTurnDiffSummaries: ReadonlyArray<{ turnId: TurnId }>,
): boolean {
  if (!selectedTurnId) {
    return false;
  }
  return !orderedTurnDiffSummaries.some((summary) => summary.turnId === selectedTurnId);
}

/** Radio value for the left diff-source picker; null when a specific older turn is active. */
export function resolveDiffPanelScopePickerValue(input: {
  viewSource: DiffPanelViewSource;
  latestTurnId: TurnId | null;
  turnScopeIntent?: DiffPanelTurnScopeIntent;
  compareRef?: string | null;
}): DiffPanelScopePickerValue | null {
  if (input.viewSource.kind === "repo") {
    if (input.viewSource.scope === "ref") {
      const ref = input.compareRef?.trim() ?? "";
      return ref.length > 0 ? buildDiffPanelCompareRefValue(ref) : null;
    }
    return input.viewSource.scope;
  }
  if (input.viewSource.turnId === null) {
    return input.turnScopeIntent === "last" ? "lastTurn" : "allTurns";
  }
  if (input.viewSource.turnId === input.latestTurnId) {
    return "lastTurn";
  }
  return null;
}

export function resolveConversationCacheScope(
  conversationCheckpointTurnCount: number | undefined,
): string | null {
  if (typeof conversationCheckpointTurnCount !== "number") {
    return null;
  }
  return `conversation:to-${conversationCheckpointTurnCount}`;
}

export function filterRenderableFilesForSearch(
  files: ReadonlyArray<FileDiffMetadata>,
  query: string,
): FileDiffMetadata[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [...files];
  }
  return files.filter((fileDiff) => {
    const filePath = resolveFileDiffPath(fileDiff).toLowerCase();
    return filePath.includes(normalizedQuery);
  });
}

export type DiffChangeNavigationDirection = "previous" | "next";

export type DiffChangeMarkerKind = "added" | "removed" | "modified";

export interface DiffChangeMarkerSource {
  path: string;
  offsetTop: number;
  changeType: FileDiffMetadata["type"];
}

export interface DiffChangeMarker {
  path: string;
  kind: DiffChangeMarkerKind;
  top: number;
}

export const DIFF_CHANGE_MARKER_HEIGHT_PX = 3;

export function resolveAdjacentDiffFilePath(
  filePaths: ReadonlyArray<string>,
  activeFilePath: string | null,
  direction: DiffChangeNavigationDirection,
): string | null {
  if (filePaths.length === 0) {
    return null;
  }
  const activeIndex = activeFilePath === null ? -1 : filePaths.indexOf(activeFilePath);
  if (activeIndex === -1) {
    return direction === "next" ? (filePaths[0] ?? null) : null;
  }
  const targetIndex = direction === "next" ? activeIndex + 1 : activeIndex - 1;
  if (targetIndex < 0 || targetIndex >= filePaths.length) {
    return null;
  }
  return filePaths[targetIndex] ?? null;
}

export function resolveDiffChangeMarkerKind(
  changeType: FileDiffMetadata["type"],
): DiffChangeMarkerKind {
  if (changeType === "new") {
    return "added";
  }
  if (changeType === "deleted") {
    return "removed";
  }
  return "modified";
}

export function resolveDiffChangeMarkers(input: {
  files: ReadonlyArray<DiffChangeMarkerSource>;
  scrollHeight: number;
  stripHeight: number;
}): DiffChangeMarker[] {
  if (input.files.length === 0 || input.scrollHeight <= 0) {
    return [];
  }
  const maxTop = Math.max(0, input.stripHeight - DIFF_CHANGE_MARKER_HEIGHT_PX);
  return input.files.map((file) => {
    const topRatio = Math.min(1, Math.max(0, file.offsetTop / input.scrollHeight));
    return {
      path: file.path,
      kind: resolveDiffChangeMarkerKind(file.changeType),
      top: Math.min(maxTop, topRatio * input.stripHeight),
    };
  });
}

export function resolveWatchedDiffFilePath(
  selectedFilePath: string | null,
  files: ReadonlyArray<FileDiffMetadata>,
): string | null {
  if (
    selectedFilePath &&
    files.some((fileDiff) => resolveFileDiffPath(fileDiff) === selectedFilePath)
  ) {
    return selectedFilePath;
  }
  return files[0] ? resolveFileDiffPath(files[0]) : null;
}

export function areAllRenderableFilesCollapsed(
  files: ReadonlyArray<FileDiffMetadata>,
  collapsedFiles: ReadonlySet<string>,
): boolean {
  if (files.length === 0) {
    return false;
  }
  return files.every((fileDiff) => collapsedFiles.has(buildFileDiffRenderKey(fileDiff)));
}

/**
 * Track whether the diff viewport is in a "select all then copy" gesture so the copy
 * handler can substitute the full raw diff instead of the few mounted rows the
 * virtualizer left in the DOM.
 *
 * The diff surface renders into shadow DOM, so a native Cmd/Ctrl+A actually selects the
 * surrounding light-DOM page and the resulting `copy` event never travels through the
 * viewport element. We listen on `document`: the keydown still passes through the
 * viewport (so we can tell the select-all happened there), and this state machine decides
 * whether the very next copy should be hijacked.
 */
export function resolveDiffSelectAllArmed(
  previous: boolean,
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
  isWithinDiffViewport: boolean,
): boolean {
  const key = event.key.toLowerCase();
  const hasShortcutModifier = event.metaKey || event.ctrlKey;

  if (hasShortcutModifier && key === "a") {
    return isWithinDiffViewport;
  }
  if (hasShortcutModifier && key === "c") {
    return previous;
  }
  if (key === "meta" || key === "control" || key === "shift" || key === "alt") {
    return previous;
  }
  return false;
}

export function resolveDiffSelectAllWithinViewport(
  eventWithinDiffViewport: boolean,
  lastPointerInDiffViewport: boolean,
  isTextEditingTarget: boolean,
): boolean {
  return eventWithinDiffViewport || (lastPointerInDiffViewport && !isTextEditingTarget);
}
