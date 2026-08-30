import { describe, expect, it } from "vitest";

import { resolveEditedFilePathTargets } from "./editedFilePathActions";

describe("resolveEditedFilePathTargets", () => {
  it("joins a workspace-relative path with POSIX and Windows roots", () => {
    expect(resolveEditedFilePathTargets("src/file.ts", "/repo/app")).toEqual({
      absolutePath: "/repo/app/src/file.ts",
      relativePath: "src/file.ts",
    });
    expect(resolveEditedFilePathTargets("src/file.ts", "C:\\repo\\app")).toEqual({
      absolutePath: "C:\\repo\\app\\src\\file.ts",
      relativePath: "src/file.ts",
    });
  });

  it("derives a relative path only for absolute files inside the workspace", () => {
    expect(resolveEditedFilePathTargets("/repo/app/src/file.ts", "/repo/app")).toEqual({
      absolutePath: "/repo/app/src/file.ts",
      relativePath: "src/file.ts",
    });
    expect(resolveEditedFilePathTargets("/tmp/file.ts", "/repo/app")).toEqual({
      absolutePath: "/tmp/file.ts",
      relativePath: null,
    });
  });

  it("keeps the relative action available when no workspace root exists", () => {
    expect(resolveEditedFilePathTargets("src/file.ts", undefined)).toEqual({
      absolutePath: null,
      relativePath: "src/file.ts",
    });
  });

  it("rejects empty and escaping paths", () => {
    expect(resolveEditedFilePathTargets("  ", "/repo/app")).toEqual({
      absolutePath: null,
      relativePath: null,
    });
    expect(resolveEditedFilePathTargets("../outside.ts", "/repo/app")).toEqual({
      absolutePath: null,
      relativePath: null,
    });
  });
});
