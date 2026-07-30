// FILE: listenerRegistry.ts
// Purpose: Fanout helper whose delivery is isolated per listener.
// Layer: Web utility
// Exports: createListenerRegistry and subscribeWithReplay.

export interface ListenerRegistry<T> {
  readonly size: number;
  subscribe(listener: (payload: T) => void): () => void;
  emit(payload: T): void;
  clear(): void;
}

export function createListenerRegistry<T>(): ListenerRegistry<T> {
  const listeners = new Set<(payload: T) => void>();
  return {
    get size() {
      return listeners.size;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(payload) {
      for (const listener of listeners) {
        try {
          listener(payload);
        } catch {
          // A listener must not prevent delivery to the remaining subscribers.
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

/**
 * Subscribes and immediately replays the latest cached payload, closing the
 * race between socket connect and React effect registration.
 */
export function subscribeWithReplay<T>(input: {
  readonly registry: Pick<ListenerRegistry<T>, "subscribe">;
  readonly listener: (payload: T) => void;
  readonly latest: T | null;
}): () => void {
  const unsubscribe = input.registry.subscribe(input.listener);
  if (input.latest) {
    try {
      input.listener(input.latest);
    } catch {
      // Replay follows the same listener isolation as live delivery.
    }
  }
  return () => void unsubscribe();
}
