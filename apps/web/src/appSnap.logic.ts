// FILE: appSnap.logic.ts
// Purpose: Resolves recent-task targeting for incoming AppSnaps.
// Layer: Web UI logic
// Depends on: Thread identity only; no React or desktop APIs.

import type { ThreadId } from "@synara/contracts";

import { isComposerAppSnapCaptureSource } from "./lib/composerImageSource";

export const APPSNAP_RECENT_TARGET_WINDOW_MS = 60_000;

export interface AppSnapThreadTarget {
  threadId: ThreadId;
  splitViewId?: string | undefined;
}

export interface TimedAppSnapThreadTarget extends AppSnapThreadTarget {
  atMs: number;
}

export type ResolvedAppSnapTarget =
  | { kind: "existing"; target: AppSnapThreadTarget }
  | { kind: "fresh" };

export interface LatestAppSnapRequestGuard {
  begin: () => number;
  isCurrent: (requestId: number) => boolean;
}

export function createLatestAppSnapRequestGuard(): LatestAppSnapRequestGuard {
  let latestRequestId = 0;
  return {
    begin: () => {
      latestRequestId += 1;
      return latestRequestId;
    },
    isCurrent: (requestId) => requestId === latestRequestId,
  };
}

interface AppSnapSourceCarrier {
  blobKey?: unknown;
  source?:
    | {
        kind?: unknown;
        captureId?: unknown;
      }
    | null
    | undefined;
}

interface AppSnapCaptureDraft {
  images?: ReadonlyArray<AppSnapSourceCarrier> | undefined;
  persistedAttachments: ReadonlyArray<AppSnapSourceCarrier>;
  promptHistorySavedDraft?:
    | {
        images?: ReadonlyArray<AppSnapSourceCarrier> | undefined;
        persistedAttachments: ReadonlyArray<AppSnapSourceCarrier>;
      }
    | null
    | undefined;
}

interface AppSnapHydrationDraft {
  images: ReadonlyArray<unknown>;
  persistedAttachments: ReadonlyArray<unknown>;
  promptHistorySavedDraft?:
    | {
        images: ReadonlyArray<unknown>;
        persistedAttachments: ReadonlyArray<unknown>;
      }
    | null
    | undefined;
}

export function didAppSnapHydrationInputsChange(
  current: Readonly<Record<string, AppSnapHydrationDraft | undefined>>,
  previous: Readonly<Record<string, AppSnapHydrationDraft | undefined>>,
): boolean {
  const threadIds = new Set([...Object.keys(current), ...Object.keys(previous)]);
  for (const threadId of threadIds) {
    const currentDraft = current[threadId];
    const previousDraft = previous[threadId];
    if (!currentDraft || !previousDraft) return true;
    if (
      currentDraft.images !== previousDraft.images ||
      currentDraft.persistedAttachments !== previousDraft.persistedAttachments
    ) {
      return true;
    }
    const currentSavedDraft = currentDraft.promptHistorySavedDraft;
    const previousSavedDraft = previousDraft.promptHistorySavedDraft;
    if (Boolean(currentSavedDraft) !== Boolean(previousSavedDraft)) return true;
    if (
      currentSavedDraft &&
      previousSavedDraft &&
      (currentSavedDraft.images !== previousSavedDraft.images ||
        currentSavedDraft.persistedAttachments !== previousSavedDraft.persistedAttachments)
    ) {
      return true;
    }
  }
  return false;
}

function isCaptureEntry(entry: AppSnapSourceCarrier, captureId: string): boolean {
  return isComposerAppSnapCaptureSource(entry.source, captureId);
}

function entriesContainCapture(
  entries: ReadonlyArray<AppSnapSourceCarrier>,
  captureId: string,
): boolean {
  return entries.some((entry) => isCaptureEntry(entry, captureId));
}

export function hasPersistedAppSnapCapture(
  drafts: Iterable<AppSnapCaptureDraft | undefined>,
  captureId: string,
): boolean {
  if (captureId.length === 0) return false;
  for (const draft of drafts) {
    if (!draft) continue;
    if (
      entriesContainCapture(draft.persistedAttachments, captureId) ||
      (draft.promptHistorySavedDraft !== null &&
        draft.promptHistorySavedDraft !== undefined &&
        entriesContainCapture(draft.promptHistorySavedDraft.persistedAttachments, captureId))
    ) {
      return true;
    }
  }
  return false;
}

/** True once persisted AppSnap metadata has also been restored into a composer image chip. */
export function hasHydratedAppSnapCapture(
  drafts: Iterable<AppSnapCaptureDraft | undefined>,
  captureId: string,
): boolean {
  if (captureId.length === 0) return false;
  for (const draft of drafts) {
    if (!draft) continue;
    if (
      entriesContainCapture(draft.images ?? [], captureId) ||
      entriesContainCapture(draft.promptHistorySavedDraft?.images ?? [], captureId)
    ) {
      return true;
    }
  }
  return false;
}

/** Blob keys backing every persisted draft attachment for a capture id. */
export function persistedAppSnapCaptureBlobKeys(
  drafts: Iterable<AppSnapCaptureDraft | undefined>,
  captureId: string,
): string[] {
  if (captureId.length === 0) return [];
  const blobKeys = new Set<string>();
  for (const draft of drafts) {
    if (!draft) continue;
    const entries = [
      ...draft.persistedAttachments,
      ...(draft.promptHistorySavedDraft?.persistedAttachments ?? []),
    ];
    for (const entry of entries) {
      if (!isCaptureEntry(entry, captureId)) continue;
      if (typeof entry.blobKey === "string" && entry.blobKey.length > 0) {
        blobKeys.add(entry.blobKey);
      }
    }
  }
  return [...blobKeys];
}

function isRecent(atMs: number, captureAtMs: number): boolean {
  const ageMs = captureAtMs - atMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= APPSNAP_RECENT_TARGET_WINDOW_MS;
}

export function resolveAppSnapTarget(input: {
  captureAtMs: number;
  lastInteraction: TimedAppSnapThreadTarget | null;
  lastAppSnap: TimedAppSnapThreadTarget | null;
  isThreadAvailable: (threadId: ThreadId) => boolean;
}): ResolvedAppSnapTarget {
  const { captureAtMs, lastInteraction, lastAppSnap, isThreadAvailable } = input;

  const recentInteraction =
    lastInteraction &&
    isRecent(lastInteraction.atMs, captureAtMs) &&
    isThreadAvailable(lastInteraction.threadId)
      ? lastInteraction
      : null;
  const recentAppSnap =
    lastAppSnap &&
    isRecent(lastAppSnap.atMs, captureAtMs) &&
    isThreadAvailable(lastAppSnap.threadId)
      ? lastAppSnap
      : null;

  // A newer explicit task interaction overrides the affinity created by an older AppSnap.
  if (recentInteraction && (!recentAppSnap || recentInteraction.atMs >= recentAppSnap.atMs)) {
    return {
      kind: "existing",
      target: {
        threadId: recentInteraction.threadId,
        ...(recentInteraction.splitViewId ? { splitViewId: recentInteraction.splitViewId } : {}),
      },
    };
  }

  // Consecutive AppSnaps stay together even while the user remains in the external app.
  if (recentAppSnap) {
    return {
      kind: "existing",
      target: {
        threadId: recentAppSnap.threadId,
        ...(recentAppSnap.splitViewId ? { splitViewId: recentAppSnap.splitViewId } : {}),
      },
    };
  }

  return { kind: "fresh" };
}

export const REQUEST_CURRENT_APP_SNAP_EVENT = "synara:request-current-app-snap";

/** Explicit UI gesture only. Capturing never sends a turn or enables Computer. */
export function requestCurrentAppSnap(): void {
  window.dispatchEvent(new Event(REQUEST_CURRENT_APP_SNAP_EVENT));
}
