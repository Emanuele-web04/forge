// FILE: environmentDirectory.ts
// Purpose: The list of environments the UI can start work in, with their live
//          reachability. One source of truth for the composer's "Start in"
//          picker and the pairing screen.
// Layer: Web environment UX
// Exports: the directory snapshot, its subscription hook, and label resolution.

import { useCallback, useSyncExternalStore } from "react";
import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { createListenerRegistry } from "./listenerRegistry";
import { listWsEnvironmentClients, onWsEnvironmentRegistryChange } from "./wsEnvironmentRegistry";

export type EnvironmentReachability = "reachable" | "unreachable" | "checking";

export interface EnvironmentDirectoryEntry {
  readonly environmentId: EnvironmentId;
  /** Human label. Falls back to the id so an entry is never nameless. */
  readonly label: string;
  readonly isLocal: boolean;
  readonly reachability: EnvironmentReachability;
  /** Absolute WS URL for a remote environment; null for the page's own server. */
  readonly wsUrl: string | null;
  /** Descriptor once `server.getEnvironment` has answered. */
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
}

const LOCAL_LABEL = "This computer";

const directoryListeners = createListenerRegistry<void>();
const metadataByEnvironmentId = new Map<
  EnvironmentId,
  {
    label?: string;
    reachability?: EnvironmentReachability;
    descriptor?: ExecutionEnvironmentDescriptor;
  }
>();

/**
 * Cached snapshot.
 *
 * `useSyncExternalStore` compares snapshots by identity, so returning a fresh
 * array each call would re-render every subscriber on every check and, in
 * StrictMode, loop. The snapshot is rebuilt only when something actually
 * changes.
 */
let cachedSnapshot: readonly EnvironmentDirectoryEntry[] = [];

function rebuildSnapshot(): void {
  cachedSnapshot = listWsEnvironmentClients().map((client): EnvironmentDirectoryEntry => {
    const isLocal = client.environmentId === LOCAL_ENVIRONMENT_ID;
    const metadata = metadataByEnvironmentId.get(client.environmentId);
    return {
      environmentId: client.environmentId,
      label: metadata?.label ?? (isLocal ? LOCAL_LABEL : client.environmentId),
      isLocal,
      // The page's own server is reachable by definition — the page loaded from it.
      reachability: isLocal ? "reachable" : (metadata?.reachability ?? "checking"),
      wsUrl: client.wsUrl,
      descriptor: metadata?.descriptor ?? null,
    };
  });
}

rebuildSnapshot();
onWsEnvironmentRegistryChange(() => {
  rebuildSnapshot();
  directoryListeners.emit();
});

/** Records what an environment reported about itself. */
export function recordEnvironmentDescriptor(
  environmentId: EnvironmentId,
  descriptor: ExecutionEnvironmentDescriptor,
): void {
  const existing = metadataByEnvironmentId.get(environmentId) ?? {};
  metadataByEnvironmentId.set(environmentId, {
    ...existing,
    descriptor,
    label: descriptor.label,
    reachability: "reachable",
  });
  rebuildSnapshot();
  directoryListeners.emit();
}

export function recordEnvironmentReachability(
  environmentId: EnvironmentId,
  reachability: EnvironmentReachability,
): void {
  const existing = metadataByEnvironmentId.get(environmentId) ?? {};
  if (existing.reachability === reachability) return;
  metadataByEnvironmentId.set(environmentId, { ...existing, reachability });
  rebuildSnapshot();
  directoryListeners.emit();
}

export function forgetEnvironmentMetadata(environmentId: EnvironmentId): void {
  if (!metadataByEnvironmentId.delete(environmentId)) return;
  rebuildSnapshot();
  directoryListeners.emit();
}

/** Test seam. */
export function resetEnvironmentDirectory(): void {
  metadataByEnvironmentId.clear();
  rebuildSnapshot();
  directoryListeners.emit();
}

export function environmentDirectorySnapshot(): readonly EnvironmentDirectoryEntry[] {
  return cachedSnapshot;
}

export function environmentLabel(environmentId: EnvironmentId): string {
  if (environmentId === LOCAL_ENVIRONMENT_ID) return LOCAL_LABEL;
  return metadataByEnvironmentId.get(environmentId)?.label ?? environmentId;
}

export function useEnvironmentDirectory(): readonly EnvironmentDirectoryEntry[] {
  const subscribe = useCallback(
    (listener: () => void) => directoryListeners.subscribe(listener),
    [],
  );
  return useSyncExternalStore(
    subscribe,
    environmentDirectorySnapshot,
    environmentDirectorySnapshot,
  );
}
