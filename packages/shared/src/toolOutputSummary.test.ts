import { describe, expect, it } from "vitest";

import { countTextLines, summarizeToolRawOutput } from "./toolOutputSummary";

describe("toolOutputSummary", () => {
  it("summarizes Cursor search totals", () => {
    expect(summarizeToolRawOutput({ totalFiles: 33, truncated: false })).toBe("33 files found");
    expect(summarizeToolRawOutput({ totalFiles: 1, truncated: true })).toBe(
      "1 file found (truncated)",
    );
  });

  it("summarizes text content with a human line count", () => {
    expect(countTextLines("one\ntwo\n")).toBe(2);
    expect(summarizeToolRawOutput({ content: "one\ntwo\n" })).toBe("Read 2 lines");
  });

  it.each([
    ["", 0],
    ["one", 1],
    ["\n", 1],
    ["\r\n", 1],
    ["\n\n", 2],
    ["one\r\ntwo\nthree\r\n", 3],
    ["one\rtwo", 1],
    ["one\u2028two", 1],
    ["one\ntwo\n\n", 3],
  ])("counts logical lines in %j", (content, expected) => {
    expect(countTextLines(content)).toBe(expected);
  });

  it("uses the first stdout line as a fallback", () => {
    expect(summarizeToolRawOutput({ stdout: "done\nextra" })).toBe("done");
    expect(summarizeToolRawOutput({ rawInput: {} })).toBeUndefined();
  });

  it("extracts a concise MCP error from an object output", () => {
    expect(
      summarizeToolRawOutput({
        is_error: true,
        output: {
          Error: 'Invalid creation plan: Unexpected key "reasoningEffort"\n  at ["threads"][1]',
        },
      }),
    ).toBe('Invalid creation plan: Unexpected key "reasoningEffort"');
  });
});
