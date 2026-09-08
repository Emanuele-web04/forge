// FILE: DiffPanelPatchViewport.tsx
// Purpose: Memoized diff body for the review panel — only re-renders when the active
//          patch or display settings change, not on unrelated chat activity.
// Layer: Diff panel UI

import type { FileDiffMetadata } from "@pierre/diffs/react";
import { memo } from "react";
import { cn } from "~/lib/utils";
import type { RenderablePatch } from "~/lib/diffRendering";
import { DiffPanelFileList, type DiffFileChatActions } from "./DiffPanelFileList";
import type { DiffLineBlameTarget } from "./DiffLineBlamePopover";
import { DiffPanelLoadingState } from "./DiffPanelShell";
import { PanelStateMessage } from "./chat/PanelStateMessage";

type DiffRenderMode = "stacked" | "split";

export const DiffPanelPatchViewport = memo(
  function DiffPanelPatchViewport(props: {
    renderablePatch: RenderablePatch | null;
    renderableFiles: ReadonlyArray<FileDiffMetadata>;
    resolvedTheme: "light" | "dark";
    diffRenderMode: DiffRenderMode;
    diffWordWrap: boolean;
    workspaceRoot: string | null;
    collapsedFiles: ReadonlySet<string>;
    onToggleFileCollapsed: (fileKey: string) => void;
    chatActions?: DiffFileChatActions | undefined;
    onBlameLine?: ((target: DiffLineBlameTarget) => void) | undefined;
    isLoading: boolean;
    hasNoChanges: boolean;
    error: string | null;
    loadingLabel: string;
    emptyLabel: string;
    unavailableLabel: string;
    viewKind: "repo" | "turn";
  }) {
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
            chatActions={props.chatActions}
            onBlameLine={props.onBlameLine}
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
  },
  (previous, next) => {
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
      previous.onBlameLine === next.onBlameLine &&
      previous.isLoading === next.isLoading &&
      previous.hasNoChanges === next.hasNoChanges &&
      previous.error === next.error &&
      previous.loadingLabel === next.loadingLabel &&
      previous.emptyLabel === next.emptyLabel &&
      previous.unavailableLabel === next.unavailableLabel &&
      previous.viewKind === next.viewKind
    );
  },
);
