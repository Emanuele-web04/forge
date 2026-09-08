// FILE: AttachmentCard.tsx
// Purpose: Shared visual shell for NON-IMAGE composer/transcript attachments —
//   files, pasted text, and other document-like references. Centralizes the icon
//   tile, title/subtitle column, and remove affordance so every non-image
//   attachment reads consistently; each kind supplies its own icon, labels, and
//   optional subtitle/action. Image attachments stay separate: they render a
//   thumbnail (see ComposerImageAttachmentChip), not this shell.
// Layer: Chat composer/transcript presentation
// Exports: AttachmentCard

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { AttachmentRemoveButton, type AttachmentRemoveButtonSize } from "./AttachmentRemoveButton";

export type AttachmentCardSize = "sm" | "md";

interface AttachmentCardSizeStyles {
  shell: string;
  shellWithRemove: string;
  shellWithoutRemove: string;
  tile: string;
  title: string;
  remove: AttachmentRemoveButtonSize;
}

const ATTACHMENT_CARD_SIZE_STYLES: Record<AttachmentCardSize, AttachmentCardSizeStyles> = {
  // Compact tile for pasted-text cards (composer + transcript echo).
  sm: {
    shell: "max-w-[16rem] gap-2 rounded-lg py-1 pl-1",
    shellWithRemove: "pr-5",
    shellWithoutRemove: "pr-2",
    tile: "size-6 rounded-md",
    title: "text-xs",
    remove: "sm",
  },
  // Roomier composer card with a prominent type glyph (file attachments).
  md: {
    shell: "h-14 w-60 max-w-full gap-2.5 rounded-xl py-2 pl-2",
    shellWithRemove: "pr-8",
    shellWithoutRemove: "pr-3",
    tile: "size-10 rounded-lg",
    title: "text-[13px]",
    remove: "md",
  },
};

interface AttachmentCardOwnProps {
  /** Leading glyph rendered inside the rounded tile; caller sizes it to the tile. */
  icon: ReactNode;
  /** Primary line — truncated to a single row. */
  title: ReactNode;
  /** Optional secondary line (type label, byte count, inline action). */
  subtitle?: ReactNode;
  size?: AttachmentCardSize;
  onRemove?: (() => void) | undefined;
  /** Accessible label for the remove button, e.g. `Remove invoice.pdf`. */
  removeLabel?: string;
}

// Spreads remaining span props/ref onto the root so the card works as a Base UI
// tooltip trigger (which merges hover/aria props + ref onto the rendered element).
type AttachmentCardProps = AttachmentCardOwnProps &
  Omit<ComponentPropsWithoutRef<"span">, keyof AttachmentCardOwnProps | "title">;

export const AttachmentCard = forwardRef<HTMLSpanElement, AttachmentCardProps>(
  function AttachmentCard(
    { icon, title, subtitle, size: sizeProp, onRemove, removeLabel, className, ...rest },
    ref,
  ) {
    const size = sizeProp ?? "md";
    const styles = ATTACHMENT_CARD_SIZE_STYLES[size];
    return (
      <span
        ref={ref}
        className={cn(
          "group relative inline-flex items-center border border-[color:var(--color-border-light)] bg-[var(--composer-surface)]",
          styles.shell,
          onRemove ? styles.shellWithRemove : styles.shellWithoutRemove,
          className,
        )}
        {...rest}
      >
        <span
          className={cn(
            "flex shrink-0 items-center justify-center bg-[var(--color-background-elevated-secondary)] text-muted-foreground",
            styles.tile,
          )}
        >
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 leading-tight">
          <span className={cn("truncate font-medium text-foreground", styles.title)}>{title}</span>
          {subtitle ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </span>
        {onRemove ? (
          <AttachmentRemoveButton
            size={styles.remove}
            label={removeLabel ?? "Remove attachment"}
            onRemove={onRemove}
          />
        ) : null}
      </span>
    );
  },
);
