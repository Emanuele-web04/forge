import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { OrchestrationThread } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { GitCoreShape } from "./git/Services/GitCore.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  classifyManagedWorktreeRemovalCandidates,
  listManagedWorktrees,
  MANAGED_WORKTREE_RETENTION_COUNT,
  pruneArchivedManagedWorktrees,
  pruneProjectedArchivedManagedWorktrees,
} from "./managedWorktrees.ts";

const temporaryRoots: string[] = [];

async function makeManagedRoot(count: number) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "synara-managed-worktrees-"));
  temporaryRoots.push(root);
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const worktreePath = path.join(root, `task-${index}`, "synara");
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(path.join(worktreePath, ".git"), "gitdir: /tmp/repo/.git/worktrees/test\n");
    paths.push(await fs.realpath(worktreePath));
  }
  return { root, paths };
}

function cleanStatusDetails() {
  return Effect.succeed({
    isRepo: true,
    hasOriginRemote: false,
    isDefaultBranch: false,
    upstreamRef: null,
    branch: "synara/test",
    hasWorkingTreeChanges: false,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
  });
}

function dirtyStatusDetails() {
  return Effect.succeed({
    isRepo: true,
    hasOriginRemote: false,
    isDefaultBranch: false,
    upstreamRef: null,
    branch: "synara/test",
    hasWorkingTreeChanges: true,
    stagedCount: 0,
    unstagedCount: 1,
    untrackedCount: 0,
  });
}

function makeGit(input: {
  readonly removals: string[];
  readonly snapshots?: string[];
  readonly dirtyPaths?: ReadonlySet<string>;
}) {
  return {
    execute: ({ cwd }: { cwd: string }) =>
      Effect.succeed({
        code: 0,
        stdout: `worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n\nworktree ${cwd}\nHEAD abc\ndetached\n`,
        stderr: "",
      }),
    withMutation: (_cwd: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
    snapshotWorktree: ({ outputPath }: { outputPath: string }) =>
      Effect.sync(() => {
        input.snapshots?.push(outputPath);
      }),
    statusDetails: (cwd: string) =>
      input.dirtyPaths?.has(cwd) ? dirtyStatusDetails() : cleanStatusDetails(),
    removeWorktree: ({ path: worktreePath }: { path: string }) =>
      Effect.sync(() => input.removals.push(worktreePath)),
  } as unknown as GitCoreShape;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("managed worktrees", () => {
  it("discovers linked worktrees and reports their primary checkout", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const git = {
      execute: ({ cwd }: { cwd: string }) =>
        Effect.succeed({
          code: 0,
          stdout: `worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n\nworktree ${cwd}\nHEAD abc\ndetached\n`,
          stderr: "",
        }),
    } as unknown as GitCoreShape;

    await expect(
      Effect.runPromise(listManagedWorktrees({ worktreesDir: root, git })),
    ).resolves.toEqual(
      paths.map((worktreePath) => ({ path: worktreePath, workspaceRoot: "/repo/project" })),
    );
  });

  it("snapshots and removes only archived worktrees beyond the retention limit", async () => {
    const count = MANAGED_WORKTREE_RETENTION_COUNT + 1;
    const { root, paths } = await makeManagedRoot(count);
    const snapshots: string[] = [];
    const removals: string[] = [];
    const git = makeGit({ removals, snapshots });
    const threads = paths.map(
      (worktreePath, index) =>
        ({
          id: `thread-${index}`,
          worktreePath,
          associatedWorktreePath: worktreePath,
          archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          deletedAt: null,
        }) as unknown as OrchestrationThread,
    );
    const snapshotsDir = path.join(root, "snapshots");

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir,
        threads,
        git,
      }),
    );

    expect(removals).toEqual([paths[0]]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain(path.join(root, "snapshots", "thread-0-"));
    expect(remaining).toHaveLength(MANAGED_WORKTREE_RETENTION_COUNT);
  });

  it("matches threads whose recorded paths reach the worktree through a symlink", async () => {
    const count = MANAGED_WORKTREE_RETENTION_COUNT + 1;
    const { root, paths } = await makeManagedRoot(count);
    const canonicalRoot = await fs.realpath(root);
    const linkRoot = await fs.mkdtemp(path.join(tmpdir(), "synara-managed-worktrees-link-"));
    temporaryRoots.push(linkRoot);
    const symlinkedRoot = path.join(linkRoot, "worktrees");
    await fs.symlink(canonicalRoot, symlinkedRoot);
    const removals: string[] = [];
    const git = makeGit({ removals });
    // Threads recorded their worktrees through the symlinked directory, while
    // the inventory scan reports realpath-canonical entries.
    const threads = paths.map(
      (worktreePath, index) =>
        ({
          id: `thread-${index}`,
          worktreePath: path.join(symlinkedRoot, path.relative(canonicalRoot, worktreePath)),
          associatedWorktreePath: path.join(
            symlinkedRoot,
            path.relative(canonicalRoot, worktreePath),
          ),
          archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          deletedAt: null,
        }) as unknown as OrchestrationThread,
    );

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([paths[0]]);
  });

  it("still prunes worktrees owned by retention-deleted threads", async () => {
    const count = MANAGED_WORKTREE_RETENTION_COUNT + 1;
    const { root, paths } = await makeManagedRoot(count);
    const removals: string[] = [];
    const git = makeGit({ removals });

    // The oldest archived thread was soft-deleted by retention. `getShellSnapshot`
    // would hide it and silently strand its worktree on disk forever, so the prune
    // path must read a projection query that keeps soft-deleted threads visible.
    const snapshotQuery = {
      listManagedWorktreeThreads: () =>
        Effect.succeed(
          paths.map((worktreePath, index) => ({
            id: `thread-${index}`,
            archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
            deletedAt: index === 0 ? new Date(Date.UTC(2026, 0, index + 2)).toISOString() : null,
            worktreePath,
            associatedWorktreePath: worktreePath,
          })),
        ),
      getSnapshot: () => Effect.die(new Error("getSnapshot must not be used by worktree prune")),
    } as unknown as ProjectionSnapshotQueryShape;

    await Effect.runPromise(
      pruneProjectedArchivedManagedWorktrees({
        homeDir: root,
        worktreesDir: root,
        snapshotQuery,
        git,
      }),
    );

    // Deleted owners reclaim immediately (bypass archived retention). The
    // remaining archived set fits inside the keep window, so only the deleted
    // owner is removed here.
    expect(removals).toEqual([paths[0]]);
  });

  it("removes a clean soft-deleted worktree even when it was never archived", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const removals: string[] = [];
    const git = makeGit({ removals });
    const threads = [
      {
        id: "thread-active",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: null,
        deletedAt: null,
      },
      {
        id: "thread-deleted",
        worktreePath: paths[1],
        associatedWorktreePath: paths[1],
        archivedAt: null,
        deletedAt: "2026-08-01T00:00:00.000Z",
      },
    ] as unknown as OrchestrationThread[];

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([paths[1]]);
  });

  it("refuses to force-remove a dirty deleted worktree", async () => {
    const { root, paths } = await makeManagedRoot(1);
    const removals: string[] = [];
    const snapshots: string[] = [];
    const git = makeGit({
      removals,
      snapshots,
      dirtyPaths: new Set([paths[0]!]),
    });
    const threads = [
      {
        id: "thread-dirty-deleted",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: null,
        deletedAt: "2026-08-01T00:00:00.000Z",
      },
    ] as unknown as OrchestrationThread[];

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([]);
    expect(snapshots).toHaveLength(1);
    expect(remaining).toEqual([{ path: paths[0], workspaceRoot: "/repo/project" }]);
  });

  it("preserves managed worktrees with no projected thread owner", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const removals: string[] = [];
    const git = makeGit({ removals });
    const threads = [
      {
        id: "thread-active",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: null,
        deletedAt: null,
      },
    ] as unknown as OrchestrationThread[];

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([]);
  });

  it("never removes active worktrees", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const removals: string[] = [];
    const git = makeGit({ removals });
    const threads = paths.map(
      (worktreePath, index) =>
        ({
          id: `thread-${index}`,
          worktreePath,
          associatedWorktreePath: worktreePath,
          archivedAt: null,
          deletedAt: null,
        }) as unknown as OrchestrationThread,
    );

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  it("classifies deleted candidates without touching active or unowned worktrees", () => {
    const inventory = [
      { path: "/wt/active", workspaceRoot: "/repo" },
      { path: "/wt/deleted", workspaceRoot: "/repo" },
      { path: "/wt/archived-old", workspaceRoot: "/repo" },
      { path: "/wt/archived-new", workspaceRoot: "/repo" },
      { path: "/wt/orphan", workspaceRoot: "/repo" },
    ];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    // Force retention window to treat only the newest archived as kept by
    // providing MANAGED_WORKTREE_RETENTION_COUNT archived paths via the real
    // classifier against a synthetic set is awkward; assert the core buckets
    // with a small inventory instead.
    const candidates = classifyManagedWorktreeRemovalCandidates({
      inventory,
      canonicalByRecordedPath,
      threads: [
        {
          id: "active",
          worktreePath: "/wt/active",
          archivedAt: null,
          deletedAt: null,
        },
        {
          id: "deleted",
          worktreePath: "/wt/deleted",
          archivedAt: null,
          deletedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "archived-old",
          worktreePath: "/wt/archived-old",
          archivedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        },
        {
          id: "archived-new",
          worktreePath: "/wt/archived-new",
          archivedAt: "2026-02-01T00:00:00.000Z",
          deletedAt: null,
        },
      ],
    });

    expect(candidates.map((candidate) => [candidate.entry.path, candidate.reason])).toEqual([
      ["/wt/deleted", "deleted"],
    ]);
  });
});
