// FILE: environmentProviderStatus.ts
// Purpose: Each connected environment's provider statuses, so the UI can say
//          whether a host can actually run a chat before one is started there.
// Layer: Web environment UX
// Exports: the snapshot, its subscription hook, and the recording entry points.
//
// WHY THIS IS NOT react-query
//
// Provider statuses already flow per-connection: `serverProviderStatusesUpdated`
// is a push channel and `onServerProviderStatusesUpdated` takes an
// environmentId. What is missing is somewhere to PUT a second environment's
// answer. The existing consumer writes into `serverQueryKeys.config()`
// (`["server","config"]`), a key with no environment in it, which every settings
// screen and model picker reads as "this server".
//
// Feeding a remote host's statuses into that key would make the remote
// overwrite the local — the provider list in Settings would flicker to another
// machine's. Re-keying the whole server query namespace per environment is the
// real fix and is a large, independent refactor touching every server query.
//
// So this holds ONLY the per-environment view, the local `["server","config"]`
// path keeps its existing single-server meaning, and nothing that reads it
// today changes behavior.

import { useCallback, useSyncExternalStore } from "react";
import type { EnvironmentId, ServerProviderStatus } from "@synara/contracts";

import { createListenerRegistry } from "./listenerRegistry";

const statusListeners = createListenerRegistry<void>();
const statusesByEnvironmentId = new Map<EnvironmentId, readonly ServerProviderStatus[]>();

/**
 * Cached snapshot, rebuilt only on change.
 *
 * `useSyncExternalStore` compares by identity, so a fresh object per call would
 * re-render every subscriber on every check and loop under StrictMode.
 */
let cachedSnapshot: Readonly<Record<string, readonly ServerProviderStatus[]>> = {};

function rebuildSnapshot(): void {
  cachedSnapshot = Object.fromEntries(statusesByEnvironmentId);
}

/** Records what one environment reported about its providers. */
export function recordEnvironmentProviderStatuses(
  environmentId: EnvironmentId,
  statuses: readonly ServerProviderStatus[],
): void {
  statusesByEnvironmentId.set(environmentId, statuses);
  rebuildSnapshot();
  statusListeners.emit();
}

/**
 * Drops an environment's statuses when it is removed.
 *
 * Retaining them would let a disconnected host keep reporting "ready" from a
 * cached answer, which is exactly the stale claim this exists to avoid.
 */
export function forgetEnvironmentProviderStatuses(environmentId: EnvironmentId): void {
  if (!statusesByEnvironmentId.delete(environmentId)) return;
  rebuildSnapshot();
  statusListeners.emit();
}

/** Test seam. */
export function resetEnvironmentProviderStatuses(): void {
  statusesByEnvironmentId.clear();
  rebuildSnapshot();
  statusListeners.emit();
}

export function environmentProviderStatusSnapshot(): Readonly<
  Record<string, readonly ServerProviderStatus[]>
> {
  return cachedSnapshot;
}

/**
 * One environment's statuses, or `undefined` when it has not reported yet.
 *
 * `undefined` is load-bearing and must not be smoothed into an empty array:
 * callers distinguish "no providers are signed in" from "we have not heard
 * from this host yet", and only the first is something to tell the user about.
 */
export function environmentProviderStatuses(
  environmentId: EnvironmentId,
): readonly ServerProviderStatus[] | undefined {
  return statusesByEnvironmentId.get(environmentId);
}

export function useEnvironmentProviderStatuses(): Readonly<
  Record<string, readonly ServerProviderStatus[]>
> {
  const subscribe = useCallback((listener: () => void) => statusListeners.subscribe(listener), []);
  return useSyncExternalStore(
    subscribe,
    environmentProviderStatusSnapshot,
    environmentProviderStatusSnapshot,
  );
}
