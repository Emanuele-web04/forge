import { describe, expect, it } from "vitest";

import { resolveRepoDiffScopeSelection, sanitizeRepoDiffCompareRefs } from "./repoDiffScopeStore";

describe("resolveRepoDiffScopeSelection", () => {
  it("keeps the ref scope for a repository that has a compare ref", () => {
    expect(resolveRepoDiffScopeSelection("ref", "release/1.2")).toEqual({
      scope: "ref",
      compareRef: "release/1.2",
    });
  });

  it("falls back to the default scope for a repository without a compare ref", () => {
    expect(resolveRepoDiffScopeSelection("ref", null)).toEqual({
      scope: "workingTree",
      compareRef: null,
    });
  });

  it("passes other scopes through untouched", () => {
    expect(resolveRepoDiffScopeSelection("branch", null)).toEqual({
      scope: "branch",
      compareRef: null,
    });
    expect(resolveRepoDiffScopeSelection("staged", "ignored")).toEqual({
      scope: "staged",
      compareRef: "ignored",
    });
  });
});

describe("sanitizeRepoDiffCompareRefs", () => {
  it("keeps only non-empty string refs keyed by repository", () => {
    expect(
      sanitizeRepoDiffCompareRefs({
        "/repo-a": "feature/x",
        "/repo-b": "   ",
        "/repo-c": 42,
        "/repo-d": null,
      }),
    ).toEqual({ "/repo-a": "feature/x" });
  });

  it("drops legacy and malformed persisted values", () => {
    expect(sanitizeRepoDiffCompareRefs(undefined)).toEqual({});
    expect(sanitizeRepoDiffCompareRefs("feature/x")).toEqual({});
    expect(sanitizeRepoDiffCompareRefs(null)).toEqual({});
  });
});
