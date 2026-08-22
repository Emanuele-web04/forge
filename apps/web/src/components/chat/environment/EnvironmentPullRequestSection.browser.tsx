// FILE: EnvironmentPullRequestSection.browser.tsx
// Purpose: Browser regression tests for PR actions in the Environment panel.
// Layer: Vitest browser tests

import "../../../index.css";

import {
  ThreadId,
  type GitPullRequestSnapshotResult,
  type GitResolvedPullRequest,
  type GitStatusResult,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { gitPullRequestSnapshotQueryOptions, gitQueryKeys } from "~/lib/gitReactQuery";
import { EnvironmentPullRequestSection } from "./EnvironmentPullRequestSection";

const cwd = "/repo";
const threadId = ThreadId.makeUnsafe("thread-pr-fix-actions");
const pullRequest = {
  number: 321,
  title: "Keep PR context visible",
  url: "https://github.com/example/synara/pull/321",
  baseBranch: "main",
  headBranch: "fix/pr-panel",
  state: "open",
  isDraft: false,
  mergeability: "conflicting",
  additions: 4,
  deletions: 2,
  changedFiles: 1,
} satisfies GitResolvedPullRequest;

// Seeds both cached queries so the component renders without calling the native API.
function createQueryClient(commentsOverride?: GitPullRequestSnapshotResult["comments"]) {
  const queryClient = new QueryClient();
  const gitStatus = {
    branch: pullRequest.headBranch,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    upstreamBranch: `origin/${pullRequest.headBranch}`,
    aheadCount: 0,
    behindCount: 0,
    pr: pullRequest,
  } satisfies GitStatusResult;
  const snapshot = {
    pullRequest,
    checks: [],
    comments: commentsOverride ?? [
      {
        id: "comment-1",
        author: "reviewer",
        body: "Preserve the Environment panel while drafting the fix.",
        path: "EnvironmentPullRequestSection.tsx",
        url: `${pullRequest.url}#discussion_r1`,
        createdAt: "2026-07-09T10:00:00Z",
      },
      {
        id: "comment-2",
        author: "reviewer",
        body: "Address the second review finding too.",
        path: "OtherFile.tsx",
        url: `${pullRequest.url}#discussion_r2`,
        createdAt: "2026-07-09T10:01:00Z",
      },
    ],
    commentsTruncated: false,
    commentsError: null,
  } satisfies GitPullRequestSnapshotResult;

  queryClient.setQueryData(gitQueryKeys.status(cwd), gitStatus);
  queryClient.setQueryData(
    gitPullRequestSnapshotQueryOptions({
      cwd,
      reference: pullRequest.url,
      enabled: true,
    }).queryKey,
    snapshot,
  );
  return queryClient;
}

describe("EnvironmentPullRequestSection", () => {
  afterEach(() => {
    useComposerDraftStore.getState().clearDraftThread(threadId);
    document.body.innerHTML = "";
  });

  it("groups all review comments into one prompt and keeps the panel open", async () => {
    const onClose = vi.fn();
    const queryClient = createQueryClient();
    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentPullRequestSection
          gitCwd={cwd}
          enabled
          activeThreadId={threadId}
          projectId={null}
          configuredRepositories={[{ nameWithOwner: "example/synara" }]}
          onOpenUrl={vi.fn()}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );

    document
      .querySelector<HTMLButtonElement>('button[title*="resolve the merge conflicts"]')
      ?.click();
    document
      .querySelector<HTMLButtonElement>(
        'button[title="Draft one prompt containing all visible review comments"]',
      )
      ?.click();

    const prompt = useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "";
    expect(prompt).toContain("has merge conflicts with its base branch");
    expect(prompt).toContain("Preserve the Environment panel while drafting the fix.");
    expect(prompt).toContain("Address the second review finding too.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("scrolls long comment lists instead of crushing the rows", async () => {
    const comments = Array.from({ length: 6 }, (_, index) => ({
      id: `long-${index}`,
      author: "chatgpt-codex-connector",
      body: `**Finding ${index}: gateway compensation skips branch cleanup**\n\n<sub>Medium Severity</sub> <!-- DESCRIPTION START --> When a worktree creation partially fails, the compensation path returns before deleting the branch revision that was created, leaving orphaned refs behind. <!-- DESCRIPTION END -->`,
      path: "apps/server/src/agentGateway/creationCoordinator.ts",
      url: `${pullRequest.url}#discussion_r${index}`,
      createdAt: "2026-08-07T10:00:00Z",
    }));
    const queryClient = createQueryClient(comments);
    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentPullRequestSection
          gitCwd={cwd}
          enabled
          activeThreadId={threadId}
          projectId={null}
          configuredRepositories={[{ nameWithOwner: "example/synara" }]}
          onOpenUrl={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await page.getByText("6 comments").click();
    await expect
      .poll(() => document.body.textContent?.includes("Finding 0"), { timeout: 5000 })
      .toBe(true);

    // Bot metadata markers are display noise and must never reach the popup.
    expect(document.body.textContent).not.toContain("DESCRIPTION START");

    // Reviewer avatar renders for each comment row.
    const avatars = document.querySelectorAll('img[src*="avatars.githubusercontent.com"]');
    expect(avatars.length).toBe(comments.length);

    // Every clamped title/snippet keeps at least one full line: when the list
    // overflows its max height, rows must scroll rather than flex-shrink into
    // slivers (their overflow-hidden spans have no automatic minimum size).
    const clamped = Array.from(document.querySelectorAll("span.line-clamp-2")).filter((span) =>
      span.textContent?.includes("Finding"),
    );
    expect(clamped.length).toBeGreaterThan(0);
    for (const span of clamped) {
      const lineHeight = Number.parseFloat(getComputedStyle(span).lineHeight);
      expect(span.getBoundingClientRect().height).toBeGreaterThanOrEqual(lineHeight - 0.5);
    }
  });
});
