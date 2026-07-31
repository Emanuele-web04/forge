// FILE: threadDetailPrewarm.ts
// Purpose: Short-lived thread-detail subscription prewarm controller for navigation intent.
// Layer: Web subscription utility
// Exports: Pure controller factory plus a React hook backed by thread-detail retention.

import type { ThreadId } from "@synara/contracts";
import { useEffect, useRef } from "react";
import { localThreadDetailResumeCursors } from "./threadDetailResumeCursors";
import {
  retainSpeculativeThreadDetail,
  type SpeculativeThreadDetailRetainOptions,
} from "./threadDetailSpeculativeRetain";

export const THREAD_DETAIL_PREWARM_RELEASE_MS = 10_000;
export const THREAD_DETAIL_PREWARM_LIMIT = 5;

type TimeoutHandle = ReturnType<typeof setTimeout>;
type RetainThreadDetailSubscription = (threadId: ThreadId) => () => void;

interface ThreadDetailPrewarmClock {
  setTimeout(callback: () => void, delayMs: number): TimeoutHandle;
  clearTimeout(timeoutId: TimeoutHandle): void;
}

interface RetainedThreadPrewarmEntry {
  release: () => void;
  timeoutId: TimeoutHandle;
}

export interface ThreadDetailPrewarmController {
  prewarmThreadDetail(threadId: ThreadId): void;
  prewarmThreadDetails(threadIds: readonly ThreadId[]): void;
  dispose(): void;
}

export interface ThreadDetailPrewarmControllerOptions {
  retainThreadDetailSubscription?: RetainThreadDetailSubscription | undefined;
  canPrewarmThreadDetail?: ((threadId: ThreadId) => boolean) | undefined;
  subscribeResumeCursorReset?: ((listener: () => void) => () => void) | undefined;
  releaseMs?: number | undefined;
  maxRetainedThreads?: number | undefined;
  clock?: ThreadDetailPrewarmClock | undefined;
}

const DEFAULT_CLOCK: ThreadDetailPrewarmClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timeoutId) => clearTimeout(timeoutId),
};

function uniqueEligibleThreadIds(
  threadIds: readonly ThreadId[],
  limit: number,
  isEligible: (threadId: ThreadId) => boolean,
): ThreadId[] {
  const nextThreadIds: ThreadId[] = [];
  const seenThreadIds = new Set<ThreadId>();

  for (const threadId of threadIds) {
    if (seenThreadIds.has(threadId)) {
      continue;
    }
    seenThreadIds.add(threadId);
    // Eligibility filters before the limit: ineligible (cold) threads must not
    // consume prewarm slots that a cached thread later in the list could use.
    if (!isEligible(threadId)) {
      continue;
    }
    nextThreadIds.push(threadId);
    if (nextThreadIds.length >= limit) {
      break;
    }
  }

  return nextThreadIds;
}

export function createThreadDetailPrewarmController(
  options: ThreadDetailPrewarmControllerOptions = {},
): ThreadDetailPrewarmController {
  // A speculative prewarm subscription is only cheap when it resumes from a
  // cursor: without cached detail it would open a full-history snapshot stream
  // and compete with real navigation for the per-client thread-stream budget.
  // Local-only cursor read: this must be keyed by (EnvironmentId, ThreadId)
  // before a remote environment can be registered — see the KNOWN GAP note at
  // the top of threadDetailSubscriptionRetention.ts.
  const canRetainThreadDetail =
    options.canPrewarmThreadDetail ??
    ((threadId) => localThreadDetailResumeCursors().has(threadId));
  const releaseMs = options.releaseMs ?? THREAD_DETAIL_PREWARM_RELEASE_MS;
  const maxRetainedThreads = options.maxRetainedThreads ?? THREAD_DETAIL_PREWARM_LIMIT;
  const clock = options.clock ?? DEFAULT_CLOCK;
  const retainedThreadById = new Map<ThreadId, RetainedThreadPrewarmEntry>();

  const releaseThread = (threadId: ThreadId) => {
    const entry = retainedThreadById.get(threadId);
    if (!entry) {
      return;
    }
    clock.clearTimeout(entry.timeoutId);
    entry.release();
    retainedThreadById.delete(threadId);
  };

  const retainOptions: SpeculativeThreadDetailRetainOptions = {
    ...(options.retainThreadDetailSubscription === undefined
      ? {}
      : { retainThreadDetailSubscription: options.retainThreadDetailSubscription }),
    ...(options.canPrewarmThreadDetail === undefined
      ? {}
      : { canRetainThreadDetail: options.canPrewarmThreadDetail }),
    ...(options.subscribeResumeCursorReset === undefined
      ? {}
      : { subscribeResumeCursorReset: options.subscribeResumeCursorReset }),
    // The retain released itself because its cursor is gone; forget the entry
    // in the same step so this map never claims a lease it no longer holds.
    onAutoRelease: (threadId) => {
      const entry = retainedThreadById.get(threadId);
      if (!entry) return;
      clock.clearTimeout(entry.timeoutId);
      retainedThreadById.delete(threadId);
    },
  };

  const prewarmThreadDetail = (threadId: ThreadId) => {
    const existing = retainedThreadById.get(threadId);
    if (existing) {
      clock.clearTimeout(existing.timeoutId);
    }

    // Eligibility lives in the shared speculative retain: it gates admission on
    // a resume cursor and gives the retain back if that cursor is later reset.
    const release = existing?.release ?? retainSpeculativeThreadDetail(threadId, retainOptions);
    if (release === null) {
      return;
    }
    const timeoutId = clock.setTimeout(() => {
      const current = retainedThreadById.get(threadId);
      if (!current || current.release !== release) {
        return;
      }
      current.release();
      retainedThreadById.delete(threadId);
    }, releaseMs);

    retainedThreadById.set(threadId, { release, timeoutId });
  };

  return {
    prewarmThreadDetail,
    prewarmThreadDetails(threadIds) {
      const nextThreadIds = uniqueEligibleThreadIds(
        threadIds,
        maxRetainedThreads,
        // Already-retained threads stay eligible: their prewarm retain is live
        // even if the cursor moved underneath, matching prewarmThreadDetail.
        // A retain the cursor reset took back has already left this map, so it
        // is re-checked here like any cold thread — one source of truth.
        (threadId) => retainedThreadById.has(threadId) || canRetainThreadDetail(threadId),
      );
      const nextThreadIdSet = new Set(nextThreadIds);

      for (const threadId of nextThreadIds) {
        prewarmThreadDetail(threadId);
      }
      for (const threadId of [...retainedThreadById.keys()]) {
        if (!nextThreadIdSet.has(threadId)) {
          releaseThread(threadId);
        }
      }
    },
    dispose() {
      for (const threadId of [...retainedThreadById.keys()]) {
        releaseThread(threadId);
      }
    },
  };
}

export function useThreadDetailPrewarm(): Omit<ThreadDetailPrewarmController, "dispose"> {
  const controllerRef = useRef<ThreadDetailPrewarmController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createThreadDetailPrewarmController();
  }

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    },
    [],
  );

  const prewarmThreadDetail = (threadId: ThreadId) => {
    controllerRef.current?.prewarmThreadDetail(threadId);
  };

  const prewarmThreadDetails = (threadIds: readonly ThreadId[]) => {
    controllerRef.current?.prewarmThreadDetails(threadIds);
  };

  return {
    prewarmThreadDetail,
    prewarmThreadDetails,
  };
}
