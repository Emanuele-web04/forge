import { describe, expect, it } from "vitest";
import { repairMarkdownTableDelimiters } from "./markdownTableRepair";

describe("repairMarkdownTableDelimiters", () => {
  it("pads a delimiter row that has fewer cells than the header", () => {
    const source = [
      "Studio vs. normal mode:",
      "",
      "| | Normal mode (regular tasks/chats) | Studio |",
      "|---|---|",
      "| Purpose | Focused, interactive work | Long-running, agent-led work |",
    ].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      [
        "Studio vs. normal mode:",
        "",
        "| | Normal mode (regular tasks/chats) | Studio |",
        "| --- | --- | --- |",
        "| Purpose | Focused, interactive work | Long-running, agent-led work |",
      ].join("\n"),
    );
  });

  it("drops delimiter cells beyond the header cell count", () => {
    const source = ["| a | b |", "|:--|---|--:|", "| 1 | 2 |"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["| a | b |", "| :-- | --- |", "| 1 | 2 |"].join("\n"),
    );
  });

  it("keeps the kept cells' alignment markers when padding", () => {
    const source = ["| a | b | c |", "|:--|--:|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["| a | b | c |", "| :-- | --: | --- |"].join("\n"),
    );
  });

  it("returns the input string unchanged when every table is well-formed", () => {
    const source = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  it("ignores pipe-and-dash lines inside fenced code blocks", () => {
    const source = ["```", "| a | b |", "|---|", "```"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  it("repairs a table that follows a closed fence", () => {
    const source = ["```ts", "const x = 1;", "```", "", "| a | b |", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["```ts", "const x = 1;", "```", "", "| a | b |", "| --- | --- |"].join("\n"),
    );
  });

  it("ignores indented code blocks", () => {
    const source = ["Example:", "", "    | a | b |", "    |---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  it("ignores blockquoted headers", () => {
    const source = ["> | a | b |", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  it("does not treat a dashed body row of an ongoing table as a delimiter", () => {
    const source = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| --- |"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  it("does not pair two delimiter-shaped rows as header and delimiter", () => {
    const source = ["|---|---|", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  it("does not count escaped pipes as cell boundaries", () => {
    const source = ["| a \\| b | c |", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["| a \\| b | c |", "| --- | --- |"].join("\n"),
    );
  });

  it("leaves text without any table candidates untouched", () => {
    const source = "plain prose - with a dash | and a pipe";

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });
});
