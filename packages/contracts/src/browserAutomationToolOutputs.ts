import { Schema } from "effect";

import { BoundedUtf8String } from "./browserAutomationBounds";
import {
  BrowserElementRef,
  BrowserSnapshotId,
  BrowserTabId,
  BrowserWebMcpDiscoveryId,
  BrowserWebMcpToolId,
} from "./browserAutomationIds";
import {
  BrowserBoundedJson,
  BrowserBoundedJsonObject,
  browserJsonBytes,
} from "./browserAutomationJson";
import { BrowserAriaRole, BrowserPoint } from "./browserAutomationTargets";
import {
  BrowserLoadState,
  browserBoundedInt as boundedInt,
  browserClosedStruct as closedStruct,
} from "./browserAutomationToolCommon";

const BoundedUrl = BoundedUtf8String(8_192, 1);
const BoundedTitle = BoundedUtf8String(2_048);

export const BrowserDialogEvent = closedStruct({
  kind: Schema.Literals(["alert", "confirm", "prompt", "beforeunload"]),
  message: BoundedUtf8String(4_096),
  defaultPrompt: Schema.optional(BoundedUtf8String(4_096)),
  action: Schema.Literals(["accepted", "dismissed"]),
  openedAt: Schema.DateTimeUtcFromString,
});
const optionalDialogFields = {
  dialogs: Schema.optional(Schema.Array(BrowserDialogEvent).check(Schema.isMaxLength(20))),
};

export const BrowserViewport = closedStruct({
  width: boundedInt(1, 3_840),
  height: boundedInt(1, 2_160),
  deviceScaleFactor: Schema.Finite.check(Schema.isBetween({ minimum: 0.25, maximum: 8 })),
});

export const BrowserTabSummary = closedStruct({
  tabId: BrowserTabId,
  title: BoundedTitle,
  url: BoundedUrl,
  active: Schema.Boolean,
  loading: Schema.Boolean,
  routable: Schema.Boolean,
  state: Schema.Literals(["live", "restore-held", "restoration-blocked", "crashed"]),
});

export const BrowserStatusOutput = closedStruct({
  available: Schema.Boolean,
  physicalScope: Schema.Literals(["visible-shared-electron-webview"]),
  assignedTabId: Schema.NullOr(BrowserTabId),
  authorization: Schema.Literals(["not-required", "pending", "granted", "denied", "revoked"]),
});

export const BrowserTabsOutput = closedStruct({
  tabs: Schema.Array(BrowserTabSummary).check(Schema.isMaxLength(24)),
  activeTabId: Schema.NullOr(BrowserTabId),
  assignedTabId: Schema.NullOr(BrowserTabId),
});

const BrowserNavigationOutputFields = {
  tabId: BrowserTabId,
  finalUrl: BoundedUrl,
  redirects: Schema.Array(BoundedUrl).check(Schema.isMaxLength(20)),
  loadState: BrowserLoadState,
  ...optionalDialogFields,
};

export const BrowserOpenOutput = closedStruct({
  ...BrowserNavigationOutputFields,
  disposition: Schema.Literals(["created", "reused"]),
});
export const BrowserNavigateOutput = closedStruct(BrowserNavigationOutputFields);
export const BrowserBackOutput = BrowserNavigateOutput;
export const BrowserForwardOutput = BrowserNavigateOutput;
export const BrowserReloadOutput = BrowserNavigateOutput;
export const BrowserResizeOutput = closedStruct({
  tabId: BrowserTabId,
  requested: closedStruct({ width: boundedInt(320, 3_840), height: boundedInt(240, 2_160) }),
  observed: BrowserViewport,
  ...optionalDialogFields,
});

const BrowserSnapshotContextAncestor = closedStruct({
  role: BrowserAriaRole,
  name: BoundedUtf8String(512),
});

const BrowserSnapshotElement = closedStruct({
  ref: BrowserElementRef,
  role: BrowserAriaRole,
  name: BoundedUtf8String(2_048),
  context: Schema.optional(
    Schema.Array(BrowserSnapshotContextAncestor).check(Schema.isMaxLength(4)),
  ),
  description: Schema.optional(BoundedUtf8String(2_048)),
  value: Schema.optional(BoundedUtf8String(4_096)),
  bounds: closedStruct({
    x: Schema.Finite,
    y: Schema.Finite,
    width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  states: Schema.Array(BoundedUtf8String(64, 1)).check(Schema.isMaxLength(24)),
});
const BrowserSnapshotDiagnostic = closedStruct({
  code: BoundedUtf8String(128, 1),
  message: BoundedUtf8String(1_024, 1),
});
const BrowserImageMetadata = closedStruct({
  mimeType: Schema.Literal("image/png"),
  width: boundedInt(1, 3_840),
  height: boundedInt(1, 2_160),
  byteLength: boundedInt(1, 8 * 1024 * 1024),
});

export const BrowserSnapshotOutput = closedStruct({
  snapshotId: BrowserSnapshotId,
  tabId: BrowserTabId,
  url: BoundedUrl,
  title: BoundedTitle,
  capturedAt: Schema.DateTimeUtcFromString,
  viewport: BrowserViewport,
  semanticSource: Schema.Literal("bounded-wai-aria"),
  semanticCoverage: closedStruct({
    openShadow: Schema.Literal("observed"),
    interceptedClosedShadow: Schema.Literal("unobservable"),
    declarativeClosedShadow: Schema.Literal("unobservable"),
  }),
  elements: Schema.Array(BrowserSnapshotElement).check(Schema.isMaxLength(250)),
  visibleText: BoundedUtf8String(131_072),
  diagnostics: Schema.Array(BrowserSnapshotDiagnostic).check(Schema.isMaxLength(64)),
  truncationReasons: Schema.Array(BoundedUtf8String(128, 1)).check(Schema.isMaxLength(16)),
  image: Schema.optional(BrowserImageMetadata),
  ...optionalDialogFields,
}).check(Schema.makeFilter((value) => browserJsonBytes(value) <= 512 * 1024));

const BrowserWebMcpTool = closedStruct({
  toolId: BrowserWebMcpToolId,
  name: BoundedUtf8String(128, 1),
  title: Schema.optional(BoundedUtf8String(1_024, 1)),
  description: BoundedUtf8String(4_096, 1),
  inputSchema: BrowserBoundedJsonObject,
  origin: BoundedUtf8String(8_192, 1),
  annotations: closedStruct({
    readOnlyHint: Schema.Boolean,
    untrustedContentHint: Schema.Boolean,
  }),
});

export const BrowserWebMcpToolsOutput = closedStruct({
  tabId: BrowserTabId,
  url: BoundedUrl,
  contentTrust: Schema.Literal("untrusted-web-page"),
  available: Schema.Boolean,
  implementation: Schema.Literals(["native", "compatibility", "unavailable"]),
  discoveryId: Schema.NullOr(BrowserWebMcpDiscoveryId),
  tools: Schema.Array(BrowserWebMcpTool).check(Schema.isMaxLength(32)),
  totalToolCount: boundedInt(0, 128),
  skippedToolCount: boundedInt(0, 1_000_000),
  truncated: Schema.Boolean,
  ...optionalDialogFields,
}).check(
  Schema.makeFilter((value) => {
    if (!value.available) {
      return (
        value.implementation === "unavailable" &&
        value.discoveryId === null &&
        value.tools.length === 0 &&
        value.totalToolCount === 0
      );
    }
    return value.implementation !== "unavailable" && value.discoveryId !== null;
  }),
  Schema.makeFilter((value) => browserJsonBytes(value) <= 512 * 1024),
);

const BrowserSnapshotImage = closedStruct({
  mimeType: Schema.Literal("image/png"),
  data: BoundedUtf8String(11 * 1024 * 1024, 1),
  width: boundedInt(1, 3_840),
  height: boundedInt(1, 2_160),
  byteLength: boundedInt(1, 8 * 1024 * 1024),
});
export const BrowserSnapshotHostOutput = closedStruct({
  structuredContent: BrowserSnapshotOutput,
  image: Schema.optional(BrowserSnapshotImage),
});

const BrowserScreenshotImageMetadata = closedStruct({
  mimeType: Schema.Literal("image/png"),
  width: boundedInt(1, 3_840),
  height: boundedInt(1, 16_384),
  byteLength: boundedInt(1, 8 * 1024 * 1024),
});
export const BrowserScreenshotOutput = closedStruct({
  tabId: BrowserTabId,
  url: BoundedUrl,
  capturedAt: Schema.DateTimeUtcFromString,
  mode: Schema.Literals(["viewport", "fullPage"]),
  clipped: Schema.Boolean,
  image: BrowserScreenshotImageMetadata,
  ...optionalDialogFields,
});
const BrowserScreenshotImage = closedStruct({
  mimeType: Schema.Literal("image/png"),
  data: BoundedUtf8String(11 * 1024 * 1024, 1),
  width: boundedInt(1, 3_840),
  height: boundedInt(1, 16_384),
  byteLength: boundedInt(1, 8 * 1024 * 1024),
});
export const BrowserScreenshotHostOutput = closedStruct({
  structuredContent: BrowserScreenshotOutput,
  image: BrowserScreenshotImage,
});

export const BrowserConsoleLogEntry = closedStruct({
  kind: Schema.Literal("console"),
  timestamp: Schema.DateTimeUtcFromString,
  level: Schema.Literals(["debug", "info", "log", "warn", "error", "exception"]),
  text: BoundedUtf8String(4_096),
  url: Schema.optional(BoundedUrl),
  lineNumber: Schema.optional(boundedInt(0, 10_000_000)),
  columnNumber: Schema.optional(boundedInt(0, 10_000_000)),
});
export const BrowserNetworkLogEntry = closedStruct({
  kind: Schema.Literal("network"),
  timestamp: Schema.DateTimeUtcFromString,
  phase: Schema.Literals(["request", "response", "failure"]),
  requestId: BoundedUtf8String(256, 1),
  url: BoundedUrl,
  method: BoundedUtf8String(32, 1),
  status: Schema.optional(boundedInt(100, 599)),
  mimeType: Schema.optional(BoundedUtf8String(256)),
  errorText: Schema.optional(BoundedUtf8String(1_024)),
  durationMs: Schema.optional(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 3_600_000 })),
  ),
});
export const BrowserLogEntry = Schema.Union([BrowserConsoleLogEntry, BrowserNetworkLogEntry]);
export const BrowserLogsOutput = closedStruct({
  tabId: BrowserTabId,
  startedAt: Schema.DateTimeUtcFromString,
  capturedAt: Schema.DateTimeUtcFromString,
  entries: Schema.Array(BrowserLogEntry).check(Schema.isMaxLength(200)),
  droppedCount: boundedInt(0, 1_000_000_000),
  truncated: Schema.Boolean,
  ...optionalDialogFields,
}).check(Schema.makeFilter((value) => browserJsonBytes(value) <= 512 * 1024));

const BrowserResolvedTarget = closedStruct({
  ref: Schema.optional(BrowserElementRef),
  role: Schema.optional(BrowserAriaRole),
  name: Schema.optional(BoundedUtf8String(2_048)),
});
const BrowserHumanActionRequired = closedStruct({
  kind: Schema.Literal("oauth_popup"),
  instruction: Schema.Literal("Complete sign-in in the visible popup before continuing."),
});
const BrowserPopupCorrelationOutputFields = {
  openedTabId: Schema.optional(BrowserTabId),
  humanActionRequired: Schema.optional(BrowserHumanActionRequired),
};
export const BrowserClickOutput = closedStruct({
  ...BrowserNavigationOutputFields,
  target: BrowserResolvedTarget,
  point: BrowserPoint,
  ...BrowserPopupCorrelationOutputFields,
});
export const BrowserHoverOutput = closedStruct({
  tabId: BrowserTabId,
  target: BrowserResolvedTarget,
  point: BrowserPoint,
  ...optionalDialogFields,
});
export const BrowserDragOutput = closedStruct({
  tabId: BrowserTabId,
  source: closedStruct({ target: BrowserResolvedTarget, point: BrowserPoint }),
  target: closedStruct({ target: BrowserResolvedTarget, point: BrowserPoint }),
  ...optionalDialogFields,
});
export const BrowserTypeOutput = closedStruct({
  tabId: BrowserTabId,
  target: BrowserResolvedTarget,
  resultingValue: closedStruct({
    kind: Schema.Literals(["empty", "text", "redacted", "unavailable"]),
    length: boundedInt(0, 65_536),
    value: Schema.optional(BoundedUtf8String(4_096)),
  }),
  ...optionalDialogFields,
});
export const BrowserSelectOutput = closedStruct({
  tabId: BrowserTabId,
  target: BrowserResolvedTarget,
  selectedValues: Schema.Array(BoundedUtf8String(2_048, 1)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
  ...optionalDialogFields,
});
export const BrowserUploadOutput = closedStruct({
  tabId: BrowserTabId,
  target: BrowserResolvedTarget,
  files: Schema.Array(
    closedStruct({
      name: BoundedUtf8String(1_024, 1),
      byteLength: boundedInt(0, 2_147_483_647),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  ...optionalDialogFields,
});
export const BrowserPressOutput = closedStruct({
  tabId: BrowserTabId,
  emitted: Schema.Array(BoundedUtf8String(128, 1)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  modifiersReleased: Schema.Boolean,
  ...BrowserPopupCorrelationOutputFields,
  ...optionalDialogFields,
});
const BrowserWebMcpCallError = closedStruct({
  name: BoundedUtf8String(256, 1),
  message: BoundedUtf8String(4_096, 1),
});
export const BrowserWebMcpCallOutput = closedStruct({
  tabId: BrowserTabId,
  discoveryId: BrowserWebMcpDiscoveryId,
  toolId: BrowserWebMcpToolId,
  toolName: BoundedUtf8String(128, 1),
  contentTrust: Schema.Literal("untrusted-web-page"),
  status: Schema.Literals(["completed", "failed"]),
  result: Schema.optional(BrowserBoundedJson),
  error: Schema.optional(BrowserWebMcpCallError),
  finalUrl: BoundedUrl,
  navigated: Schema.Boolean,
  redirects: Schema.Array(BoundedUrl).check(Schema.isMaxLength(20)),
  loadState: Schema.optional(BrowserLoadState),
  ...BrowserPopupCorrelationOutputFields,
  ...optionalDialogFields,
}).check(
  Schema.makeFilter((value) =>
    value.status === "completed"
      ? value.result !== undefined && value.error === undefined
      : value.result === undefined && value.error !== undefined,
  ),
  Schema.makeFilter((value) => browserJsonBytes(value) <= 512 * 1024),
);
const BrowserScrollPosition = closedStruct({ x: Schema.Finite, y: Schema.Finite });
export const BrowserScrollOutput = closedStruct({
  tabId: BrowserTabId,
  before: BrowserScrollPosition,
  after: BrowserScrollPosition,
  reachedBoundary: closedStruct({
    top: Schema.Boolean,
    right: Schema.Boolean,
    bottom: Schema.Boolean,
    left: Schema.Boolean,
  }),
  ...optionalDialogFields,
});
export const BrowserWaitOutput = closedStruct({
  tabId: BrowserTabId,
  satisfiedConditionIndexes: Schema.Array(boundedInt(0, 7)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  observed: closedStruct({ url: BoundedUrl, loadState: BrowserLoadState }),
  ...optionalDialogFields,
});
export const BrowserEvaluateOutput = closedStruct({
  tabId: BrowserTabId,
  value: BrowserBoundedJson,
  serializedByteCount: boundedInt(0, 262_144),
  ...optionalDialogFields,
});
export const BrowserCloseOutput = closedStruct({
  closedTabId: BrowserTabId,
  activeTabId: Schema.NullOr(BrowserTabId),
  ...optionalDialogFields,
});

export type BrowserStatusOutput = typeof BrowserStatusOutput.Type;
export type BrowserTabsOutput = typeof BrowserTabsOutput.Type;
export type BrowserOpenOutput = typeof BrowserOpenOutput.Type;
export type BrowserNavigateOutput = typeof BrowserNavigateOutput.Type;
export type BrowserBackOutput = typeof BrowserBackOutput.Type;
export type BrowserForwardOutput = typeof BrowserForwardOutput.Type;
export type BrowserReloadOutput = typeof BrowserReloadOutput.Type;
export type BrowserResizeOutput = typeof BrowserResizeOutput.Type;
export type BrowserSnapshotOutput = typeof BrowserSnapshotOutput.Type;
export type BrowserSnapshotHostOutput = typeof BrowserSnapshotHostOutput.Type;
export type BrowserWebMcpToolsOutput = typeof BrowserWebMcpToolsOutput.Type;
export type BrowserWebMcpCallOutput = typeof BrowserWebMcpCallOutput.Type;
export type BrowserScreenshotOutput = typeof BrowserScreenshotOutput.Type;
export type BrowserScreenshotHostOutput = typeof BrowserScreenshotHostOutput.Type;
export type BrowserConsoleLogEntry = typeof BrowserConsoleLogEntry.Type;
export type BrowserNetworkLogEntry = typeof BrowserNetworkLogEntry.Type;
export type BrowserLogEntry = typeof BrowserLogEntry.Type;
export type BrowserLogsOutput = typeof BrowserLogsOutput.Type;
export type BrowserClickOutput = typeof BrowserClickOutput.Type;
export type BrowserHoverOutput = typeof BrowserHoverOutput.Type;
export type BrowserDragOutput = typeof BrowserDragOutput.Type;
export type BrowserTypeOutput = typeof BrowserTypeOutput.Type;
export type BrowserSelectOutput = typeof BrowserSelectOutput.Type;
export type BrowserUploadOutput = typeof BrowserUploadOutput.Type;
export type BrowserPressOutput = typeof BrowserPressOutput.Type;
export type BrowserScrollOutput = typeof BrowserScrollOutput.Type;
export type BrowserWaitOutput = typeof BrowserWaitOutput.Type;
export type BrowserEvaluateOutput = typeof BrowserEvaluateOutput.Type;
export type BrowserCloseOutput = typeof BrowserCloseOutput.Type;
