// FILE: PullRequestCodeTab.tsx
// Purpose: The Code tab of the pull request detail surface — owns the diff query and the
//          patch viewport. Lazy-loaded by PullRequestDetailPanel so the diff renderer and its
//          worker infrastructure never ship to users who only read the list or Summary.
// Layer: Pull request presentation
// Exports: PullRequestCodeTab (default export for React.lazy)

import type { PullRequestDetail, PullRequestDetailInput } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { DiffPanelPatchViewport } from "~/components/DiffPanelPatchViewport";
import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { DiffPanelLoadingState } from "~/components/DiffPanelShell";
import { useTheme } from "~/hooks/useTheme";
import { getRenderablePatch, sortFileDiffsByPath, summarizePatchTotals } from "~/lib/diffRendering";
import { pullRequestDiffQueryOptions } from "~/lib/pullRequestReactQuery";
import { cn } from "~/lib/utils";
import { PullRequestDiffStat } from "./PullRequestDiffStat";
import { PullRequestMetaLine } from "./PullRequestMetaLine";
import { PR_META_TEXT_CLASS_NAME } from "./pullRequestText";
import { PullRequestWarningNote } from "./PullRequestWarningNote";
import { PullRequestReviewSubmitBar } from "./review/PullRequestReviewSubmitBar";
import { usePullRequestReview } from "./review/usePullRequestReview";

export function PullRequestCodeTab({
  input,
  detail,
}: {
  input: PullRequestDetailInput;
  detail: PullRequestDetail;
}) {
  const { resolvedTheme } = useTheme();
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const diffQuery = useQuery(pullRequestDiffQueryOptions(input));
  const review = usePullRequestReview({ target: input, detail, diff: diffQuery.data });

  const renderablePatch = getRenderablePatch(
    diffQuery.data?.patch,
    `pull-request:${input.projectId}:${input.number}`,
  );
  const renderableFiles =
    renderablePatch?.kind === "files" ? sortFileDiffsByPath(renderablePatch.files) : [];
  const patchTotals = summarizePatchTotals(diffQuery.data?.patch);

  return (
    <DiffWorkerPoolProvider>
      <div className="flex h-full min-h-0 flex-col">
        {diffQuery.data?.truncated ? (
          <PullRequestWarningNote shape="banner">
            Diff exceeded 8 MiB and was truncated.
          </PullRequestWarningNote>
        ) : null}
        {patchTotals ? (
          <PullRequestMetaLine
            className={cn(
              PR_META_TEXT_CLASS_NAME,
              "border-b border-border/60 px-3 py-2 text-muted-foreground",
            )}
          >
            <span>{patchTotals.fileCount} files</span>
            <PullRequestDiffStat
              additions={patchTotals.additions}
              deletions={patchTotals.deletions}
              tone="diff"
            />
          </PullRequestMetaLine>
        ) : null}
        {diffQuery.isPending ? (
          <DiffPanelLoadingState label="Loading pull request diff…" />
        ) : (
          <DiffPanelPatchViewport
            renderablePatch={renderablePatch}
            renderableFiles={renderableFiles}
            resolvedTheme={resolvedTheme}
            diffRenderMode="split"
            diffWordWrap
            workspaceRoot={detail.workspaceRoot}
            collapsedFiles={collapsedFiles}
            onToggleFileCollapsed={(key) =>
              setCollapsedFiles((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            lineAnnotations={review.annotationsByFile}
            renderAnnotation={review.renderAnnotation}
            onStartLineComment={review.startDraft}
            isLoading={diffQuery.isFetching}
            hasNoChanges={diffQuery.isSuccess && !renderablePatch}
            error={
              diffQuery.isError
                ? diffQuery.error instanceof Error
                  ? diffQuery.error.message
                  : "Could not load diff."
                : null
            }
            loadingLabel="Loading pull request diff…"
            emptyLabel="This pull request has no file changes."
            unavailableLabel="The pull request diff is unavailable."
            viewKind="repo"
          />
        )}
        <PullRequestReviewSubmitBar
          target={input}
          drafts={review.currentDrafts}
          staleDrafts={review.staleDrafts}
          loading={review.isLoading}
          busy={review.busy}
          onDeleteDraft={review.deleteDraft}
        />
      </div>
    </DiffWorkerPoolProvider>
  );
}

export default PullRequestCodeTab;
