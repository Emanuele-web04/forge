// FILE: pullRequestDetail.logic.ts
// Purpose: Pure helpers shared by every host of the pull request detail surface (the
//          /pull-requests route overlay and the chat right-dock pane): the canonical
//          pane identity key, the "PR #n" tab chip label, the plain-language state
//          descriptor, and the flattened chronological timeline event list.
// Layer: Web domain helpers (no React)
// Exports: pullRequestDetailInputKey, pullRequestPaneTabLabel, pullRequestDetailInputFromPane,
//          describePullRequestState, stripHtmlComments, PullRequestTimelineEvent,
//          buildPullRequestTimelineEvents

import type {
  PullRequestDetail,
  PullRequestDetailInput,
  PullRequestState,
} from "@synara/contracts";

import type { RightDockPane } from "~/rightDockStore.logic";

import { pullRequestMarkdownPreview } from "./pullRequestMarkdown.logic";

/** Canonical identity for one detail surface — used as the React key so switching the
 *  selected pull request remounts the panel (resetting its tab and diff state). */
export function pullRequestDetailInputKey(input: PullRequestDetailInput): string {
  return `${input.projectId}:${input.provider}:${input.repository}#${input.number}`;
}

/** Tab chip label shared by the route overlay chip and the right-dock pane tab. */
export function pullRequestPaneTabLabel(number: number): string {
  return `PR #${number}`;
}

/** The detail input a dock "pullRequest" pane points at, or null while the pane is empty.
 *  Single owner of the identity-fields guard so every pane consumer (content, tab icon)
 *  validates the same way. */
export function pullRequestDetailInputFromPane(pane: RightDockPane): PullRequestDetailInput | null {
  if (
    pane.kind !== "pullRequest" ||
    !pane.pullRequestProjectId ||
    !pane.pullRequestRepository ||
    !pane.pullRequestNumber
  ) {
    return null;
  }
  return {
    projectId: pane.pullRequestProjectId,
    provider: pane.pullRequestProvider ?? "github",
    repository: pane.pullRequestRepository,
    number: pane.pullRequestNumber,
  };
}

// Plain-language state descriptor shown next to the author line — the state color itself is
// already conveyed by the PullRequestStateGlyph in the header, so this stays neutral text.
// State only, matching git: conflicts are a merge signal and render as their own row.
export function describePullRequestState(state: PullRequestState, isDraft: boolean): string {
  if (isDraft && state === "open") return "Draft";
  if (state === "open") return "Ready for review";
  if (state === "merged") return "Merged";
  return "Closed";
}

// stripHtmlComments now lives with the rest of the markdown preprocessing.
export { stripHtmlComments } from "./pullRequestMarkdown.logic";

export interface PullRequestTimelineEvent {
  id: string;
  /** ISO timestamp the event sorts by. */
  at: string;
  title: string;
  body: string | null;
}

type PullRequestTimelineSource = Pick<
  PullRequestDetail,
  "createdAt" | "author" | "commits" | "comments" | "mergedAt" | "closedAt"
>;

/** Flattens creation, commits, comments/reviews, and the terminal merge/close event into one
 *  chronologically sorted list. Merged wins over closed: GitHub sets both timestamps on a
 *  merge, and showing "closed" for a merged pull request would misstate what happened. */
export function buildPullRequestTimelineEvents(
  detail: PullRequestTimelineSource,
): PullRequestTimelineEvent[] {
  const events: PullRequestTimelineEvent[] = [
    {
      id: "created",
      at: detail.createdAt,
      title: `${detail.author?.login ?? "Someone"} opened this pull request`,
      body: null,
    },
    ...detail.commits.map((commit) => ({
      id: commit.oid,
      at: commit.committedDate,
      title: `Commit ${commit.oid.slice(0, 7)}`,
      body: commit.messageHeadline || "No commit message.",
    })),
    ...detail.comments.map((comment) => ({
      id: comment.id,
      at: comment.createdAt,
      title: `${comment.author?.login ?? "Someone"} ${comment.kind === "review" ? "reviewed" : "commented"}`,
      // Timeline previews are plain text, so raw markdown/HTML would print literally.
      body: pullRequestMarkdownPreview(comment.body) || null,
    })),
    ...(detail.mergedAt
      ? [{ id: "merged", at: detail.mergedAt, title: "Pull request merged", body: null }]
      : []),
    ...(detail.closedAt && !detail.mergedAt
      ? [{ id: "closed", at: detail.closedAt, title: "Pull request closed", body: null }]
      : []),
  ];
  return events.toSorted((left, right) => left.at.localeCompare(right.at));
}
