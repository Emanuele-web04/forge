import type { AnnotationSide, DiffLineAnnotation } from "@pierre/diffs";
import type {
  PullRequestReviewDraft,
  PullRequestReviewSide,
  PullRequestReviewThread,
} from "@synara/contracts";

export interface PullRequestReviewAnchor {
  path: string;
  line: number;
  side: PullRequestReviewSide;
}

export type PullRequestReviewAnnotationData =
  | {
      kind: "new-draft";
      anchor: PullRequestReviewAnchor;
    }
  | {
      kind: "draft";
      draft: PullRequestReviewDraft;
    }
  | {
      kind: "remote-thread";
      thread: PullRequestReviewThread;
    };

export type PullRequestReviewAnnotationsByFile = ReadonlyMap<
  string,
  ReadonlyArray<DiffLineAnnotation<PullRequestReviewAnnotationData>>
>;

export function toDiffAnnotationSide(side: PullRequestReviewSide): AnnotationSide {
  return side === "LEFT" ? "deletions" : "additions";
}

export function reviewAnchorKey(anchor: PullRequestReviewAnchor): string {
  return `${anchor.path}\u0000${String(anchor.line)}\u0000${anchor.side}`;
}
