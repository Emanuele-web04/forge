import type {
  ComputerEvent,
  ComputerOpenPaneRequestedEvent,
  ComputerWindow,
  ThreadComputerState,
  ThreadId,
} from "@synara/contracts";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

type ComputerActionEvent = Extract<ComputerEvent, { type: "computer.action" }>;

interface ComputerStateStore {
  threadStatesByThreadId: Record<string, ThreadComputerState | undefined>;
  /** Newest desktop action per thread, so one thread never reads another's. */
  lastActionByThreadId: Record<string, ComputerActionEvent | undefined>;
  /** Open requests no surface has honored yet, latest per thread. */
  pendingOpenRequests: Record<string, ComputerOpenPaneRequestedEvent | undefined>;
  queueOpenRequest: (event: ComputerOpenPaneRequestedEvent) => void;
  takeOpenRequests: () => ComputerOpenPaneRequestedEvent[];
  upsertThreadState: (state: ThreadComputerState) => void;
  applyWindowsChanged: (windows: readonly ComputerWindow[]) => void;
  recordAction: (action: ComputerActionEvent) => void;
  removeThreadState: (threadId: ThreadId) => void;
  clear: () => void;
}

export const useComputerStateStore = create<ComputerStateStore>()((set, get) => ({
  threadStatesByThreadId: {},
  lastActionByThreadId: {},
  pendingOpenRequests: {},
  queueOpenRequest: (event) =>
    set((current) => ({
      pendingOpenRequests: { ...current.pendingOpenRequests, [event.threadId]: event },
    })),
  takeOpenRequests: () => {
    const requests = Object.values(get().pendingOpenRequests).filter(
      (event) => event !== undefined,
    );
    if (requests.length > 0) set({ pendingOpenRequests: {} });
    return requests;
  },
  upsertThreadState: (state) =>
    set((current) => {
      const previousState = current.threadStatesByThreadId[state.threadId];
      if (previousState && previousState.version >= state.version) {
        return current;
      }
      return {
        ...current,
        threadStatesByThreadId: {
          ...current.threadStatesByThreadId,
          [state.threadId]: state,
        },
      };
    }),
  applyWindowsChanged: (windows) =>
    set((current) => {
      let changed = false;
      const nextStates = { ...current.threadStatesByThreadId };
      for (const [threadId, state] of Object.entries(current.threadStatesByThreadId)) {
        if (!state || state.windows === windows) {
          continue;
        }
        nextStates[threadId] = { ...state, windows };
        changed = true;
      }
      return changed ? { ...current, threadStatesByThreadId: nextStates } : current;
    }),
  recordAction: (action) =>
    set((current) => {
      // Unattributed pane input belongs to no thread, and nothing reads a
      // cross-thread "newest action": keeping the state identical leaves every
      // subscriber unnotified instead of re-rendering them for nobody.
      const threadId = action.threadId;
      if (!threadId) {
        return current;
      }
      return {
        ...current,
        lastActionByThreadId: {
          ...current.lastActionByThreadId,
          [threadId]: action,
        },
      };
    }),
  removeThreadState: (threadId) =>
    set((current) => {
      const hasState = Object.hasOwn(current.threadStatesByThreadId, threadId);
      const hasAction = Object.hasOwn(current.lastActionByThreadId, threadId);
      const hasOpenRequest = Object.hasOwn(current.pendingOpenRequests, threadId);
      if (!hasState && !hasAction && !hasOpenRequest) {
        return current;
      }
      const nextThreadStatesByThreadId = { ...current.threadStatesByThreadId };
      delete nextThreadStatesByThreadId[threadId];
      const nextLastActionByThreadId = { ...current.lastActionByThreadId };
      delete nextLastActionByThreadId[threadId];
      const pendingOpenRequests = { ...current.pendingOpenRequests };
      delete pendingOpenRequests[threadId];
      return {
        ...current,
        threadStatesByThreadId: nextThreadStatesByThreadId,
        lastActionByThreadId: nextLastActionByThreadId,
        pendingOpenRequests,
      };
    }),
  clear: () =>
    set({
      threadStatesByThreadId: {},
      lastActionByThreadId: {},
      pendingOpenRequests: {},
    }),
}));

export function selectThreadComputerState(
  threadId: ThreadId,
): (store: ComputerStateStore) => ThreadComputerState | undefined {
  return (store) => store.threadStatesByThreadId[threadId];
}

export function selectThreadComputerAction(
  threadId: ThreadId,
): (store: ComputerStateStore) => ComputerActionEvent | undefined {
  return (store) => store.lastActionByThreadId[threadId];
}

/** Composer availability must not subscribe to desktop activity or geometry. */
export function useThreadComputerAvailability(threadId: ThreadId) {
  return useComputerStateStore(
    useShallow((state) => state.threadStatesByThreadId[threadId]?.availability),
  );
}
