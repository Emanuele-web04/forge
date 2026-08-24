import { describe, expect, it } from "vitest";

import {
  findExplicitDirectoryBase,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

describe("rewriteMarkdownFileUriHref", () => {
  it("rewrites file uri hrefs into direct path hrefs", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L42")).toBe(
      "/Users/julius/project/src/main.ts#L42",
    );
  });

  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});

describe("findExplicitDirectoryBase", () => {
  function referenceOffset(text: string, reference: string): number {
    return text.indexOf(`\`${reference}\``);
  }

  it("finds the declared directory for one listed child", () => {
    const text = [
      "Dir: `/Users/alina/external-tool`",
      "- `docs/example.md`",
    ].join("\n");

    expect(findExplicitDirectoryBase(text, referenceOffset(text, "docs/example.md"))).toBe(
      "/Users/alina/external-tool",
    );
  });

  it("uses one declared directory for every contiguous sibling", () => {
    const text = [
      "Dir: `/Users/mira/.codex/skills/example`",
      "- `SKILL.md`",
      "- `references/first.md`",
      "- `references/second.md`",
    ].join("\n");

    for (const reference of ["SKILL.md", "references/first.md", "references/second.md"]) {
      expect(findExplicitDirectoryBase(text, referenceOffset(text, reference))).toBe(
        "/Users/mira/.codex/skills/example",
      );
    }
  });

  it("keeps adjacent directory groups scoped to their own children", () => {
    const text = [
      "Dir: `/Users/nia/first`",
      "- `references/one.md`",
      "Dir: `/Users/nia/second`",
      "- `references/two.md`",
    ].join("\n");

    expect(findExplicitDirectoryBase(text, referenceOffset(text, "references/one.md"))).toBe(
      "/Users/nia/first",
    );
    expect(findExplicitDirectoryBase(text, referenceOffset(text, "references/two.md"))).toBe(
      "/Users/nia/second",
    );
  });

  it("ignores an unrelated absolute path in later prose", () => {
    const text = [
      "Dir: `/Users/olivia/declared`",
      "- `references/item.md`",
      "Also see `/Users/olivia/unrelated/references/item.md`.",
    ].join("\n");

    expect(findExplicitDirectoryBase(text, referenceOffset(text, "references/item.md"))).toBe(
      "/Users/olivia/declared",
    );
  });

  it("rejects a group interrupted by prose", () => {
    const text = [
      "Dir: `/Users/petra/declared`",
      "These files are relevant:",
      "- `references/item.md`",
    ].join("\n");

    expect(findExplicitDirectoryBase(text, referenceOffset(text, "references/item.md"))).toBeNull();
  });

  it("rejects a missing source offset", () => {
    const text = "Dir: `/Users/quinn/declared`\n- `references/item.md`";

    expect(findExplicitDirectoryBase(text, Number.NaN)).toBeNull();
  });

  it.each(["../secret.md", "/etc/hosts", "https://example.com/item.md"])(
    "rejects unsafe or non-relative child %s",
    (reference) => {
      const text = `Dir: \`/Users/rina/declared\`\n- \`${reference}\``;

      expect(findExplicitDirectoryBase(text, referenceOffset(text, reference))).toBeNull();
    },
  );

  it("accepts line and column suffixes without changing the declared base", () => {
    const text = "Dir: `/Users/sana/declared`\n- `references/item.md:42:7`";
    const reference = "references/item.md:42:7";
    const base = findExplicitDirectoryBase(text, referenceOffset(text, reference));

    expect(base).toBe("/Users/sana/declared");
    expect(resolveMarkdownFileLinkTarget(reference, base ?? undefined)).toBe(
      "/Users/sana/declared/references/item.md:42:7",
    );
  });

  it.each([
    "Directory: `/Users/tara/declared`\n- `references/item.md`",
    "Dir: /Users/tara/declared\n- `references/item.md`",
    "Dir: `/Users/tara/declared`\n\n- `references/item.md`",
    "Dir: `/Users/tara/declared`\n- `references/item.md` trailing",
  ])("rejects malformed directory groups", (text) => {
    expect(findExplicitDirectoryBase(text, text.lastIndexOf("`references/item.md`"))).toBeNull();
  });

  it("does not affect the same relative file outside a group", () => {
    const text = "Open `references/item.md` from the workspace.";
    const reference = "references/item.md";

    expect(findExplicitDirectoryBase(text, referenceOffset(text, reference))).toBeNull();
    expect(resolveMarkdownFileLinkTarget(reference, "/Users/uma/workspace")).toBe(
      "/Users/uma/workspace/references/item.md",
    );
  });
});
