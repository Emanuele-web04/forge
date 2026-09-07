// FILE: ComposerBackgroundTasksPanel.tsx
// Purpose: Lists work the agent detached to the background (backgrounded shell
// commands, provider-native tasks) while it is still running, stacked above the
// composer like the subagent strip. Each row names the work, counts up its
// elapsed time, and can stop it.
// Layer: Chat composer UI
// Exports: ComposerBackgroundTasksPanel

import { formatClockDuration } from "../../session-logic";
import { useLiveClockNow } from "~/lib/liveActivityPresentation";
import {
  BackgroundTrayIcon,
  BotIcon,
  LoaderIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  StopIcon,
  TerminalIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import {
  summarizeComposerBackgroundTaskRows,
  type ComposerBackgroundTaskRow,
} from "./ComposerBackgroundTasksPanel.logic";
import {
  ComposerStackedPanelHeaderRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import {
  COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
} from "./composerStackedPanelStyles";

interface ComposerBackgroundTasksPanelProps {
  rows: ReadonlyArray<ComposerBackgroundTaskRow>;
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
  onStopTask?: (row: ComposerBackgroundTaskRow) => void;
  attachedToPrevious?: boolean;
}

function rowIcon(kind: ComposerBackgroundTaskRow["kind"]) {
  const className = "size-3 shrink-0 text-muted-foreground/55";
  if (kind === "command") return <TerminalIcon className={className} />;
  if (kind === "agent") return <BotIcon className={className} />;
  return <BackgroundTrayIcon className={className} />;
}

export function ComposerBackgroundTasksPanel({
  rows,
  compact,
  onCompactChange,
  onStopTask,
  attachedToPrevious: attachedToPreviousProp,
}: ComposerBackgroundTasksPanelProps) {
  const attachedToPrevious = attachedToPreviousProp ?? false;
  const nowMs = useLiveClockNow(rows.length > 0);
  const summary = summarizeComposerBackgroundTaskRows(rows);

  return (
    <ComposerStackedPanel
      passthroughSideMargins
      attachedToPrevious={attachedToPrevious}
      data-testid="composer-background-tasks-panel"
    >
      <ComposerStackedPanelHeaderRow>
        <ComposerStackedPanelRowMain>
          <LoaderIcon className={cn(COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, "animate-spin")} />
          <ComposerStackedPanelRowLabel tone="meta">{summary}</ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn("shrink-0", COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME)}
          onClick={() => onCompactChange(!compact)}
          aria-label={compact ? "Expand background work" : "Collapse background work"}
          title={compact ? "Expand background work" : "Collapse background work"}
        >
          {compact ? (
            <PanelExpandIcon className="size-3" />
          ) : (
            <PanelCollapseIcon className="size-3" />
          )}
        </Button>
      </ComposerStackedPanelHeaderRow>

      <DisclosureRegion open={!compact}>
        <div
          className={cn(
            "space-y-0",
            COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
            COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
          )}
        >
          {rows.map((row) => {
            const startedAtMs = Date.parse(row.startedAt);
            const elapsed = Number.isFinite(startedAtMs)
              ? formatClockDuration(Math.max(0, nowMs - startedAtMs))
              : null;
            return (
              <div
                key={row.key}
                data-testid="composer-background-task-row"
                className="group -mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-1 rounded-md px-1 py-1 transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2" title={row.label}>
                  {rowIcon(row.kind)}
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/85">
                    {row.label}
                  </span>
                  {elapsed ? (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/55">
                      {elapsed}
                    </span>
                  ) : null}
                </div>
                {onStopTask ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      "shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                      COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
                    )}
                    onClick={() => onStopTask(row)}
                    aria-label={`Stop ${row.label}`}
                    title="Stop this background work"
                  >
                    <StopIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </DisclosureRegion>
    </ComposerStackedPanel>
  );
}
