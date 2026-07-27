// FILE: DiffPanelPatchViewport.tsx
// Purpose: Memoized diff body for the review panel — only re-renders when the active
//          patch or display settings change, not on unrelated chat activity.
// Layer: Diff panel UI

import type { DiffLineAnnotation } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { memo, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import type { RenderablePatch } from "~/lib/diffRendering";
import { DiffPanelFileList, type DiffFileChatActions } from "./DiffPanelFileList";
import { DiffPanelLoadingState } from "./DiffPanelShell";
import type { DiffLineCommentAnchor } from "./chat/FileDiffView";
import { PanelStateMessage } from "./chat/PanelStateMessage";

type DiffRenderMode = "stacked" | "split";

interface DiffPanelPatchViewportProps<TAnnotation = undefined> {
  renderablePatch: RenderablePatch | null;
  renderableFiles: ReadonlyArray<FileDiffMetadata>;
  resolvedTheme: "light" | "dark";
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  workspaceRoot: string | null;
  collapsedFiles: ReadonlySet<string>;
  onToggleFileCollapsed: (fileKey: string) => void;
  chatActions?: DiffFileChatActions | undefined;
  lineAnnotations?: ReadonlyMap<string, ReadonlyArray<DiffLineAnnotation<TAnnotation>>>;
  renderAnnotation?: (data: TAnnotation) => ReactNode;
  onStartLineComment?: (anchor: DiffLineCommentAnchor) => void;
  isLoading: boolean;
  hasNoChanges: boolean;
  error: string | null;
  loadingLabel: string;
  emptyLabel: string;
  unavailableLabel: string;
  viewKind: "repo" | "turn";
}

function DiffPanelPatchViewportView<TAnnotation = undefined>(
  props: DiffPanelPatchViewportProps<TAnnotation>,
) {
  const viewportClassName = "flex h-full min-h-0 w-full flex-1 flex-col";

  if (props.error && !props.renderablePatch) {
    return (
      <div className={viewportClassName}>
        <PanelStateMessage
          density="compact"
          fill="flex"
          className="items-start justify-start px-3 pt-3"
        >
          <p className="text-left text-[11px] text-red-500/80">{props.error}</p>
        </PanelStateMessage>
      </div>
    );
  }

  if (!props.renderablePatch) {
    if (props.isLoading) {
      return (
        <div className={viewportClassName}>
          <DiffPanelLoadingState label={props.loadingLabel} />
        </div>
      );
    }
    return (
      <div className={viewportClassName}>
        <PanelStateMessage density="compact" fill="flex">
          <p>
            {props.hasNoChanges
              ? props.emptyLabel
              : props.viewKind === "repo"
                ? props.unavailableLabel
                : "No patch available for this selection."}
          </p>
        </PanelStateMessage>
      </div>
    );
  }

  if (props.renderablePatch.kind === "files") {
    return (
      <div className={viewportClassName}>
        <DiffPanelFileList
          renderableFiles={props.renderableFiles}
          resolvedTheme={props.resolvedTheme}
          diffRenderMode={props.diffRenderMode}
          diffWordWrap={props.diffWordWrap}
          workspaceRoot={props.workspaceRoot}
          collapsedFiles={props.collapsedFiles}
          onToggleFileCollapsed={props.onToggleFileCollapsed}
          {...(props.chatActions ? { chatActions: props.chatActions } : {})}
          {...(props.lineAnnotations ? { lineAnnotations: props.lineAnnotations } : {})}
          {...(props.renderAnnotation ? { renderAnnotation: props.renderAnnotation } : {})}
          {...(props.onStartLineComment ? { onStartLineComment: props.onStartLineComment } : {})}
        />
      </div>
    );
  }

  return (
    <div className={cn(viewportClassName, "overflow-auto p-2")}>
      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground/75">{props.renderablePatch.reason}</p>
        <pre
          className={cn(
            "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
            props.diffWordWrap
              ? "overflow-auto whitespace-pre-wrap wrap-break-word"
              : "overflow-auto",
          )}
        >
          {props.renderablePatch.text}
        </pre>
      </div>
    </div>
  );
}

function areDiffPanelPatchViewportPropsEqual<TAnnotation>(
  previous: DiffPanelPatchViewportProps<TAnnotation>,
  next: DiffPanelPatchViewportProps<TAnnotation>,
): boolean {
  return (
    previous.renderablePatch === next.renderablePatch &&
    previous.renderableFiles === next.renderableFiles &&
    previous.resolvedTheme === next.resolvedTheme &&
    previous.diffRenderMode === next.diffRenderMode &&
    previous.diffWordWrap === next.diffWordWrap &&
    previous.workspaceRoot === next.workspaceRoot &&
    previous.collapsedFiles === next.collapsedFiles &&
    previous.onToggleFileCollapsed === next.onToggleFileCollapsed &&
    previous.chatActions === next.chatActions &&
    previous.lineAnnotations === next.lineAnnotations &&
    previous.renderAnnotation === next.renderAnnotation &&
    previous.onStartLineComment === next.onStartLineComment &&
    previous.isLoading === next.isLoading &&
    previous.hasNoChanges === next.hasNoChanges &&
    previous.error === next.error &&
    previous.loadingLabel === next.loadingLabel &&
    previous.emptyLabel === next.emptyLabel &&
    previous.unavailableLabel === next.unavailableLabel &&
    previous.viewKind === next.viewKind
  );
}

export const DiffPanelPatchViewport = memo(
  DiffPanelPatchViewportView,
  areDiffPanelPatchViewportPropsEqual,
) as typeof DiffPanelPatchViewportView;
