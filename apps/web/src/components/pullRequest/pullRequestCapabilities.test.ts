import { describe, expect, it } from "vitest";

import type { PullRequestListEntry } from "@synara/contracts";

import { providerLabel, visibleRowFields } from "./pullRequestCapabilities";

function makeEntry(overrides: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  return {
    projectId: "project-1" as PullRequestListEntry["projectId"],
    projectTitle: "Project One",
    provider: "github",
    repository: "acme/widgets",
    number: 1,
    title: "Untitled",
    url: "https://github.com/acme/widgets/pull/1",
    author: null,
    headBranch: "feature",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 2,
    deletions: 1,
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-14T08:00:00.000Z",
    reviewDecision: null,
    viewerReviewRequested: false,
    isPinned: false,
    projectContexts: [],
    mergeability: "unknown",
    stack: null,
    labels: [],
    capabilities: { ...LEGACY_GITHUB_CAPABILITIES },
    viewerInvolvement: "none",
    ...overrides,
  } as PullRequestListEntry;
}

const LEGACY_GITHUB_CAPABILITIES = {
  detail: true,
  diff: true,
  comments: true,
  checks: true,
  comment: true,
  resolveComment: true,
  stateMutation: true,
  merge: true,
} as const;

const READ_ONLY_CAPABILITIES = {
  detail: true,
  diff: true,
  comments: true,
  checks: false,
  comment: false,
  resolveComment: false,
  stateMutation: false,
  merge: false,
} as const;

describe("providerLabel", () => {
  it("labels both providers with stable accessible copy", () => {
    expect(providerLabel("github")).toBe("GitHub");
    expect(providerLabel("bitbucket")).toBe("Bitbucket");
  });
});

describe("visibleRowFields", () => {
  it("shows diff stats, checks, and draft for GitHub rows", () => {
    expect(visibleRowFields(makeEntry({ isDraft: true }))).toEqual({
      showDiffStats: true,
      showChecks: true,
      showDraft: true,
    });
  });

  it("hides diff stats when both sides are unavailable", () => {
    expect(
      visibleRowFields(
        makeEntry({
          provider: "bitbucket",
          additions: null,
          deletions: null,
          mergeability: null,
          capabilities: { ...READ_ONLY_CAPABILITIES },
          viewerInvolvement: "unknown",
        }),
      ).showDiffStats,
    ).toBe(false);
  });

  it("keeps available diff sides without fabricating the missing one", () => {
    const fields = visibleRowFields(
      makeEntry({
        provider: "bitbucket",
        additions: null,
        deletions: 1,
        mergeability: null,
        capabilities: { ...READ_ONLY_CAPABILITIES },
        viewerInvolvement: "unknown",
      }),
    );
    expect(fields.showDiffStats).toBe(true);
    expect(fields.showChecks).toBe(false);
    expect(fields.showDraft).toBe(false);
  });

  it("never shows draft for Bitbucket rows", () => {
    expect(
      visibleRowFields(
        makeEntry({
          provider: "bitbucket",
          isDraft: true,
          additions: null,
          deletions: null,
          mergeability: null,
          capabilities: { ...READ_ONLY_CAPABILITIES },
          viewerInvolvement: "unknown",
        }),
      ).showDraft,
    ).toBe(false);
  });
});
