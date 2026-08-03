// FILE: sidebarRowStyles.ts
// Purpose: Shared layout and interaction tokens for sidebar header/thread rows.
// Layer: Sidebar UI styling
// Exports: row dimension, radius, hover/active, header + thread row class names

/** Compact sidebar row height shared by projects, threads, chats, and settings nav. */
export const SIDEBAR_ROW_HEIGHT_CLASS_NAME =
  "min-h-[var(--app-density-row-height,1.75rem)] h-[var(--app-density-row-height,1.75rem)]";

export const SIDEBAR_ROW_RADIUS_CLASS_NAME = "rounded-md";

export const SIDEBAR_ROW_PADDING_CLASS_NAME = "px-2 py-[var(--app-density-row-padding-y,0.125rem)]";

export const SIDEBAR_ROW_GAP_CLASS_NAME = "gap-[var(--app-density-row-gap,0.5rem)]";

export const SIDEBAR_ROW_TEXT_CLASS_NAME = "text-[length:var(--app-font-size-ui,12px)] font-normal";

export const SIDEBAR_ROW_FOCUS_CLASS_NAME =
  "outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

export const SIDEBAR_ROW_HOVER_CLASS_NAME =
  "hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-accent-foreground)]";

export const SIDEBAR_ROW_ACTIVE_CLASS_NAME =
  "bg-[var(--sidebar-accent-active)] text-[var(--sidebar-accent-foreground)] hover:bg-[var(--sidebar-accent-active)] hover:text-[var(--sidebar-accent-foreground)]";

export const SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME = "text-foreground/89";

/**
 * Resting foreground for primary sidebar item labels and their accompanying
 * leading/pin icons (inactive thread name, project/folder name, folder + pin
 * glyphs). Sits just below the full-foreground active row so resting items read
 * clearly without competing with the selected thread.
 */
export const SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME = "text-foreground/95";

/** Section label ("Threads"/"Pinned" and settings "App"/"Synara"). */
export const SIDEBAR_SECTION_LABEL_CLASS_NAME =
  "text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/58";

/** Project/chat/settings header rows and settings sidebar nav items. */
export const SIDEBAR_HEADER_ROW_CLASS_NAME = [
  "flex w-full min-w-0 cursor-pointer items-center text-left select-none",
  SIDEBAR_ROW_HEIGHT_CLASS_NAME,
  SIDEBAR_ROW_GAP_CLASS_NAME,
  SIDEBAR_ROW_RADIUS_CLASS_NAME,
  SIDEBAR_ROW_PADDING_CLASS_NAME,
  SIDEBAR_ROW_TEXT_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
].join(" ");

/** Thread rows nested under a project. */
export const SIDEBAR_THREAD_ROW_BASE_CLASS_NAME = [
  "w-full translate-x-0 cursor-pointer justify-start text-left select-none",
  SIDEBAR_ROW_HEIGHT_CLASS_NAME,
  SIDEBAR_ROW_RADIUS_CLASS_NAME,
  "pl-8 text-[13px]",
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
].join(" ");

/** Spacing between a header row and its nested thread list, and between thread rows. */
export const SIDEBAR_NESTED_LIST_GAP_CLASS_NAME = "gap-0.5";

export const SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME = "pt-0.5";

/** Sidebar row groups whose resting status fades to yield its slot to a hover toolbar. */
export type SidebarHoverRevealGroup = "activity-row" | "project-header" | "thread-row";

/**
 * The single rule for "fade a resting glyph out the moment its row reveals the hover
 * action toolbar, so the actions replace it instead of stacking on top." A project
 * header (folder icon + run-status dot) and a thread row (meta chips, timestamp/status
 * slot, jump hint) both follow it — the faded element also drops pointer events so it
 * never intercepts clicks meant for the revealed toolbar.
 *
 * Tailwind only emits utilities it can read as complete literals, so each group's classes
 * are spelled out in full rather than interpolating the `group/<row>` token. The variants
 * differ only by that token and by which focus signal the row's toolbar reveals on
 * (project headers reveal on keyboard `focus-visible`; thread rows reveal on any
 * `focus-within`) — keep each in lockstep with its row's toolbar. Requires an ancestor
 * carrying the matching `group/<row>` marker.
 *
 * Apply this to a *static* element. If the element you want to hide animates its own
 * `opacity` (e.g. `animate-pulse`), the running animation overrides this `opacity-0`;
 * put the class on a wrapper instead so the parent's collapsed opacity hides the subtree.
 */
const SIDEBAR_HOVER_REVEAL_HIDE_CLASS_NAME: Record<SidebarHoverRevealGroup, string> = {
  "activity-row":
    "transition-opacity group-hover/activity-row:pointer-events-none group-hover/activity-row:opacity-0 group-focus-within/activity-row:pointer-events-none group-focus-within/activity-row:opacity-0",
  "project-header":
    "transition-opacity group-hover/project-header:pointer-events-none group-hover/project-header:opacity-0 group-has-[:focus-visible]/project-header:pointer-events-none group-has-[:focus-visible]/project-header:opacity-0",
  "thread-row":
    "transition-opacity group-hover/thread-row:pointer-events-none group-hover/thread-row:opacity-0 group-focus-within/thread-row:pointer-events-none group-focus-within/thread-row:opacity-0",
};

export function sidebarHoverRevealHideClassName(group: SidebarHoverRevealGroup): string {
  return SIDEBAR_HOVER_REVEAL_HIDE_CLASS_NAME[group];
}

export const SIDEBAR_HEADER_LABEL_CLASS_NAME = "truncate";
