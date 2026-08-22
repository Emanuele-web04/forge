// FILE: confirmedCustomBinaryPathStore.ts
// Purpose: Persist which custom provider binary paths a successful session has
//   already confirmed, so the "uses a custom local binary path" warning does not
//   reappear on every app restart for a path that is already known to work.
// Layer: Web UI state utilities
// Exports: load/save helpers for the confirmed-path record.

import type { ProviderKind } from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { isPlainObject } from "./persistedRecord";

const STORAGE_KEY = "synara:confirmed-custom-binary-paths:v1";

const PROVIDER_KINDS: ReadonlySet<ProviderKind> = new Set(
  PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.kind),
);

function isProviderKind(value: string): value is ProviderKind {
  return PROVIDER_KINDS.has(value as ProviderKind);
}

export function loadConfirmedCustomBinaryPaths(): Partial<Record<ProviderKind, string>> {
  if (typeof window === "undefined") {
    return {};
  }
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) {
    return {};
  }
  // Validating keys against the known provider set also blocks prototype
  // pollution (e.g. "__proto__") from untrusted persisted input.
  const result: Partial<Record<ProviderKind, string>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isProviderKind(key) || typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      result[key] = trimmed;
    }
  }
  return result;
}

export function saveConfirmedCustomBinaryPaths(paths: Partial<Record<ProviderKind, string>>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // Best-effort persistence; ignore quota/availability errors.
  }
}
