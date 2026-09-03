// FILE: PullRequestDetailPanel.browser.tsx
// Purpose: Browser regressions for capability-gated pull request detail controls.
// Layer: Pull request presentation test

import "../../index.css";

import type { ProjectId, PullRequestDetail, PullRequestDetailInput } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { pullRequestDiffQueryOptions, pullRequestQueryKeys } from "~/lib/pullRequestReactQuery";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";

vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({ settings: { defaultThreadEnvMode: "local" } }),
  };
});

vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: vi.fn() }),
}));

const PROJECT_ID = "project-1" as ProjectId;

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

const GITHUB_CAPABILITIES = {
  detail: true,
  diff: true,
  comments: true,
  checks: true,
  comment: true,
  resolveComment: true,
  stateMutation: true,
  merge: true,
} as const;

function detailFixture(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    projectId: PROJECT_ID,
    projectTitle: "Project One",
    workspaceRoot: "/workspace/project-one",
    provider: "bitbucket",
    repository: "paraty/payment-seeker",
    number: 12,
    title: "Read-only provider",
    body: "Read content remains visible.",
    url: "https://bitbucket.org/paraty/payment-seeker/pull-requests/12",
    capabilities: READ_ONLY_CAPABILITIES,
    author: { login: "author", name: null, avatarUrl: null, url: null },
    state: "open",
    isDraft: false,
    mergeable: null,
    mergeability: "mergeable",
    mergeStateStatus: null,
    reviewDecision: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    headBranch: "feature/readonly",
    baseBranch: "main",
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-14T08:00:00.000Z",
    mergedAt: null,
    closedAt: null,
    maintainerCanModify: false,
    reviewers: [],
    labels: [],
    checks: null,
    comments: [
      {
        id: "comment-1",
        kind: "issue-comment",
        author: { login: "reviewer", name: null, avatarUrl: null, url: null },
        body: "Review content remains visible.",
        createdAt: "2026-07-14T08:00:00.000Z",
        updatedAt: null,
        url: null,
        path: null,
        reviewState: null,
      },
    ],
    commentsTruncated: false,
    commentsIncomplete: false,
    commits: [],
    mergeCapabilities: {
      merge: true,
      squash: true,
      rebase: true,
      deleteBranchOnMerge: false,
    },
    stack: null,
    stackMetadataIncomplete: false,
    ...overrides,
  } as PullRequestDetail;
}

async function renderDetail(
  detail: PullRequestDetail,
  options: { initialTab?: "summary" | "timeline" | "code"; patch?: string } = {},
) {
  const input: PullRequestDetailInput = {
    projectId: detail.projectId,
    provider: detail.provider,
    repository: detail.repository,
    number: detail.number,
  };
  const queryClient = new QueryClient();
  queryClient.setQueryData(pullRequestQueryKeys.detail(input), detail);
  if (options.patch !== undefined) {
    queryClient.setQueryData(pullRequestDiffQueryOptions(input).queryKey, {
      patch: options.patch,
      truncated: false,
    });
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <PullRequestDetailPanel
        input={input}
        {...(options.initialTab ? { initialTab: options.initialTab } : {})}
        pollingEnabled={false}
      />
    </QueryClientProvider>,
  );
}

function visibleButtonLabels(): string[] {
  return Array.from(document.querySelectorAll("button"))
    .map((button) => button.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .filter((label) => label.length > 0);
}

describe("PullRequestDetailPanel capabilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hides read-only Bitbucket open-state write controls while preserving read content", async () => {
    await renderDetail(detailFixture());

    expect(page.getByRole("heading", { name: "Read-only provider" })).toBeVisible();
    expect(page.getByText("Read content remains visible.")).toBeVisible();
    expect(page.getByText("Review content remains visible.")).toBeVisible();
    expect(visibleButtonLabels()).not.toContain("Reply");
    expect(visibleButtonLabels()).not.toContain("Merge");
    expect(document.querySelector('textarea[aria-label="Leave a comment"]')).toBeNull();
    expect(document.querySelector('button[title="Post comment"]')).toBeNull();

    await page.getByRole("button", { name: "More actions" }).click();

    expect(document.body.textContent).toContain("Copy link");
    expect(document.body.textContent).toContain("Fix findings");
    expect(visibleButtonLabels()).not.toContain("Close pull request");
    expect(visibleButtonLabels()).not.toContain("Draft");
    expect(visibleButtonLabels()).not.toContain("Ready for review");
    expect(visibleButtonLabels()).not.toContain("Squash");
    expect(visibleButtonLabels()).not.toContain("Rebase");
  });

  it("hides read-only Bitbucket conflict resolution controls", async () => {
    await renderDetail(detailFixture({ mergeability: "conflicting" }));

    await page.getByRole("button", { name: "More actions" }).click();

    expect(document.body.textContent).toContain("Conflicts with main");
    expect(visibleButtonLabels()).not.toContain("Resolve conflicts");
  });

  it("hides read-only Bitbucket reopen controls", async () => {
    await renderDetail(
      detailFixture({
        state: "closed",
        mergeability: null,
        closedAt: "2026-07-15T08:00:00.000Z",
      }),
    );

    await page.getByRole("button", { name: "More actions" }).click();

    expect(page.getByRole("heading", { name: "Read-only provider" })).toBeVisible();
    expect(visibleButtonLabels()).not.toContain("Reopen pull request");
  });

  it("uses Bitbucket copy for incomplete comments without GitHub wording", async () => {
    await renderDetail(detailFixture({ commentsIncomplete: true }));

    expect(page.getByText("Review content remains visible.")).toBeVisible();
    expect(document.body.textContent).toContain(
      "Some unresolved review comments could not be loaded. Check Bitbucket for the complete review.",
    );
    expect(document.body.textContent).not.toContain("GitHub");
  });

  it("uses Bitbucket copy for truncated comments without GitHub wording", async () => {
    await renderDetail(detailFixture({ commentsTruncated: true }));

    expect(page.getByText("Review content remains visible.")).toBeVisible();
    expect(document.body.textContent).toContain(
      "More unresolved review comments may be available on Bitbucket.",
    );
    expect(document.body.textContent).not.toContain("GitHub");
  });

  it("preserves GitHub write controls when capabilities allow them", async () => {
    await renderDetail(
      detailFixture({
        provider: "github",
        repository: "acme/widgets",
        url: "https://github.com/acme/widgets/pull/12",
        capabilities: GITHUB_CAPABILITIES,
      }),
    );

    expect(visibleButtonLabels()).toContain("Merge");
    expect(visibleButtonLabels()).toContain("Reply");
    expect(document.querySelector('textarea[aria-label="Leave a comment"]')).not.toBeNull();

    await page.getByRole("button", { name: "More actions" }).click();

    expect(document.body.textContent).toContain("Close pull request");
    expect(document.body.textContent).toContain("Draft");
    expect(document.body.textContent).toContain("Ready for review");
  });

  it("renders the Bitbucket unified diff without mutation controls on the Code tab", async () => {
    await renderDetail(detailFixture(), {
      initialTab: "code",
      patch:
        "diff --git a/widget.ts b/widget.ts\n--- a/widget.ts\n+++ b/widget.ts\n@@ -1 +1 @@\n-const widget = 1;\n+const widget = 2;\n",
    });

    await vi.waitFor(() => {
      expect(page.getByText("widget.ts").first()).toBeVisible();
    });
    expect(visibleButtonLabels()).not.toContain("Merge");
    expect(visibleButtonLabels()).not.toContain("Reply");
    expect(document.querySelector('textarea[aria-label="Leave a comment"]')).toBeNull();
  });
});
