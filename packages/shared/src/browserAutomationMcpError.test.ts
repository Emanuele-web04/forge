import { describe, expect, it } from "vitest";

import { stableJsonStringify } from "./browserAutomationCatalogue";
import { makeBrowserAutomationError } from "./browserAutomationErrors";
import { encodeBrowserMcpToolError } from "./browserAutomationMcpError";

const STALE_REFERENCE_ERROR = makeBrowserAutomationError({
  code: "BrowserStaleReference",
  retryable: true,
  phase: "target",
  effectMayHaveCommitted: false,
});

describe("browser MCP tool error encoder", () => {
  it("encodes the canonical MCP tool-error result", () => {
    const encoded = encodeBrowserMcpToolError(STALE_REFERENCE_ERROR);
    expect(encoded).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: stableJsonStringify({
            type: "synara_browser_error",
            version: 1,
            error: STALE_REFERENCE_ERROR,
          }),
        },
      ],
    });
  });

  it("rejects malformed errors and noncanonical messages before encoding", () => {
    expect(() => encodeBrowserMcpToolError({})).toThrow();
    expect(() =>
      encodeBrowserMcpToolError({ ...STALE_REFERENCE_ERROR, message: "secret-token" }),
    ).toThrow();
  });
});
