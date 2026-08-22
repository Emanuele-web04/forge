import { describe, expect, it } from "vitest";

import {
  isValidGitHubRepositoryNameWithOwner,
  parseGitHubRepositoryInput,
  parseGitHubRepositoryNameWithOwnerFromPullRequestUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
} from "./githubRepository";

describe("parseGitHubRepositoryInput", () => {
  it.each([
    ["openai/codex", "openai/codex"],
    [" https://github.com/openai/codex ", "openai/codex"],
    ["https://github.com/OpenAI/Codex.git/", "OpenAI/Codex"],
  ])("parses %s", (input, expected) => {
    expect(parseGitHubRepositoryInput(input)).toBe(expected);
  });

  it.each([
    "",
    "https://example.com/openai/codex",
    "https://user:token@github.com/openai/codex",
    "https://github.com/openai/codex/issues",
    "https://github.com/openai/codex?tab=readme",
    "git@github.com:openai/codex.git",
    "--upload-pack=malicious",
  ])("rejects %s", (input) => {
    expect(parseGitHubRepositoryInput(input)).toBeNull();
  });
});

describe("isValidGitHubRepositoryNameWithOwner", () => {
  it.each(["openai/codex", "OpenAI/Codex.js", "owner-1/repo_name", "owner/.github"])(
    "accepts %s",
    (repository) => expect(isValidGitHubRepositoryNameWithOwner(repository)).toBe(true),
  );

  it.each([
    "",
    "owner",
    "owner/repo/extra",
    "owner repo/name",
    "-owner/name",
    "owner-/name",
    "owner/..",
    `owner/${"x".repeat(101)}`,
  ])("rejects %s", (repository) =>
    expect(isValidGitHubRepositoryNameWithOwner(repository)).toBe(false),
  );
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it.each([
    ["git@github.com:openai/codex.git", "openai/codex"],
    ["ssh://git@github.com/openai/codex.git", "openai/codex"],
    ["https://github.com/openai/codex", "openai/codex"],
    ["git://github.com/openai/codex/", "openai/codex"],
    [" HTTPS://GITHUB.COM/OpenAI/Codex.git ", "OpenAI/Codex"],
  ])("parses %s", (remote, expected) => {
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remote)).toBe(expected);
  });

  it.each([
    null,
    "",
    "https://gitlab.com/openai/codex",
    "https://github.com/owner",
    "https://github.com/-owner/repo",
  ])("rejects unsupported remote %s", (remote) => {
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remote)).toBeNull();
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromPullRequestUrl", () => {
  it.each([
    ["https://github.com/openai/codex/pull/123", "openai/codex"],
    ["https://github.com/OpenAI/Codex/pull/123/files", "OpenAI/Codex"],
    ["http://github.com/openai/codex/pull/123?diff=split", "openai/codex"],
  ])("parses %s", (url, expected) => {
    expect(parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(url)).toBe(expected);
  });

  it.each([
    null,
    "",
    "https://gitlab.com/openai/codex/pull/1",
    "https://github.com/openai/codex/issues/1",
    "https://github.com/-owner/codex/pull/1",
    "javascript:alert(1)",
  ])("rejects unsupported URL %s", (url) => {
    expect(parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(url)).toBeNull();
  });
});
