// FILE: settingsSidebarNavStyles.ts
// Purpose: Settings sidebar navigation layout tokens (section labels, groups).
// Layer: UI styling helper
// Exports: settings-specific section tokens; row tokens re-exported from sidebarRowStyles

import {
  SIDEBAR_HEADER_LABEL_CLASS_NAME,
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
} from "./sidebarRowStyles";
import { SETTINGS_SECTION_LABEL_CLASS_NAME } from "./settingsPanelStyles";

/** Wrapper for each settings group — break before the next header matches the project list rhythm. */
export const SETTINGS_SIDEBAR_SECTION_CLASS_NAME = "flex flex-col not-first:mt-3";

/** Section labels ("App", "Synara") — shared with the settings content panel. */
export const SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME = SETTINGS_SECTION_LABEL_CLASS_NAME;

/** Nav row — same chrome as project/chat sidebar header rows. */
export const SETTINGS_SIDEBAR_ITEM_CLASS_NAME = SIDEBAR_HEADER_ROW_CLASS_NAME;

export const SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME = SIDEBAR_HEADER_LABEL_CLASS_NAME;

/** Inner glyph size; tone is set at each call site to `text-inherit` so the glyph tracks the row text. */
export const SETTINGS_SIDEBAR_ICON_CLASS_NAME = "size-4";

/**
 * Idle nav rows rest at the same foreground as primary sidebar item rows (thread/project
 * names) so settings navigation reads as part of the sidebar instead of a muted secondary
 * list. The leading icon inherits this via `tone="text-inherit"` at the call site, so label
 * and glyph track together through hover and the active fill.
 */
export const SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME = [
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
].join(" ");

export const SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME = SIDEBAR_ROW_ACTIVE_CLASS_NAME;

export const SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME = SIDEBAR_NESTED_LIST_GAP_CLASS_NAME;
