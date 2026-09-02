// FILE: modelFavorites.ts
// Purpose: Shared storage keys + readers for per-provider favorite model slugs.
// Layer: Web local-storage helpers used by the model picker and model cycle shortcuts.

import type { ProviderKind } from "@synara/contracts";
import { Schema } from "effect";

export const FAVORITE_MODEL_STORAGE_KEYS = {
  cursor: "synara:cursor-favourite-models:v1",
  opencode: "synara:opencode-favourite-models:v1",
  pi: "synara:pi-favourite-models:v1",
} as const;

const LEGACY_KILO_FAVORITE_MODEL_STORAGE_KEY = "synara:kilo-favourite-models:v1";

export type FavoriteModelProvider = keyof typeof FAVORITE_MODEL_STORAGE_KEYS;

const FavoriteModelSlugsSchema = Schema.Array(Schema.String);

function getLocalStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function decodeFavoriteModelSlugs(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const decoded = Schema.decodeUnknownSync(FavoriteModelSlugsSchema)(parsed);
    return Array.from(new Set(decoded.filter((entry) => entry.trim().length > 0)));
  } catch {
    return null;
  }
}

/** Preserve Kilo picker preferences after its provider data is migrated to OpenCode. */
export function migrateLegacyKiloFavoriteModelSlugs(
  storage: Storage | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    const legacyRaw = storage.getItem(LEGACY_KILO_FAVORITE_MODEL_STORAGE_KEY);
    if (!legacyRaw) return;
    const legacyFavorites = decodeFavoriteModelSlugs(legacyRaw);
    if (!legacyFavorites) return;

    const currentRaw = storage.getItem(FAVORITE_MODEL_STORAGE_KEYS.opencode);
    const currentFavorites = currentRaw ? (decodeFavoriteModelSlugs(currentRaw) ?? []) : [];
    const mergedFavorites = Array.from(new Set([...currentFavorites, ...legacyFavorites]));
    storage.setItem(FAVORITE_MODEL_STORAGE_KEYS.opencode, JSON.stringify(mergedFavorites));
    storage.removeItem(LEGACY_KILO_FAVORITE_MODEL_STORAGE_KEY);
  } catch {
    // Best-effort preference migration; leave the legacy value for a later retry.
  }
}

export function supportsModelFavorites(provider: ProviderKind): provider is FavoriteModelProvider {
  return provider === "cursor" || provider === "opencode" || provider === "pi";
}

// Read favorite slugs for cycle order. Failures (SSR, parse errors) return [].
export function readFavoriteModelSlugs(provider: ProviderKind): string[] {
  const storage = getLocalStorage();
  if (!supportsModelFavorites(provider) || !storage) {
    return [];
  }
  try {
    const raw = storage.getItem(FAVORITE_MODEL_STORAGE_KEYS[provider]);
    return raw ? (decodeFavoriteModelSlugs(raw) ?? []) : [];
  } catch {
    return [];
  }
}

migrateLegacyKiloFavoriteModelSlugs();
