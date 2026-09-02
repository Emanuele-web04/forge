import { describe, expect, it } from "vitest";

import {
  appendAcpTextGenerationOutput,
  type AcpTextGenerationOutput,
} from "./AcpTextGeneration.ts";

const EMPTY_OUTPUT: AcpTextGenerationOutput = {
  text: "",
  byteLength: 0,
  exceededLimit: false,
};

describe("appendAcpTextGenerationOutput", () => {
  it("counts UTF-8 bytes while preserving accepted chunks", () => {
    const output = appendAcpTextGenerationOutput(EMPTY_OUTPUT, "a😀", 5);

    expect(output).toEqual({
      text: "a😀",
      byteLength: 5,
      exceededLimit: false,
    });
  });

  it("stops retaining output after the byte limit is exceeded", () => {
    const accepted = appendAcpTextGenerationOutput(EMPTY_OUTPUT, "safe", 5);
    const exceeded = appendAcpTextGenerationOutput(accepted, "!!", 5);

    expect(exceeded).toEqual({
      text: "safe",
      byteLength: 4,
      exceededLimit: true,
    });
    expect(appendAcpTextGenerationOutput(exceeded, "ignored", 5)).toBe(exceeded);
  });
});
