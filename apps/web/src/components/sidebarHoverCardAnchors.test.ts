import { describe, expect, it } from "vitest";

import { abbreviateHomePath } from "./sidebarHoverCardAnchors";

describe("abbreviateHomePath", () => {
  it("collapses the home directory to a tilde", () => {
    expect(abbreviateHomePath("/Users/me/project", "/Users/me")).toBe("~/project");
    expect(abbreviateHomePath("/Users/me", "/Users/me")).toBe("~");
  });

  it("collapses Windows home paths case-insensitively", () => {
    expect(abbreviateHomePath("C:\\Users\\Me\\project", "c:\\users\\me")).toBe("~\\project");
    expect(abbreviateHomePath("C:/Users/Me/project", "c:\\users\\me")).toBe("~/project");
    expect(abbreviateHomePath("C:\\Users\\Me", "c:\\users\\me\\")).toBe("~");
  });

  it("leaves unrelated paths unchanged", () => {
    expect(abbreviateHomePath("/Volumes/work/project", "/Users/me")).toBe("/Volumes/work/project");
    expect(abbreviateHomePath("/Users/me-other/project", "/Users/me")).toBe(
      "/Users/me-other/project",
    );
    expect(abbreviateHomePath("C:\\Users\\Me-other\\project", "C:\\Users\\Me")).toBe(
      "C:\\Users\\Me-other\\project",
    );
  });
});
