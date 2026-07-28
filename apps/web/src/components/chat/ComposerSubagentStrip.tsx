// FILE: ComposerSubagentStrip.tsx
// Purpose: Compact subagent rows stacked above the composer input (status dot,
// nickname, role/model, live status); clicking a row switches to that subagent's
// thread. Wraps the shared stacked-header frame like the active task list.
// Layer: Chat composer UI
// Exports: ComposerSubagentStrip

import type { ThreadId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";

import {
  BackgroundTrayIcon,
  BackToParentIcon,
  BotIcon,
  LoaderIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  StopIcon,
} from "~/lib/icons";
import {
  subagentStatusDotClassName,
  subagentStatusTextToneClassName,
} from "~/lib/subagentPresentation";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import type {
  ComposerSubagentStripItem,
  ComposerSubagentStripRow,
} from "./ComposerSubagentStrip.logic";
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

interface ComposerSubagentStripProps {
  items: ReadonlyArray<ComposerSubagentStripRow>;
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onBackgroundItem?: (item: ComposerSubagentStripItem) => void;
  onStopItem?: (item: ComposerSubagentStripItem) => void;
  onStopAll?: () => void;
  attachedToPrevious?: boolean;
}

export const ComposerSubagentStrip = function ComposerSubagentStrip({
  items,
  compact,
  onCompactChange,
  onOpenThread,
  onBackgroundItem,
  onStopItem,
  onStopAll,
  attachedToPrevious: attachedToPreviousProp,
}: ComposerSubagentStripProps) {
  const attachedToPrevious = attachedToPreviousProp ?? false;
  const subagentItems = items.filter(
    (item): item is ComposerSubagentStripItem => item.kind === "subagent",
  );
  const runningCount = subagentItems.filter((item) => item.isActive).length;

  return (
    <ComposerStackedPanel
      passthroughSideMargins
      attachedToPrevious={attachedToPrevious}
      data-testid="composer-subagent-strip"
    >
      <ComposerStackedPanelHeaderRow>
        <ComposerStackedPanelRowMain>
          {compact && runningCount > 0 ? (
            <LoaderIcon className={cn(COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, "animate-spin")} />
          ) : (
            <BotIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          )}
          <ComposerStackedPanelRowLabel tone="meta">
            {runningCount > 0
              ? `${runningCount} of ${subagentItems.length} ${pluralize(subagentItems.length, "subagent")} running`
              : `${subagentItems.length} ${pluralize(subagentItems.length, "subagent")}`}
          </ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        {onStopAll && runningCount > 1 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn("shrink-0", COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME)}
            onClick={onStopAll}
            aria-label="Stop all subagents"
            title="Stop all running subagents"
          >
            <StopIcon className="size-3" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn("shrink-0", COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME)}
          onClick={() => onCompactChange(!compact)}
          aria-label={compact ? "Expand subagent strip" : "Collapse subagent strip"}
          title={compact ? "Expand subagent strip" : "Collapse subagent strip"}
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
          {items.map((item) =>
            item.kind === "parent" ? (
              <div
                key={item.key}
                data-testid="composer-subagent-parent-row"
                className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-1 rounded-md px-1 py-1 transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={item.label}
                  onClick={() => onOpenThread(item.threadId)}
                >
                  <BackToParentIcon className="size-3 shrink-0 text-muted-foreground/55" />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/85">
                    {item.label}
                  </span>
                </button>
              </div>
            ) : (
              <div
                key={item.key}
                data-testid="composer-subagent-row"
                data-viewed={item.isViewed || undefined}
                className={cn(
                  "group -mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-1 rounded-md px-1 py-1 transition-colors hover:bg-[var(--color-background-button-secondary-hover)]",
                  item.isViewed && "bg-[var(--color-background-button-secondary)]",
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={item.fullLabel}
                  onClick={() => onOpenThread(item.threadId)}
                >
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      subagentStatusDotClassName(item.statusKind),
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/85">
                    <span>{item.primaryLabel}</span>
                    {item.role ? (
                      <span className="ml-1 text-[11px] font-normal text-muted-foreground/55">
                        ({item.role})
                      </span>
                    ) : null}
                    {item.modelLabel ? (
                      <span className="ml-1.5 text-[11px] font-normal text-muted-foreground/45">
                        {item.modelLabel}
                      </span>
                    ) : null}
                    {item.isBackground ? (
                      <span className="ml-1.5 text-[11px] font-normal text-muted-foreground/45">
                        background
                      </span>
                    ) : null}
                  </span>
                  {item.statusLabel ? (
                    <span
                      className={cn(
                        "shrink-0 text-[11px]",
                        subagentStatusTextToneClassName(item.statusKind),
                      )}
                    >
                      {item.statusLabel}
                    </span>
                  ) : null}
                </button>
                {item.isActive && !item.isBackground && onBackgroundItem ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      "shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
                      COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
                    )}
                    onClick={() => onBackgroundItem(item)}
                    aria-label="Run in background (ctrl+b)"
                    title="Run in background (ctrl+b)"
                  >
                    <BackgroundTrayIcon className="size-3" />
                  </Button>
                ) : null}
                {item.isActive && onStopItem ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      "shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
                      COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
                    )}
                    onClick={() => onStopItem(item)}
                    aria-label="Stop subagent"
                    title="Stop subagent"
                  >
                    <StopIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
            ),
          )}
        </div>
      </DisclosureRegion>
    </ComposerStackedPanel>
  );
};
