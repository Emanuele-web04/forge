// FILE: desktopStorageMigration.ts
// Purpose: Reads and acknowledges a validated browser-storage handoff from older desktop builds.
// Layer: Desktop main-process utility

import * as FS from "node:fs";
import * as Path from "node:path";

import type { SynaraStorageSnapshot } from "@synara/contracts";

export const SYNARA_STORAGE_SNAPSHOT_FILE_NAME = "synara-storage-origin-v1.json";
export const SYNARA_STORAGE_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const SYNARA_STORAGE_SNAPSHOT_MAX_ENTRIES = 2_048;
export const SYNARA_STORAGE_SNAPSHOT_MAX_KEY_LENGTH = 512;
export const SYNARA_STORAGE_SNAPSHOT_MAX_VALUE_LENGTH = 16 * 1024 * 1024;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isSynaraStorageKey(key: string): boolean {
  return key.startsWith("synara:") || key.startsWith("synara.");
}

export function validateSynaraStorageSnapshot(value: unknown): SynaraStorageSnapshot | null {
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.entries)) {
    return null;
  }
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) {
    return null;
  }

  const entries = Object.entries(value.entries);
  if (entries.length > SYNARA_STORAGE_SNAPSHOT_MAX_ENTRIES) {
    return null;
  }
  for (const [key, entryValue] of entries) {
    if (
      !isSynaraStorageKey(key) ||
      key.length === 0 ||
      key.length > SYNARA_STORAGE_SNAPSHOT_MAX_KEY_LENGTH ||
      typeof entryValue !== "string" ||
      entryValue.length > SYNARA_STORAGE_SNAPSHOT_MAX_VALUE_LENGTH
    ) {
      return null;
    }
  }

  const snapshot = value as unknown as SynaraStorageSnapshot;
  try {
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > SYNARA_STORAGE_SNAPSHOT_MAX_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  return snapshot;
}

export function resolveSynaraStorageSnapshotPath(userDataPath: string): string {
  return Path.join(userDataPath, SYNARA_STORAGE_SNAPSHOT_FILE_NAME);
}

export function readSynaraStorageSnapshot(snapshotPath: string): SynaraStorageSnapshot | null {
  try {
    const stats = FS.statSync(snapshotPath);
    if (!stats.isFile() || stats.size > SYNARA_STORAGE_SNAPSHOT_MAX_BYTES) {
      return null;
    }
    return validateSynaraStorageSnapshot(JSON.parse(FS.readFileSync(snapshotPath, "utf8")));
  } catch {
    return null;
  }
}

export async function acknowledgeSynaraStorageSnapshot(snapshotPath: string): Promise<void> {
  await FS.promises.rm(snapshotPath, { force: true }).catch(() => undefined);
}
