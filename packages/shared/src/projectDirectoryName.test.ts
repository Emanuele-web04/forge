import { describe, expect, it } from "vitest";

import { normalizeProjectDirectoryName } from "./projectDirectoryName";

describe("normalizeProjectDirectoryName", () => {
  it.each([
    ["codex", "codex"],
    ["my-project", "my-project"],
    [".github", ".github"],
    ["project.v2", "project.v2"],
    [" name ", "name"],
  ])("accepts %s", (name, expected) => {
    expect(normalizeProjectDirectoryName(name)).toBe(expected);
  });

  it.each(["", ".", "..", "a/b", "a\\b", "CON", "name."])("rejects %s", (name) => {
    expect(normalizeProjectDirectoryName(name)).toBeNull();
  });

  it("enforces the filesystem component limit in UTF-8 bytes", () => {
    expect(normalizeProjectDirectoryName("a".repeat(255))).toBe("a".repeat(255));
    expect(normalizeProjectDirectoryName("a".repeat(256))).toBeNull();
    expect(normalizeProjectDirectoryName("😀".repeat(63))).toBe("😀".repeat(63));
    expect(normalizeProjectDirectoryName("😀".repeat(64))).toBeNull();
  });
});
