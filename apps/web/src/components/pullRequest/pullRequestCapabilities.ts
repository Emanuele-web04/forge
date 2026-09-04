// FILE: pullRequestCapabilities.ts
// Purpose: Centralize provider capability decisions for pull request rows — which fields are
//          safe to render for a given list entry — so list/detail components never branch on
//          `provider` independently (except the provider badge copy itself).
// Layer: Web domain helpers (no React)
// Exports: providerLabel, visibleRowFields

import type { PullRequestListEntry, PullRequestProvider } from "@synara/contracts";
import { LEGACY_GITHUB_PULL_REQUEST_CAPABILITIES } from "@synara/contracts";

export function providerLabel(provider: PullRequestProvider): "GitHub" | "Bitbucket" {
  return provider === "bitbucket" ? "Bitbucket" : "GitHub";
}

/** Which row affordances are meaningful for this entry. Bitbucket list rows carry null diff
 * stats, no checks, and no draft state, so those slots stay empty instead of fabricating
 * zeros or GitHub-only controls. Entries without capabilities predate the provider-aware
 * contracts and keep the legacy GitHub presentation. */
export function visibleRowFields(entry: PullRequestListEntry): {
  showDiffStats: boolean;
  showChecks: boolean;
  showDraft: boolean;
} {
  const capabilities = entry.capabilities ?? LEGACY_GITHUB_PULL_REQUEST_CAPABILITIES;
  return {
    showDiffStats: entry.additions !== null || entry.deletions !== null,
    showChecks: capabilities.checks,
    showDraft: entry.provider === "github" && entry.isDraft,
  };
}
