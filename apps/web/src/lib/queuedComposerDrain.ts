// FILE: queuedComposerDrain.ts
// Purpose: Auto-dispatch composer queued turns for every thread, including ones
//          whose ChatView is unmounted, using the same gates as the open chat.
// Layer: Web subscription utility
// Exports: drain gates, exclusive per-thread send lock, locked-dispatch helper,
//          steer-gate sharing, ChatView claim/release, watcher start

import type { AssistantDeliveryMode, ThreadId } from "@synara/contracts";

import {
  type QueuedSteerGate,
  resolveQueuedSteerGateTransition,
} from "../components/ChatView.logic";
import { useComposerDraftStore, type QueuedComposerTurn } from "../composerDraftStore";
import { derivePendingApprovals, derivePendingUserInputs, derivePhase } from "../session-logic";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import type { SessionPhase } from "../types";
import { dispatchQueuedComposerTurnHeadless } from "./queuedComposerDispatch";

export interface QueuedComposerAutoDispatchGates {
  hasQueueableLiveTurn: boolean;
  phase: SessionPhase;
  isSendBusy: boolean;
  isConnecting: boolean;
  steerGate: QueuedSteerGate | null;
  hasPendingApproval: boolean;
  hasPendingProgress: boolean;
  pendingUserInputCount: number;
  queuedTurnCount: number;
}

export function shouldAutoDispatchQueuedComposerTurn(
  gates: QueuedComposerAutoDispatchGates,
): boolean {
  return !(
    gates.hasQueueableLiveTurn ||
    gates.phase === "disconnected" ||
    gates.isSendBusy ||
    gates.isConnecting ||
    gates.steerGate !== null ||
    gates.hasPendingApproval ||
    gates.hasPendingProgress ||
    gates.pendingUserInputCount > 0 ||
    gates.queuedTurnCount === 0
  );
}

type QueuedComposerDispatchFn = (input: {
  threadId: ThreadId;
  queuedTurn: QueuedComposerTurn;
  dispatchMode: "queue" | "steer";
  assistantDeliveryMode: AssistantDeliveryMode;
}) => Promise<boolean>;

const claimedThreadIds = new Set<ThreadId>();
const autoDispatchLocks = new Set<ThreadId>();
const steerGatesByThreadId = new Map<ThreadId, QueuedSteerGate>();

let drainStartCount = 0;
let stopDrainSubscriptions: (() => void) | null = null;
let tickScheduled = false;
let steerExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let assistantDeliveryMode: AssistantDeliveryMode = "streaming";
let dispatchQueuedTurn: QueuedComposerDispatchFn = dispatchQueuedComposerTurnHeadless;
let nowMs: () => number = () => Date.now();

export function armQueuedComposerSteerGate(threadId: ThreadId, gate: QueuedSteerGate): void {
  steerGatesByThreadId.set(threadId, gate);
  requestQueuedComposerDrainPass();
}

export function clearQueuedComposerSteerGate(threadId: ThreadId): void {
  if (!steerGatesByThreadId.delete(threadId)) {
    return;
  }
  requestQueuedComposerDrainPass();
}

export function getQueuedComposerSteerGate(threadId: ThreadId): QueuedSteerGate | null {
  return steerGatesByThreadId.get(threadId) ?? null;
}

export function tryBeginQueuedComposerAutoDispatch(threadId: ThreadId): boolean {
  if (autoDispatchLocks.has(threadId)) {
    return false;
  }
  autoDispatchLocks.add(threadId);
  return true;
}

export function endQueuedComposerAutoDispatch(threadId: ThreadId): void {
  if (!autoDispatchLocks.delete(threadId)) {
    return;
  }
  requestQueuedComposerDrainPass();
}

// Module-scope try/finally: ChatView is a hot-path compiler target and cannot
// lower TryStatement without a catch. Callers must already hold the lock.
export async function runLockedQueuedComposerAutoDispatch(input: {
  threadId: ThreadId;
  run: () => Promise<void>;
  onSettled?: () => void;
}): Promise<void> {
  try {
    await input.run();
  } finally {
    input.onSettled?.();
    endQueuedComposerAutoDispatch(input.threadId);
  }
}

export function claimQueuedComposerAutoDispatch(threadId: ThreadId): void {
  claimedThreadIds.add(threadId);
}

export function releaseQueuedComposerAutoDispatch(threadId: ThreadId): void {
  claimedThreadIds.delete(threadId);
  requestQueuedComposerDrainPass();
}

export function setQueuedComposerDrainAssistantDeliveryMode(nextMode: AssistantDeliveryMode): void {
  assistantDeliveryMode = nextMode;
}

export function startQueuedComposerDrainWatcher(options?: {
  dispatch?: QueuedComposerDispatchFn;
  now?: () => number;
  assistantDeliveryMode?: AssistantDeliveryMode;
}): () => void {
  drainStartCount += 1;
  if (options?.dispatch) {
    dispatchQueuedTurn = options.dispatch;
  }
  if (options?.now) {
    nowMs = options.now;
  }
  if (options?.assistantDeliveryMode) {
    assistantDeliveryMode = options.assistantDeliveryMode;
  }
  if (drainStartCount === 1) {
    const unsubscribeDrafts = useComposerDraftStore.subscribe(() => {
      requestQueuedComposerDrainPass();
    });
    const unsubscribeStore = useStore.subscribe(() => {
      requestQueuedComposerDrainPass();
    });
    stopDrainSubscriptions = () => {
      unsubscribeDrafts();
      unsubscribeStore();
    };
    requestQueuedComposerDrainPass();
  }
  return () => {
    drainStartCount = Math.max(0, drainStartCount - 1);
    if (drainStartCount > 0) {
      return;
    }
    stopDrainSubscriptions?.();
    stopDrainSubscriptions = null;
    if (steerExpiryTimer !== null) {
      clearTimeout(steerExpiryTimer);
      steerExpiryTimer = null;
    }
    tickScheduled = false;
    dispatchQueuedTurn = dispatchQueuedComposerTurnHeadless;
    nowMs = () => Date.now();
  };
}

function requestQueuedComposerDrainPass(): void {
  if (tickScheduled) {
    return;
  }
  tickScheduled = true;
  queueMicrotask(() => {
    tickScheduled = false;
    void runQueuedComposerDrainPass();
  });
}

export function resetQueuedComposerDrainForTests(): void {
  claimedThreadIds.clear();
  autoDispatchLocks.clear();
  steerGatesByThreadId.clear();
  drainStartCount = 0;
  stopDrainSubscriptions?.();
  stopDrainSubscriptions = null;
  if (steerExpiryTimer !== null) {
    clearTimeout(steerExpiryTimer);
    steerExpiryTimer = null;
  }
  tickScheduled = false;
  assistantDeliveryMode = "streaming";
  dispatchQueuedTurn = dispatchQueuedComposerTurnHeadless;
  nowMs = () => Date.now();
}

function collectThreadIdsWithQueuedTurns(): ThreadId[] {
  const drafts = useComposerDraftStore.getState().draftsByThreadId;
  const threadIds: ThreadId[] = [];
  for (const [threadId, draft] of Object.entries(drafts)) {
    if (draft.queuedTurns.length > 0) {
      threadIds.push(threadId as ThreadId);
    }
  }
  return threadIds;
}

function readQueuedComposerAutoDispatchGates(threadId: ThreadId): QueuedComposerAutoDispatchGates {
  const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
  const thread = getThreadFromState(useStore.getState(), threadId);
  const phase = derivePhase(thread?.session ?? null);
  const hasLiveTurn = phase === "running";
  const pendingApprovals = derivePendingApprovals(
    thread?.activities ?? [],
    thread?.pendingInteractions,
    {
      authoritativeHasPending: thread?.hasPendingApprovals,
      latestTurnId: thread?.latestTurn?.turnId,
    },
  );
  const pendingUserInputs = derivePendingUserInputs(
    thread?.activities ?? [],
    thread?.pendingInteractions,
    {
      authoritativeHasPending: thread?.hasPendingUserInput,
      latestTurnId: thread?.latestTurn?.turnId,
    },
  );
  return {
    hasQueueableLiveTurn: hasLiveTurn && thread?.session?.activeTurnId != null,
    phase,
    isSendBusy: false,
    isConnecting: phase === "connecting",
    steerGate: getQueuedComposerSteerGate(threadId),
    hasPendingApproval: pendingApprovals.length > 0,
    hasPendingProgress: pendingUserInputs.length > 0,
    pendingUserInputCount: pendingUserInputs.length,
    queuedTurnCount: draft?.queuedTurns.length ?? 0,
  };
}

function advanceSteerGates(): number | null {
  let earliestExpiryMs: number | null = null;
  const now = nowMs();
  for (const [threadId, gate] of [...steerGatesByThreadId.entries()]) {
    const thread = getThreadFromState(useStore.getState(), threadId);
    const transition = resolveQueuedSteerGateTransition({
      gate,
      phase: derivePhase(thread?.session ?? null),
      sessionErrored: thread?.session?.status === "error",
      activeTurnId: thread?.session?.activeTurnId ?? null,
      now,
    });
    if (transition.kind === "clear") {
      steerGatesByThreadId.delete(threadId);
      continue;
    }
    const nextGate = transition.gate;
    if (
      nextGate.sawInterruptGap !== gate.sawInterruptGap ||
      nextGate.gapStartedAt !== gate.gapStartedAt ||
      nextGate.armedActiveTurnId !== gate.armedActiveTurnId
    ) {
      steerGatesByThreadId.set(threadId, nextGate);
    }
    if (transition.expiresInMs !== null) {
      earliestExpiryMs =
        earliestExpiryMs === null
          ? transition.expiresInMs
          : Math.min(earliestExpiryMs, transition.expiresInMs);
    }
  }
  return earliestExpiryMs;
}

function runQueuedComposerDrainPass(): void {
  const steerExpiryMs = advanceSteerGates();
  if (steerExpiryTimer !== null) {
    clearTimeout(steerExpiryTimer);
    steerExpiryTimer = null;
  }
  if (steerExpiryMs !== null) {
    steerExpiryTimer = setTimeout(
      () => {
        steerExpiryTimer = null;
        requestQueuedComposerDrainPass();
      },
      Math.max(0, steerExpiryMs),
    );
  }

  const threadIds = collectThreadIdsWithQueuedTurns();
  for (const threadId of threadIds) {
    if (claimedThreadIds.has(threadId)) {
      continue;
    }
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    const nextQueuedTurn = draft?.queuedTurns[0];
    if (!nextQueuedTurn) {
      continue;
    }
    const gates = readQueuedComposerAutoDispatchGates(threadId);
    if (!shouldAutoDispatchQueuedComposerTurn(gates)) {
      continue;
    }
    if (!tryBeginQueuedComposerAutoDispatch(threadId)) {
      continue;
    }
    void runLockedQueuedComposerAutoDispatch({
      threadId,
      run: async () => {
        const succeeded = await dispatchQueuedTurn({
          threadId,
          queuedTurn: nextQueuedTurn,
          dispatchMode: "queue",
          assistantDeliveryMode,
        });
        if (succeeded) {
          useComposerDraftStore.getState().removeQueuedTurn(threadId, nextQueuedTurn.id);
        }
      },
    });
  }
}
