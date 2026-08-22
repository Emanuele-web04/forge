/**
 * Thread-scoped device metadata cache.
 *
 * The live simulator surface is a canvas fed by binary frames; this store keeps
 * only the metadata the pane chrome needs (device list, attachment, agent
 * activity, availability) so a thread switch renders instantly and a late push
 * can never roll the pane back to an older generation.
 *
 * Deliberately not persisted: device boot state is only meaningful while the
 * server that reported it is alive, and a stale "Booted" from last week's
 * session would render a picker that lies.
 */

import type { ThreadDeviceState, ThreadId } from "@synara/contracts";
import { create } from "zustand";

interface DeviceStateStore {
  threadStatesByThreadId: Record<string, ThreadDeviceState | undefined>;
  upsertThreadState: (state: ThreadDeviceState) => void;
  removeThreadState: (threadId: ThreadId) => void;
  clear: () => void;
}

export const useDeviceStateStore = create<DeviceStateStore>()((set) => ({
  threadStatesByThreadId: {},
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
      return {
        threadStatesByThreadId: {
          ...current.threadStatesByThreadId,
          [state.threadId]: state,
        },
      };
    }),
  removeThreadState: (threadId) =>
    set((current) => {
      if (!Object.hasOwn(current.threadStatesByThreadId, threadId)) {
        return current;
      }
      const nextThreadStatesByThreadId = { ...current.threadStatesByThreadId };
      delete nextThreadStatesByThreadId[threadId];
      return { threadStatesByThreadId: nextThreadStatesByThreadId };
    }),
  clear: () => set({ threadStatesByThreadId: {} }),
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
