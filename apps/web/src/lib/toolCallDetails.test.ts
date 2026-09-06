import { describe, expect, it } from "vitest";

import { deriveWorkLogToolDetails } from "./toolCallDetails";

describe("tool output exit-code suffixes", () => {
  it("preserves a large whitespace run inside raw output", () => {
    const stdout = `start${" ".repeat(23_980)}end`;
    const details = deriveWorkLogToolDetails({
      label: "Command",
      command: "run",
      payload: { data: { rawOutput: { stdout } } },
    });
    expect(details?.output).toEqual({ stdout });
  });

  it.each([
    ["  output\n", "  output\n", undefined],
    ["  output\n <exited with exit code 2>\n", "  output", 2],
    ["\toutput\r\n<EXITED WITH EXIT CODE 000>\t", "\toutput", 0],
    ["<exited with exit code 1>", undefined, 1],
    ["<exited with exit code -1>", "<exited with exit code -1>", undefined],
    ["<exited with exit code 1> later", "<exited with exit code 1> later", undefined],
    ["<exited with exit code 1>\n<exited with exit code 2>", "<exited with exit code 1>", 2],
    ["\n\t", undefined, undefined],
  ])("preserves raw stdout and parses only the final suffix: %j", (stdout, output, exitCode) => {
    const details = deriveWorkLogToolDetails({
      label: "Command",
      command: "run",
      detail: stdout,
      payload: { data: { rawOutput: { stdout } } },
    });
    expect(details?.output?.stdout).toBe(output);
    expect(details?.output?.exitCode).toBe(exitCode);
  });
});
