// FILE: WorkspaceFilePreview.path.test.ts
// Purpose: Guards which file extensions open as rendered markdown/HTML previews.
// Layer: Focused unit tests

import { describe, expect, it } from "vitest";

import { isHtmlPreviewablePath, isMarkdownPreviewablePath } from "./WorkspaceFilePreview";

describe("isHtmlPreviewablePath", () => {
  it("matches html and htm files regardless of case", () => {
    expect(isHtmlPreviewablePath("decks/finance_deck.html")).toBe(true);
    expect(isHtmlPreviewablePath("index.HTM")).toBe(true);
    expect(isHtmlPreviewablePath("page.html.bak")).toBe(false);
    expect(isHtmlPreviewablePath("README.md")).toBe(false);
  });
});

describe("isMarkdownPreviewablePath", () => {
  it("matches markdown extensions and not HTML", () => {
    expect(isMarkdownPreviewablePath("docs/README.md")).toBe(true);
    expect(isMarkdownPreviewablePath("notes.mdx")).toBe(true);
    expect(isMarkdownPreviewablePath("deck.html")).toBe(false);
  });
});
