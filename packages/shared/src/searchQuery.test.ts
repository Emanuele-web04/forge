import { describe, expect, it } from "vitest";

import { normalizeWorkspaceEntrySearchQuery } from "./searchQuery";

describe("normalizeWorkspaceEntrySearchQuery", () => {
  it("lowercases and trims", () => {
    expect(normalizeWorkspaceEntrySearchQuery("  Composer ")).toBe("composer");
  });

  it("strips leading relative-path and mention prefixes", () => {
    expect(normalizeWorkspaceEntrySearchQuery("./comp")).toBe("comp");
    expect(normalizeWorkspaceEntrySearchQuery("@Composer")).toBe("composer");
    expect(normalizeWorkspaceEntrySearchQuery("/apps/web")).toBe("apps/web");
    expect(normalizeWorkspaceEntrySearchQuery(".././x")).toBe("x");
  });

  it("only strips prefixes, not interior separators", () => {
    expect(normalizeWorkspaceEntrySearchQuery("apps/web.ts")).toBe("apps/web.ts");
  });

  it("can normalize to empty", () => {
    expect(normalizeWorkspaceEntrySearchQuery("./")).toBe("");
    expect(normalizeWorkspaceEntrySearchQuery("   ")).toBe("");
  });
});
