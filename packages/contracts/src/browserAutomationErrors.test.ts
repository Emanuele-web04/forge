import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import * as BrowserContracts from "./index";
import {
  BrowserAutomationError,
  BrowserAutomationErrorMessages,
  BrowserErrorCode,
  BrowserFixedAutomationErrorInvariants,
  BrowserMcpToolErrorEnvelope,
  utf8ByteLength,
} from "./index";

const browserErrorCodes = [
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
] as const;

const validError = {
  code: "BrowserStaleReference" as const,
  message: "The snapshot reference is stale.",
  retryable: true,
  phase: "target" as const,
  effectMayHaveCommitted: false,
};

const specialPolicies = {
  BrowserReconciliationRequired: {
    message:
      "The accepted browser routing inventory changed before the operation was admitted. Refresh browser tabs and retry.",
    retryable: true,
    phase: "routing",
    effectMayHaveCommitted: false,
  },
  BrowserWebMcpDiscoveryStale: {
    message: "The WebMCP discovery is stale. Discover the page's tools again before calling one.",
    retryable: true,
    phase: "input",
    effectMayHaveCommitted: false,
  },
  BrowserTargetAmbiguous: {
    message: "The locator matched more than one browser element. Use a unique locator.",
    retryable: false,
    phase: "target",
    effectMayHaveCommitted: false,
  },
  BrowserTargetNotEnabled: {
    message: "The matched browser element is disabled.",
    retryable: false,
    phase: "target",
    effectMayHaveCommitted: false,
  },
  BrowserTargetObscured: {
    message: "The matched browser element is covered by another page element.",
    retryable: true,
    phase: "target",
    effectMayHaveCommitted: false,
  },
  BrowserInputUnsupported: {
    message: "The requested browser input is unsupported. Use a supported browser action.",
    retryable: false,
    phase: "input",
    effectMayHaveCommitted: false,
  },
  BrowserScreenshotTooLarge: {
    message: "The browser screenshot exceeds the safe response limit.",
    retryable: false,
    phase: "snapshot",
    effectMayHaveCommitted: false,
  },
  BrowserUploadPathOutsideWorkspace: {
    message: "The requested upload file resolves outside the active workspace.",
    retryable: false,
    phase: "input",
    effectMayHaveCommitted: false,
  },
  BrowserUploadWorkspaceUnavailable: {
    message: "No canonical workspace is available for browser file upload.",
    retryable: false,
    phase: "input",
    effectMayHaveCommitted: false,
  },
  BrowserUploadFileUnsupported: {
    message: "The requested upload path is not a supported regular workspace file.",
    retryable: false,
    phase: "input",
    effectMayHaveCommitted: false,
  },
  BrowserAmbiguousResult: {
    message:
      "A prior browser action may have completed, but its result is no longer available. Observe with browser_tabs or browser_snapshot before deciding on a new intention and idempotency key.",
    retryable: false,
    phase: "runtime",
    effectMayHaveCommitted: true,
  },
} as const;

function hasSpecialPolicy(
  code: (typeof browserErrorCodes)[number],
): code is keyof typeof specialPolicies {
  return Object.hasOwn(specialPolicies, code);
}

function makeCanonicalError(code: (typeof browserErrorCodes)[number]) {
  if (hasSpecialPolicy(code)) {
    return { code, ...specialPolicies[code] };
  }
  return {
    code,
    message: BrowserAutomationErrorMessages[code],
    retryable: false,
    phase: "runtime",
    effectMayHaveCommitted: false,
  };
}

describe("browser automation errors", () => {
  it("accepts only the versioned provider-safe MCP error shape", () => {
    expect(
      Schema.is(BrowserMcpToolErrorEnvelope)({
        type: "synara_browser_error",
        version: 1,
        error: validError,
      }),
    ).toBe(true);
    expect(
      Schema.is(BrowserMcpToolErrorEnvelope)({
        type: "browser_error",
        version: 1,
        error: validError,
      }),
    ).toBe(false);
    expect(
      Schema.is(BrowserMcpToolErrorEnvelope)({
        type: "synara_browser_error",
        version: 2,
        error: validError,
      }),
    ).toBe(false);
  });

  it("exports the exact canonical browser error-code catalogue", () => {
    for (const code of browserErrorCodes) {
      expect(Schema.is(BrowserErrorCode)(code)).toBe(true);
    }
    expect(Schema.is(BrowserErrorCode)("BrowserInternalError")).toBe(false);
    expect(Schema.is(BrowserErrorCode)("BrowserTargetAmbigious")).toBe(false);
  });

  it("keeps the canonical error envelope bounded", () => {
    const value = Schema.decodeUnknownSync(BrowserAutomationError)(validError);
    expect(Schema.is(BrowserErrorCode)(value.code)).toBe(true);
    expect(value.message.length).toBeLessThanOrEqual(512);

    const largestError = browserErrorCodes
      .map(makeCanonicalError)
      .reduce((largest, candidate) =>
        utf8ByteLength(candidate.message) > utf8ByteLength(largest.message) ? candidate : largest,
      );
    const largestEnvelope = Schema.decodeUnknownSync(BrowserMcpToolErrorEnvelope)({
      type: "synara_browser_error",
      version: 1,
      error: {
        ...largestError,
        operationId: "018f4f7a-4b2a-7c10-8d6e-4c1ac7b92f31",
        tabId: "018f4f7a-4b2a-7c10-8d6e-4c1ac7b92f32",
      },
    });
    expect(utf8ByteLength(JSON.stringify(largestEnvelope))).toBeLessThanOrEqual(8 * 1024);
  });

  it("rejects empty, arbitrary in-bounds, and oversized messages", () => {
    expect(Schema.is(BrowserAutomationError)({ ...validError, message: "" })).toBe(false);
    expect(Schema.is(BrowserAutomationError)({ ...validError, message: "é".repeat(256) })).toBe(
      false,
    );
    expect(Schema.is(BrowserAutomationError)({ ...validError, message: "é".repeat(257) })).toBe(
      false,
    );
  });

  it("accepts validated contextual phases and optional UUID correlations", () => {
    const phases = [
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
    ] as const;

    for (const phase of phases) {
      expect(Schema.is(BrowserAutomationError)({ ...validError, phase })).toBe(true);
    }
    expect(Schema.is(BrowserAutomationError)({ ...validError, phase: "transport" })).toBe(false);
    expect(
      Schema.is(BrowserAutomationError)({
        ...validError,
        operationId: "018f4f7a-4b2a-7c10-8d6e-4c1ac7b92f31",
        tabId: "018f4f7a-4b2a-7c10-8d6e-4c1ac7b92f32",
      }),
    ).toBe(true);
    expect(Schema.is(BrowserAutomationError)({ ...validError, operationId: "not-a-uuid" })).toBe(
      false,
    );
  });

  it("strips arbitrary provider details from canonical decoded envelopes", () => {
    const decoded = Schema.decodeUnknownSync(BrowserMcpToolErrorEnvelope)({
      type: "synara_browser_error",
      version: 1,
      stack: "secret stack",
      error: {
        ...validError,
        details: "secret details",
        selector: "#private",
      },
    });

    expect(decoded).toEqual({
      type: "synara_browser_error",
      version: 1,
      error: validError,
    });
  });

  it("exports only readonly canonical data and rejects every forged message", () => {
    expect("makeBrowserAutomationError" in BrowserContracts).toBe(false);
    expect("makeBrowserMcpToolErrorEnvelope" in BrowserContracts).toBe(false);
    expect("normalizeBrowserAutomationDefect" in BrowserContracts).toBe(false);
    expect(Object.isFrozen(BrowserAutomationErrorMessages)).toBe(true);
    expect(Object.isFrozen(BrowserFixedAutomationErrorInvariants)).toBe(true);
    for (const invariant of Object.values(BrowserFixedAutomationErrorInvariants)) {
      expect(Object.isFrozen(invariant)).toBe(true);
    }

    for (const code of browserErrorCodes) {
      const error = makeCanonicalError(code);

      expect(error.code).toBe(code);
      expect(Schema.is(BrowserAutomationError)(error)).toBe(true);
      expect(utf8ByteLength(error.message)).toBeGreaterThan(0);
      expect(utf8ByteLength(error.message)).toBeLessThanOrEqual(512);
      expect(
        Schema.is(BrowserAutomationError)({
          ...error,
          message: "Provider text containing selector #secret and credential hunter2",
        }),
      ).toBe(false);
    }
  });

  it("preserves pre-effect and post-effect malformed-response context", () => {
    const preEffect = {
      code: "BrowserMalformedResponse",
      message: BrowserAutomationErrorMessages.BrowserMalformedResponse,
      retryable: true,
      phase: "routing",
      effectMayHaveCommitted: false,
    } as const;
    const postEffect = {
      code: "BrowserMalformedResponse",
      message: BrowserAutomationErrorMessages.BrowserMalformedResponse,
      retryable: false,
      phase: "runtime",
      effectMayHaveCommitted: true,
    } as const;

    expect(preEffect.message).toBe("Browser automation failed due to an internal error.");
    expect(postEffect.message).toBe(preEffect.message);
    expect(Schema.is(BrowserAutomationError)(preEffect)).toBe(true);
    expect(Schema.is(BrowserAutomationError)(postEffect)).toBe(true);
    expect(preEffect.effectMayHaveCommitted).toBe(false);
    expect(postEffect.effectMayHaveCommitted).toBe(true);
  });

  it("preserves pre-effect and post-effect timeout and cancellation context", () => {
    for (const code of ["BrowserTimeout", "BrowserCancelled"] as const) {
      const preEffect = {
        code,
        message: BrowserAutomationErrorMessages[code],
        retryable: true,
        phase: "queue",
        effectMayHaveCommitted: false,
      } as const;
      const postEffect = {
        code,
        message: BrowserAutomationErrorMessages[code],
        retryable: false,
        phase: "runtime",
        effectMayHaveCommitted: true,
      } as const;

      expect(preEffect.message).toBe(postEffect.message);
      expect(Schema.is(BrowserAutomationError)(preEffect)).toBe(true);
      expect(Schema.is(BrowserAutomationError)(postEffect)).toBe(true);
      expect(preEffect).toMatchObject({
        retryable: true,
        phase: "queue",
        effectMayHaveCommitted: false,
      });
      expect(postEffect).toMatchObject({
        retryable: false,
        phase: "runtime",
        effectMayHaveCommitted: true,
      });
    }
  });

  it("enforces every fixed security-sensitive policy exactly", () => {
    for (const code of Object.keys(specialPolicies) as Array<keyof typeof specialPolicies>) {
      const expected = { code, ...specialPolicies[code] };

      expect(BrowserFixedAutomationErrorInvariants[code]).toEqual({
        retryable: expected.retryable,
        phase: expected.phase,
        effectMayHaveCommitted: expected.effectMayHaveCommitted,
      });
      expect(Schema.decodeUnknownSync(BrowserAutomationError)(expected)).toEqual(expected);
      expect(
        Schema.is(BrowserAutomationError)({ ...expected, retryable: !expected.retryable }),
      ).toBe(false);
      expect(Schema.is(BrowserAutomationError)({ ...expected, phase: "cleanup" })).toBe(false);
      expect(
        Schema.is(BrowserAutomationError)({
          ...expected,
          effectMayHaveCommitted: !expected.effectMayHaveCommitted,
        }),
      ).toBe(false);
    }
  });
});
