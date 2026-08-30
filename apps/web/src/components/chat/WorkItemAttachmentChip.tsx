// FILE: WorkItemAttachmentChip.tsx
// Purpose: Render a compact attached GitHub issue / PR chip.

import type { WorkItemAttachment } from "@synara/contracts";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "~/lib/utils";
import { COMPOSER_ATTACHMENT_CHIP_CLASS_NAME } from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AttachmentRemoveButton } from "./AttachmentRemoveButton";

interface WorkItemAttachmentChipProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  item: WorkItemAttachment;
  onRemove?: (() => void) | undefined;
  variant?: "pill" | "list";
}

export function WorkItemAttachmentChip({
  item,
  onRemove,
  variant = "pill",
  className,
  ...rest
}: WorkItemAttachmentChipProps) {
  const kindLabel = item.kind === "issue" ? "Issue" : "PR";
  const stateClass =
    item.state === "open"
      ? "text-emerald-600"
      : item.state === "merged"
        ? "text-purple-600"
        : "text-red-600";
  const removeLabel = `Remove ${kindLabel.toLowerCase()} #${item.number}`;

  const trigger =
    variant === "list" ? (
      <span
        className={cn(
          "group relative flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-xs text-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)]",
          onRemove && "pr-8",
          className,
        )}
        aria-label={`${kindLabel} #${item.number}: ${item.title}`}
        data-testid="work-item-chip"
        {...rest}
      >
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--sidebar-accent-active)] text-[10px] font-semibold",
            stateClass,
          )}
        >
          {item.kind === "issue" ? "I" : "P"}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">#{item.number}</span>
        <span className="max-w-[60%] shrink truncate text-[11px] text-muted-foreground">
          {item.title}
        </span>
        {onRemove ? (
          <AttachmentRemoveButton
            size="sm"
            tone="ghost"
            placement="center-right"
            label={removeLabel}
            onRemove={onRemove}
          />
        ) : null}
      </span>
    ) : (
      <span
        className={cn(
          "group relative min-w-0 shrink",
          COMPOSER_ATTACHMENT_CHIP_CLASS_NAME,
          onRemove && "pr-5",
          className,
        )}
        aria-label={`${kindLabel} #${item.number}: ${item.title}`}
        data-testid="work-item-chip"
        {...rest}
      >
        <span className="inline-flex h-6 min-w-0 max-w-[14rem] items-center gap-1.5 rounded-full pl-2 pr-2">
          <span className={cn("shrink-0 text-[10px] font-semibold", stateClass)}>
            {item.kind === "issue" ? "Issue" : "PR"}
          </span>
          <span className="min-w-0 truncate text-xs">#{item.number}</span>
        </span>
        {onRemove ? (
          <AttachmentRemoveButton
            size="sm"
            tone="ghost"
            placement="center-right"
            label={removeLabel}
            onRemove={onRemove}
          />
        ) : null}
      </span>
    );

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">
            {kindLabel} #{item.number}: {item.title}
          </p>
          <p className="text-[0.6875rem] text-muted-foreground">{item.state}</p>
          <p className="break-all font-mono text-[0.625rem] text-muted-foreground/80">{item.url}</p>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
