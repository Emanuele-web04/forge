// FILE: chatWorkspaceFolders.test.ts
// Purpose: Verifies Codex-style date/slug workspace folder naming for general chats.

import { describe, expect, it } from "vitest";

import {
  buildChatWorkspaceFolderPath,
  formatChatWorkspaceDate,
  slugifyChatWorkspaceSeed,
} from "./chatWorkspaceFolders";

describe("chatWorkspaceFolders", () => {
  it("formats local date buckets like Codex chat folders", () => {
    expect(formatChatWorkspaceDate(new Date(2026, 5, 11, 23, 30, 43))).toBe("2026-06-11");
  });

  it("builds lowercase hyphen slugs from the first prompt seed", () => {
    expect(slugifyChatWorkspaceSeed("Yes, it takes all the skills!")).toBe(
      "yes-it-takes-all-the-skills",
    );
  });

  it("places new chat folders under date and slug segments", () => {
    expect(
      buildChatWorkspaceFolderPath({
        chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        createdAt: new Date(2026, 5, 11, 23, 30, 43),
        existingWorkspaceRoots: [],
        titleSeed: "Yes, it takes all the skills!",
      }),
    ).toBe("/Users/tester/Documents/Synara/2026-06-11/yes-it-takes-all-the-skills");
  });

  it("adds numeric suffixes when the same slug already exists", () => {
    expect(
      buildChatWorkspaceFolderPath({
        chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        createdAt: new Date(2026, 5, 11, 23, 30, 43),
        existingWorkspaceRoots: [
          "/Users/tester/Documents/Synara/2026-06-11/yes-it-takes-all-the-skills",
        ],
        titleSeed: "Yes, it takes all the skills!",
      }),
    ).toBe("/Users/tester/Documents/Synara/2026-06-11/yes-it-takes-all-the-skills-2");
  });

  it("preserves Windows separators when the server root uses them", () => {
    expect(
      buildChatWorkspaceFolderPath({
        chatWorkspaceRoot: "C:\\Users\\tester\\Documents\\Synara",
        createdAt: new Date(2026, 5, 11, 23, 30, 43),
        existingWorkspaceRoots: [],
        titleSeed: "Hello there",
      }),
    ).toBe("C:\\Users\\tester\\Documents\\Synara\\2026-06-11\\hello-there");
  });
});
