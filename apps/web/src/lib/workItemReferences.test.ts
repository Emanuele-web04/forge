import { describe, expect, it } from "vitest";

import {
  appendWorkItemReferencesToPrompt,
  createWorkItemReferenceDraft,
  formatWorkItemChipLabel,
  parseWorkItemUrl,
} from "./workItemReferences";

describe("parseWorkItemUrl", () => {
  it("parses GitHub issue URLs", () => {
    expect(parseWorkItemUrl("https://github.com/acme/app/issues/12")).toEqual({
      source: "github-issue",
      reference: "12",
      repository: "acme/app",
      url: "https://github.com/acme/app/issues/12",
    });
  });

  it("parses GitHub pull request URLs", () => {
    expect(parseWorkItemUrl("github.com/acme/app/pull/42")).toEqual({
      source: "github-pr",
      reference: "42",
      repository: "acme/app",
      url: "https://github.com/acme/app/pull/42",
    });
  });

  it("parses Linear issue URLs", () => {
    expect(parseWorkItemUrl("https://linear.app/acme/issue/ENG-12/title-slug")).toEqual({
      source: "linear-issue",
      reference: "ENG-12",
      repository: null,
      url: "https://linear.app/acme/issue/ENG-12",
    });
  });
});

describe("appendWorkItemReferencesToPrompt", () => {
  it("appends a trailing work_item_references block", () => {
    const draft = createWorkItemReferenceDraft({
      source: "linear-issue",
      id: "uuid-1",
      url: "https://linear.app/acme/issue/ENG-12",
      title: "Fix login",
      identifier: "ENG-12",
      body: "Users cannot sign in.",
      bodyPreview: "Users cannot sign in.",
      repository: null,
    });
    const prompt = appendWorkItemReferencesToPrompt("Please implement this.", [draft]);
    expect(prompt.startsWith("Please implement this.")).toBe(true);
    expect(prompt).toContain("<work_item_references>");
    expect(prompt).toContain("[linear-issue] ENG-12 — Fix login");
    expect(prompt).toContain("Users cannot sign in.");
    expect(prompt).toContain("</work_item_references>");
  });

  it("formats chip labels", () => {
    expect(
      formatWorkItemChipLabel({
        identifier: "#12",
        title: "Broken button",
      }),
    ).toBe("#12: Broken button");
  });
});
