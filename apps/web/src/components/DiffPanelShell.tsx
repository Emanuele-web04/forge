import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
} from "./chat/chatHeaderControls";
import { Skeleton } from "./ui/skeleton";

export type DiffPanelMode = "inline" | "sheet" | "sidebar" | "floating";

function getDiffPanelHeaderRowClassName(mode: DiffPanelMode) {
  const shouldUseDragRegion = isElectron && mode !== "sheet" && mode !== "floating";
  // Match RightDock tab strip inset (`px-1.5`) so picker triggers line up under dock tabs.
  return cn(
    "flex w-full min-w-0 items-center gap-1.5 px-1.5",
    CHAT_SURFACE_HEADER_HEIGHT_CLASS,
    shouldUseDragRegion && cn("drag-region", CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME),
  );
}

export function DiffPanelShell(props: {
  mode: DiffPanelMode;
  header?: ReactNode;
  children: ReactNode;
}) {
  const shouldUseDragRegion = isElectron && props.mode !== "sheet" && props.mode !== "floating";
  const hasHeader = props.header !== null && props.header !== undefined;

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col",
        props.mode === "floating" ? "bg-transparent" : "bg-[var(--color-background-surface)]",
        props.mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
          : "w-full",
      )}
    >
      {hasHeader ? (
        shouldUseDragRegion ? (
          <div className={getDiffPanelHeaderRowClassName(props.mode)}>{props.header}</div>
        ) : (
          <div className={CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME}>
            <div className={getDiffPanelHeaderRowClassName(props.mode)}>{props.header}</div>
          </div>
        )
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{props.children}</div>
    </div>
  );
}

export function DiffPanelHeaderSkeleton() {
  return (
    <div className="flex h-full w-full items-center gap-2">
      <Skeleton className="h-8 w-28 shrink-0 rounded-lg" />
      <Skeleton className="h-4 w-14 shrink-0 rounded-full" />
      <div className="ml-auto flex items-center gap-1.5">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-7 w-16 rounded-md" />
        <Skeleton className="h-8 w-20 rounded-lg" />
      </div>
    </div>
  );
}

export function DiffPanelLoadingState(props: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-2">
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60 bg-card/25"
        role="status"
        aria-live="polite"
        aria-label={props.label}
      >
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
          <Skeleton className="h-4 w-32 rounded-full" />
          <Skeleton className="ml-auto h-4 w-20 rounded-full" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-3 py-4">
          <div className="space-y-2">
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-3 w-10/12 rounded-full" />
            <Skeleton className="h-3 w-11/12 rounded-full" />
            <Skeleton className="h-3 w-9/12 rounded-full" />
          </div>
          <span className="sr-only">{props.label}</span>
        </div>
      </div>
    </div>
  );
}
