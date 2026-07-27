import type { DiffLineAnnotation } from "@pierre/diffs";
import type {
  PullRequestDetail,
  PullRequestDetailInput,
  PullRequestDiffResult,
  PullRequestReviewDraft,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import {
  pullRequestReviewDraftCreateMutationOptions,
  pullRequestReviewDraftDeleteMutationOptions,
  pullRequestReviewDraftsQueryOptions,
  pullRequestReviewDraftUpdateMutationOptions,
} from "~/lib/pullRequestReactQuery";
import { PullRequestReviewAnnotation } from "./PullRequestReviewAnnotation";
import {
  type PullRequestReviewAnchor,
  type PullRequestReviewAnnotationData,
  type PullRequestReviewAnnotationsByFile,
  toDiffAnnotationSide,
} from "./reviewAnnotations";

const EMPTY_REVIEW_DRAFTS: ReadonlyArray<PullRequestReviewDraft> = Object.freeze([]);

function pushAnnotation(
  map: Map<string, DiffLineAnnotation<PullRequestReviewAnnotationData>[]>,
  path: string,
  annotation: DiffLineAnnotation<PullRequestReviewAnnotationData>,
): void {
  const current = map.get(path);
  if (current) current.push(annotation);
  else map.set(path, [annotation]);
}

export function usePullRequestReview(input: {
  target: PullRequestDetailInput;
  detail: PullRequestDetail;
  diff: PullRequestDiffResult | undefined;
}) {
  const queryClient = useQueryClient();
  const [pendingAnchor, setPendingAnchor] = useState<PullRequestReviewAnchor | null>(null);
  const headSha = input.diff?.headSha ?? "";
  const patchSignature = input.diff?.patchSignature ?? "";
  const draftsQuery = useQuery(
    pullRequestReviewDraftsQueryOptions(input.target, Boolean(headSha && patchSignature)),
  );
  const createMutation = useMutation(pullRequestReviewDraftCreateMutationOptions(queryClient));
  const updateMutation = useMutation(pullRequestReviewDraftUpdateMutationOptions(queryClient));
  const deleteMutation = useMutation(pullRequestReviewDraftDeleteMutationOptions(queryClient));
  const drafts = draftsQuery.data?.drafts ?? EMPTY_REVIEW_DRAFTS;
  const { currentDrafts, staleDrafts } = useMemo(() => {
    const current: PullRequestReviewDraft[] = [];
    const stale: PullRequestReviewDraft[] = [];
    for (const draft of drafts) {
      if (draft.headSha === headSha && draft.patchSignature === patchSignature) {
        current.push(draft);
      } else {
        stale.push(draft);
      }
    }
    return { currentDrafts: current, staleDrafts: stale };
  }, [drafts, headSha, patchSignature]);

  const annotationsByFile = useMemo<PullRequestReviewAnnotationsByFile>(() => {
    const map = new Map<string, DiffLineAnnotation<PullRequestReviewAnnotationData>[]>();
    for (const draft of currentDrafts) {
      pushAnnotation(map, draft.path, {
        side: toDiffAnnotationSide(draft.side),
        lineNumber: draft.line,
        metadata: { kind: "draft", draft },
      });
    }
    for (const thread of input.detail.reviewThreads ?? []) {
      if (!thread.path || thread.line === null || !thread.side) continue;
      pushAnnotation(map, thread.path, {
        side: toDiffAnnotationSide(thread.side),
        lineNumber: thread.line,
        metadata: { kind: "remote-thread", thread },
      });
    }
    if (pendingAnchor) {
      pushAnnotation(map, pendingAnchor.path, {
        side: toDiffAnnotationSide(pendingAnchor.side),
        lineNumber: pendingAnchor.line,
        metadata: { kind: "new-draft", anchor: pendingAnchor },
      });
    }
    return map;
  }, [currentDrafts, input.detail.reviewThreads, pendingAnchor]);

  const createDraft = useCallback(
    (anchor: PullRequestReviewAnchor, body: string) => {
      if (!headSha || !patchSignature) return;
      createMutation.mutate(
        {
          ...input.target,
          headSha,
          patchSignature,
          path: anchor.path,
          line: anchor.line,
          side: anchor.side,
          body,
        },
        { onSuccess: () => setPendingAnchor(null) },
      );
    },
    [createMutation, headSha, input.target, patchSignature],
  );

  const updateDraft = useCallback(
    (draft: PullRequestReviewDraft, body: string) => {
      updateMutation.mutate({ ...input.target, id: draft.id, body });
    },
    [input.target, updateMutation],
  );
  const deleteDraft = useCallback(
    (draft: PullRequestReviewDraft) => {
      deleteMutation.mutate({ ...input.target, id: draft.id });
    },
    [deleteMutation, input.target],
  );
  const busy = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;
  const renderAnnotation = useCallback(
    (data: PullRequestReviewAnnotationData) => (
      <PullRequestReviewAnnotation
        data={data}
        busy={busy}
        onCreate={createDraft}
        onCancelCreate={() => setPendingAnchor(null)}
        onUpdate={updateDraft}
        onDelete={deleteDraft}
      />
    ),
    [busy, createDraft, deleteDraft, updateDraft],
  );

  return {
    annotationsByFile,
    startDraft: setPendingAnchor,
    renderAnnotation,
    drafts,
    currentDrafts,
    staleDrafts,
    deleteDraft,
    busy,
    isLoading: draftsQuery.isPending,
  };
}
