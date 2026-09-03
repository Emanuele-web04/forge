// FILE: lib/changelog.ts
// Purpose: Shared, server-importable helpers for the changelog — preserving
//          curated release order, building stable section anchors, and mapping
//          releases to shareable URL slugs. Centralizing this keeps the static
//          /changelog page, per-version routes, and the sitemap in sync.
// Layer: shared logic (no React).

import { CHANGELOG_ENTRIES, type ChangelogEntry } from "@/data/changelog";

// Stable in-page anchor per release, e.g. "0.1.1" -> "v0-1-1". Shared by the
// page sections and the left-rail nav so the two never drift.
export const toAnchor = (version: string) => `v${version.replace(/\./g, "-")}`;

// Shareable URL slug for a release, e.g. "0.1.1" -> "v0.1.1". Used as the
// dynamic [version] segment: /changelog/v0.1.1.
export const toVersionSlug = (version: string) => `v${version}`;

// Inverse of toVersionSlug: "v0.1.1" -> "0.1.1". Tolerates a missing "v" and
// returns the bare version string (callers validate it against the data).
export const fromVersionSlug = (slug: string) => (slug.startsWith("v") ? slug.slice(1) : slug);

/** All releases in the curated newest-first order from src/data/changelog.ts. */
export function getSortedReleases(): ChangelogEntry[] {
  return [...CHANGELOG_ENTRIES];
}

/** Find a release by its bare version string (e.g. "0.1.1"), or undefined. */
export function findRelease(version: string): ChangelogEntry | undefined {
  return CHANGELOG_ENTRIES.find((entry) => entry.version === version);
}
