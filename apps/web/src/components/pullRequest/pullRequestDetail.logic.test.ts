import { describe, expect, it } from "vitest";

import type {
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetailInput,
} from "@synara/contracts";

import type { RightDockPane } from "~/rightDockStore.logic";

import {
  buildPullRequestDetailModel,
  buildPullRequestTimelineEvents,
  describePullRequestState,
  pullRequestDetailInputFromPane,
  pullRequestDetailInputKey,
  pullRequestPaneTabLabel,
  stripHtmlComments,
} from "./pullRequestDetail.logic";

function makeCommit(overrides: Partial<PullRequestCommit> = {}): PullRequestCommit {
  return {
    oid: "abcdef1234567890",
    messageHeadline: "Fix the widget",
    messageBody: "",
    committedDate: "2026-07-02T10:00:00Z",
    authors: [],
    ...overrides,
  };
}

function makeComment(overrides: Partial<PullRequestComment> = {}): PullRequestComment {
  return {
    id: "comment-1",
    kind: "issue-comment",
    author: { login: "reviewer", name: null, avatarUrl: null, url: null },
    body: "Looks good",
    createdAt: "2026-07-03T10:00:00Z",
    updatedAt: null,
    url: null,
    path: null,
    reviewState: null,
    ...overrides,
  };
}

function makeTimelineSource() {
  return {
    createdAt: "2026-07-01T10:00:00Z",
    author: { login: "author", name: null, avatarUrl: null, url: null },
    commits: [makeCommit()],
    comments: [makeComment()],
    mergedAt: null,
    closedAt: null,
  };
}

describe("pullRequestDetailInputKey", () => {
  it("builds a stable projectId:provider:repository#number identity", () => {
    const input: PullRequestDetailInput = {
      projectId: "project-1" as PullRequestDetailInput["projectId"],
      provider: "bitbucket",
      repository: "acme/widgets",
      number: 350,
    };
    expect(pullRequestDetailInputKey(input)).toBe("project-1:bitbucket:acme/widgets#350");
  });
});

describe("pullRequestPaneTabLabel", () => {
  it("formats the shared tab chip label", () => {
    expect(pullRequestPaneTabLabel(350)).toBe("PR #350");
  });
});

describe("describePullRequestState", () => {
  it("describes each state, with draft only applying to open pull requests", () => {
    expect(describePullRequestState("open", true)).toBe("Draft");
    expect(describePullRequestState("open", false)).toBe("Ready for review");
    expect(describePullRequestState("merged", true)).toBe("Merged");
    expect(describePullRequestState("closed", false)).toBe("Closed");
  });
});

describe("buildPullRequestTimelineEvents", () => {
  it("orders created, commit, and comment events chronologically", () => {
    const events = buildPullRequestTimelineEvents(makeTimelineSource());
    expect(events.map((event) => event.id)).toEqual(["created", "abcdef1234567890", "comment-1"]);
  });

  it("titles review comments differently from issue comments", () => {
    const events = buildPullRequestTimelineEvents({
      ...makeTimelineSource(),
      comments: [
        makeComment({ kind: "review" }),
        makeComment({ id: "comment-2", kind: "review-comment" }),
      ],
    });
    const titles = events.map((event) => event.title);
    expect(titles).toContain("reviewer reviewed");
    expect(titles).toContain("reviewer commented");
  });

  it("falls back to placeholders for missing authors and empty commit messages", () => {
    const events = buildPullRequestTimelineEvents({
      ...makeTimelineSource(),
      author: null,
      commits: [makeCommit({ messageHeadline: "" })],
      comments: [makeComment({ author: null })],
    });
    expect(events[0]?.title).toBe("Someone opened this pull request");
    expect(events[1]?.body).toBe("No commit message.");
    expect(events[2]?.title).toBe("Someone commented");
  });

  it("appends a merged event and suppresses the closed event when both timestamps exist", () => {
    const events = buildPullRequestTimelineEvents({
      ...makeTimelineSource(),
      mergedAt: "2026-07-04T10:00:00Z",
      closedAt: "2026-07-04T10:00:00Z",
    });
    const ids = events.map((event) => event.id);
    expect(ids).toContain("merged");
    expect(ids).not.toContain("closed");
    expect(events.at(-1)?.title).toBe("Pull request merged");
  });

  it("appends a closed event for a closed-but-unmerged pull request", () => {
    const events = buildPullRequestTimelineEvents({
      ...makeTimelineSource(),
      closedAt: "2026-07-04T10:00:00Z",
    });
    expect(events.at(-1)?.title).toBe("Pull request closed");
  });
});

describe("pullRequestDetailInputFromPane", () => {
  const basePane: RightDockPane = {
    id: "pane-1",
    kind: "pullRequest",
    threadId: null,
    diffTurnId: null,
    diffFilePath: null,
    filePath: null,
    pullRequestProjectId: "project-1" as RightDockPane["pullRequestProjectId"],
    pullRequestProvider: "bitbucket",
    pullRequestRepository: "acme/widgets",
    pullRequestNumber: 350,
    pullRequestInitialTab: null,
  };

  it("builds the detail input from a fully-populated pull request pane", () => {
    expect(pullRequestDetailInputFromPane(basePane)).toEqual({
      projectId: "project-1",
      provider: "bitbucket",
      repository: "acme/widgets",
      number: 350,
    });
  });

  it("returns null for empty pull request panes and other pane kinds", () => {
    expect(pullRequestDetailInputFromPane({ ...basePane, pullRequestNumber: null })).toBeNull();
    expect(pullRequestDetailInputFromPane({ ...basePane, kind: "diff" })).toBeNull();
  });
});

describe("stripHtmlComments", () => {
  it("removes PR template boilerplate comments", () => {
    expect(stripHtmlComments("<!-- ⚠️ READ BEFORE OPENING -->\n## Summary\nReal content.")).toBe(
      "## Summary\nReal content.",
    );
  });

  it("removes multi-line comments anywhere in the body", () => {
    expect(stripHtmlComments("Before\n<!--\nline one\nline two\n-->\nAfter")).toBe(
      "Before\n\nAfter",
    );
  });

  it("keeps comments inside fenced code blocks", () => {
    const markdown = "Intro\n```html\n<!-- keep me -->\n```\n<!-- drop me -->";
    expect(stripHtmlComments(markdown)).toBe("Intro\n```html\n<!-- keep me -->\n```");
  });

  it("passes plain markdown through untouched", () => {
    expect(stripHtmlComments("## Summary\n- item")).toBe("## Summary\n- item");
  });
});

const GITHUB_DETAIL_CAPABILITIES = {
  detail: true,
  diff: true,
  comments: true,
  checks: true,
  comment: true,
  resolveComment: true,
  stateMutation: true,
  merge: true,
} as const;

const READ_ONLY_DETAIL_CAPABILITIES = {
  detail: true,
  diff: true,
  comments: true,
  checks: false,
  comment: false,
  resolveComment: false,
  stateMutation: false,
  merge: false,
} as const;

describe("buildPullRequestDetailModel", () => {
  it("hides every mutation affordance for a read-only Bitbucket detail", () => {
    const model = buildPullRequestDetailModel({
      capabilities: { ...READ_ONLY_DETAIL_CAPABILITIES },
      state: "open",
      isDraft: false,
    });

    expect(model.tabs).toEqual(["summary", "code", "timeline"]);
    expect(model.actions).toEqual([]);
    expect(model.showCommentComposer).toBe(false);
    expect(model.showResolveControls).toBe(false);
    expect(model.showMergeability).toBe(false);
  });

  it("exposes merge, draft, and close actions for an open GitHub pull request", () => {
    const model = buildPullRequestDetailModel({
      capabilities: { ...GITHUB_DETAIL_CAPABILITIES },
      state: "open",
      isDraft: false,
    });

    expect(model.tabs).toEqual(["summary", "code", "timeline"]);
    expect(model.actions).toEqual(["merge", "draft", "close"]);
    expect(model.showCommentComposer).toBe(true);
    expect(model.showResolveControls).toBe(true);
    expect(model.showMergeability).toBe(true);
  });

  it("offers ready instead of merge and draft for a GitHub draft", () => {
    const model = buildPullRequestDetailModel({
      capabilities: { ...GITHUB_DETAIL_CAPABILITIES },
      state: "open",
      isDraft: true,
    });

    expect(model.actions).toEqual(["ready", "close"]);
  });

  it("offers only reopen for a closed GitHub pull request", () => {
    const model = buildPullRequestDetailModel({
      capabilities: { ...GITHUB_DETAIL_CAPABILITIES },
      state: "closed",
      isDraft: false,
    });

    expect(model.actions).toEqual(["reopen"]);
  });

  it("exposes no action for a merged pull request", () => {
    const model = buildPullRequestDetailModel({
      capabilities: { ...GITHUB_DETAIL_CAPABILITIES },
      state: "merged",
      isDraft: false,
    });

    expect(model.actions).toEqual([]);
  });
});
