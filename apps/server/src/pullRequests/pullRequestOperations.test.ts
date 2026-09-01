import {
  ProjectId,
  type OrchestrationProject,
  type PullRequestProvider,
} from "@synara/contracts";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins";
import { PullRequestCapabilityError } from "./Errors";
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
  readonly resolveProjectRepository: (
    provider: PullRequestProvider,
  ) => Effect.Effect<RemoteRepositoryRef>;
  readonly providers?: ReadonlyArray<PullRequestProviderShape>;
}) {
  return makePullRequestOperations({
    providers: makePullRequestProviderRegistry(input.providers ?? [githubProvider()]),
    pins: input.pins,
    findProject: () => Effect.succeed(project),
    validateRepository: (_provider, repository) => Effect.succeed(repository),
    resolveProjectRepository: (_project, provider) => input.resolveProjectRepository(provider),
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

  it.each([
    ["close", "stateMutation"],
    ["merge", "merge"],
  ] as const)(
    "rejects a read-only provider %s action before a provider write",
    async (action, capability) => {
      const remoteAction = vi.fn(() => Effect.die("Bitbucket write must not be called"));
      const readOnlyBitbucket: PullRequestProviderShape = {
        ...githubProvider(),
        provider: "bitbucket",
        host: "bitbucket.org",
        supports: (repository) =>
          repository.provider === "bitbucket" && repository.host === "bitbucket.org",
        action: remoteAction,
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
            action,
          }),
        ),
      );

      expect(error).toBeInstanceOf(PullRequestCapabilityError);
      expect(error).toMatchObject({
        _tag: "PullRequestCapabilityError",
        provider: "bitbucket",
        capability,
      });
      expect(error.message).toBe("This pull request provider does not support that operation.");
      expect(remoteAction).not.toHaveBeenCalled();
    },
  );

  it("rejects a read-only provider comment before invoking its adapter", async () => {
    const remoteComment = vi.fn(() => Effect.die("Bitbucket comment must not be called"));
    const readOnlyBitbucket: PullRequestProviderShape = {
      ...githubProvider(),
      provider: "bitbucket",
      host: "bitbucket.org",
      supports: (repository) =>
        repository.provider === "bitbucket" && repository.host === "bitbucket.org",
      comment: remoteComment,
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
        operations.comment({
          projectId: project.id,
          provider: "bitbucket",
          repository: bitbucketRepository.displayName,
          number: 42,
          body: "No remote write",
        }),
      ),
    );

    expect(error).toBeInstanceOf(PullRequestCapabilityError);
    expect(error).toMatchObject({ provider: "bitbucket", capability: "comment" });
    expect(remoteComment).not.toHaveBeenCalled();
  });

  it("routes detail and diff by the explicit provider after local identity validation", async () => {
    const routedProviders: PullRequestProvider[] = [];
    const detail = vi.fn(() => Effect.succeed({ route: "bitbucket-detail" } as never));
    const diff = vi.fn(() => Effect.succeed({ patch: "bitbucket-diff", truncated: false }));
    const bitbucket: PullRequestProviderShape = {
      ...githubProvider(),
      provider: "bitbucket",
      host: "bitbucket.org",
      supports: (repository) => repository.identityKey === bitbucketRepository.identityKey,
      detail,
      diff,
      action: undefined,
    };
    const operations = makeOperations({
      pins: {
        listByProjectIds: () => Effect.succeed([]),
        setPinned: () => Effect.void,
      },
      resolveProjectRepository: (provider) =>
        Effect.sync(() => {
          routedProviders.push(provider);
          return bitbucketRepository;
        }),
      providers: [githubProvider(), bitbucket],
    });

    const [detailResult, diffResult] = await Effect.runPromise(
      Effect.all([
        operations.detail({
          projectId: project.id,
          provider: "bitbucket",
          repository: bitbucketRepository.displayName,
          number: 42,
        }),
        operations.diff({
          projectId: project.id,
          provider: "bitbucket",
          repository: bitbucketRepository.displayName,
          number: 42,
        }),
      ]),
    );

    expect(detailResult).toEqual({ route: "bitbucket-detail" });
    expect(diffResult).toEqual({ patch: "bitbucket-diff", truncated: false });
    expect(routedProviders).toEqual(["bitbucket", "bitbucket"]);
  });

  it("rejects a fabricated Bitbucket identity before provider dispatch", async () => {
    const detail = vi.fn(() => Effect.die("Provider must not receive a fabricated repository"));
    const bitbucket: PullRequestProviderShape = {
      ...githubProvider(),
      provider: "bitbucket",
      host: "bitbucket.org",
      supports: () => true,
      detail,
      action: undefined,
    };
    const operations = makeOperations({
      pins: {
        listByProjectIds: () => Effect.succeed([]),
        setPinned: () => Effect.void,
      },
      resolveProjectRepository: () =>
        Effect.fail(new Error("bitbucket repository does not belong to the selected project.")),
      providers: [bitbucket],
    });

    const error = await Effect.runPromise(
      Effect.flip(
        operations.detail({
          projectId: project.id,
          provider: "bitbucket",
          repository: bitbucketRepository.displayName,
          number: 42,
        }),
      ),
    );

    expect(error.message).toContain("does not belong");
    expect(detail).not.toHaveBeenCalled();
  });
});
