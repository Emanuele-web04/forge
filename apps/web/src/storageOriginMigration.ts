// FILE: storageOriginMigration.ts
// Purpose: Imports Synara browser state before renderer stores hydrate after a desktop origin move.

import type { SynaraStorageSnapshot } from "@synara/contracts";

const MAX_SNAPSHOT_ENTRIES = 2_048;
const MAX_SNAPSHOT_KEY_LENGTH = 512;
const MAX_SNAPSHOT_VALUE_LENGTH = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

function isCanonicalStorageKey(key: string): boolean {
  return key.startsWith("synara:") || key.startsWith("synara.");
}

function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function importSynaraStorageSnapshot(
  snapshot: SynaraStorageSnapshot | null,
  storage = getLocalStorage(),
): boolean {
  if (!snapshot || !storage || snapshot.version !== 1 || !snapshot.entries) return false;
  const entries = Object.entries(snapshot.entries);
  if (entries.length > MAX_SNAPSHOT_ENTRIES) return false;

  try {
    if (
      !Number.isFinite(Date.parse(snapshot.exportedAt)) ||
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES
    ) {
      return false;
    }
    for (const [key, value] of entries) {
      if (
        !isCanonicalStorageKey(key) ||
        key.length > MAX_SNAPSHOT_KEY_LENGTH ||
        typeof value !== "string" ||
        value.length > MAX_SNAPSHOT_VALUE_LENGTH
      ) {
        return false;
      }
    }
    for (const [key, value] of entries) {
      if (storage.getItem(key) === null) storage.setItem(key, value);
    }
    return true;
  } catch {
    return false;
  }
}

export function bootstrapSynaraStorageOriginMigration(): void {
  const bridge = globalThis.window?.desktopBridge?.storageMigration;
  if (!bridge) return;

  try {
    const snapshot = bridge.readSnapshot();
    if (snapshot && importSynaraStorageSnapshot(snapshot)) {
      void bridge.acknowledgeSnapshot().catch(() => undefined);
    }
  } catch {
    // Keep the snapshot for a later retry if preload or storage is unavailable.
  }
}

bootstrapSynaraStorageOriginMigration();
