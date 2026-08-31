import { describe, expect, it } from "vitest";

import {
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
});
