import { ProjectId, type OrchestrationProject } from "@synara/contracts";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins";
import {
  makePullRequestProviderRegistry,
  type PullRequestProviderShape,
} from "./Services/PullRequestProvider";
import { makePullRequestOperations } from "./pullRequestOperations";

const now = "2026-07-15T00:00:00.000Z";

const project: OrchestrationProject = {
  id: ProjectId.makeUnsafe("project-detail"),
  kind: "project",
  title: "Detail",
  workspaceRoot: "/tmp/detail",
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
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

function githubProvider(action = vi.fn()): PullRequestProviderShape {
  return {
    provider: "github",
    host: "github.com",
    supports: (repository) => repository.provider === "github" && repository.host === "github.com",
    list: () =>
      Effect.succeed({
        entries: [],
        truncated: false,
        reviewingNumbers: new Set(),
        reviewingTruncated: false,
      }),
    exactSummary: () => Effect.succeed({ _tag: "not-found" }),
    detail: () => Effect.die("detail should not be called"),
    diff: () => Effect.die("diff should not be called"),
    action,
  };
}

function makeOperations(input: {
  readonly pins: ProjectPullRequestPinsShape;
  readonly resolveProjectRepository: () => Effect.Effect<RemoteRepositoryRef>;
  readonly providers?: ReadonlyArray<PullRequestProviderShape>;
}) {
  return makePullRequestOperations({
    providers: makePullRequestProviderRegistry(input.providers ?? [githubProvider()]),
    pins: input.pins,
    findProject: () => Effect.succeed(project),
    validateRepository: (_provider, repository) => Effect.succeed(repository),
    resolveProjectRepository: input.resolveProjectRepository,
  });
}

describe("makePullRequestOperations", () => {
  it("forwards the explicit provider to pin persistence", async () => {
    const writes: unknown[] = [];
    const operations = makeOperations({
      pins: {
        listByProjectIds: () => Effect.succeed([]),
        setPinned: (input) => Effect.sync(() => void writes.push(input)),
      },
      resolveProjectRepository: () =>
        Effect.succeed({ ...bitbucketRepository, displayName: "Acme/Widgets" }),
    });

    await Effect.runPromise(
      operations.setPinned({
        projectId: project.id,
        provider: "bitbucket",
        repository: "Acme/Widgets",
        number: 42,
        isPinned: true,
      }),
    );

    expect(writes).toEqual([
      {
        projectId: project.id,
        provider: "bitbucket",
        repositoryKey: "acme/widgets",
        number: 42,
        isPinned: true,
      },
    ]);
  });

  it("rejects an unregistered Bitbucket mutation before any GitHub or pin effect", async () => {
    const action = vi.fn(() => Effect.die("GitHub action must not be called"));
    const pinWrites: unknown[] = [];
    const operations = makeOperations({
      pins: {
        listByProjectIds: () => Effect.succeed([]),
        setPinned: (input) => Effect.sync(() => void pinWrites.push(input)),
      },
      resolveProjectRepository: () => Effect.succeed(bitbucketRepository),
      providers: [githubProvider(action)],
    });

    const exit = await Effect.runPromiseExit(
      operations.action({
        projectId: project.id,
        provider: "bitbucket",
        repository: bitbucketRepository.displayName,
        number: 42,
        action: "close",
      }),
    );

    expect(exit._tag).toBe("Failure");
    expect(action).not.toHaveBeenCalled();
    expect(pinWrites).toEqual([]);
  });

  it("fails an unsupported provider mutation as a normal operation error", async () => {
    const readOnlyBitbucket: PullRequestProviderShape = {
      ...githubProvider(),
      provider: "bitbucket",
      host: "bitbucket.org",
      supports: (repository) =>
        repository.provider === "bitbucket" && repository.host === "bitbucket.org",
      action: undefined,
    };
    const operations = makeOperations({
      pins: {
        listByProjectIds: () => Effect.succeed([]),
        setPinned: () => Effect.void,
      },
      resolveProjectRepository: () => Effect.succeed(bitbucketRepository),
      providers: [readOnlyBitbucket],
    });

    const error = await Effect.runPromise(
      Effect.flip(
        operations.action({
          projectId: project.id,
          provider: "bitbucket",
          repository: bitbucketRepository.displayName,
          number: 42,
          action: "close",
        }),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("bitbucket pull requests do not support action.");
  });
});
