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

export type FavoriteModelProvider = keyof typeof FAVORITE_MODEL_STORAGE_KEYS;

const FavoriteModelSlugsSchema = Schema.Array(Schema.String);

export function supportsModelFavorites(provider: ProviderKind): provider is FavoriteModelProvider {
  return provider === "cursor" || provider === "opencode" || provider === "pi";
}

// Read favorite slugs for cycle order. Failures (SSR, parse errors) return [].
export function readFavoriteModelSlugs(provider: ProviderKind): string[] {
  if (!supportsModelFavorites(provider) || typeof globalThis.localStorage === "undefined") {
    return [];
  }
  try {
    const raw = globalThis.localStorage.getItem(FAVORITE_MODEL_STORAGE_KEYS[provider]);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const decoded = Schema.decodeUnknownSync(FavoriteModelSlugsSchema)(parsed);
    return decoded.filter((entry) => entry.trim().length > 0);
  } catch {
    return [];
  }
}
