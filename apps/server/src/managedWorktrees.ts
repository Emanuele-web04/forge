import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ServerManagedWorktree } from "@synara/contracts";
import { Effect } from "effect";

import type { GitCoreShape } from "./git/Services/GitCore.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";

const MANAGED_WORKTREE_SCAN_DEPTH = 6;
export const MANAGED_WORKTREE_RETENTION_COUNT = 15;

/**
 * The only thread state managed-worktree retention reads. Structural on purpose so
 * both the narrow projection row and a full `OrchestrationThread` satisfy it, and so
 * the prune path never pulls a whole read model into memory just to look at four
 * columns.
 */
export interface ManagedWorktreeThreadRef {
  readonly id: string;
  // Widened with `| undefined` so both the narrow reader's normalized rows and a
  // full `OrchestrationThread` (whose optional columns are `?: T | null` under
  // `exactOptionalPropertyTypes`) structurally satisfy this ref.
  readonly archivedAt?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly associatedWorktreePath?: string | null | undefined;
}

async function findLinkedWorktreeRoots(root: string, current = root, depth = 0): Promise<string[]> {
  if (depth > MANAGED_WORKTREE_SCAN_DEPTH) return [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  if (entries.some((entry) => entry.name === ".git" && entry.isFile())) {
    return [await fs.realpath(current)];
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => findLinkedWorktreeRoots(root, path.join(current, entry.name), depth + 1)),
  );
  return nested.flat();
}

function parsePrimaryWorktreePath(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      const value = line.slice("worktree ".length).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

export function listManagedWorktrees(input: {
  readonly worktreesDir: string;
  readonly git: GitCoreShape;
}): Effect.Effect<ReadonlyArray<ServerManagedWorktree>, Error> {
  return Effect.tryPromise({
    try: () => findLinkedWorktreeRoots(input.worktreesDir),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.flatMap((worktreePaths) =>
      Effect.forEach(
        worktreePaths,
        (worktreePath) =>
          input.git
            .execute({
              operation: "ManagedWorktrees.list",
              cwd: worktreePath,
              args: ["worktree", "list", "--porcelain"],
              timeoutMs: 5_000,
            })
            .pipe(
              Effect.flatMap((result) => {
                const workspaceRoot = parsePrimaryWorktreePath(result.stdout);
                return workspaceRoot
                  ? Effect.succeed({ path: worktreePath, workspaceRoot })
                  : Effect.fail(
                      new Error(`Git did not report a primary worktree for ${worktreePath}.`),
                    );
              }),
              Effect.catch((error) =>
                Effect.logWarning("managed worktree inventory skipped an invalid entry", {
                  worktreePath,
                  error: error instanceof Error ? error.message : String(error),
                }).pipe(Effect.as(null)),
              ),
            ),
        { concurrency: 4 },
      ),
    ),
    Effect.map((entries) =>
      entries
        .filter((entry): entry is ServerManagedWorktree => entry !== null)
        .sort((left, right) => left.path.localeCompare(right.path)),
    ),
  );
}

function threadManagedWorktreePath(thread: ManagedWorktreeThreadRef): string | null {
  return thread.associatedWorktreePath ?? thread.worktreePath ?? null;
}

// The scanned inventory is realpath-canonical, while recorded thread paths may
// reach the same directory through symlinks (e.g. /var -> /private/var).
// Canonicalize the thread side too, or retention silently never matches
// anything on symlinked layouts. Missing paths fall back to plain resolution.
function canonicalizeThreadWorktreePaths(
  threads: ReadonlyArray<ManagedWorktreeThreadRef>,
): Effect.Effect<ReadonlyMap<string, string>, Error> {
  return Effect.tryPromise({
    try: async () => {
      const canonicalByRecordedPath = new Map<string, string>();
      for (const thread of threads) {
        const recordedPath = threadManagedWorktreePath(thread);
        if (recordedPath === null || canonicalByRecordedPath.has(recordedPath)) continue;
        canonicalByRecordedPath.set(
          recordedPath,
          await fs.realpath(recordedPath).catch(() => path.resolve(recordedPath)),
        );
      }
      return canonicalByRecordedPath;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

/** Keep active worktrees and the 15 most recently archived managed worktrees. */
export function pruneArchivedManagedWorktrees(input: {
  readonly worktreesDir: string;
  readonly snapshotsDir: string;
  readonly threads: ReadonlyArray<ManagedWorktreeThreadRef>;
  readonly git: GitCoreShape;
}): Effect.Effect<ReadonlyArray<ServerManagedWorktree>, Error> {
  return Effect.gen(function* () {
    const inventory = yield* listManagedWorktrees(input);
    const canonicalByRecordedPath = yield* canonicalizeThreadWorktreePaths(input.threads);
    const canonicalThreadPath = (thread: ManagedWorktreeThreadRef): string | null => {
      const recordedPath = threadManagedWorktreePath(thread);
      return recordedPath === null ? null : (canonicalByRecordedPath.get(recordedPath) ?? null);
    };
    const inventoryByPath = new Map(inventory.map((entry) => [entry.path, entry]));
    const activePaths = new Set(
      input.threads
        .filter((thread) => (thread.archivedAt ?? null) === null)
        .map(canonicalThreadPath)
        .filter((value): value is string => value !== null),
    );
    const seenArchivedPaths = new Set<string>();
    const archived = input.threads
      .filter((thread) => (thread.archivedAt ?? null) !== null)
      .map((thread) => {
        const worktreePath = canonicalThreadPath(thread);
        return worktreePath
          ? { thread, entry: inventoryByPath.get(worktreePath) ?? null }
          : { thread, entry: null };
      })
      .filter(
        (value): value is { thread: ManagedWorktreeThreadRef; entry: ServerManagedWorktree } =>
          value.entry !== null && !activePaths.has(value.entry.path),
      )
      .sort((left, right) =>
        (right.thread.archivedAt ?? "").localeCompare(left.thread.archivedAt ?? ""),
      )
      .filter(({ entry }) => {
        if (seenArchivedPaths.has(entry.path)) return false;
        seenArchivedPaths.add(entry.path);
        return true;
      });
    const removalCandidates = archived.slice(MANAGED_WORKTREE_RETENTION_COUNT);
    if (removalCandidates.length === 0) return inventory;

    yield* Effect.tryPromise({
      try: () => fs.mkdir(input.snapshotsDir, { recursive: true, mode: 0o700 }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    const removedPaths = new Set<string>();
    yield* Effect.forEach(
      removalCandidates,
      ({ thread, entry }) => {
        const digest = createHash("sha256").update(entry.path).digest("hex").slice(0, 12);
        const threadPathSegment = String(thread.id)
          .replace(/[^a-z0-9._-]+/giu, "-")
          .replace(/^-+|-+$/gu, "")
          .slice(0, 80);
        const snapshotPath = path.join(
          input.snapshotsDir,
          `${threadPathSegment || "thread"}-${digest}`,
        );
        return input.git
          .withMutation(
            entry.workspaceRoot,
            Effect.tryPromise({
              try: () =>
                fs
                  .stat(path.join(snapshotPath, "snapshot.json"))
                  .then((entry) => entry.isFile())
                  .catch((cause: unknown) => {
                    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
                    throw cause;
                  }),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }).pipe(
              Effect.flatMap((snapshotExists) =>
                snapshotExists
                  ? Effect.void
                  : input.git.snapshotWorktree({ cwd: entry.path, outputPath: snapshotPath }),
              ),
              Effect.flatMap(() =>
                input.git.removeWorktree({
                  cwd: entry.workspaceRoot,
                  path: entry.path,
                  force: true,
                  reclaimTemporaryBranch: true,
                }),
              ),
              Effect.tap(() => Effect.sync(() => removedPaths.add(entry.path))),
            ),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("managed worktree retention skipped an unsafe cleanup", {
                threadId: thread.id,
                worktreePath: entry.path,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          );
      },
      { discard: true, concurrency: 1 },
    );
    return inventory.filter((entry) => !removedPaths.has(entry.path));
  });
}

export function pruneProjectedArchivedManagedWorktrees(input: {
  readonly homeDir: string;
  readonly worktreesDir: string;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly git: GitCoreShape;
}): Effect.Effect<ReadonlyArray<ServerManagedWorktree>, Error> {
  return Effect.gen(function* () {
    // Deliberately not the shell snapshot: it hides soft-deleted threads, and a
    // retention-deleted thread still owns a worktree that must be reclaimed.
    const threads = yield* input.snapshotQuery.listManagedWorktreeThreads();
    return yield* pruneArchivedManagedWorktrees({
      worktreesDir: input.worktreesDir,
      snapshotsDir: path.join(input.homeDir, "worktree-snapshots"),
      threads,
      git: input.git,
    });
  });
}
