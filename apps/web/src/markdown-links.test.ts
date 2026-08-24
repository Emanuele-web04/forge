import { describe, expect, it } from "vitest";

import {
  deriveMarkdownExternalFileCandidates,
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

describe("deriveMarkdownExternalFileCandidates", () => {
  it("joins a relative reference to the nearest preceding absolute directory", () => {
    const text = [
      "Dir: `/Users/tester/.cache/ember-204`",
      "- `artifacts/quartz-731.md`",
      "Also exists at `/Users/tester/.local/share/onyx-918`.",
    ].join("\n");
    const reference = "artifacts/quartz-731.md";

    expect(
      deriveMarkdownExternalFileCandidates({
        text,
        reference,
        referenceOffset: text.indexOf(reference),
      }),
    ).toEqual(["/Users/tester/.cache/ember-204/artifacts/quartz-731.md"]);
  });

  it("keeps only structured paths with the full relative suffix", () => {
    expect(
      deriveMarkdownExternalFileCandidates({
        text: "`artifacts/quartz-731.md`",
        reference: "artifacts/quartz-731.md",
        referenceOffset: 0,
        provenancePaths: [
          "/Users/tester/.cache/ember-204/artifacts/quartz-731.md",
          "/Users/tester/.cache/ember-204",
          "/Users/tester/archive/quartz-731.md",
        ],
      }),
    ).toEqual(["/Users/tester/.cache/ember-204/artifacts/quartz-731.md"]);
  });

  it("does not derive candidates for unsafe traversal", () => {
    expect(
      deriveMarkdownExternalFileCandidates({
        text: "Dir: `/Users/tester/project` then `../secret.md`",
        reference: "../secret.md",
        referenceOffset: 40,
      }),
    ).toEqual([]);
  });
});
