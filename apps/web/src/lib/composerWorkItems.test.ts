import { describe, expect, it } from "vitest";

import {
  buildAttachedWorkItemsBlock,
  canAddWorkItem,
  extractTrailingWorkItems,
  uniqueWorkItems,
  WORK_ITEM_ATTACHMENT_LIMIT,
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

  it("enforces attachment limit", () => {
    const items: WorkItemDraft[] = [];
    for (let i = 1; i <= WORK_ITEM_ATTACHMENT_LIMIT + 1; i++) {
      items.push(makeItem("issue", i));
    }
    expect(items.length).toBe(WORK_ITEM_ATTACHMENT_LIMIT + 1);
    expect(
      canAddWorkItem(items.slice(0, WORK_ITEM_ATTACHMENT_LIMIT), { kind: "issue", number: 99 }),
    ).toBe(false);
    expect(
      canAddWorkItem(items.slice(0, WORK_ITEM_ATTACHMENT_LIMIT - 1), { kind: "issue", number: 99 }),
    ).toBe(true);
  });

  it("deduplicates by kind:number", () => {
    const items = [makeItem("issue", 1), makeItem("issue", 1), makeItem("pull-request", 1)];
    const unique = uniqueWorkItems(items);
    expect(unique).toHaveLength(2);
  });
});
