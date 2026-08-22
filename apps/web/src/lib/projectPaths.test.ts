import { describe, expect, it } from "vitest";

import { expandProjectHomePath, isFilesystemBrowseQuery, joinProjectPath } from "./projectPaths";

describe("joinProjectPath", () => {
  it.each([
    ["/Users/test/Developer/", "codex", "/Users/test/Developer/codex"],
    ["/", "codex", "/codex"],
    ["C:\\Users\\test\\", "codex", "C:\\Users\\test\\codex"],
    ["C:\\", "codex", "C:\\codex"],
  ])("joins %s and %s", (parent, child, expected) => {
    expect(joinProjectPath(parent, child)).toBe(expected);
  });
});

describe("expandProjectHomePath", () => {
  it.each([
    ["~", "/Users/test", "/Users/test"],
    ["~/Developer", "/Users/test", "/Users/test/Developer"],
    ["~\\Developer", "C:\\Users\\test", "C:\\Users\\test\\Developer"],
    ["/srv/repos", "/Users/test", "/srv/repos"],
    ["~/Developer", null, "~/Developer"],
  ])("expands %s against %s", (value, homeDir, expected) => {
    expect(expandProjectHomePath(value, homeDir)).toBe(expected);
  });
});

describe("isFilesystemBrowseQuery", () => {
  it("recognizes a Windows-style home path on Windows", () => {
    expect(isFilesystemBrowseQuery("~\\Developer", "Win32")).toBe(true);
  });

  it("does not treat a Windows-style home path as a browse query on macOS", () => {
    expect(isFilesystemBrowseQuery("~\\Developer", "MacIntel")).toBe(false);
  });
});
