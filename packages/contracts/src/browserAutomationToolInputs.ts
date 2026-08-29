import { Schema } from "effect";

import { BoundedUtf8String } from "./browserAutomationBounds";
import {
  BrowserIdempotencyKey,
  BrowserTabId,
  BrowserWebMcpDiscoveryId,
  BrowserWebMcpToolId,
} from "./browserAutomationIds";
import { BrowserBoundedJsonObject } from "./browserAutomationJson";
import { BrowserNodeTarget, BrowserPointerTarget } from "./browserAutomationTargets";
import {
  BrowserLoadState,
  browserBoundedInt as boundedInt,
  browserClosedStruct as closedStruct,
} from "./browserAutomationToolCommon";

const described = <S extends Schema.Top>(schema: S, description: string): S =>
  schema.annotate({ description }) as S;

export const BROWSER_FIELD_INSTRUCTION_COPY = {
  tabId:
    "Optional scoped tab returned by browser_tabs/open; omit to use provider-session affinity.",
  timeoutMs: "Optional end-to-end action deadline in milliseconds within the published bounds.",
  idempotencyKey:
    "Optional advanced retry key. Synara derives a stable key from the authenticated tool request when omitted; provide one only to deliberately deduplicate a byte-identical retry.",
  target:
    "Exactly one target; prefer a current snapshot {ref,snapshotId}, then a literal semantic locator, strict CSS, or an allowed point.",
  show: "Whether to request the shared browser surface when its owning thread is already active; defaults true and never changes the user's active chat. False reuses an existing scoped tab without requesting UI visibility.",
  waitUntil:
    "Navigation milestone; domcontentloaded is the default, while networkidle uses Synara's bounded tracker.",
  annotationId:
    "Optional opaque annotation id from a browser annotation attachment. Pass exactly one of annotationId or url; annotationId resolves the exact captured live page locally without embedding its private live URL in the prompt.",
  conditions:
    'One to eight closed wait conditions. Every condition uses the discriminator field "kind" (never "type"), for example {"kind":"text","text":"Done","state":"present"}; a deliberate bounded delay uses {"kind":"delay","timeMs":500}; no regular expressions or arbitrary predicates.',
} as const;

export const BrowserTimeoutMs = described(
  boundedInt(100, 30_000).pipe(Schema.brand("BrowserTimeoutMs")),
  BROWSER_FIELD_INSTRUCTION_COPY.timeoutMs,
);

function makeInvocationFields() {
  return {
    timeoutMs: Schema.optional(BrowserTimeoutMs),
    idempotencyKey: Schema.optional(
      described(BrowserIdempotencyKey, BROWSER_FIELD_INSTRUCTION_COPY.idempotencyKey),
    ),
  };
}

const readOnlyInvocationFields = makeInvocationFields();
const effectingInvocationFields = makeInvocationFields();
const optionalTabField = {
  tabId: Schema.optional(described(BrowserTabId, BROWSER_FIELD_INSTRUCTION_COPY.tabId)),
};

export const BrowserReadOnlyInvocationCommon = closedStruct(readOnlyInvocationFields);
export const BrowserEffectingInvocationCommon = closedStruct(effectingInvocationFields);
export const BrowserReadOnlyTabInvocationCommon = closedStruct({
  ...readOnlyInvocationFields,
  ...optionalTabField,
});
export const BrowserEffectingTabInvocationCommon = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
});

const BrowserUrl = described(
  BoundedUtf8String(8_192, 1),
  "Absolute HTTP or HTTPS URL, bounded to 8 KiB. Localhost and other local addresses are fully supported. Other schemes (e.g. file:) are rejected as tool input only — the integrated browser itself can open local HTML files when the user enters them in its address bar.",
);
const BrowserAnnotationId = described(
  BoundedUtf8String(128, 1).check(
    Schema.makeFilter((value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)),
  ),
  BROWSER_FIELD_INSTRUCTION_COPY.annotationId,
);
const BrowserWaitUntil = described(BrowserLoadState, BROWSER_FIELD_INSTRUCTION_COPY.waitUntil);
const BrowserTypedText = described(
  BoundedUtf8String(65_536),
  "Literal text to enter, bounded to 64 KiB in UTF-8; it is never selector or expression source.",
);
const BrowserEvaluateExpression = described(
  BoundedUtf8String(16_384, 1),
  "One main-world JavaScript expression bounded to 16 KiB; the result must be bounded JSON.",
);
const BrowserWaitText = BoundedUtf8String(2_048, 1);
export const BrowserWorkspaceRelativePath = described(
  BoundedUtf8String(4_096, 1).check(
    Schema.makeFilter((value: string) => {
      if (/^[a-zA-Z]:[\\/]/u.test(value) || /^[\\/]/u.test(value)) return false;
      if (/\u0000/u.test(value)) return false;
      const segments = value.split(/[\\/]/u);
      return (
        segments.length > 0 &&
        segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
      );
    }),
  ),
  "Workspace-relative file path bounded to 4 KiB. Absolute paths, parent traversal and empty/dot segments are rejected; the desktop resolves every symlink and requires the final regular file to remain inside the canonical workspace root.",
);
const BrowserKeyChord = described(
  BoundedUtf8String(128, 1).check(
    Schema.makeFilter(
      (value: string) =>
        !/[\u0000-\u001f\u007f]/u.test(value) &&
        /^(?:(?:Alt|Control|Meta|Shift)\+)*(?:[A-Za-z0-9]|Arrow(?:Down|Left|Right|Up)|Backspace|Delete|End|Enter|Escape|Home|PageDown|PageUp|Space|Tab|F(?:[1-9]|1[0-2]))$/u.test(
          value,
        ),
    ),
  ),
  'Case-sensitive normalized page key chord such as "Enter", "Tab", "Control+A", or "Shift+ArrowDown"; modifiers must be in Alt, Control, Meta, Shift order. Privileged browser or OS chords are unsupported.',
);

const defaultTrue = () => true;
const defaultFalse = () => false;
const defaultDomContentLoaded = () => "domcontentloaded" as const;
const optionalDefault = <S extends Schema.Top>(schema: S, value: () => S["Encoded"]) =>
  Schema.optional(schema).pipe(Schema.withDecodingDefault<Schema.optional<S>>(value));

export const BrowserStatusInput = closedStruct(readOnlyInvocationFields);
export const BrowserTabsInput = closedStruct(readOnlyInvocationFields);
export const BrowserToolOpenInput = closedStruct({
  ...effectingInvocationFields,
  url: Schema.optional(BrowserUrl),
  show: optionalDefault(
    described(Schema.Boolean, BROWSER_FIELD_INSTRUCTION_COPY.show),
    defaultTrue,
  ),
  reuse: optionalDefault(
    described(
      Schema.Boolean,
      "Whether an existing assigned/current scoped live tab may be reused; defaults true. False always requests a new tab.",
    ),
    defaultTrue,
  ),
});
export const BrowserToolNavigateInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  url: Schema.optional(BrowserUrl),
  annotationId: Schema.optional(BrowserAnnotationId),
  waitUntil: optionalDefault(BrowserWaitUntil, defaultDomContentLoaded),
}).check(
  Schema.makeFilter((input) => (input.url === undefined) !== (input.annotationId === undefined)),
);
const BrowserHistoryNavigationFields = {
  ...effectingInvocationFields,
  ...optionalTabField,
  waitUntil: optionalDefault(BrowserWaitUntil, defaultDomContentLoaded),
};
export const BrowserBackInput = closedStruct(BrowserHistoryNavigationFields);
export const BrowserForwardInput = closedStruct(BrowserHistoryNavigationFields);
export const BrowserReloadInput = closedStruct({
  ...BrowserHistoryNavigationFields,
  ignoreCache: optionalDefault(
    described(Schema.Boolean, "Bypass Chromium's HTTP cache for this reload; defaults false."),
    defaultFalse,
  ),
});
export const BrowserResizeInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  width: described(
    boundedInt(320, 3_840),
    "Requested viewport width in CSS pixels, from 320 through 3840.",
  ),
  height: described(
    boundedInt(240, 2_160),
    "Requested viewport height in CSS pixels, from 240 through 2160.",
  ),
});
export const BrowserSnapshotInput = closedStruct({
  ...readOnlyInvocationFields,
  ...optionalTabField,
  includeImage: optionalDefault(
    described(
      Schema.Boolean,
      "Include bounded PNG image metadata and a host-only PNG sidecar; defaults false. Prefer semantic snapshots and request an image only as a visual fallback.",
    ),
    defaultFalse,
  ),
  includeDiagnostics: optionalDefault(
    described(
      Schema.Boolean,
      "Include bounded semantic collection and truncation diagnostics; defaults true.",
    ),
    defaultTrue,
  ),
});
export const BrowserWebMcpToolsInput = closedStruct({
  ...readOnlyInvocationFields,
  ...optionalTabField,
  query: Schema.optional(
    described(
      BoundedUtf8String(512, 1),
      "Optional current user goal used to rank page-declared WebMCP tools before returning them.",
    ),
  ),
  limit: optionalDefault(
    described(
      boundedInt(1, 32),
      "Maximum page-declared WebMCP tools to return after ranking; defaults to 8.",
    ),
    () => 8,
  ),
});
export const BrowserWebMcpCallInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  discoveryId: described(
    BrowserWebMcpDiscoveryId,
    "Opaque discovery id returned by browser_webmcp_tools for the current document.",
  ),
  toolId: described(
    BrowserWebMcpToolId,
    "Opaque tool id returned by browser_webmcp_tools; never substitute the page tool name.",
  ),
  arguments: Schema.optional(BrowserBoundedJsonObject).pipe(
    Schema.withDecodingDefault<Schema.optional<typeof BrowserBoundedJsonObject>>(() => ({})),
  ),
});
export const BrowserScreenshotInput = closedStruct({
  ...readOnlyInvocationFields,
  ...optionalTabField,
  fullPage: optionalDefault(
    described(
      Schema.Boolean,
      "Capture the bounded main-frame document instead of only the visible viewport; defaults false. Oversized documents are clipped and reported, never captured without bounds.",
    ),
    defaultFalse,
  ),
});
export const BrowserLogsInput = closedStruct({
  ...readOnlyInvocationFields,
  ...optionalTabField,
  includeConsole: optionalDefault(
    described(
      Schema.Boolean,
      "Include bounded page console, exception and Chromium log entries; defaults true.",
    ),
    defaultTrue,
  ),
  includeNetwork: optionalDefault(
    described(
      Schema.Boolean,
      "Include bounded network request/response/failure metadata without headers or bodies; defaults true.",
    ),
    defaultTrue,
  ),
  limit: optionalDefault(
    described(
      boundedInt(1, 200),
      "Maximum combined entries to return, from one through 200; defaults 100.",
    ),
    () => 100,
  ),
}).check(Schema.makeFilter((value) => value.includeConsole || value.includeNetwork));
export const BrowserClickInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  target: described(BrowserPointerTarget, BROWSER_FIELD_INSTRUCTION_COPY.target),
  button: Schema.optional(
    described(Schema.Literals(["left", "right", "middle"]), "Mouse button; defaults to left."),
  ),
  clickCount: Schema.optional(
    described(boundedInt(1, 3), "Number of clicks, from one through three; defaults to one."),
  ),
});
export const BrowserHoverInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  target: described(BrowserPointerTarget, BROWSER_FIELD_INSTRUCTION_COPY.target),
});
export const BrowserDragInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  source: described(
    BrowserPointerTarget,
    "Exact drag source; prefer a current snapshot {ref,snapshotId}, then a literal locator, strict CSS selector or viewport point.",
  ),
  target: described(
    BrowserPointerTarget,
    "Exact drop target; prefer a current snapshot {ref,snapshotId}, then a literal locator, strict CSS selector or viewport point.",
  ),
  steps: optionalDefault(
    described(boundedInt(1, 100), "Number of bounded trusted pointer-move steps; defaults 12."),
    () => 12,
  ),
});
export const BrowserTypeInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  target: described(
    BrowserNodeTarget,
    "Exactly one non-point target resolving to an editable element; prefer a current snapshot ref.",
  ),
  text: BrowserTypedText,
  append: optionalDefault(
    described(
      Schema.Boolean,
      "Append instead of replacing the current editable value; defaults false.",
    ),
    defaultFalse,
  ),
});
export const BrowserSelectInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  target: described(
    BrowserNodeTarget,
    "Exactly one select element; prefer a current snapshot {ref,snapshotId}.",
  ),
  values: described(
    Schema.Array(BoundedUtf8String(2_048, 1))
      .check(Schema.isMinLength(1), Schema.isMaxLength(64))
      .check(Schema.makeFilter((values) => new Set(values).size === values.length)),
    "One through 64 unique exact option values. A non-multiple select accepts exactly one value.",
  ),
});
export const BrowserUploadInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  target: described(
    BrowserNodeTarget,
    "Exactly one enabled input[type=file] in the shared browser page; prefer a current snapshot {ref,snapshotId}.",
  ),
  paths: described(
    Schema.Array(BrowserWorkspaceRelativePath)
      .check(Schema.isMinLength(1), Schema.isMaxLength(32))
      .check(Schema.makeFilter((paths) => new Set(paths).size === paths.length)),
    "One through 32 unique workspace-relative files. The desktop resolves real paths, rejects directories and refuses any symlink or path escaping the canonical workspace root.",
  ),
});
export const BrowserPressInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  keys: described(
    Schema.Array(BrowserKeyChord).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
    'An array of one through sixteen case-sensitive normalized page key chords emitted in order, for example ["Enter"] or ["Control+A", "Backspace"], with all modifiers released afterward.',
  ),
});

const BrowserScrollTarget = Schema.optional(
  described(
    BrowserPointerTarget,
    "Optional element or viewport point whose nearest scroll container should be scrolled.",
  ),
);
const nonZeroFinite = Schema.Finite.check(
  Schema.makeFilter((value: number) => value !== 0 && Math.abs(value) <= 100_000),
);
const nonZeroPageCount = boundedInt(-100_000, 100_000).check(
  Schema.makeFilter((value: number) => value !== 0),
);
export const BrowserScrollInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  mode: Schema.Literals(["pixels", "pages", "direction"]),
  deltaX: Schema.optional(nonZeroFinite),
  deltaY: Schema.optional(nonZeroFinite),
  pagesX: Schema.optional(nonZeroPageCount),
  pagesY: Schema.optional(nonZeroPageCount),
  direction: Schema.optional(Schema.Literals(["up", "down", "left", "right", "start", "end"])),
  amount: Schema.optional(boundedInt(1, 100_000)),
  target: BrowserScrollTarget,
}).check(
  Schema.makeFilter((value) => {
    if (value.mode === "pixels") {
      return (
        (value.deltaX !== undefined || value.deltaY !== undefined) &&
        value.pagesX === undefined &&
        value.pagesY === undefined &&
        value.direction === undefined &&
        value.amount === undefined
      );
    }
    if (value.mode === "pages") {
      return (
        (value.pagesX !== undefined || value.pagesY !== undefined) &&
        value.deltaX === undefined &&
        value.deltaY === undefined &&
        value.direction === undefined &&
        value.amount === undefined
      );
    }
    return (
      value.direction !== undefined &&
      value.deltaX === undefined &&
      value.deltaY === undefined &&
      value.pagesX === undefined &&
      value.pagesY === undefined
    );
  }),
);

export const BrowserWaitCondition = Schema.Union([
  closedStruct({
    kind: Schema.Literal("delay"),
    timeMs: described(
      boundedInt(1, 29_000),
      "Bounded fallback delay in milliseconds; prefer a page condition whenever one is observable.",
    ),
  }),
  closedStruct({
    kind: Schema.Literal("target"),
    target: BrowserNodeTarget,
    state: Schema.Literals(["attached", "visible", "hidden", "enabled", "editable", "detached"]),
  }),
  closedStruct({
    kind: Schema.Literal("text"),
    text: BrowserWaitText,
    state: Schema.Literals(["present", "absent"]),
  }),
  closedStruct({ kind: Schema.Literal("url"), exact: BrowserUrl }),
  closedStruct({ kind: Schema.Literal("url"), glob: BrowserWaitText }),
  closedStruct({ kind: Schema.Literal("load"), state: BrowserLoadState }),
]);
export const BrowserWaitInput = closedStruct({
  ...readOnlyInvocationFields,
  ...optionalTabField,
  mode: optionalDefault(
    described(Schema.Literals(["all", "any"]), "Combine conditions using all (default) or any."),
    () => "all" as const,
  ),
  conditions: described(
    Schema.Array(BrowserWaitCondition).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    BROWSER_FIELD_INSTRUCTION_COPY.conditions,
  ),
});
export const BrowserEvaluateInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
  expression: BrowserEvaluateExpression,
});
export const BrowserCloseInput = closedStruct({
  ...effectingInvocationFields,
  ...optionalTabField,
});

export type BrowserStatusInput = typeof BrowserStatusInput.Type;
export type BrowserTabsInput = typeof BrowserTabsInput.Type;
export type BrowserToolOpenInput = typeof BrowserToolOpenInput.Type;
export type BrowserToolNavigateInput = typeof BrowserToolNavigateInput.Type;
export type BrowserBackInput = typeof BrowserBackInput.Type;
export type BrowserForwardInput = typeof BrowserForwardInput.Type;
export type BrowserReloadInput = typeof BrowserReloadInput.Type;
export type BrowserResizeInput = typeof BrowserResizeInput.Type;
export type BrowserSnapshotInput = typeof BrowserSnapshotInput.Type;
export type BrowserWebMcpToolsInput = typeof BrowserWebMcpToolsInput.Type;
export type BrowserWebMcpCallInput = typeof BrowserWebMcpCallInput.Type;
export type BrowserScreenshotInput = typeof BrowserScreenshotInput.Type;
export type BrowserLogsInput = typeof BrowserLogsInput.Type;
export type BrowserClickInput = typeof BrowserClickInput.Type;
export type BrowserHoverInput = typeof BrowserHoverInput.Type;
export type BrowserDragInput = typeof BrowserDragInput.Type;
export type BrowserTypeInput = typeof BrowserTypeInput.Type;
export type BrowserSelectInput = typeof BrowserSelectInput.Type;
export type BrowserUploadInput = typeof BrowserUploadInput.Type;
export type BrowserPressInput = typeof BrowserPressInput.Type;
export type BrowserScrollInput = typeof BrowserScrollInput.Type;
export type BrowserWaitCondition = typeof BrowserWaitCondition.Type;
export type BrowserWaitInput = typeof BrowserWaitInput.Type;
export type BrowserEvaluateInput = typeof BrowserEvaluateInput.Type;
export type BrowserCloseInput = typeof BrowserCloseInput.Type;
