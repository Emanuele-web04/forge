// FILE: ParatyBitbucketFlow.browser.tsx
// Purpose: Browser acceptance for the Paraty Bitbucket journey — one connection prompt,
//          mixed-provider rows with provider-aware selection, and a readable read-only
//          Bitbucket summary without mutation controls.
// Layer: Pull request acceptance test

import "../../index.css";

import type { ProjectId, PullRequestDetail, PullRequestListEntry } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { PullRequestList } from "./PullRequestList";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import {
  needsBitbucketConnection,
  PullRequestBitbucketConnectPrompt,
} from "./PullRequestBitbucketConnectPrompt";

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

function listEntry(overrides: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  return {
    projectId: "project-1" as PullRequestListEntry["projectId"],
    projectTitle: "Payment Seeker",
    provider: "github",
    repository: "acme/widgets",
    number: 7,
    title: "GitHub stays visible",
    url: "https://github.com/acme/widgets/pull/7",
    author: { login: "viewer", name: null, avatarUrl: null, url: null },
    headBranch: "feature/widgets",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 3,
    deletions: 1,
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:00:00.000Z",
    reviewDecision: null,
    viewerReviewRequested: false,
    isPinned: false,
    projectContexts: [],
    mergeability: "unknown",
    stack: null,
    labels: [],
    ...overrides,
  } as PullRequestListEntry;
}

function bitbucketEntry(): PullRequestListEntry {
  return listEntry({
    projectId: "project-payment-seeker" as PullRequestListEntry["projectId"],
    projectTitle: "Payment Seeker",
    provider: "bitbucket",
    repository: "paraty/payment-seeker",
    number: 42,
    title: "Read-only MCP acceptance",
    url: "https://bitbucket.org/paraty/payment-seeker/pull-requests/42",
    headBranch: "feature/mcp-acceptance",
    additions: null,
    deletions: null,
    mergeability: null,
    capabilities: { ...READ_ONLY_CAPABILITIES },
    viewerInvolvement: "unknown",
  });
}

function bitbucketDetail(): PullRequestDetail {
  return {
    projectId: "project-payment-seeker" as PullRequestDetail["projectId"],
    projectTitle: "Payment Seeker",
    workspaceRoot: "/tmp/payment-seeker",
    provider: "bitbucket",
    repository: "paraty/payment-seeker",
    number: 42,
    title: "Read-only MCP acceptance",
    body: "Acceptance detail body.",
    url: "https://bitbucket.org/paraty/payment-seeker/pull-requests/42",
    capabilities: { ...READ_ONLY_CAPABILITIES },
    author: { login: "ada", name: null, avatarUrl: null, url: null },
    state: "open" as const,
    isDraft: false,
    mergeable: null,
    mergeability: null,
    mergeStateStatus: null,
    reviewDecision: null,
    headBranch: "feature/mcp-acceptance",
    baseBranch: "main",
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:00:00.000Z",
    mergedAt: null,
    closedAt: null,
    maintainerCanModify: false,
    reviewers: [],
    labels: [],
    additions: null,
    deletions: null,
    changedFiles: null,
    checks: null,
    comments: [
      {
        id: "7",
        kind: "issue-comment" as const,
        author: { login: "reviewer", name: null, avatarUrl: null, url: null },
        body: "Acceptance review comment",
        createdAt: "2026-08-31T12:00:00.000Z",
        updatedAt: null,
        url: null,
        path: null,
        reviewState: null,
      },
    ],
    commentsTruncated: true,
    commentsIncomplete: false,
    commits: [],
    mergeCapabilities: {
      merge: false,
      squash: false,
      rebase: false,
      deleteBranchOnMerge: false,
    },
    stack: null,
    stackMetadataIncomplete: false,
  } as PullRequestDetail;
}

describe("Paraty Bitbucket flow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("asks for exactly one connection prompt when Paraty is not connected", async () => {
    expect(
      needsBitbucketConnection([
        { provider: "bitbucket", presetId: "paraty", status: "not-connected" },
      ]),
    ).toBe(true);
    expect(needsBitbucketConnection([])).toBe(false);
    expect(
      needsBitbucketConnection([
        { provider: "github", presetId: "paraty", status: "not-connected" },
      ]),
    ).toBe(false);

    const onOpenIntegrations = vi.fn();
    await render(<PullRequestBitbucketConnectPrompt onOpenIntegrations={onOpenIntegrations} />);

    const prompts = page.getByRole("button", { name: "Open integrations" });
    expect(prompts).toBeVisible();
    expect(document.body.textContent).toContain(
      "Connect Paraty MCP to include Bitbucket pull requests.",
    );
    await prompts.click();
    expect(onOpenIntegrations).toHaveBeenCalledOnce();
  });

  it("mixes provider rows and selects the Bitbucket identity", async () => {
    const onSelect = vi.fn();
    await render(
      <PullRequestList
        entries={[listEntry(), bitbucketEntry()]}
        grouped={null}
        selectedProjectId={undefined}
        selectedProvider={undefined}
        selectedRepo={undefined}
        selectedNumber={undefined}
        onSelect={onSelect}
        onTogglePinned={vi.fn()}
      />,
    );

    expect(page.getByText("GitHub", { exact: true })).toBeVisible();
    expect(page.getByText("Bitbucket", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("+0");

    document.querySelector<HTMLButtonElement>('button[data-provider="bitbucket"]')?.click();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({
      provider: "bitbucket",
      repository: "paraty/payment-seeker",
      number: 42,
    });
  });

  it("reads the Bitbucket summary without mutation controls", async () => {
    await render(<PullRequestSummaryTab detail={bitbucketDetail()} />);

    expect(page.getByRole("heading", { name: "Read-only MCP acceptance" })).toBeVisible();
    expect(page.getByText("Acceptance detail body.")).toBeVisible();
    expect(page.getByText("Acceptance review comment")).toBeVisible();
    expect(document.body.textContent).toContain(
      "More unresolved review comments may be available on Bitbucket.",
    );
    expect(document.body.textContent).toContain("Checks are unavailable from this provider.");
    const buttons = Array.from(document.querySelectorAll("button")).map(
      (button) => button.textContent?.replace(/\s+/g, " ").trim() ?? "",
    );
    expect(buttons).not.toContain("Reply");
    expect(document.querySelector('textarea[aria-label="Leave a comment"]')).toBeNull();
  });
});
