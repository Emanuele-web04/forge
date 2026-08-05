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
});
