import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  WorkItemAttachment,
  WorkItemAvailabilityResult,
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

  it("accepts a body excerpt of exactly 500 characters", () => {
    const exact = { ...validAttachment, bodyExcerpt: "x".repeat(500) };
    expect(() => Schema.decodeUnknownSync(WorkItemAttachment)(exact)).not.toThrow();
  });

  it("rejects non-positive numbers", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkItemAttachment)({ ...validAttachment, number: 0 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(WorkItemAttachment)({ ...validAttachment, number: -3 }),
    ).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkItemAttachment)({ ...validAttachment, title: "   " }),
    ).toThrow();
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

  it("rejects an oversized search query", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkItemSearchInput)({ cwd: "/repo", query: "x".repeat(257) }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(WorkItemSearchInput)({ cwd: "/repo", query: "x".repeat(256) }),
    ).not.toThrow();
  });

  it("rejects an out-of-range search limit", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkItemSearchInput)({ cwd: "/repo", limit: 21 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(WorkItemSearchInput)({ cwd: "/repo", limit: 0 }),
    ).toThrow();
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

  it("decodes availability results and rejects unknown statuses", () => {
    for (const status of [
      "ready",
      "no-repository",
      "gh-not-installed",
      "gh-not-authenticated",
    ] as const) {
      expect(() =>
        Schema.decodeUnknownSync(WorkItemAvailabilityResult)({ status, hint: null }),
      ).not.toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(WorkItemAvailabilityResult)({ status: "offline", hint: null }),
    ).toThrow();
  });
});
