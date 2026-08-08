import type { GitStatusResult, GitStatusStreamEvent } from "@synara/contracts";
import { Deferred, Effect, Layer, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitManagerServiceError } from "../Errors";
import { GitCore, type GitCoreShape, type GitStatusDetails } from "../Services/GitCore";
import { GitManager, type GitManagerShape } from "../Services/GitManager";
import { GitStatusBroadcaster } from "../Services/GitStatusBroadcaster";
import { GIT_STATUS_CACHE_MAX_ENTRIES } from "../gitStatusCache";
import { GitStatusBroadcasterLive } from "./GitStatusBroadcaster";

const baseStatus: GitStatusResult = {
  branch: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  upstreamBranch: "feature/status-broadcast",
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const baseDetails: GitStatusDetails = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: baseStatus.branch,
  upstreamRef: "origin/feature/status-broadcast",
  upstreamBranch: baseStatus.upstreamBranch,
  hasWorkingTreeChanges: baseStatus.hasWorkingTreeChanges,
  workingTree: baseStatus.workingTree,
  hasUpstream: baseStatus.hasUpstream,
  aheadCount: baseStatus.aheadCount,
  behindCount: baseStatus.behindCount,
};

function makeTestLayer(state: {
  currentDetails: GitStatusDetails;
  currentStatus: GitStatusResult;
  detailsCalls: number;
  statusCalls: number;
}) {
  const gitCore = {
    statusDetails: () =>
      Effect.sync(() => {
        state.detailsCalls += 1;
        return state.currentDetails;
      }),
  } as unknown as GitCoreShape;
  const gitManager: GitManagerShape = {
    status: () =>
      Effect.sync(() => {
        state.statusCalls += 1;
        return state.currentStatus;
      }),
    pullRequestForBranch: () =>
      Effect.die("pullRequestForBranch should not be called in this test"),
    readWorkingTreeDiff: () => Effect.die("readWorkingTreeDiff should not be called in this test"),
    readWorkingTreeDiffStats: () =>
      Effect.die("readWorkingTreeDiffStats should not be called in this test"),
    summarizeDiff: () => Effect.die("summarizeDiff should not be called in this test"),
    resolvePullRequest: () => Effect.die("resolvePullRequest should not be called in this test"),
    pullRequestSnapshot: () => Effect.die("pullRequestSnapshot should not be called in this test"),
    preparePullRequestThread: () =>
      Effect.die("preparePullRequestThread should not be called in this test"),
    handoffThread: () => Effect.die("handoffThread should not be called in this test"),
    runStackedAction: () => Effect.die("runStackedAction should not be called in this test"),
  };

  return GitStatusBroadcasterLive.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(GitCore, gitCore), Layer.succeed(GitManager, gitManager)),
    ),
  );
}

const runBroadcasterTest = (
  state: {
    currentDetails: GitStatusDetails;
    currentStatus: GitStatusResult;
    detailsCalls: number;
    statusCalls: number;
  },
  effect: Effect.Effect<void, GitManagerServiceError, GitStatusBroadcaster | Scope.Scope>,
) => effect.pipe(Effect.provide(makeTestLayer(state)), Effect.scoped, Effect.runPromise);

afterEach(() => {
  vi.useRealTimers();
});

describe("GitStatusBroadcasterLive", () => {
  it("refreshes local git status on repeated reads without repeating PR lookup", async () => {
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;

        const first = yield* broadcaster.getStatus({ cwd: "/repo" });
        state.currentDetails = {
          ...baseDetails,
          hasWorkingTreeChanges: true,
          workingTree: {
            files: [{ path: "src/app.ts", insertions: 5, deletions: 1 }],
            insertions: 5,
            deletions: 1,
          },
        };
        const second = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(first).toEqual(baseStatus);
        expect(second).toEqual({
          ...baseStatus,
          hasWorkingTreeChanges: true,
          workingTree: state.currentDetails.workingTree,
        });
        expect(state.statusCalls).toBe(1);
        expect(state.detailsCalls).toBe(1);
      }),
    );
  });

  it("refreshes the configured PR base while reusing cached remote metadata", async () => {
    const initialStatus = {
      ...baseStatus,
      configuredPrBaseBranch: "main",
    };
    const state = {
      currentDetails: {
        ...baseDetails,
        configuredPrBaseBranch: "main",
      },
      currentStatus: initialStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;

        const first = yield* broadcaster.getStatus({ cwd: "/repo" });
        state.currentDetails = {
          ...baseDetails,
          configuredPrBaseBranch: "release",
        };
        const second = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(first.configuredPrBaseBranch).toBe("main");
        expect(second.configuredPrBaseBranch).toBe("release");
        expect(state.statusCalls).toBe(1);
        expect(state.detailsCalls).toBe(1);
      }),
    );
  });

  it("refreshes full status when cached remote metadata expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;

        const first = yield* broadcaster.getStatus({ cwd: "/repo" });
        vi.setSystemTime(31_000);
        state.currentStatus = {
          ...baseStatus,
          pr: {
            number: 42,
            title: "Open PR",
            url: "https://github.com/acme/repo/pull/42",
            state: "open",
            baseBranch: "main",
            headBranch: "feature/status-refresh",
            isDraft: false,
            mergeability: "unknown",
            additions: null,
            deletions: null,
            changedFiles: null,
          },
        };
        const second = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(first.pr).toBeNull();
        expect(second.pr?.number).toBe(42);
        expect(state.statusCalls).toBe(2);
        // Expired remote metadata can never be reused, so the details probe is
        // skipped instead of being fetched and thrown away by the full reload.
        expect(state.detailsCalls).toBe(0);
      }),
    );
  });

  it("does not extend the remote metadata TTL when reusing cached remote status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;

        yield* broadcaster.getStatus({ cwd: "/repo" });
        vi.setSystemTime(20_000);
        yield* broadcaster.getStatus({ cwd: "/repo" });

        vi.setSystemTime(31_000);
        state.currentStatus = {
          ...baseStatus,
          pr: {
            number: 43,
            title: "Fresh PR",
            url: "https://github.com/acme/repo/pull/43",
            state: "open",
            baseBranch: "main",
            headBranch: "feature/status-refresh",
            isDraft: false,
            mergeability: "unknown",
            additions: null,
            deletions: null,
            changedFiles: null,
          },
        };
        const third = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(third.pr?.number).toBe(43);
        expect(state.statusCalls).toBe(2);
        expect(state.detailsCalls).toBe(1);
      }),
    );
  });

  it("refreshes the cached snapshot after explicit invalidation", async () => {
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;
        const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

        state.currentStatus = {
          ...baseStatus,
          branch: "feature/updated-status",
          aheadCount: 2,
        };
        state.currentDetails = {
          ...baseDetails,
          branch: "feature/updated-status",
          aheadCount: 2,
        };
        const refreshed = yield* broadcaster.refreshStatus("/repo");
        const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(initial).toEqual(baseStatus);
        expect(refreshed).toEqual(state.currentStatus);
        expect(cached).toEqual(state.currentStatus);
        expect(state.statusCalls).toBe(2);
        expect(state.detailsCalls).toBe(1);
      }),
    );
  });

  it("reads git status once per poll when the cache has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;

        // The sidebar polls on a 60s timer against a 30s remote TTL, so every poll
        // after the first misses the cache. Each miss must cost exactly one status
        // read, not a discarded details probe plus a full reload.
        yield* broadcaster.getStatus({ cwd: "/repo" });
        vi.setSystemTime(60_000);
        yield* broadcaster.getStatus({ cwd: "/repo" });
        vi.setSystemTime(120_000);
        yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(state.statusCalls).toBe(3);
        expect(state.detailsCalls).toBe(0);
      }),
    );
  });

  it("evicts the coldest working directory once the cache is full", async () => {
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;

        // Every thread worktree is a distinct cwd, so an unbounded cache would pin
        // status details for every directory the server ever saw.
        for (let index = 0; index <= GIT_STATUS_CACHE_MAX_ENTRIES; index += 1) {
          yield* broadcaster.getStatus({ cwd: `/worktrees/repo-${index}` });
        }
        expect(state.statusCalls).toBe(GIT_STATUS_CACHE_MAX_ENTRIES + 1);

        // The most recent directories are still cached (details reuse, no reload).
        yield* broadcaster.getStatus({
          cwd: `/worktrees/repo-${GIT_STATUS_CACHE_MAX_ENTRIES}`,
        });
        expect(state.statusCalls).toBe(GIT_STATUS_CACHE_MAX_ENTRIES + 1);
        expect(state.detailsCalls).toBe(1);

        // The coldest one was evicted, so it reloads from git.
        yield* broadcaster.getStatus({ cwd: "/worktrees/repo-0" });
        expect(state.statusCalls).toBe(GIT_STATUS_CACHE_MAX_ENTRIES + 2);
      }),
    );
  });

  it("streams a status snapshot first and later refresh updates", async () => {
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;
        const snapshotDeferred = yield* Deferred.make<GitStatusStreamEvent>();
        const localUpdatedDeferred = yield* Deferred.make<GitStatusStreamEvent>();

        yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "localUpdated") {
            return Deferred.succeed(localUpdatedDeferred, event).pipe(Effect.ignore);
          }
          return Effect.void;
        }).pipe(Effect.forkScoped);

        const snapshot = yield* Deferred.await(snapshotDeferred);
        state.currentStatus = {
          ...baseStatus,
          branch: "feature/local-refresh",
        };
        yield* broadcaster.refreshStatus("/repo");
        const localUpdated = yield* Deferred.await(localUpdatedDeferred);

        expect(snapshot).toEqual({
          _tag: "snapshot",
          local: {
            branch: baseStatus.branch,
            hasWorkingTreeChanges: baseStatus.hasWorkingTreeChanges,
            workingTree: baseStatus.workingTree,
          },
          remote: {
            hasUpstream: baseStatus.hasUpstream,
            upstreamBranch: baseStatus.upstreamBranch,
            aheadCount: baseStatus.aheadCount,
            behindCount: baseStatus.behindCount,
            pr: baseStatus.pr,
          },
        });
        expect(localUpdated).toEqual({
          _tag: "localUpdated",
          local: {
            branch: "feature/local-refresh",
            hasWorkingTreeChanges: false,
            workingTree: baseStatus.workingTree,
          },
        });
      }),
    );
  });
});
