import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  WorkItemAttachment,
  WorkItemKind,
  WorkItemSearchInput,
  WorkItemSearchResult,
} from "./workItems";

describe("WorkItem schemas", () => {
  const validAttachment = {
    kind: "issue" as const,
    number: 123,
    title: "Fix login bug",
    state: "open" as const,
    url: "https://github.com/owner/repo/issues/123",
    bodyExcerpt: "Users cannot log in with 2FA.",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
  };

  it("decodes a valid work item attachment", () => {
    const result = Schema.decodeUnknownSync(WorkItemAttachment)(validAttachment);
    expect(result).toEqual(validAttachment);
  });

  it("rejects a body excerpt over 500 characters", () => {
    const oversized = { ...validAttachment, bodyExcerpt: "x".repeat(501) };
    expect(() => Schema.decodeUnknownSync(WorkItemAttachment)(oversized)).toThrow();
  });

  it("decodes a pull request attachment", () => {
    const pr = { ...validAttachment, kind: "pull-request" as const, state: "merged" as const };
    const result = Schema.decodeUnknownSync(WorkItemAttachment)(pr);
    expect(result).toEqual(pr);
  });

  it("decodes a search input with defaults", () => {
    const result = Schema.decodeUnknownSync(WorkItemSearchInput)({ cwd: "/repo" });
    expect(result).toEqual({ cwd: "/repo", query: "", limit: 20 });
  });

  it("decodes a search result", () => {
    const result = Schema.decodeUnknownSync(WorkItemSearchResult)({
      available: true,
      errorHint: null,
      items: [validAttachment],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.number).toBe(123);
  });

  it("decodes all allowed work item kinds", () => {
    expect(() => Schema.decodeUnknownSync(WorkItemKind)("issue")).not.toThrow();
    expect(() => Schema.decodeUnknownSync(WorkItemKind)("pull-request")).not.toThrow();
    expect(() => Schema.decodeUnknownSync(WorkItemKind)("discussion")).toThrow();
  });
});
