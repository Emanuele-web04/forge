import { normalizeWorkspaceEntrySearchQuery } from "@synara/shared/searchQuery";
import { describe, expect, it } from "vitest";

import { buildMatchSegments } from "./matchHighlight";

function render(text: string, query: string): string | null {
  const segments = buildMatchSegments(text, query);
  if (!segments) return null;
  return segments.map((segment) => (segment.matched ? `[${segment.text}]` : segment.text)).join("");
}

describe("buildMatchSegments", () => {
  it("emphasises a contiguous substring match", () => {
    expect(render("central-icons.tsx", "cent")).toBe("[cent]ral-icons.tsx");
  });

  it("matches case-insensitively while preserving the original casing", () => {
    expect(render("Composer.tsx", "compo")).toBe("[Compo]ser.tsx");
  });

  it("falls back to a subsequence walk and merges adjacent hits", () => {
    expect(render("Composer.tsx", "cmp")).toBe("[C]o[mp]oser.tsx");
  });

  it("reports offsets that can be used as stable keys", () => {
    expect(buildMatchSegments("abcd", "bc")).toEqual([
      { text: "a", matched: false, start: 0 },
      { text: "bc", matched: true, start: 1 },
      { text: "d", matched: false, start: 3 },
    ]);
  });

  it("returns null when the query does not occur at all", () => {
    expect(buildMatchSegments("central-icons.tsx", "zzz")).toBeNull();
  });

  it("returns null for empty inputs", () => {
    expect(buildMatchSegments("central-icons.tsx", "   ")).toBeNull();
    expect(buildMatchSegments("", "cent")).toBeNull();
  });

  it("skips emphasis when lowercasing would desync the indices", () => {
    expect(buildMatchSegments("İstanbul.ts", "st")).toBeNull();
  });

  it("emphasises queries the server matched after prefix normalization", () => {
    // The server strips leading @ ./ before matching file entries; highlighting
    // must receive the same normalized query or matched rows lose emphasis.
    expect(render("Composer.tsx", normalizeWorkspaceEntrySearchQuery("./comp"))).toBe(
      "[Comp]oser.tsx",
    );
    expect(render("Composer.tsx", "./comp")).toBeNull();
  });
});
