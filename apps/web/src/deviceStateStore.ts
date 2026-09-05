/**
 * Thread-scoped device metadata and deferred pane requests.
 *
 * The live simulator surface is a canvas fed by binary frames; this store keeps
 * the metadata the pane chrome needs (device list, attachment, agent
 * activity, availability) so a thread switch renders instantly and a late push
 * can never roll the pane back to an older generation. Open requests wait here
 * until a chat surface can honor the user's automatic-opening preference.
 *
 * Deliberately not persisted: device boot state is only meaningful while the
 * server that reported it is alive, and a stale "Booted" from last week's
 * session would render a picker that lies.
 */

import type { DeviceOpenPaneRequestedEvent, ThreadDeviceState, ThreadId } from "@synara/contracts";
import { create } from "zustand";

interface DeviceStateStore {
  threadStatesByThreadId: Record<string, ThreadDeviceState | undefined>;
  pendingOpenRequests: Record<string, DeviceOpenPaneRequestedEvent | undefined>;
  queueOpenRequest: (event: DeviceOpenPaneRequestedEvent) => void;
  takeOpenRequests: () => DeviceOpenPaneRequestedEvent[];
  upsertThreadState: (state: ThreadDeviceState) => void;
  removeThreadState: (threadId: ThreadId) => void;
  clear: () => void;
}

export const useDeviceStateStore = create<DeviceStateStore>()((set, get) => ({
  threadStatesByThreadId: {},
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
      // The server pushes state independently of the RPCs the pane issues, so a
      // slow `device.getThreadState` response can land after a newer push. The
      // version is monotonic per thread; anything at or behind the current one
      // is a straggler and must not overwrite live attachment or device lists.
      if (previousState && previousState.version >= state.version) {
        return current;
      }
      // Detach, shutdown and thread removal cancel a deferred open. Keep this
      // behind the version gate so a late snapshot cannot discard a new request.
      let pendingOpenRequests = current.pendingOpenRequests;
      if (state.attachedDeviceUdid === null && pendingOpenRequests[state.threadId]) {
        pendingOpenRequests = { ...pendingOpenRequests };
        delete pendingOpenRequests[state.threadId];
      }
      return {
        pendingOpenRequests,
        threadStatesByThreadId: {
          ...current.threadStatesByThreadId,
          [state.threadId]: state,
        },
      };
    }),
  removeThreadState: (threadId) =>
    set((current) => {
      if (
        !Object.hasOwn(current.threadStatesByThreadId, threadId) &&
        !Object.hasOwn(current.pendingOpenRequests, threadId)
      ) {
        return current;
      }
      const nextThreadStatesByThreadId = { ...current.threadStatesByThreadId };
      delete nextThreadStatesByThreadId[threadId];
      const pendingOpenRequests = { ...current.pendingOpenRequests };
      delete pendingOpenRequests[threadId];
      return { threadStatesByThreadId: nextThreadStatesByThreadId, pendingOpenRequests };
    }),
  clear: () => set({ threadStatesByThreadId: {}, pendingOpenRequests: {} }),
}));

// Dev-only handle so the pane's availability and setup states — which otherwise
// require a Mac without Xcode, or a broken helper — can be driven directly when
// verifying the UI. Stripped from production builds by the import.meta.env guard.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__deviceStateStoreForTests = useDeviceStateStore;
}

export function selectThreadDeviceState(
  threadId: ThreadId,
): (store: DeviceStateStore) => ThreadDeviceState | undefined {
  return (store) => store.threadStatesByThreadId[threadId];
}
