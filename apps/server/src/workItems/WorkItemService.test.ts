import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { createGitHubCliWithFakeGh } from "../git/testing/fakeGitHubCli";
import { GitHubCli } from "../git/Services/GitHubCli";
import { ServerSettingsService } from "../serverSettings";
import { WorkItemServiceLive } from "./Layers/WorkItemService";
import { WorkItemService } from "./Services/WorkItemService";

describe("WorkItemService", () => {
  it.effect("lists GitHub issues from gh", () =>
    Effect.gen(function* () {
      const { service: github } = createGitHubCliWithFakeGh({
        repositoryIssues: [
          {
            number: 12,
            title: "Broken login",
            url: "https://github.com/acme/app/issues/12",
            body: "Cannot sign in",
            state: "OPEN",
            updatedAt: "2026-07-01T00:00:00Z",
          },
        ],
      });

      const layer = WorkItemServiceLive.pipe(
        Layer.provide(Layer.succeed(GitHubCli, github)),
        Layer.provide(ServerSettingsService.layerTest({})),
      );

      const result = yield* Effect.gen(function* () {
        const workItems = yield* WorkItemService;
        return yield* workItems.search({
          cwd: "/tmp/repo",
          repository: "acme/app",
          source: "github-issue",
          query: "",
          limit: 20,
        });
      }).pipe(Effect.provide(layer));

      expect(result.authStatus).toBe("ready");
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.identifier).toBe("#12");
      expect(result.items[0]?.title).toBe("Broken login");
    }),
  );

  it.effect("loads a pull request detail as a work item", () =>
    Effect.gen(function* () {
      const { service: github } = createGitHubCliWithFakeGh({
        pullRequestDetail: {
          number: 7,
          title: "Add feature",
          body: "Implements the feature",
          url: "https://github.com/acme/app/pull/7",
          author: null,
          state: "open",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeability: "mergeable",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          headBranch: "feat",
          baseBranch: "main",
          createdAt: "2026-07-01T00:00:00Z",
          updatedAt: "2026-07-01T00:00:00Z",
          mergedAt: null,
          closedAt: null,
          maintainerCanModify: true,
          reviewers: [],
          labels: [],
          checks: [],
          comments: [],
          commits: [],
        },
      });

      const layer = WorkItemServiceLive.pipe(
        Layer.provide(Layer.succeed(GitHubCli, github)),
        Layer.provide(ServerSettingsService.layerTest({})),
      );

      const result = yield* Effect.gen(function* () {
        const workItems = yield* WorkItemService;
        return yield* workItems.get({
          cwd: "/tmp/repo",
          repository: "acme/app",
          source: "github-pr",
          reference: "7",
        });
      }).pipe(Effect.provide(layer));

      expect(result.item?.source).toBe("github-pr");
      expect(result.item?.identifier).toBe("#7");
      expect(result.item?.body).toContain("Implements the feature");
    }),
  );

  it.effect("reports missing Linear API key", () =>
    Effect.gen(function* () {
      const { service: github } = createGitHubCliWithFakeGh();
      const layer = WorkItemServiceLive.pipe(
        Layer.provide(Layer.succeed(GitHubCli, github)),
        Layer.provide(ServerSettingsService.layerTest({ integrations: { linearApiKey: "" } })),
      );

      const result = yield* Effect.gen(function* () {
        const workItems = yield* WorkItemService;
        return yield* workItems.search({
          cwd: "/tmp/repo",
          repository: null,
          source: "linear-issue",
          query: "login",
          limit: 10,
        });
      }).pipe(Effect.provide(layer));

      expect(result.authStatus).toBe("linear-key-missing");
      expect(result.items).toHaveLength(0);
    }),
  );
});
