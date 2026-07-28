// FILE: ActiveTaskListCard.tsx
// Purpose: Renders the active plan/task activity panel used above the composer.
// Layer: Chat composer UI
// Exports: ActiveTaskListCard

import { pluralize } from "@synara/shared/text";
import {
  PiArrowsInSimple,
  PiArrowsOutSimple,
  PiSidebarSimple,
  PiSlidersHorizontal,
} from "react-icons/pi";

import type { ActiveTaskListState } from "../../session-logic";
import { BotIcon, CheckIcon, LoaderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  ComposerStackedPanelHeaderRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import { COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME } from "./ComposerStackedPanel";
import {
  COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
  COMPOSER_STACKED_PANEL_FOOTER_ROW_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
} from "./composerStackedPanelStyles";

interface ActiveTaskListCardProps {
  activeTaskList: ActiveTaskListState;
  backgroundTaskCount?: number;
  compact?: boolean;
  onCompactChange: (compact: boolean) => void;
  onOpenSidebar: () => void;
}

// Maps task state to the compact status glyph shown in the activity list.
function taskStatusIcon(status: ActiveTaskListState["tasks"][number]["status"]) {
  if (status === "completed") {
    return <CheckIcon className="size-3" />;
  }
  if (status === "inProgress") {
    return <LoaderIcon className="size-3 animate-spin" />;
  }
  return <span className="block size-[7px] rounded-full border border-current" />;
}

export function ActiveTaskListCard({
  activeTaskList,
  backgroundTaskCount: backgroundTaskCountProp,
  compact: compactProp,
  onCompactChange,
  onOpenSidebar,
}: ActiveTaskListCardProps) {
  const backgroundTaskCount = backgroundTaskCountProp ?? 0;
  const compact = compactProp ?? false;
  const totalCount = activeTaskList.tasks.length;
  const completedCount = activeTaskList.tasks.filter((task) => task.status === "completed").length;
  const hasInProgressTask = activeTaskList.tasks.some((task) => task.status === "inProgress");
  const taskOccurrenceCount = new Map<string, number>();

  return (
    <>
      <ComposerStackedPanelHeaderRow>
        <ComposerStackedPanelRowMain>
          {compact && hasInProgressTask ? (
            <LoaderIcon className={cn(COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, "animate-spin")} />
          ) : (
            <PiSlidersHorizontal className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          )}
          <ComposerStackedPanelRowLabel tone="meta">
            {completedCount} out of {totalCount} tasks completed
          </ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
            onClick={onOpenSidebar}
            aria-label="Open tasks sidebar"
            title="Open tasks sidebar"
          >
            <PiSidebarSimple className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
            onClick={() => onCompactChange(!compact)}
            aria-label={compact ? "Expand task banner" : "Collapse task banner"}
            title={compact ? "Expand task banner" : "Collapse task banner"}
          >
            {compact ? (
              <PiArrowsOutSimple className="size-3" />
            ) : (
              <PiArrowsInSimple className="size-3" />
            )}
          </Button>
        </div>
      </ComposerStackedPanelHeaderRow>

      {compact ? null : (
        <>
          <ol
            className={cn(
              "space-y-0",
              COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
              COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
            )}
          >
            {activeTaskList.tasks.map((task, index) => {
              const occurrence = (taskOccurrenceCount.get(task.task) ?? 0) + 1;
              taskOccurrenceCount.set(task.task, occurrence);

              return (
                <li key={`${task.task}:${occurrence}`} className="flex items-start gap-2 py-1">
                  <div
                    className={cn(
                      "mt-[3px] flex min-w-0 shrink-0 items-center gap-1.5 text-[12px]",
                      task.status === "completed"
                        ? "text-muted-foreground/45"
                        : task.status === "inProgress"
                          ? "text-foreground/80"
                          : "text-muted-foreground/60",
                    )}
                  >
                    <span className="flex size-3.5 items-center justify-center">
                      {taskStatusIcon(task.status)}
                    </span>
                    <span className="tabular-nums">{index + 1}.</span>
                  </div>
                  <p
                    className={cn(
                      "min-w-0 flex-1 text-[13px] leading-5 text-foreground/85",
                      task.status === "completed" && "text-muted-foreground/50 line-through",
                    )}
                  >
                    {task.task}
                  </p>
                </li>
              );
            })}
          </ol>

          {backgroundTaskCount > 0 ? (
            <div
              className={cn(
                COMPOSER_STACKED_PANEL_FOOTER_ROW_CLASS_NAME,
                COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME,
              )}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <BotIcon className="size-3 shrink-0" />
                <span className="truncate">
                  {backgroundTaskCount} background {pluralize(backgroundTaskCount, "agent")}
                </span>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

export type { ActiveTaskListCardProps };
