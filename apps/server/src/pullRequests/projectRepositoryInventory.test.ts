import type { OrchestrationProject } from "@synara/contracts";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  cleanupUnconfiguredPullRequestPins,
  indexProjectRepositoryInventories,
  pullRequestPinRepositoryKey,
  resolveProjectRepositoryInventories,
} from "./projectRepositoryInventory";

function project(id: string, title: string): OrchestrationProject {
  return { id, title, workspaceRoot: `/tmp/${id}` } as OrchestrationProject;
}

const githubRepository: RemoteRepositoryRef = {
  provider: "github",
  host: "github.com",
  owner: "Paraty",
  slug: "payment-seeker",
  webUrl: "https://github.com/Paraty/payment-seeker",
  identityKey: "github:github.com:paraty/payment-seeker",
  displayName: "Paraty/payment-seeker",
};

const bitbucketRepository: RemoteRepositoryRef = {
  provider: "bitbucket",
  host: "bitbucket.org",
  owner: "paraty",
  slug: "payment-seeker",
  webUrl: "https://bitbucket.org/paraty/payment-seeker",
  identityKey: "bitbucket:bitbucket.org:paraty/payment-seeker",
  displayName: "paraty/payment-seeker",
};

describe("resolveProjectRepositoryInventories", () => {
  it("marks a failed repository lookup non-authoritative", async () => {
    const sourceProject = project("project-1", "Project One");

    const [resolved] = await Effect.runPromise(
      resolveProjectRepositoryInventories({
        projects: [sourceProject],
        resolve: () => Effect.fail(new Error("Git configuration unavailable")),
      }),
    );

    expect(resolved).toEqual({
      project: sourceProject,
      error: expect.objectContaining({ message: "Git configuration unavailable" }),
      inventory: { repositories: [], authoritative: false },
    });
  });
});

describe("indexProjectRepositoryInventories", () => {
  it("keeps same-name repositories from different providers distinct", () => {
    const firstProject = project("project-1", "Project One");
    const secondProject = project("project-2", "Project Two");

    const index = indexProjectRepositoryInventories([
      {
        project: firstProject,
        error: null,
        inventory: { authoritative: true, repositories: [githubRepository, bitbucketRepository] },
      },
      {
        project: secondProject,
        error: null,
        inventory: {
          authoritative: true,
          repositories: [{ ...bitbucketRepository, owner: "PARATY", slug: "Payment-Seeker" }],
        },
      },
    ]);

    expect([...index.uniqueRepositories.keys()]).toEqual([
      "github:github.com:paraty/payment-seeker",
      "bitbucket:bitbucket.org:paraty/payment-seeker",
    ]);
    expect([...index.repositoryKeysByProject.get(firstProject.id)!]).toEqual([
      "github\0paraty/payment-seeker",
      "bitbucket\0paraty/payment-seeker",
    ]);
    expect(
      index.uniqueRepositories.get("bitbucket:bitbucket.org:paraty/payment-seeker")?.projects,
    ).toEqual([firstProject, secondProject]);
  });

  it("preserves nameWithOwner keys for current GitHub service consumers", () => {
    const sourceProject = project("project-1", "Project One");

    const index = indexProjectRepositoryInventories([
      {
        project: sourceProject,
        error: null,
        inventory: {
          authoritative: true,
          repositories: [{ nameWithOwner: "OpenAI/Codex", url: "https://github.com/OpenAI/Codex" }],
        },
      },
    ]);

    expect([...index.uniqueRepositories.keys()]).toEqual(["openai/codex"]);
    expect([...index.repositoryKeysByProject.get(sourceProject.id)!]).toEqual([
      "github\0openai/codex",
    ]);
  });
});

describe("cleanupUnconfiguredPullRequestPins", () => {
  const sourceProject = project("project-cleanup", "Cleanup");

  async function cleanup(input: {
    authoritative: boolean;
    repositories: ReadonlyArray<RemoteRepositoryRef>;
    pinProvider: "github" | "bitbucket";
  }) {
    const writes: unknown[] = [];
    const resolved = [
      {
        project: sourceProject,
        error: null,
        inventory: {
          authoritative: input.authoritative,
          repositories: input.repositories,
        },
      },
    ];
    const { repositoryKeysByProject } = indexProjectRepositoryInventories(resolved);
    await Effect.runPromise(
      cleanupUnconfiguredPullRequestPins({
        pins: {
          listByProjectIds: () => Effect.succeed([]),
          setPinned: (write) => Effect.sync(() => void writes.push(write)),
        },
        pinnedRows: [
          {
            projectId: sourceProject.id,
            provider: input.pinProvider,
            repositoryKey: "paraty/payment-seeker",
            number: 17,
          },
        ],
        projectById: new Map([[sourceProject.id, sourceProject]]),
        repositoryKeysByProject,
        resolved,
      }),
    );
    return writes;
  }

  it("preserves a Bitbucket pin from authoritative local Git inventory while MCP is disconnected", async () => {
    expect(
      await cleanup({
        authoritative: true,
        repositories: [bitbucketRepository],
        pinProvider: "bitbucket",
      }),
    ).toEqual([]);
  });

  it("preserves every pin when local Git inventory is non-authoritative", async () => {
    expect(
      await cleanup({ authoritative: false, repositories: [], pinProvider: "bitbucket" }),
    ).toEqual([]);
  });

  it("deletes a pin absent from authoritative matching-provider inventory", async () => {
    expect(
      await cleanup({ authoritative: true, repositories: [], pinProvider: "bitbucket" }),
    ).toEqual([
      {
        projectId: sourceProject.id,
        provider: "bitbucket",
        repositoryKey: "paraty/payment-seeker",
        number: 17,
        isPinned: false,
      },
    ]);
  });

  it("does not let a GitHub remote preserve a same-name Bitbucket pin", async () => {
    expect(
      await cleanup({
        authoritative: true,
        repositories: [githubRepository],
        pinProvider: "bitbucket",
      }),
    ).toHaveLength(1);
  });

  it("normalizes the canonical provider and repository pin identity", () => {
    expect(pullRequestPinRepositoryKey("bitbucket", " Paraty/Payment-Seeker ")).toBe(
      "bitbucket\0paraty/payment-seeker",
    );
  });
});
