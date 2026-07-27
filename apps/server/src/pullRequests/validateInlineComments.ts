import { parsePatchFiles } from "@pierre/diffs";
import type { PullRequestReviewDraft, PullRequestReviewSide } from "@synara/contracts";

type InlineAnchor = Pick<PullRequestReviewDraft, "id" | "path" | "line" | "side">;

function anchorKey(path: string, line: number, side: PullRequestReviewSide): string {
  return `${path}\u0000${line}\u0000${side}`;
}

function collectInlineCommentAnchors(patch: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  for (const parsedPatch of parsePatchFiles(patch)) {
    for (const file of parsedPatch.files) {
      for (const hunk of file.hunks) {
        for (let offset = 0; offset < hunk.deletionCount; offset += 1) {
          anchors.add(anchorKey(file.name, hunk.deletionStart + offset, "LEFT"));
        }
        for (let offset = 0; offset < hunk.additionCount; offset += 1) {
          anchors.add(anchorKey(file.name, hunk.additionStart + offset, "RIGHT"));
        }
      }
    }
  }

  return anchors;
}

export function validateInlineComments(
  patch: string,
  drafts: ReadonlyArray<InlineAnchor>,
): ReadonlyArray<string> {
  const anchors = collectInlineCommentAnchors(patch);
  return drafts.flatMap((draft) =>
    anchors.has(anchorKey(draft.path, draft.line, draft.side)) ? [] : [draft.id],
  );
}
