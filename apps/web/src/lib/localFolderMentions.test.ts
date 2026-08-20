// FILE: localFolderMentions.test.ts
// Purpose: Cover the composer helpers that open and root the local-folder mention browser.
// Layer: Web composer tests

import { describe, expect, it } from "vitest";

import {
  expandLocalFolderPath,
  getLocalFolderBrowseRootPath,
  isLocalFolderMentionQuery,
  matchesLocalFolderMentionShortcut,
} from "./localFolderMentions";

describe("localFolderMentions", () => {
  it("offers the local shortcut from an empty or partial mention query", () => {
    expect(matchesLocalFolderMentionShortcut("")).toBe(true);
    expect(matchesLocalFolderMentionShortcut("loc")).toBe(true);
    expect(matchesLocalFolderMentionShortcut("workspace")).toBe(false);
  });

  it("detects mac and windows absolute-path mention browsing", () => {
    expect(isLocalFolderMentionQuery("/Users/test")).toBe(true);
    expect(isLocalFolderMentionQuery("C:\\Users\\test")).toBe(true);
    expect(isLocalFolderMentionQuery("\\\\server\\share\\project")).toBe(true);
    expect(isLocalFolderMentionQuery("local")).toBe(false);
  });

  it("does not treat an incomplete UNC server path as a browseable share", () => {
    expect(isLocalFolderMentionQuery("\\\\server")).toBe(false);
  });

  it("detects `~/` and `~\\` as local folder browsing triggers", () => {
    expect(isLocalFolderMentionQuery("~/")).toBe(true);
    expect(isLocalFolderMentionQuery("~/Documents")).toBe(true);
    expect(isLocalFolderMentionQuery("~\\Documents")).toBe(true);
    // Bare `~` is ambiguous (could be an alias or plugin name) - keep browser closed.
    expect(isLocalFolderMentionQuery("~")).toBe(false);
  });

  it("derives the filesystem root from the server home directory when requested", () => {
    expect(getLocalFolderBrowseRootPath("/Users/test", true)).toBe("/");
    expect(getLocalFolderBrowseRootPath("C:\\Users\\test", true)).toBe("C:\\");
    expect(getLocalFolderBrowseRootPath("\\\\server\\share\\Users\\test", true)).toBe(
      "\\\\server\\share\\",
    );
    expect(getLocalFolderBrowseRootPath("/Users/test", false)).toBe("/Users/test");
    expect(getLocalFolderBrowseRootPath("\\\\server\\share\\Users\\test", false)).toBe(
      "\\\\server\\share\\Users\\test",
    );
  });

  describe("expandLocalFolderPath", () => {
    it("returns the input unchanged when there is no leading tilde", () => {
      expect(expandLocalFolderPath("/Users/test/foo", "/Users/test")).toBe("/Users/test/foo");
      expect(expandLocalFolderPath("", "/Users/test")).toBe("");
    });

    it("expands `~` alone to the home directory", () => {
      expect(expandLocalFolderPath("~", "/Users/test")).toBe("/Users/test");
    });

    it("expands `~/` and `~/subpath` preserving the typed separator", () => {
      expect(expandLocalFolderPath("~/", "/Users/test")).toBe("/Users/test");
      expect(expandLocalFolderPath("~/Documents/foo", "/Users/test")).toBe(
        "/Users/test/Documents/foo",
      );
      expect(expandLocalFolderPath("~\\Documents\\foo", "C:\\Users\\test")).toBe(
        "C:\\Users\\test\\Documents\\foo",
      );
    });

    it("avoids a double separator when the home directory already ends with one", () => {
      expect(expandLocalFolderPath("~/foo", "/Users/test/")).toBe("/Users/test/foo");
    });

    it("returns the input unchanged when home directory is missing", () => {
      expect(expandLocalFolderPath("~/foo", null)).toBe("~/foo");
      expect(expandLocalFolderPath("~/foo", "")).toBe("~/foo");
    });
  });
});
