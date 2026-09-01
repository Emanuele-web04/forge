import { describe, expect, it } from "vitest";

import { appendBrowserAnnotationsToPrompt, extractTrailingBrowserAnnotations, type BrowserAnnotationDraft } from "./browserAnnotations";
import { appendPastedTextsToPrompt, extractTrailingPastedTexts } from "./composerPastedText";
import {
  appendWorkItemsToPrompt,
  buildAttachedWorkItemsBlock,
  extractTrailingWorkItems,
  type WorkItemDraft,
} from "./composerWorkItems";

const makeItem = (kind: WorkItemDraft["kind"], number: number): WorkItemDraft => ({
  id: `${kind}-${number}`,
  kind,
  number,
  title: `Title ${number}`,
  state: "open",
  url: `https://github.com/owner/repo/${kind === "issue" ? "issues" : "pull"}/${number}`,
  bodyExcerpt: "Body",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
});

describe("composerWorkItems", () => {
  it("serializes exactly one work items block after pasted text and before browser annotations", () => {
    // Composed in the same nesting order as the live and queued send paths.
    const annotation: BrowserAnnotationDraft = {
      id: "annotation-1",
      ordinal: 1,
      tabId: "tab-1",
      source: { url: "https://example.test/page", pageTitle: "Page" },
      selector: "#save",
      tagName: "button",
      role: "button",
      name: "Save",
      text: "Save",
      fingerprint: "button|save",
      comment: "Check this",
      capturedAt: "2024-01-03T00:00:00.000Z",
    };
    const composed = appendBrowserAnnotationsToPrompt(
      appendWorkItemsToPrompt(appendPastedTextsToPrompt("Fix this", [{ text: "pasted body" }]), [
        makeItem("issue", 3),
      ]),
      [annotation],
      "msg-1" as never,
    );

    expect(composed.match(/<attached_work_items>/g)).toHaveLength(1);
    const pastedIndex = composed.indexOf("<pasted_text>");
    const workItemsIndex = composed.indexOf("<attached_work_items>");
    const annotationsIndex = composed.indexOf("<browser_annotations>");
    expect(pastedIndex).toBeGreaterThan(-1);
    expect(workItemsIndex).toBeGreaterThan(pastedIndex);
    expect(annotationsIndex).toBeGreaterThan(workItemsIndex);

    // Display-time extraction unwinds the same order back out.
    const extractedAnnotations = extractTrailingBrowserAnnotations(composed, "msg-1" as never);
    const extractedWorkItems = extractTrailingWorkItems(extractedAnnotations.promptText);
    const extractedPasted = extractTrailingPastedTexts(extractedWorkItems.promptText);
    expect(extractedPasted.promptText).toBe("Fix this");
    expect(extractedWorkItems.workItems).toHaveLength(1);
    expect(extractedWorkItems.workItems[0]).toMatchObject({ kind: "issue", number: 3 });
    expect(extractedPasted.pastedTexts).toHaveLength(1);
  });

  it("serializes and extracts work items round-trip", () => {
    const items = [makeItem("issue", 1), makeItem("pull-request", 2)];
    const prompt = buildAttachedWorkItemsBlock(items);
    expect(prompt).toContain("<attached_work_items>");
    expect(prompt).not.toContain('"id"');
    const { promptText, workItems } = extractTrailingWorkItems(`Hello${prompt}`);
    expect(promptText).toBe("Hello");
    expect(workItems).toHaveLength(2);
    expect(workItems[0]).toMatchObject({ kind: "issue", number: 1 });
    expect(workItems[1]).toMatchObject({ kind: "pull-request", number: 2 });
  });

  it("returns empty block for no work items", () => {
    expect(buildAttachedWorkItemsBlock([])).toBe("");
    const { promptText, workItems } = extractTrailingWorkItems("Hello");
    expect(promptText).toBe("Hello");
    expect(workItems).toEqual([]);
  });

  it("strips the draft id from the serialized block", () => {
    const block = buildAttachedWorkItemsBlock([makeItem("issue", 1)]);
    expect(block).not.toContain('"id"');
    expect(block).toContain('"number"');
  });

  it("ignores malformed and invalid entries", () => {
    const badBlock = `\n<attached_work_items>\n[{"kind":"issue","title":"No number","state":"open","url":"http://x","bodyExcerpt":"","createdAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-02T00:00:00Z"},123,{"kind":"unknown","number":3,"title":"Bad kind","state":"open","url":"http://x","bodyExcerpt":"","createdAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-02T00:00:00Z"}]\n</attached_work_items>`;
    const { workItems } = extractTrailingWorkItems(`Hello${badBlock}`);
    expect(workItems).toEqual([]);
  });

  it("rejects out-of-range bodyExcerpt", () => {
    const item = makeItem("issue", 1);
    const bigItem = { ...item, bodyExcerpt: "x".repeat(501) };
    const block = buildAttachedWorkItemsBlock([bigItem]);
    const { workItems } = extractTrailingWorkItems(`Hello${block}`);
    expect(workItems).toEqual([]);
  });

  it("preserves the prompt text when the block is malformed JSON", () => {
    const { promptText, workItems } = extractTrailingWorkItems(
      "Hello\n<attached_work_items>\n{not json\n</attached_work_items>",
    );
    expect(promptText).toBe("Hello");
    expect(workItems).toEqual([]);
  });

  it("preserves the prompt text when the block is not an array", () => {
    const { promptText, workItems } = extractTrailingWorkItems(
      'Hello\n<attached_work_items>\n{"kind":"issue"}\n</attached_work_items>',
    );
    expect(promptText).toBe("Hello");
    expect(workItems).toEqual([]);
  });

  it("drops entries missing required timestamps", () => {
    const block =
      '\n<attached_work_items>\n[{"kind":"issue","number":7,"title":"No timestamps","state":"open","url":"https://github.com/owner/repo/issues/7","bodyExcerpt":""}]\n</attached_work_items>';
    const { promptText, workItems } = extractTrailingWorkItems(`Hello${block}`);
    expect(promptText).toBe("Hello");
    expect(workItems).toEqual([]);
  });
});
