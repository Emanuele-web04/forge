// FILE: ThreadArchiveActionButton.tsx
// Purpose: Hover-revealed archive action shared by classic thread rows and
//          Activity rows — one icon, label, sizing, and row-activation guard.
// Layer: Sidebar UI primitive
// Exports: ThreadArchiveActionButton

import { HiOutlineArchiveBox } from "react-icons/hi2";

import type { ThreadId } from "@synara/contracts";

import { cn } from "~/lib/utils";
import { SIDEBAR_TRAILING_ICON_CLASS, sidebarGlyphClass } from "./sidebarGlyphs";
import { SidebarIconButton } from "./SidebarIconButton";

export function ThreadArchiveActionButton({
  threadId,
  toneClassName,
  compact,
  onArchive,
}: {
  threadId: ThreadId;
  toneClassName?: string;
  /** Denser glyph scale used by subagent rows. */
  compact?: boolean;
  onArchive: () => void;
}) {
  const isCompact = compact === true;
  return (
    <SidebarIconButton
      icon={HiOutlineArchiveBox}
      label="Archive thread"
      title="Archive thread"
      data-testid={`thread-archive-${threadId}`}
      size={isCompact ? "sm" : "md"}
      // Match the pin and the right-side meta chips (shared trailing-icon size);
      // subagent rows stay on the denser "compact" scale.
      iconClassName={isCompact ? sidebarGlyphClass("compact") : SIDEBAR_TRAILING_ICON_CLASS}
      className={cn("hover:text-foreground/89", toneClassName)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onArchive();
      }}
    />
  );
}
