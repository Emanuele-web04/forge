import { ProjectId } from "@synara/contracts";
import type { OrchestrationProject } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { GitHubCliError } from "../../git/Errors";
import type {
  GitHubCliShape,
  GitHubPullRequestListBatch,
  GitHubPullRequestListItem,
} from "../../git/Services/GitHubCli";
import { createGitHubCliWithFakeGh } from "../../git/testing/fakeGitHubCli";
import type { ProjectPullRequestPinsShape } from "../../persistence/Services/ProjectPullRequestPins";
import {
  PULL_REQUEST_PIN_RECOVERY_LIMIT,
  isDefinitivePullRequestNotFound,
  makePullRequestService,
} from "./PullRequestService";

const now = "2026-07-15T00:00:00.000Z";

function makeProject(id: string, title: string, workspaceRoot: string): OrchestrationProject {
  return {
    id: ProjectId.makeUnsafe(id),
    kind: "project",
    title,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function makeItem(number: number, repository = "acme/shared"): GitHubPullRequestListItem {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
    author: { login: "viewer", name: null, avatarUrl: null, url: null },
    headBranch: `feature-${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 1,
    deletions: 0,
    createdAt: now,
    updatedAt: now,
    reviewDecision: null,
    reviewRequestLogins: [],
    labels: [],
    mergeability: "unknown",
    stack: null,
  };
}

function makeBatch(
  entries: ReadonlyArray<GitHubPullRequestListItem>,
  rawCount = entries.length,
): GitHubPullRequestListBatch {
  return { entries, rawCount };
}

function makePins(
  rows: ReadonlyArray<{ projectId: ProjectId; repositoryKey: string; number: number }> = [],
  onSetPinned?: (input: {
    projectId: ProjectId;
    repositoryKey: string;
    number: number;
    isPinned: boolean;
  }) => void,
): ProjectPullRequestPinsShape {
  return {
    listByProjectIds: ({ projectIds }) =>
      Effect.succeed(rows.filter((row) => projectIds.includes(row.projectId))),
    setPinned: (input) => Effect.sync(() => onSetPinned?.(input)),
  };
}

function makeDependencies(input: {
  projects: OrchestrationProject[];
  repositories: ReadonlyMap<ProjectId, string>;
  github: GitHubCliShape;
  pins?: ProjectPullRequestPinsShape;
}) {
  return {
    homeDir: "/tmp",
    github: input.github,
    pins: input.pins ?? makePins(),
    listProjects: () => Effect.succeed(input.projects),
    resolveRepositories: (project: OrchestrationProject) => {
      const repository = input.repositories.get(project.id);
      return Effect.succeed({
        repositories: repository
          ? [{ nameWithOwner: repository, url: `https://github.com/${repository}` }]
          : [],
        authoritative: true,
      });
    },
  };
}

describe("PullRequestService", () => {
  it("returns one repository-level row for projects sharing a repository", async () => {
    const projectA = makeProject("project-list-a", "List A", "/tmp/list-a");
    const projectB = makeProject("project-list-b", "feature-1", "/tmp/list-b");
    const base = createGitHubCliWithFakeGh().service;
    let listReads = 0;
    const github: GitHubCliShape = {
      ...base,
      listRepositoryPullRequests: () =>
        Effect.sync(() => {
          listReads += 1;
          return makeBatch([
            {
              ...makeItem(1),
              stack: { number: 2, size: 3, position: 1, baseBranch: "main" },
            },
          ]);
        }),
    };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [projectA, projectB],
              repositories: new Map([
                [projectA.id, "acme/shared"],
                [projectB.id, "acme/shared"],
              ]),
              github,
            }),
          );
          return yield* service.list({ state: "open", involvement: "authored" });
        }),
      ),
    );

    expect(listReads).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.projectId).toBe(projectB.id);
    expect(result.entries[0]?.projectContexts).toHaveLength(2);
    expect(result.entries[0]?.stack).toEqual({
      number: 2,
      size: 3,
      position: 1,
      baseBranch: "main",
    });
    expect(result.repositoryBatches).toHaveLength(1);
  });

  it("counts review requests once for projects sharing a repository without loading rich rows", async () => {
    const projectA = makeProject("project-count-a", "Count A", "/tmp/count-a");
    const projectB = makeProject("project-count-b", "Count B", "/tmp/count-b");
    const base = createGitHubCliWithFakeGh().service;
    let countReads = 0;
    let richListReads = 0;
    const github: GitHubCliShape = {
      ...base,
      listReviewRequestedPullRequestNumbers: () =>
        Effect.sync(() => {
          countReads += 1;
          return [12, 19];
        }),
      listRepositoryPullRequests: () =>
        Effect.sync(() => {
          richListReads += 1;
          return makeBatch([]);
        }),
    };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [projectA, projectB],
              repositories: new Map([
                [projectA.id, "acme/shared"],
                [projectB.id, "acme/shared"],
              ]),
              github,
            }),
          );
          return yield* service.reviewRequestCount({ projectId: null });
        }),
      ),
    );

    expect(result).toEqual({ count: 2, incomplete: false });
    expect(countReads).toBe(1);
    expect(richListReads).toBe(0);
  });

  it("marks the review count incomplete when repository discovery is non-authoritative", async () => {
    const project = makeProject("project-count-incomplete", "Incomplete", "/tmp/incomplete");
    const dependencies = makeDependencies({
      projects: [project],
      repositories: new Map(),
      github: createGitHubCliWithFakeGh().service,
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService({
            ...dependencies,
            resolveRepositories: () => Effect.succeed({ repositories: [], authoritative: false }),
          });
          return yield* service.reviewRequestCount({ projectId: null });
        }),
      ),
    );

    expect(result).toEqual({ count: 0, incomplete: true });
  });

  it("does not invoke gh viewer lookup when the selected scope has no repositories", async () => {
    const project = makeProject("project-empty", "Empty", "/tmp/empty");
    const base = createGitHubCliWithFakeGh().service;
    let viewerLookups = 0;
    const github: GitHubCliShape = {
      ...base,
      getViewerLogin: () =>
        Effect.sync(() => {
          viewerLookups += 1;
          return "viewer";
        }),
    };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [project],
              repositories: new Map(),
              github,
            }),
          );
          return yield* service.list({ state: "open", involvement: "all" });
        }),
      ),
    );

    expect(viewerLookups).toBe(0);
    expect(result).toMatchObject({ viewer: null, entries: [], repositoryBatches: [] });
  });

  it("reloads the GitHub viewer during a forced list refresh", async () => {
    const project = makeProject("project-viewer-refresh", "Viewer refresh", "/tmp/viewer-refresh");
    const base = createGitHubCliWithFakeGh().service;
    const viewerLogins = ["alice", "bob"];
    const listViewers: string[] = [];
    let viewerLookup = 0;
    const github: GitHubCliShape = {
      ...base,
      getViewerLogin: () =>
        Effect.sync(() => viewerLogins[Math.min(viewerLookup++, viewerLogins.length - 1)]!),
      listRepositoryPullRequests: ({ viewer }) =>
        Effect.sync(() => {
          listViewers.push(viewer);
          return makeBatch([]);
        }),
    };

    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [project],
              repositories: new Map([[project.id, "acme/shared"]]),
              github,
            }),
          );
          return [
            yield* service.list({ state: "open", involvement: "authored" }),
            yield* service.list({ state: "open", involvement: "authored", forceRefresh: true }),
          ];
        }),
      ),
    );

    expect(results.map((result) => result.viewer)).toEqual(["alice", "bob"]);
    expect(listViewers).toEqual(["alice", "bob"]);
    expect(viewerLookup).toBe(2);
  });

  it("allows clearing a pin after its repository remote was removed", async () => {
    const project = makeProject("project-orphan", "Orphan", "/tmp/orphan");
    const base = createGitHubCliWithFakeGh().service;
    const writes: Array<{ repositoryKey: string; isPinned: boolean }> = [];
    const pins: ProjectPullRequestPinsShape = {
      listByProjectIds: () => Effect.succeed([]),
      setPinned: (input) =>
        Effect.sync(() => {
          writes.push({ repositoryKey: input.repositoryKey, isPinned: input.isPinned });
        }),
    };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [project],
              repositories: new Map(),
              github: base,
              pins,
            }),
          );
          return yield* service.setPinned({
            projectId: project.id,
            repository: " Acme/Removed ",
            number: 42,
            isPinned: false,
          });
        }),
      ),
    );

    expect(result.repository).toBe("Acme/Removed");
    expect(writes).toEqual([{ repositoryKey: "acme/removed", isPinned: false }]);
  });

  it("cleans pins for repositories removed after a successful project inventory", async () => {
    const project = makeProject("project-stale-repo", "Stale repo", "/tmp/stale-repo");
    const writes: Array<{ repositoryKey: string; number: number; isPinned: boolean }> = [];
    const pins = makePins(
      [
        { projectId: project.id, repositoryKey: "acme/removed", number: 9 },
        { projectId: project.id, repositoryKey: "acme/current", number: 10 },
      ],
      (input) => writes.push(input),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [project],
              repositories: new Map([[project.id, "acme/current"]]),
              github: createGitHubCliWithFakeGh().service,
              pins,
            }),
          );
          yield* service.list({ state: "open", involvement: "authored" });
        }),
      ),
    );

    expect(writes).toEqual([
      { projectId: project.id, repositoryKey: "acme/removed", number: 9, isPinned: false },
    ]);
  });

  it("preserves stale-looking pins when repository inventory fails", async () => {
    const project = makeProject("project-inventory-error", "Inventory", "/tmp/inventory");
    const writes: Array<{ repositoryKey: string; number: number; isPinned: boolean }> = [];
    const dependencies = makeDependencies({
      projects: [project],
      repositories: new Map(),
      github: createGitHubCliWithFakeGh().service,
      pins: makePins(
        [{ projectId: project.id, repositoryKey: "acme/possibly-current", number: 11 }],
        (input) => writes.push(input),
      ),
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService({
            ...dependencies,
            resolveRepositories: () => Effect.fail(new Error("git config unavailable")),
          });
          return yield* service.list({ state: "open", involvement: "authored" });
        }),
      ),
    );

    expect(writes).toEqual([]);
    expect(result.errors.some((error) => error.message.includes("git config unavailable"))).toBe(
      true,
    );
  });

  it("preserves stale-looking pins when repository inventory is non-authoritative", async () => {
    const project = makeProject("project-inventory-unknown", "Inventory", "/tmp/inventory");
    const writes: Array<{ repositoryKey: string; number: number; isPinned: boolean }> = [];
    const dependencies = makeDependencies({
      projects: [project],
      repositories: new Map(),
      github: createGitHubCliWithFakeGh().service,
      pins: makePins(
        [{ projectId: project.id, repositoryKey: "acme/possibly-current", number: 11 }],
        (input) => writes.push(input),
      ),
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService({
            ...dependencies,
            resolveRepositories: () => Effect.succeed({ repositories: [], authoritative: false }),
          });
          return yield* service.list({ state: "open", involvement: "authored" });
        }),
      ),
    );

    expect(writes).toEqual([]);
  });

  it("uses raw list cardinality to recover a pin after a malformed capped item", async () => {
    const project = makeProject("project-malformed-cap", "Malformed cap", "/tmp/malformed-cap");
    const rawEntries: unknown[] = Array.from({ length: 50 }, (_, index) => ({
      number: index + 1,
      title: `PR ${index + 1}`,
      url: `https://github.com/acme/shared/pull/${index + 1}`,
      author: { login: "viewer" },
      headRefName: `feature-${index + 1}`,
      baseRefName: "main",
      state: "OPEN",
      createdAt: now,
      updatedAt: now,
    }));
    rawEntries.push({ number: "malformed" });
    const { service: github, ghCalls } = createGitHubCliWithFakeGh({
      repositoryPullRequestListJson: JSON.stringify(rawEntries),
      pullRequestListItems: [makeItem(99)],
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [project],
              repositories: new Map([[project.id, "acme/shared"]]),
              github,
              pins: makePins([{ projectId: project.id, repositoryKey: "acme/shared", number: 99 }]),
            }),
          );
          return yield* service.list({ state: "open", involvement: "authored" });
        }),
      ),
    );

    expect(
      ghCalls.filter((call) => call.includes("pr view 99") && call.includes("list-item")),
    ).toHaveLength(1);
    expect(result.repositoryBatches[0]?.truncated).toBe(true);
    expect(result.entries.some((entry) => entry.number === 99 && entry.isPinned)).toBe(true);
  });

  it("bounds aggregate recovery and keeps shared-repository pins project-scoped", async () => {
    const projectA = makeProject("project-a", "Project A", "/tmp/project-a");
    const projectB = makeProject("project-b", "Project B", "/tmp/project-b");
    const base = createGitHubCliWithFakeGh().service;
    let itemLookups = 0;
    const github: GitHubCliShape = {
      ...base,
      listRepositoryPullRequests: () =>
        Effect.succeed(makeBatch(Array.from({ length: 51 }, (_, index) => makeItem(index + 1)))),
      getPullRequestListItem: ({ number }) =>
        Effect.sync(() => {
          itemLookups += 1;
          return makeItem(number);
        }),
    };
    const pins = [
      ...Array.from({ length: 15 }, (_, index) => ({
        projectId: projectA.id,
        repositoryKey: "acme/shared",
        number: 100 + index,
      })),
      ...Array.from({ length: 15 }, (_, index) => ({
        projectId: projectB.id,
        repositoryKey: "acme/shared",
        number: 115 + index,
      })),
    ];

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [projectA, projectB],
              repositories: new Map([
                [projectA.id, "acme/shared"],
                [projectB.id, "acme/shared"],
              ]),
              github,
              pins: makePins(pins),
            }),
          );
          return yield* service.list({ state: "open", involvement: "authored" });
        }),
      ),
    );

    expect(itemLookups).toBe(PULL_REQUEST_PIN_RECOVERY_LIMIT);
    expect(result.errors.some((error) => error.message.includes("recovery was limited"))).toBe(
      true,
    );
    expect(
      result.entries.filter((entry) => entry.number === 100).map((entry) => entry.projectId),
    ).toEqual([projectA.id]);
  });

  it("fans one bounded lookup into one visible row for a shared pinned PR", async () => {
    const projects = Array.from({ length: PULL_REQUEST_PIN_RECOVERY_LIMIT + 6 }, (_, index) =>
      makeProject(`project-shared-${index}`, `Shared ${index}`, `/tmp/shared-${index}`),
    );
    const base = createGitHubCliWithFakeGh().service;
    let itemLookups = 0;
    const github: GitHubCliShape = {
      ...base,
      listRepositoryPullRequests: () =>
        Effect.succeed(makeBatch(Array.from({ length: 51 }, (_, index) => makeItem(index + 1)))),
      getPullRequestListItem: ({ number }) =>
        Effect.sync(() => {
          itemLookups += 1;
          return makeItem(number);
        }),
    };
    const repositories = new Map(projects.map((project) => [project.id, "acme/shared"]));
    const pins = projects.map((project) => ({
      projectId: project.id,
      repositoryKey: "acme/shared",
      number: 99,
    }));

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({ projects, repositories, github, pins: makePins(pins) }),
          );
          return yield* service.list({ state: "open", involvement: "authored" });
        }),
      ),
    );

    expect(itemLookups).toBe(1);
    expect(result.entries.filter((entry) => entry.number === 99)).toHaveLength(1);
    expect(result.entries.find((entry) => entry.number === 99)?.isPinned).toBe(true);
    expect(result.errors.some((error) => error.message.includes("recovery was limited"))).toBe(
      false,
    );
  });

  it("negative-caches only definitive not-found recovery failures", async () => {
    const project = makeProject("project-negative", "Negative", "/tmp/project-negative");
    const base = createGitHubCliWithFakeGh().service;
    let notFoundLookups = 0;
    const github: GitHubCliShape = {
      ...base,
      listRepositoryPullRequests: () =>
        Effect.succeed(makeBatch(Array.from({ length: 51 }, (_, index) => makeItem(index + 1)))),
      getPullRequestListItem: () =>
        Effect.suspend(() => {
          notFoundLookups += 1;
          return Effect.fail(
            new GitHubCliError({
              operation: "getPullRequestListItem",
              detail: "GraphQL: Could not resolve to a PullRequest with the number of 99.",
              reason: "other",
            }),
          );
        }),
    };

    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [project],
              repositories: new Map([[project.id, "acme/shared"]]),
              github,
              pins: makePins([{ projectId: project.id, repositoryKey: "acme/shared", number: 99 }]),
            }),
          );
          return [
            yield* service.list({ state: "open", involvement: "authored" }),
            yield* service.list({ state: "open", involvement: "authored" }),
          ];
        }),
      ),
    );

    expect(notFoundLookups).toBe(1);
    expect(results.flatMap((result) => result.errors)).toEqual([]);
  });

  it("deletes a pin only after exact recovery proves the pull request is missing", async () => {
    const project = makeProject("project-missing-pin", "Missing pin", "/tmp/missing-pin");
    const writes: Array<{
      projectId: ProjectId;
      repositoryKey: string;
      number: number;
      isPinned: boolean;
    }> = [];
    const base = createGitHubCliWithFakeGh().service;
    const github: GitHubCliShape = {
      ...base,
      listRepositoryPullRequests: () =>
        Effect.succeed(makeBatch(Array.from({ length: 51 }, (_, index) => makeItem(index + 1)))),
      getPullRequestListItem: () =>
        Effect.fail(
          new GitHubCliError({
            operation: "getPullRequestListItem",
            detail: "GraphQL: Could not resolve to a PullRequest with the number of 99.",
            reason: "other",
          }),
        ),
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [project],
              repositories: new Map([[project.id, "acme/shared"]]),
              github,
              pins: makePins(
                [{ projectId: project.id, repositoryKey: "acme/shared", number: 99 }],
                (input) => writes.push(input),
              ),
            }),
          );
          yield* service.list({ state: "open", involvement: "authored" });
        }),
      ),
    );

    expect(writes).toEqual([
      { projectId: project.id, repositoryKey: "acme/shared", number: 99, isPinned: false },
    ]);
  });

  it("does not negative-cache or hide transient recovery failures", async () => {
    const project = makeProject("project-transient", "Transient", "/tmp/project-transient");
    const base = createGitHubCliWithFakeGh().service;
    let transientLookups = 0;
    const pinWrites: Array<{ isPinned: boolean }> = [];
    const github: GitHubCliShape = {
      ...base,
      listRepositoryPullRequests: () =>
        Effect.succeed(makeBatch(Array.from({ length: 51 }, (_, index) => makeItem(index + 1)))),
      getPullRequestListItem: () =>
        Effect.suspend(() => {
          transientLookups += 1;
          return Effect.fail(
            new GitHubCliError({
              operation: "getPullRequestListItem",
              detail: "GitHub API rate limit exceeded.",
              reason: "other",
            }),
          );
        }),
    };

    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [project],
              repositories: new Map([[project.id, "acme/shared"]]),
              github,
              pins: makePins(
                [{ projectId: project.id, repositoryKey: "acme/shared", number: 99 }],
                (input) => pinWrites.push(input),
              ),
            }),
          );
          return [
            yield* service.list({ state: "open", involvement: "authored" }),
            yield* service.list({ state: "open", involvement: "authored" }),
          ];
        }),
      ),
    );

    expect(transientLookups).toBe(2);
    expect(
      results.every((result) =>
        result.errors.some((error) => error.message.includes("rate limit exceeded")),
      ),
    ).toBe(true);
    expect(pinWrites).toEqual([]);
  });

  it("surfaces review-match recovery as incomplete at GitHub's search ceiling", async () => {
    const project = makeProject("project-review-ceiling", "Review ceiling", "/tmp/review-cap");
    const base = createGitHubCliWithFakeGh().service;
    const github: GitHubCliShape = {
      ...base,
      listRepositoryPullRequests: () =>
        Effect.succeed(makeBatch(Array.from({ length: 51 }, (_, index) => makeItem(index + 1)))),
      getPullRequestListItem: ({ number }) =>
        Effect.succeed({
          ...makeItem(number),
          author: { login: "teammate", name: null, avatarUrl: null, url: null },
        }),
      listReviewRequestedPullRequestNumbers: () =>
        Effect.succeed(Array.from({ length: 1_000 }, (_, index) => index + 1_000)),
    };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [project],
              repositories: new Map([[project.id, "acme/shared"]]),
              github,
              pins: makePins([{ projectId: project.id, repositoryKey: "acme/shared", number: 99 }]),
            }),
          );
          return yield* service.list({ state: "open", involvement: "reviewing" });
        }),
      ),
    );

    expect(result.errors.some((error) => error.message.includes("1,000-item limit"))).toBe(true);
  });

  it("invalidates list caches for the mutated repository only", async () => {
    const projectA = makeProject("project-action-a", "Action A", "/tmp/action-a");
    const projectB = makeProject("project-action-b", "Action B", "/tmp/action-b");
    const base = createGitHubCliWithFakeGh().service;
    const listCalls = new Map<string, number>();
    const github: GitHubCliShape = {
      ...base,
      listRepositoryPullRequests: ({ repository }) =>
        Effect.sync(() => {
          listCalls.set(repository, (listCalls.get(repository) ?? 0) + 1);
          return makeBatch([makeItem(1, repository)]);
        }),
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [projectA, projectB],
              repositories: new Map([
                [projectA.id, "acme/one"],
                [projectB.id, "acme/two"],
              ]),
              github,
            }),
          );
          const listInput = { state: "open" as const, involvement: "authored" as const };
          yield* service.list(listInput);
          yield* service.list(listInput);
          yield* service.action({
            projectId: projectA.id,
            repository: "acme/one",
            number: 1,
            action: "close",
          });
          yield* service.list(listInput);
        }),
      ),
    );

    expect(listCalls.get("acme/one")).toBe(2);
    expect(listCalls.get("acme/two")).toBe(1);
  });

  it("invalidates repository caches when an in-flight action is interrupted", async () => {
    const project = makeProject("project-action-cancel", "Cancelled", "/tmp/action-cancel");
    let listCalls = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const actionStarted = yield* Deferred.make<void>();
          const base = createGitHubCliWithFakeGh().service;
          const github: GitHubCliShape = {
            ...base,
            listRepositoryPullRequests: () =>
              Effect.sync(() => {
                listCalls += 1;
                return makeBatch([makeItem(1, "acme/cancelled")]);
              }),
            runPullRequestAction: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(actionStarted, undefined);
                return yield* Effect.never;
              }),
          };
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [project],
              repositories: new Map([[project.id, "acme/cancelled"]]),
              github,
            }),
          );
          const listInput = { state: "open" as const, involvement: "authored" as const };
          yield* service.list(listInput);
          const actionFiber = yield* service
            .action({
              projectId: project.id,
              repository: "acme/cancelled",
              number: 1,
              action: "close",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(actionStarted);
          yield* Fiber.interrupt(actionFiber);
          yield* service.list(listInput);
        }),
      ),
    );

    expect(listCalls).toBe(2);
  });

  it("invalidates list and recovered-item caches when a comment is interrupted", async () => {
    const project = makeProject("project-comment-cancel", "Comment", "/tmp/comment-cancel");
    let listCalls = 0;
    let itemLookups = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const commentStarted = yield* Deferred.make<void>();
          const base = createGitHubCliWithFakeGh().service;
          const github: GitHubCliShape = {
            ...base,
            listRepositoryPullRequests: () =>
              Effect.sync(() => {
                listCalls += 1;
                return makeBatch(Array.from({ length: 51 }, (_, index) => makeItem(index + 1)));
              }),
            getPullRequestListItem: ({ number }) =>
              Effect.sync(() => {
                itemLookups += 1;
                return makeItem(number);
              }),
            commentOnPullRequest: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(commentStarted, undefined);
                return yield* Effect.never;
              }),
          };
          const service = yield* makePullRequestService(
            makeDependencies({
              projects: [project],
              repositories: new Map([[project.id, "acme/shared"]]),
              github,
              pins: makePins([{ projectId: project.id, repositoryKey: "acme/shared", number: 99 }]),
            }),
          );
          const listInput = { state: "open" as const, involvement: "authored" as const };
          yield* service.list(listInput);
          const commentFiber = yield* service
            .comment({
              projectId: project.id,
              repository: "acme/shared",
              number: 99,
              body: "Looks good",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(commentStarted);
          yield* Fiber.interrupt(commentFiber);
          yield* service.list(listInput);
        }),
      ),
    );

    expect(listCalls).toBe(2);
    expect(itemLookups).toBe(2);
  });
});

describe("isDefinitivePullRequestNotFound", () => {
  it("does not classify generic, permission, transport, or global failures as missing PRs", () => {
    for (const detail of [
      "HTTP 404: Not Found",
      "request timed out",
      "GitHub API rate limit exceeded",
      "GraphQL: Resource not accessible by integration",
    ]) {
      expect(
        isDefinitivePullRequestNotFound(
          new GitHubCliError({ operation: "getPullRequestListItem", detail, reason: "other" }),
        ),
      ).toBe(false);
    }
    expect(
      isDefinitivePullRequestNotFound(
        new GitHubCliError({
          operation: "getPullRequestListItem",
          detail: "Could not resolve to a PullRequest because authentication expired.",
          reason: "not-authenticated",
        }),
      ),
    ).toBe(false);
  });
});
