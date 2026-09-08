// FILE: EnvironmentPullRequestSection.browser.tsx
// Purpose: Browser regression tests for the PR row menu in the Environment panel — Repair
//          attaches composer context cards, the comment list scrolls, and link actions close
//          the panel.
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
    checks: [
      { name: "Test, lint, build, and smoke", status: "failure", url: "https://ci.example/1" },
      { name: "Typecheck", status: "success", url: null },
    ],
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

function renderSection(queryClient: QueryClient, onClose = vi.fn()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <EnvironmentPullRequestSection
        gitCwd={cwd}
        enabled
        activeThreadId={threadId}
        // No project: Merge/Status stay hidden and View PR falls back to the URL handler.
        projectId={null}
        configuredRepositories={[{ nameWithOwner: "example/synara" }]}
        onOpenUrl={vi.fn()}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
}

async function openRepairSubmenu() {
  await page.getByText("#321 Keep PR context visible", { exact: true }).click();
  await expect.element(page.getByText("Repair", { exact: true })).toBeVisible();
  await page.getByText("Repair", { exact: true }).hover();
  await expect.element(page.getByText("Everything", { exact: true })).toBeVisible();
}

function draftCards() {
  return useComposerDraftStore.getState().draftsByThreadId[threadId]?.pullRequestContexts ?? [];
}

describe("EnvironmentPullRequestSection", () => {
  afterEach(() => {
    useComposerDraftStore.getState().clearDraftThread(threadId);
    document.body.innerHTML = "";
  });

  it("attaches one Repair card per scope instead of pasting prompt text", async () => {
    const onClose = vi.fn();
    const queryClient = createQueryClient();
    await renderSection(queryClient, onClose);

    await openRepairSubmenu();
    // Repair's badge counts comments + failing checks + conflicts.
    expect(document.body.textContent).toContain("Repair");
    await page.getByText("Failing checks", { exact: true }).click();

    await expect.poll(() => draftCards().length).toBe(1);
    expect(draftCards()[0]).toMatchObject({
      scope: "checks",
      prNumber: 321,
      title: "1 failing check",
      subtitle: "Test, lint, build, and smoke",
    });
    expect(draftCards()[0]?.text).toContain("Fix the failing CI checks on PR #321");
    // The prompt itself never lands in the editor.
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "").toBe("");
    expect(onClose).toHaveBeenCalledTimes(1);

    // A second scope adds a second card; re-picking the same scope replaces, not stacks.
    await openRepairSubmenu();
    await page.getByText("Everything", { exact: true }).click();
    await expect.poll(() => draftCards().length).toBe(2);
    expect(draftCards()[1]).toMatchObject({
      scope: "everything",
      title: "Repair PR #321",
      subtitle: "2 comments, 1 failing check, merge conflicts",
    });
    expect(draftCards()[1]?.text).toContain(
      "Preserve the Environment panel while drafting the fix.",
    );
    expect(draftCards()[1]?.text).toContain("Address the second review finding too.");
    expect(draftCards()[1]?.text).toContain("Merge conflicts:");

    await openRepairSubmenu();
    await page.getByText("Failing checks", { exact: true }).click();
    await expect.poll(() => draftCards().length).toBe(2);
    expect(draftCards().filter((card) => card.scope === "checks")).toHaveLength(1);
  });

  it("adds the pull request itself to the chat as a reference card", async () => {
    const queryClient = createQueryClient();
    await renderSection(queryClient);

    await page.getByText("#321 Keep PR context visible", { exact: true }).click();
    await page.getByText("Add to chat", { exact: true }).click();

    await expect.poll(() => draftCards().length).toBe(1);
    expect(draftCards()[0]).toMatchObject({
      scope: "reference",
      title: "#321 Keep PR context visible",
      subtitle: "fix/pr-panel → main",
    });
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
    await renderSection(queryClient);

    await page.getByText("#321 Keep PR context visible", { exact: true }).click();
    await expect.element(page.getByText("6 comments", { exact: true })).toBeVisible();
    await page.getByText("Comments", { exact: true }).hover();
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
