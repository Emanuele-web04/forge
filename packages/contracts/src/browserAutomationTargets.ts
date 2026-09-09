import { Schema } from "effect";

import { BoundedUtf8String } from "./browserAutomationBounds";
import { BrowserCssSelector } from "./browserAutomationCssSelector";
import { BrowserElementRef, BrowserSnapshotId } from "./browserAutomationIds";
import { browserClosedStruct } from "./browserAutomationToolCommon";

export const BrowserAriaRole = Schema.Literals([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "dialog",
  "directory",
  "document",
  "feed",
  "figure",
  "form",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "meter",
  "navigation",
  "none",
  "note",
  "option",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);

const BoundedLocatorText = BoundedUtf8String(2_048, 1);

export const BrowserLocator = Schema.Union([
  browserClosedStruct({
    kind: Schema.Literal("role"),
    role: BrowserAriaRole,
    name: Schema.optional(BoundedLocatorText),
    exact: Schema.optional(Schema.Boolean),
  }),
  browserClosedStruct({
    kind: Schema.Literals(["text", "label", "placeholder"]),
    text: BoundedLocatorText,
    exact: Schema.optional(Schema.Boolean),
  }),
  browserClosedStruct({ kind: Schema.Literal("testId"), value: BoundedLocatorText }),
]);

export const BrowserNodeTarget = Schema.Union([
  browserClosedStruct({ ref: BrowserElementRef, snapshotId: BrowserSnapshotId }),
  browserClosedStruct({ locator: BrowserLocator }),
  browserClosedStruct({ selector: BrowserCssSelector }),
]);

export const BrowserPoint = browserClosedStruct({ x: Schema.Finite, y: Schema.Finite });

export const BrowserPointerTarget = Schema.Union([
  BrowserNodeTarget,
  browserClosedStruct({ point: BrowserPoint }),
]);

export const BrowserTarget = BrowserPointerTarget;

export type BrowserAriaRole = typeof BrowserAriaRole.Type;
export type BrowserLocator = typeof BrowserLocator.Type;
export type BrowserNodeTarget = typeof BrowserNodeTarget.Type;
export type BrowserPoint = typeof BrowserPoint.Type;
export type BrowserPointerTarget = typeof BrowserPointerTarget.Type;
export type BrowserTarget = typeof BrowserTarget.Type;
