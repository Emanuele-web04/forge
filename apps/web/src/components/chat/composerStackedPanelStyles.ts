// FILE: composerStackedPanelStyles.ts
// Purpose: Shared layout, typography, and chrome tokens for panels stacked above the
// composer (plan activity, queued follow-ups, live file changes).
// Layer: Chat composer styling
// Exports: stacked panel row/header tokens and divider class name

import { COMPACT_CHAT_MARKDOWN_TIGHT_CLASS_NAME } from "~/components/chatMarkdownSpacing";
import { COMPOSER_STACKED_SURFACE_BORDER_CLASS_NAME } from "./composerPickerStyles";

/** Frame, border, radius, and surface chrome for a stacked composer panel.
 *  Uses `chat-composer-stacked-top` (not `chat-composer-surface`) so the rail
 *  reads as a translucent continuation of the input shell (same color at half
 *  opacity), with full-width hairline dividers between fused sections. No raised
 *  z-index: the input shell paints later and keeps its top border visible across
 *  the seam. */
export const COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME = [
  "chat-composer-stacked-top relative overflow-hidden border border-b-0",
  COMPOSER_STACKED_SURFACE_BORDER_CLASS_NAME,
].join(" ");

/** Divider between rows inside the same stacked panel. */
export const COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME = `border-t ${COMPOSER_STACKED_SURFACE_BORDER_CLASS_NAME}`;

/** Standard single-line row inside a stacked panel header strip. */
export const COMPOSER_STACKED_PANEL_ROW_CLASS_NAME =
  "flex items-center gap-2 px-2.5 py-1.5 text-[12px]";

/** Tighter row for multi-line panels such as queued follow-ups. */
export const COMPOSER_STACKED_PANEL_ROW_COMPACT_CLASS_NAME =
  "flex items-center gap-2 px-2.5 py-1 text-[12px]";

/** Header row with trailing actions (plan activity controls). */
export const COMPOSER_STACKED_PANEL_HEADER_ROW_CLASS_NAME =
  "flex items-center justify-between gap-2 px-2.5 py-1.5";

/** Primary content cluster: leading icon + label. */
export const COMPOSER_STACKED_PANEL_ROW_MAIN_CLASS_NAME =
  "flex min-w-0 flex-1 items-center gap-1.5";

/** Leading icon treatment shared by queue, file-change, and plan rows. */
export const COMPOSER_STACKED_PANEL_ICON_CLASS_NAME =
  "size-3.5 shrink-0 text-[var(--color-text-foreground-secondary)]";

/** Primary stacked-panel label (queue preview, file-change summary). */
export const COMPOSER_STACKED_PANEL_LABEL_CLASS_NAME = "truncate font-medium text-foreground/85";

/**
 * Queued follow-up preview rendered through the shared `ChatMarkdown` pipeline so it parses
 * exactly like assistant messages and the recap (mentions, inline code, emphasis, links).
 * Keeps the queue label tone/weight and clamps to one row so raw prompts cannot expand the panel.
 */
export const COMPOSER_STACKED_PANEL_PREVIEW_MARKDOWN_CLASS_NAME = [
  "line-clamp-1 max-h-[1.25rem] overflow-hidden text-[12px] font-medium !text-foreground/85",
  "[&_p]:truncate [&_p]:whitespace-nowrap",
  COMPACT_CHAT_MARKDOWN_TIGHT_CLASS_NAME,
].join(" ");

/** Muted summary label (plan task progress header). */
export const COMPOSER_STACKED_PANEL_META_CLASS_NAME =
  "truncate text-[12px] text-muted-foreground/80";

/** Horizontal padding for multi-line stacked panel bodies. */
export const COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME = "px-2.5 pb-1.5";

/**
 * Bounded scroll region for unbounded row lists inside stacked panels (subagent
 * strip, workflow agent list). Panels sit in normal flow above the composer, so
 * without a cap a large agent fleet grows the panel past the viewport and pushes
 * the composer input off-screen; capping here keeps the layout shift constant
 * regardless of row count.
 */
export const COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME =
  "max-h-56 overflow-y-auto overscroll-contain";

/** Footer/meta row below stacked panel content (background agents). */
export const COMPOSER_STACKED_PANEL_FOOTER_ROW_CLASS_NAME =
  "flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-muted-foreground/70";

/** Ghost icon button used in stacked panel header actions. */
export const COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME =
  "size-5 rounded-md text-[var(--color-text-foreground-tertiary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]";
