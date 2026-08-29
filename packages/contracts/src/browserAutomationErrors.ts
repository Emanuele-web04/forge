import { Schema } from "effect";

import { BoundedUtf8String } from "./browserAutomationBounds";
import { BrowserOperationId, BrowserTabId } from "./browserAutomationIds";

export const BrowserErrorCode = Schema.Literals([
  "BrowserUnauthorized",
  "BrowserAuthorizationRequired",
  "BrowserAuthorizationDenied",
  "BrowserConduitAttachRejected",
  "BrowserConduitDisconnected",
  "BrowserTransportDisconnected",
  "BrowserProviderProcessMismatch",
  "BrowserTransportIsolationUnavailable",
  "BrowserHostUnavailable",
  "BrowserRuntimeDisconnected",
  "BrowserRuntimeRestarted",
  "BrowserDesktopMismatch",
  "BrowserHomeAlreadyInUse",
  "BrowserGuestAttachRejected",
  "BrowserTabNotFound",
  "BrowserTabScopeViolation",
  "BrowserCapacityExceeded",
  "BrowserQueueFull",
  "BrowserTimeout",
  "BrowserCancelled",
  "BrowserInterruptedByHuman",
  "BrowserDebuggerConflict",
  "BrowserReconciliationRequired",
  "BrowserStaleReference",
  "BrowserWebMcpDiscoveryStale",
  "BrowserTargetNotFound",
  "BrowserTargetAmbiguous",
  "BrowserTargetNotVisible",
  "BrowserTargetNotEnabled",
  "BrowserTargetObscured",
  "BrowserTargetNotEditable",
  "BrowserInvalidLocator",
  "BrowserInputUnsupported",
  "BrowserNavigationBlocked",
  "BrowserNetworkBlocked",
  "BrowserNavigationFailed",
  "BrowserPopupBlocked",
  "BrowserPopupOpenerUnsupported",
  "BrowserDownloadApprovalRequired",
  "BrowserEvaluationFailed",
  "BrowserEvaluationResultTooLarge",
  "BrowserSnapshotTooLarge",
  "BrowserScreenshotTooLarge",
  "BrowserUploadPathOutsideWorkspace",
  "BrowserUploadWorkspaceUnavailable",
  "BrowserUploadFileUnsupported",
  "BrowserMalformedResponse",
  "BrowserSpoofedResponse",
  "BrowserRequestConflict",
  "BrowserAmbiguousResult",
  "BrowserMcpNameConflict",
  "BrowserProviderIsolationUnavailable",
]);

export type BrowserErrorCode = typeof BrowserErrorCode.Type;

const BrowserAutomationErrorPhase = Schema.Literals([
  "auth",
  "queue",
  "routing",
  "runtime",
  "navigation",
  "snapshot",
  "target",
  "input",
  "evaluate",
  "cleanup",
]);

export type BrowserAutomationErrorPhase = typeof BrowserAutomationErrorPhase.Type;

type BrowserFixedAutomationErrorCode =
  | "BrowserReconciliationRequired"
  | "BrowserWebMcpDiscoveryStale"
  | "BrowserTargetAmbiguous"
  | "BrowserTargetNotEnabled"
  | "BrowserTargetObscured"
  | "BrowserInputUnsupported"
  | "BrowserScreenshotTooLarge"
  | "BrowserUploadPathOutsideWorkspace"
  | "BrowserUploadWorkspaceUnavailable"
  | "BrowserUploadFileUnsupported"
  | "BrowserAmbiguousResult";

interface BrowserFixedAutomationErrorInvariant {
  readonly retryable: boolean;
  readonly phase: BrowserAutomationErrorPhase;
  readonly effectMayHaveCommitted: boolean;
}

const fixedBrowserErrorInvariant = (
  retryable: boolean,
  phase: BrowserAutomationErrorPhase,
  effectMayHaveCommitted: boolean,
): BrowserFixedAutomationErrorInvariant =>
  Object.freeze({ retryable, phase, effectMayHaveCommitted });

export const BrowserAutomationErrorMessages = Object.freeze({
  BrowserUnauthorized: "Browser access is not authorized for this request.",
  BrowserAuthorizationRequired: "Browser authorization is required before this request can run.",
  BrowserAuthorizationDenied: "Browser authorization was denied.",
  BrowserConduitAttachRejected:
    "The browser conduit could not be attached to this provider session.",
  BrowserConduitDisconnected: "The browser conduit disconnected before a result was delivered.",
  BrowserTransportDisconnected: "The browser transport disconnected before a result was delivered.",
  BrowserProviderProcessMismatch:
    "The provider process does not match the authorized browser session.",
  BrowserTransportIsolationUnavailable: "The required isolated browser transport is unavailable.",
  BrowserHostUnavailable: "No browser host is available for this workspace.",
  BrowserRuntimeDisconnected: "The browser runtime disconnected before a result was delivered.",
  BrowserRuntimeRestarted: "The browser runtime restarted before a result was delivered.",
  BrowserDesktopMismatch: "The browser desktop does not match this operation.",
  BrowserHomeAlreadyInUse: "The browser home is already in use by another desktop instance.",
  BrowserGuestAttachRejected:
    "The browser tab was created, but its isolated runtime could not be attached.",
  BrowserTabNotFound: "The requested browser tab was not found.",
  BrowserTabScopeViolation: "The requested browser tab is outside this thread's scope.",
  BrowserCapacityExceeded: "Browser capacity is currently exhausted.",
  BrowserQueueFull: "The browser operation queue is full.",
  BrowserTimeout: "The browser operation timed out before a confirmed result was available.",
  BrowserCancelled: "The browser operation was cancelled before a confirmed result was available.",
  BrowserInterruptedByHuman: "The browser operation was interrupted by human control.",
  BrowserDebuggerConflict: "The browser tab is currently controlled by another debugger.",
  BrowserReconciliationRequired:
    "The accepted browser routing inventory changed before the operation was admitted. Refresh browser tabs and retry.",
  BrowserStaleReference: "The snapshot reference is stale.",
  BrowserWebMcpDiscoveryStale:
    "The WebMCP discovery is stale. Discover the page's tools again before calling one.",
  BrowserTargetNotFound: "No browser element matched the locator.",
  BrowserTargetAmbiguous:
    "The locator matched more than one browser element. Use a unique locator.",
  BrowserTargetNotVisible: "The matched browser element is not visible.",
  BrowserTargetNotEnabled: "The matched browser element is disabled.",
  BrowserTargetObscured: "The matched browser element is covered by another page element.",
  BrowserTargetNotEditable: "The matched browser element is not editable.",
  BrowserInvalidLocator: "The browser locator is invalid.",
  BrowserInputUnsupported:
    "The requested browser input is unsupported. Use a supported browser action.",
  BrowserNavigationBlocked:
    "Browser navigation was rejected: browser tools accept only http/https URLs (localhost is allowed) or a resolvable annotationId. The user can open local HTML files from the integrated browser's address bar.",
  BrowserNetworkBlocked: "The browser network request was blocked by policy.",
  BrowserNavigationFailed: "Browser navigation failed before a confirmed result was available.",
  BrowserPopupBlocked: "The browser popup was blocked by policy.",
  BrowserPopupOpenerUnsupported: "The popup opener relationship is unsupported.",
  BrowserDownloadApprovalRequired: "The browser download requires explicit approval.",
  BrowserEvaluationFailed: "Browser evaluation failed before a confirmed result was available.",
  BrowserEvaluationResultTooLarge: "The browser evaluation result exceeds the safe response limit.",
  BrowserSnapshotTooLarge: "The browser snapshot exceeds the safe response limit.",
  BrowserScreenshotTooLarge: "The browser screenshot exceeds the safe response limit.",
  BrowserUploadPathOutsideWorkspace:
    "The requested upload file resolves outside the active workspace.",
  BrowserUploadWorkspaceUnavailable: "No canonical workspace is available for browser file upload.",
  BrowserUploadFileUnsupported:
    "The requested upload path is not a supported regular workspace file.",
  BrowserMalformedResponse: "Browser automation failed due to an internal error.",
  BrowserSpoofedResponse: "The browser runtime returned a response with invalid correlation.",
  BrowserRequestConflict:
    "The idempotency key is already associated with a different browser request.",
  BrowserAmbiguousResult:
    "A prior browser action may have completed, but its result is no longer available. Observe with browser_tabs or browser_snapshot before deciding on a new intention and idempotency key.",
  BrowserMcpNameConflict: "A browser tool name conflicts with another provider tool.",
  BrowserProviderIsolationUnavailable:
    "The provider cannot satisfy browser isolation requirements.",
} as const satisfies Record<BrowserErrorCode, string>);

export const BrowserFixedAutomationErrorInvariants = Object.freeze({
  BrowserReconciliationRequired: fixedBrowserErrorInvariant(true, "routing", false),
  BrowserWebMcpDiscoveryStale: fixedBrowserErrorInvariant(true, "input", false),
  BrowserTargetAmbiguous: fixedBrowserErrorInvariant(false, "target", false),
  BrowserTargetNotEnabled: fixedBrowserErrorInvariant(false, "target", false),
  BrowserTargetObscured: fixedBrowserErrorInvariant(true, "target", false),
  BrowserInputUnsupported: fixedBrowserErrorInvariant(false, "input", false),
  BrowserScreenshotTooLarge: fixedBrowserErrorInvariant(false, "snapshot", false),
  BrowserUploadPathOutsideWorkspace: fixedBrowserErrorInvariant(false, "input", false),
  BrowserUploadWorkspaceUnavailable: fixedBrowserErrorInvariant(false, "input", false),
  BrowserUploadFileUnsupported: fixedBrowserErrorInvariant(false, "input", false),
  BrowserAmbiguousResult: fixedBrowserErrorInvariant(false, "runtime", true),
} as const satisfies Record<BrowserFixedAutomationErrorCode, BrowserFixedAutomationErrorInvariant>);

const getFixedBrowserErrorInvariant = (
  code: BrowserErrorCode,
): BrowserFixedAutomationErrorInvariant | undefined =>
  BrowserFixedAutomationErrorInvariants[code as BrowserFixedAutomationErrorCode];

const BrowserAutomationErrorFields = Schema.Struct({
  code: BrowserErrorCode,
  message: BoundedUtf8String(512, 1),
  retryable: Schema.Boolean,
  phase: BrowserAutomationErrorPhase,
  operationId: Schema.optional(BrowserOperationId),
  tabId: Schema.optional(BrowserTabId),
  effectMayHaveCommitted: Schema.Boolean,
});

export const BrowserAutomationError = BrowserAutomationErrorFields.check(
  Schema.makeFilter((error: typeof BrowserAutomationErrorFields.Type) => {
    const fixedInvariant = getFixedBrowserErrorInvariant(error.code);
    return (
      error.message === BrowserAutomationErrorMessages[error.code] &&
      (fixedInvariant === undefined ||
        (error.retryable === fixedInvariant.retryable &&
          error.phase === fixedInvariant.phase &&
          error.effectMayHaveCommitted === fixedInvariant.effectMayHaveCommitted))
    );
  }),
);

export const BrowserMcpToolErrorEnvelope = Schema.Struct({
  type: Schema.Literal("synara_browser_error"),
  version: Schema.Literal(1),
  error: BrowserAutomationError,
});

export type BrowserAutomationError = typeof BrowserAutomationError.Type;
export type BrowserMcpToolErrorEnvelope = typeof BrowserMcpToolErrorEnvelope.Type;

export interface BrowserAutomationErrorCorrelation {
  readonly operationId?: BrowserOperationId;
  readonly tabId?: BrowserTabId;
}

type BrowserContextualAutomationErrorCode = Exclude<
  BrowserErrorCode,
  BrowserFixedAutomationErrorCode
>;

type BrowserFixedAutomationErrorInput = BrowserAutomationErrorCorrelation & {
  readonly code: BrowserFixedAutomationErrorCode;
};

type BrowserContextualAutomationErrorInput = BrowserAutomationErrorCorrelation & {
  readonly code: BrowserContextualAutomationErrorCode;
  readonly retryable: boolean;
  readonly phase: BrowserAutomationErrorPhase;
  readonly effectMayHaveCommitted: boolean;
};

export type BrowserAutomationErrorInput =
  | BrowserFixedAutomationErrorInput
  | BrowserContextualAutomationErrorInput;
