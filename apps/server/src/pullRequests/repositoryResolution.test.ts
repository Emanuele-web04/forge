import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ExecuteGitInput, GitCoreShape } from "../git/Services/GitCore";
import { resolveGitHubRepositories, resolveRemoteRepositories } from "./repositoryResolution";

function makeGit(input: {
  branchExitCode?: number;
  branchStderr?: string;
  configExitCode?: number;
  configStderr?: string;
  branchRemote?: string;
  pushDefaultRemote?: string;
  urls?: Readonly<Record<string, string>>;
  expandedUrls?: Readonly<Record<string, string>>;
  remoteExitCode?: number;
  remoteStderr?: string;
  calls?: string[][];
  operations?: string[];
}): GitCoreShape {
  return {
    execute: ({ args, operation }: ExecuteGitInput) => {
      input.calls?.push([...args]);
      input.operations?.push(operation);
      if (args[0] === "branch") {
        return Effect.succeed({
          code: input.branchExitCode ?? 0,
          stdout: "main\n",
          stderr: input.branchStderr ?? "",
        });
      }
      if (args[0] === "config") {
        const records = [
          ...(input.branchRemote ? [`branch.main.remote\n${input.branchRemote}\0`] : []),
          ...(input.pushDefaultRemote ? [`remote.pushDefault\n${input.pushDefaultRemote}\0`] : []),
          ...Object.entries(input.urls ?? {}).map(([name, url]) => `remote.${name}.url\n${url}\0`),
        ];
        return Effect.succeed({
          code: input.configExitCode ?? (records.length > 0 ? 0 : 1),
          stdout: records.join(""),
          stderr: input.configStderr ?? "",
        });
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        const expandedUrl = input.expandedUrls?.[args[2] ?? ""];
        return Effect.succeed({
          code: input.remoteExitCode ?? (expandedUrl ? 0 : 2),
          stdout: expandedUrl ? `${expandedUrl}\n` : "",
          stderr: input.remoteStderr ?? (expandedUrl ? "" : "error: No such remote"),
        });
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
    readConfigValue: () => Effect.succeed(null),
  } as unknown as GitCoreShape;
}

describe("resolveGitHubRepositories", () => {
  it("fails outside a repository before reading process-wide config", async () => {
    const calls: string[][] = [];
    const git = makeGit({
      branchExitCode: 128,
      branchStderr: "fatal: not a git repository",
      calls,
    });

    await expect(Effect.runPromise(resolveGitHubRepositories(git, "/tmp/project"))).rejects.toThrow(
      "not a git repository",
    );
    expect(calls).toHaveLength(1);
  });

  it("fails instead of returning an authoritative empty inventory when git remote fails", async () => {
    const git = makeGit({
      configExitCode: 128,
      configStderr: "fatal: not a git repository",
    });

    await expect(Effect.runPromise(resolveGitHubRepositories(git, "/tmp/project"))).rejects.toThrow(
      "not a git repository",
    );
  });

  it("returns an authoritative inventory for every configured GitHub remote", async () => {
    const calls: string[][] = [];
    const git = makeGit({
      branchRemote: "upstream",
      urls: {
        upstream: "git@github.com:acme/widgets.git",
        mirror: "https://github.com/acme/other.git",
      },
      calls,
    });

    await expect(
      Effect.runPromise(resolveGitHubRepositories(git, "/tmp/project")),
    ).resolves.toEqual({
      authoritative: true,
      repositories: [
        { nameWithOwner: "acme/widgets", url: "https://github.com/acme/widgets" },
        { nameWithOwner: "acme/other", url: "https://github.com/acme/other" },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((args) => args[0])).toEqual(["branch", "config"]);
  });

  it("treats a repository with no matching config keys as authoritatively empty", async () => {
    await expect(
      Effect.runPromise(resolveGitHubRepositories(makeGit({}), "/tmp/project")),
    ).resolves.toEqual({ authoritative: true, repositories: [] });
  });

  it("expands an unparseable Git URL alias without slowing direct GitHub remotes", async () => {
    const calls: string[][] = [];
    const git = makeGit({
      urls: {
        origin: "gh:acme/widgets.git",
        upstream: "https://github.com/acme/platform.git",
      },
      expandedUrls: { origin: "git@github.com:acme/widgets.git" },
      calls,
    });

    await expect(
      Effect.runPromise(resolveGitHubRepositories(git, "/tmp/project")),
    ).resolves.toEqual({
      authoritative: true,
      repositories: [
        { nameWithOwner: "acme/widgets", url: "https://github.com/acme/widgets" },
        { nameWithOwner: "acme/platform", url: "https://github.com/acme/platform" },
      ],
    });
    expect(calls).toEqual([
      ["branch", "--show-current"],
      expect.arrayContaining(["config", "--null", "--get-regexp"]),
      ["remote", "get-url", "origin"],
    ]);
  });

  it("fails discovery when an unparseable remote cannot be resolved authoritatively", async () => {
    const git = makeGit({
      urls: { origin: "gh:acme/widgets.git" },
      remoteExitCode: 2,
      remoteStderr: "error: No such remote 'origin'",
    });

    await expect(Effect.runPromise(resolveGitHubRepositories(git, "/tmp/project"))).rejects.toThrow(
      "No such remote",
    );
  });
});

describe("resolveRemoteRepositories", () => {
  it("preserves remote precedence and deduplicates by provider-aware identity", async () => {
    const operations: string[] = [];
    const git = makeGit({
      branchRemote: "upstream",
      pushDefaultRemote: "mirror",
      urls: {
        origin: "https://github.com/Paraty/payment-seeker.git",
        upstream: "git@bitbucket.org:paraty/payment-seeker.git",
        mirror: "https://BITBUCKET.ORG/PARATY/Payment-Seeker.git",
      },
      operations,
    });

    await expect(
      Effect.runPromise(resolveRemoteRepositories(git, "/tmp/project")),
    ).resolves.toEqual({
      authoritative: true,
      repositories: [
        {
          provider: "bitbucket",
          host: "bitbucket.org",
          owner: "paraty",
          slug: "payment-seeker",
          webUrl: "https://bitbucket.org/paraty/payment-seeker",
          identityKey: "bitbucket:bitbucket.org:paraty/payment-seeker",
          displayName: "paraty/payment-seeker",
        },
        {
          provider: "github",
          host: "github.com",
          owner: "Paraty",
          slug: "payment-seeker",
          webUrl: "https://github.com/Paraty/payment-seeker",
          identityKey: "github:github.com:paraty/payment-seeker",
          displayName: "Paraty/payment-seeker",
        },
      ],
    });
    expect(operations).toEqual([
      "PullRequestService.remoteRepository.currentBranch",
      "PullRequestService.remoteRepository.config",
    ]);
  });

  it("expands aliases only after direct provider-neutral parsing fails", async () => {
    const calls: string[][] = [];
    const git = makeGit({
      urls: {
        origin: "bb:paraty/payment-seeker.git",
        upstream: "https://bitbucket.org/paraty/platform.git",
      },
      expandedUrls: { origin: "git@bitbucket.org:paraty/payment-seeker.git" },
      calls,
    });

    await expect(
      Effect.runPromise(resolveRemoteRepositories(git, "/tmp/project")),
    ).resolves.toMatchObject({
      repositories: [
        { identityKey: "bitbucket:bitbucket.org:paraty/payment-seeker" },
        { identityKey: "bitbucket:bitbucket.org:paraty/platform" },
      ],
    });
    expect(calls.filter((args) => args[0] === "remote")).toEqual([["remote", "get-url", "origin"]]);
  });

  it("keeps the legacy GitHub resolver projection GitHub-only", async () => {
    const git = makeGit({
      urls: {
        origin: "git@bitbucket.org:paraty/payment-seeker.git",
        upstream: "git@github.com:openai/codex.git",
      },
    });

    await expect(
      Effect.runPromise(resolveGitHubRepositories(git, "/tmp/project")),
    ).resolves.toEqual({
      authoritative: true,
      repositories: [{ nameWithOwner: "openai/codex", url: "https://github.com/openai/codex" }],
    });
  });
});
