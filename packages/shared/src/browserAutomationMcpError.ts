import { BrowserAutomationError, utf8ByteLength } from "@synara/contracts";
import { Schema } from "effect";

import { stableJsonStringify } from "./browserAutomationCatalogue";

const MAX_ERROR_TEXT_BYTES = 8 * 1024;

export interface BrowserMcpToolErrorResult {
  readonly isError: true;
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
}

export function encodeBrowserMcpToolError(error: unknown): BrowserMcpToolErrorResult {
  const decoded = Schema.decodeUnknownSync(BrowserAutomationError)(error);
  const text = stableJsonStringify({ type: "synara_browser_error", version: 1, error: decoded });
  if (utf8ByteLength(text) > MAX_ERROR_TEXT_BYTES) {
    throw new RangeError("Browser MCP error envelope exceeds 8 KiB");
  }
  return { isError: true, content: [{ type: "text", text }] };
}
