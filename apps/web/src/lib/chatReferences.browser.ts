// FILE: chatReferences.browser.ts
// Purpose: Browser regressions for DOM-backed selection readers (line spans and
//          verbatim snippets scoped to a container).
// Layer: Web UI utility tests

import { afterEach, expect, it } from "vitest";

import { getSelectionSnippetWithin, getSelectionWithin } from "./chatReferences";

function selectNodeContents(node: Node): void {
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("window.getSelection() is unavailable");
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

it("getSelectionSnippetWithin quotes the selected rendered text verbatim", () => {
  document.body.innerHTML =
    "<article><h1>Title</h1><ul><li>first item</li><li>second item</li></ul></article>";
  const container = document.querySelector("article");
  if (!(container instanceof HTMLElement)) {
    throw new Error("missing container");
  }
  const list = container.querySelector("ul");
  if (!list) {
    throw new Error("missing list");
  }

  selectNodeContents(list);

  expect(getSelectionSnippetWithin(container)).toEqual({ snippet: "first item\nsecond item" });
});

it("getSelectionSnippetWithin ignores selections outside the container or collapsed", () => {
  document.body.innerHTML = "<article><p>inside</p></article><p id='outside'>outside</p>";
  const container = document.querySelector("article");
  const outside = document.querySelector("#outside");
  if (!(container instanceof HTMLElement) || !outside) {
    throw new Error("missing fixtures");
  }

  selectNodeContents(outside);
  expect(getSelectionSnippetWithin(container)).toBeNull();

  window.getSelection()?.removeAllRanges();
  expect(getSelectionSnippetWithin(container)).toBeNull();
});

it("getSelectionSnippetWithin treats whitespace-only selections as no selection", () => {
  document.body.innerHTML = "<article><p>   </p></article>";
  const container = document.querySelector("article");
  const paragraph = container?.querySelector("p");
  if (!(container instanceof HTMLElement) || !paragraph) {
    throw new Error("missing fixtures");
  }

  selectNodeContents(paragraph);

  expect(getSelectionSnippetWithin(container)).toBeNull();
});

it("getSelectionWithin resolves the line and column span of a source selection", () => {
  document.body.innerHTML = "<pre>alpha\nbeta gamma\ndelta\n</pre>";
  const container = document.querySelector("pre");
  const text = container?.firstChild;
  if (!(container instanceof HTMLElement) || !(text instanceof Text)) {
    throw new Error("missing fixtures");
  }
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("window.getSelection() is unavailable");
  }
  const range = document.createRange();
  // "gamma" on line 2 (columns 6-10).
  range.setStart(text, "alpha\nbeta ".length);
  range.setEnd(text, "alpha\nbeta gamma".length);
  selection.removeAllRanges();
  selection.addRange(range);

  expect(getSelectionWithin(container)).toEqual({
    startLine: 2,
    endLine: 2,
    startColumn: 6,
    endColumn: 10,
  });
});
