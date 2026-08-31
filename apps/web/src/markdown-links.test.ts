import { describe, expect, it } from "vitest";

import {
  extractAbsoluteFilesystemPaths,
  resolveMarkdownFileLinkTarget,
  resolveUniqueAbsoluteSuffixTarget,
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

describe("resolveUniqueAbsoluteSuffixTarget", () => {
  const skillFile = "/Users/tester/.agents/skills/annotate-pr/references/uploadthing.md";
  const tempFile = "/tmp/synara-codex-workspaces/thread-1/notes.md";

  it("returns the unique known absolute path that already ends with the reference", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget("references/uploadthing.md", [
        "/Users/tester/project/src/index.ts",
        skillFile,
      ]),
    ).toBe(skillFile);
  });

  it("keeps line suffixes on the known absolute path", () => {
    expect(resolveUniqueAbsoluteSuffixTarget("notes.md:12", [tempFile])).toBe(`${tempFile}:12`);
  });

  it("returns null when no known path matches", () => {
    expect(resolveUniqueAbsoluteSuffixTarget("references/uploadthing.md", [tempFile])).toBeNull();
  });

  it("returns null when two known paths share the same suffix", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget("references/uploadthing.md", [
        skillFile,
        "/Users/tester/.codex/skills/other/references/uploadthing.md",
      ]),
    ).toBeNull();
  });

  it("does not treat workspace-relative tool paths as known destinations", () => {
    expect(resolveUniqueAbsoluteSuffixTarget("src/index.ts", ["apps/web/src/index.ts"])).toBeNull();
  });

  it("strips a collapsed .../ prefix before matching the real tool path", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget(".../scripts/delete_uploadthing.py", [
        "/Users/tester/.agents/skills/annotate-pr/scripts/delete_uploadthing.py",
      ]),
    ).toBe("/Users/tester/.agents/skills/annotate-pr/scripts/delete_uploadthing.py");
  });

  it("uses a unique basename when the relative path is truncated", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget("delete_uploadthing.py", [
        "/Users/tester/.agents/skills/annotate-pr/scripts/delete_uploadthing.py",
      ]),
    ).toBe("/Users/tester/.agents/skills/annotate-pr/scripts/delete_uploadthing.py");
  });

  it("joins a relative file onto a unique directory declared in the same message", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget("scripts/delete_uploadthing.py", [
        "/Users/tester/.agents/skills/annotate-pr",
      ]),
    ).toBe("/Users/tester/.agents/skills/annotate-pr/scripts/delete_uploadthing.py");
  });

  it("does not treat a unique known file's parent as a join directory", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget("scripts/upsert_pr_proof.py", [
        "/Users/tester/.agents/skills/annotate-pr/SKILL.md",
      ]),
    ).toBeNull();
  });

  it("returns null when two declared directories would join to different files", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget("scripts/delete_uploadthing.py", [
        "/Users/tester/.agents/skills/annotate-pr",
        "/Users/tester/.config/opencode/skills/annotate-pr",
      ]),
    ).toBeNull();
  });
});

describe("extractAbsoluteFilesystemPaths", () => {
  it("collects backtick absolute files and directories", () => {
    expect(
      extractAbsoluteFilesystemPaths(
        [
          "**Dir:** `/Users/tester/.agents/skills/annotate-pr`",
          "- `scripts/delete_uploadthing.py`",
          "- `/Users/tester/.agents/skills/annotate-pr/SKILL.md:1`",
        ].join("\n"),
      ),
    ).toEqual([
      "/Users/tester/.agents/skills/annotate-pr",
      "/Users/tester/.agents/skills/annotate-pr/SKILL.md",
    ]);
  });

  it("collects a bare POSIX home path in prose", () => {
    expect(
      extractAbsoluteFilesystemPaths(
        "Created global copy at /Users/tester/.agents/skills/annotate-pr for every project.",
      ),
    ).toEqual(["/Users/tester/.agents/skills/annotate-pr"]);
  });
});
