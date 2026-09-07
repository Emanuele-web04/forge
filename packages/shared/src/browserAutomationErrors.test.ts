import {
  BrowserAutomationError,
  BrowserAutomationErrorMessages,
  BrowserFixedAutomationErrorInvariants,
  BrowserMcpToolErrorEnvelope,
  utf8ByteLength,
  type BrowserAutomationErrorInput,
  type BrowserErrorCode,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  browserInputErrorCode,
  makeBrowserAutomationError,
  makeBrowserMcpToolErrorEnvelope,
} from "./browserAutomationErrors";

const browserErrorCodes = Object.keys(BrowserAutomationErrorMessages) as BrowserErrorCode[];
type BrowserFixedAutomationErrorCode = keyof typeof BrowserFixedAutomationErrorInvariants;

function hasFixedInvariant(code: BrowserErrorCode): code is BrowserFixedAutomationErrorCode {
  return Object.hasOwn(BrowserFixedAutomationErrorInvariants, code);
}

function makeCanonicalInput(code: BrowserErrorCode): BrowserAutomationErrorInput {
  if (hasFixedInvariant(code)) {
    return { code };
  }
  return {
    code,
    retryable: false,
    phase: "runtime",
    effectMayHaveCommitted: false,
  };
}

describe("browser automation error factories", () => {
  it.each([45_000, 60_000, 99, 30_001, 100.5, "30000", null, NaN, Infinity])("explains invalid timeout %s without reflecting input", (timeoutMs) => {
    const code = browserInputErrorCode({ timeoutMs, code: "private-secret" });
    expect(code).toBe("BrowserInvalidTimeout");
    const error = makeBrowserAutomationError({ code });
    expect(error).toMatchObject({ phase: "input", retryable: false, effectMayHaveCommitted: false });
    expect(error.message).toContain("100 to 30000");
    expect(error.message).not.toContain("private-secret");
  });

  it.each([{}, { timeoutMs: undefined }, { timeoutMs: 100 }, { timeoutMs: 30000 }, null])("distinguishes other schema failures from timeout bounds", (input) => {
    expect(browserInputErrorCode(input)).toBe("BrowserInvalidArguments");
  });

  it("constructs every canonical error as a strictly decoded contract value", () => {
    for (const code of browserErrorCodes) {
      const error = makeBrowserAutomationError(makeCanonicalInput(code));

      expect(error.code).toBe(code);
      expect(error.message).toBe(BrowserAutomationErrorMessages[code]);
      expect(Schema.is(BrowserAutomationError)(error)).toBe(true);
      expect(utf8ByteLength(error.message)).toBeGreaterThan(0);
      expect(utf8ByteLength(error.message)).toBeLessThanOrEqual(512);
    }
  });

  it("keeps the largest constructed envelope below the provider boundary", () => {
    const largestError = browserErrorCodes
      .map((code) => makeBrowserAutomationError(makeCanonicalInput(code)))
      .reduce((largest, candidate) =>
        utf8ByteLength(candidate.message) > utf8ByteLength(largest.message) ? candidate : largest,
      );
    const envelope = Schema.decodeUnknownSync(BrowserMcpToolErrorEnvelope)({
      type: "synara_browser_error",
      version: 1,
      error: {
        ...largestError,
        operationId: "018f4f7a-4b2a-7c10-8d6e-4c1ac7b92f31",
        tabId: "018f4f7a-4b2a-7c10-8d6e-4c1ac7b92f32",
      },
    });

    expect(utf8ByteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(8 * 1024);
  });

  it("preserves contextual pre-effect and post-effect state", () => {
    for (const code of [
      "BrowserMalformedResponse",
      "BrowserTimeout",
      "BrowserCancelled",
    ] as const) {
      const preEffect = makeBrowserAutomationError({
        code,
        retryable: true,
        phase: "queue",
        effectMayHaveCommitted: false,
      });
      const postEffect = makeBrowserAutomationError({
        code,
        retryable: false,
        phase: "runtime",
        effectMayHaveCommitted: true,
      });

      expect(preEffect.message).toBe(postEffect.message);
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

  it("enforces fixed invariants instead of accepting forged caller policy", () => {
    for (const code of Object.keys(
      BrowserFixedAutomationErrorInvariants,
    ) as BrowserFixedAutomationErrorCode[]) {
      const secret = "selector=#bank-account credential=hunter2";
      const unsafeInput = {
        code,
        message: secret,
        retryable: !BrowserFixedAutomationErrorInvariants[code].retryable,
        phase: "cleanup",
        effectMayHaveCommitted: !BrowserFixedAutomationErrorInvariants[code].effectMayHaveCommitted,
      } as unknown as BrowserAutomationErrorInput;
      const error = makeBrowserAutomationError(unsafeInput);

      expect(error).toEqual({
        code,
        message: BrowserAutomationErrorMessages[code],
        ...BrowserFixedAutomationErrorInvariants[code],
      });
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("strictly decodes caller correlations and omits arbitrary provider details", () => {
    expect(() =>
      makeBrowserAutomationError({
        code: "BrowserStaleReference",
        retryable: true,
        phase: "target",
        effectMayHaveCommitted: false,
        operationId: "not-an-operation-id",
      } as unknown as BrowserAutomationErrorInput),
    ).toThrow();

    const secret = "selector=#private credential=hunter2";
    const error = makeBrowserAutomationError({
      code: "BrowserStaleReference",
      retryable: true,
      phase: "target",
      effectMayHaveCommitted: false,
      details: secret,
    } as unknown as BrowserAutomationErrorInput);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("constructs canonical envelopes without copying arbitrary caller text", () => {
    const secret = "selector=#bank-account credential=hunter2";
    const unsafeInput = {
      code: "BrowserInputUnsupported",
      message: secret,
      retryable: true,
      phase: "cleanup",
      effectMayHaveCommitted: true,
    } as unknown as BrowserAutomationErrorInput;
    const envelope = makeBrowserMcpToolErrorEnvelope(unsafeInput);

    expect(envelope).toEqual({
      type: "synara_browser_error",
      version: 1,
      error: {
        code: "BrowserInputUnsupported",
        message: BrowserAutomationErrorMessages.BrowserInputUnsupported,
        ...BrowserFixedAutomationErrorInvariants.BrowserInputUnsupported,
      },
    });
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(Schema.is(BrowserMcpToolErrorEnvelope)(envelope)).toBe(true);
  });
});
