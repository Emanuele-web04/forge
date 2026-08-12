import { Debouncer } from "@tanstack/react-pacer";
import type { PersistStorage, StorageValue } from "zustand/middleware";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DeferredPersistStorage<S> extends PersistStorage<S> {
  /** Serialize the latest captured state and write it through synchronously. */
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

/**
 * A zustand-persist-compatible storage that defers BOTH `partialize` and
 * `JSON.stringify` off the hot `set()` path.
 *
 * `createJSONStorage` (the zustand default) runs `partialize(get())` and the full
 * `JSON.stringify` of the entire store synchronously on every state change; only
 * the underlying `localStorage.setItem` I/O can be debounced. For large stores
 * (e.g. drafts carrying base64 image attachments) that per-keystroke serialization
 * is the dominant cost and stalls typing.
 *
 * Here, `setItem` only captures the latest `StorageValue` reference. The expensive
 * `partialize` + `JSON.stringify` runs a single time inside the debounced flush,
 * over the most recent captured state. The persisted bytes are identical to
 * `createJSONStorage` + a `partialize` config for the same final state — only
 * *when* serialization happens changes. At most one debounce window of changes can
 * be lost on a crash; wire `flush()` to `pagehide`/`visibilitychange` to bound that.
 *
 * IMPORTANT: pass `partialize` here and DO NOT also set `partialize` in the persist
 * config, otherwise partialize would run eagerly on every `set()` (defeating the
 * deferral) and then again at flush.
 */
interface PageHideEventTarget {
  readonly addEventListener: (type: string, listener: () => void) => void;
}

interface PageVisibilityTarget extends PageHideEventTarget {
  readonly visibilityState: string;
}

export interface FlushBeforePageHideEnv {
  readonly window?: PageHideEventTarget | undefined;
  readonly document?: PageVisibilityTarget | undefined;
}

/**
 * Flush a debounced/deferred storage before the page goes away, so at most one
 * debounce window of changes can be lost. Wires `beforeunload`, `pagehide`, and
 * `visibilitychange`→hidden — the latter two fire on mobile/bfcache navigations
 * where `beforeunload` does not. No-ops when the DOM globals are unavailable
 * (SSR / non-browser test environments), and is injectable for testing.
 */
export function flushStorageBeforePageHide(
  flush: () => void,
  env: FlushBeforePageHideEnv = {
    window: typeof window !== "undefined" ? window : undefined,
    document: typeof document !== "undefined" ? document : undefined,
  },
): void {
  // Guard each capability separately: SSR-style test environments stub partial
  // globals (e.g. a `document` with only `documentElement`), and this runs at
  // module scope in store files — a missing listener API must degrade to a
  // no-op, never crash module evaluation.
  const win = env.window;
  if (typeof win?.addEventListener === "function") {
    win.addEventListener("beforeunload", flush);
    win.addEventListener("pagehide", flush);
  }
  const doc = env.document;
  if (typeof doc?.addEventListener === "function") {
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "hidden") {
        flush();
      }
    });
  }
}

export function createDeferredPersistStorage<State, Persisted = State>(options: {
  readonly getStorage: () => StateStorage;
  readonly partialize: (state: State) => Persisted;
  readonly debounceMs?: number;
}): DeferredPersistStorage<Persisted> {
  const { getStorage, partialize, debounceMs = 300 } = options;

  // Latest pending write, captured lazily. Serialization is deferred to flush time.
  // zustand's persist calls setItem with the FULL store state as `value.state`
  // (there must be no `partialize` in the persist config — see the doc above), so
  // it is typed as `Persisted` per the PersistStorage contract but is really `State`.
  let pending: { readonly name: string; readonly value: StorageValue<Persisted> } | null = null;

  const writePending = (): void => {
    if (pending === null) {
      return;
    }
    const { name, value } = pending;
    pending = null;
    // Mirror zustand's `{ state, version }` StorageValue key order so the produced
    // bytes stay identical to createJSONStorage for the same state.
    getStorage().setItem(
      name,
      JSON.stringify({
        state: partialize(value.state as unknown as State),
        version: value.version,
      }),
    );
  };

  const debouncedWrite = new Debouncer(() => writePending(), { wait: debounceMs });

  const parse = (value: string | null): StorageValue<Persisted> | null =>
    value === null ? null : (JSON.parse(value) as StorageValue<Persisted>);

  return {
    getItem: (name) => {
      const raw = getStorage().getItem(name);
      return raw instanceof Promise ? raw.then(parse) : parse(raw);
    },
    setItem: (name, value) => {
      pending = { name, value };
      debouncedWrite.maybeExecute();
    },
    removeItem: (name) => {
      pending = null;
      debouncedWrite.cancel();
      getStorage().removeItem(name);
    },
    flush: () => {
      debouncedWrite.cancel();
      writePending();
    },
  };
}
