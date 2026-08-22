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
 * the prune path never pulls a whole read model into memory just to look at five
 * columns.
 */
export interface ManagedWorktreeThreadRef {
  readonly id: string;
  // Widened with `| undefined` so both the narrow reader's normalized rows and a
  // full `OrchestrationThread` (whose optional columns are `?: T | null` under
  // `exactOptionalPropertyTypes`) structurally satisfy this ref.
  readonly archivedAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly associatedWorktreePath?: string | null | undefined;
}

export type ManagedWorktreeRemovalReason = "deleted" | "archived-retention";

export interface ManagedWorktreeRemovalCandidate {
  readonly entry: ServerManagedWorktree;
  readonly thread: ManagedWorktreeThreadRef;
  readonly reason: ManagedWorktreeRemovalReason;
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

function isActiveManagedWorktreeThread(thread: ManagedWorktreeThreadRef): boolean {
  return (thread.deletedAt ?? null) === null && (thread.archivedAt ?? null) === null;
}

function isDeletedManagedWorktreeThread(thread: ManagedWorktreeThreadRef): boolean {
  return (thread.deletedAt ?? null) !== null;
}

function isArchivedOnlyManagedWorktreeThread(thread: ManagedWorktreeThreadRef): boolean {
  return !isDeletedManagedWorktreeThread(thread) && (thread.archivedAt ?? null) !== null;
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

function snapshotOutputPath(input: {
  readonly snapshotsDir: string;
  readonly threadId: string;
  readonly worktreePath: string;
}): string {
  const digest = createHash("sha256").update(input.worktreePath).digest("hex").slice(0, 12);
  const threadPathSegment = input.threadId
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return path.join(input.snapshotsDir, `${threadPathSegment || "thread"}-${digest}`);
}

/**
 * Classify inventory entries into immediate reclaim vs retained archived keepers.
 * Active owners are never reclaim candidates. Deleted paths bypass the archived
 * retention window; only non-deleted archived worktrees honor it. Unowned inventory
 * is deliberately preserved: a newly-created worktree exists briefly before its
 * thread association is projected, and standalone worktrees are valid user data.
 */
export function classifyManagedWorktreeRemovalCandidates(input: {
  readonly inventory: ReadonlyArray<ServerManagedWorktree>;
  readonly threads: ReadonlyArray<ManagedWorktreeThreadRef>;
  readonly canonicalByRecordedPath: ReadonlyMap<string, string>;
}): ReadonlyArray<ManagedWorktreeRemovalCandidate> {
  const canonicalThreadPath = (thread: ManagedWorktreeThreadRef): string | null => {
    const recordedPath = threadManagedWorktreePath(thread);
    return recordedPath === null ? null : (input.canonicalByRecordedPath.get(recordedPath) ?? null);
  };
  const inventoryByPath = new Map(input.inventory.map((entry) => [entry.path, entry]));

  const activePaths = new Set<string>();
  for (const thread of input.threads) {
    if (!isActiveManagedWorktreeThread(thread)) continue;
    const worktreePath = canonicalThreadPath(thread);
    if (worktreePath !== null) activePaths.add(worktreePath);
  }

  const deletedCandidates: ManagedWorktreeRemovalCandidate[] = [];
  const seenDeletedPaths = new Set<string>();
  for (const thread of input.threads) {
    if (!isDeletedManagedWorktreeThread(thread)) continue;
    const worktreePath = canonicalThreadPath(thread);
    if (
      worktreePath === null ||
      activePaths.has(worktreePath) ||
      seenDeletedPaths.has(worktreePath)
    ) {
      continue;
    }
    const entry = inventoryByPath.get(worktreePath);
    if (!entry) continue;
    seenDeletedPaths.add(worktreePath);
    deletedCandidates.push({ entry, thread, reason: "deleted" });
  }

  const seenArchivedPaths = new Set<string>();
  const archivedKeepers = input.threads
    .filter(isArchivedOnlyManagedWorktreeThread)
    .map((thread) => {
      const worktreePath = canonicalThreadPath(thread);
      return worktreePath
        ? { thread, entry: inventoryByPath.get(worktreePath) ?? null }
        : { thread, entry: null };
    })
    .filter(
      (value): value is { thread: ManagedWorktreeThreadRef; entry: ServerManagedWorktree } =>
        value.entry !== null &&
        !activePaths.has(value.entry.path) &&
        !seenDeletedPaths.has(value.entry.path),
    )
    .sort((left, right) =>
      (right.thread.archivedAt ?? "").localeCompare(left.thread.archivedAt ?? ""),
    )
    .filter(({ entry }) => {
      if (seenArchivedPaths.has(entry.path)) return false;
      seenArchivedPaths.add(entry.path);
      return true;
    });

  const archivedRetentionCandidates = archivedKeepers.slice(MANAGED_WORKTREE_RETENTION_COUNT).map(
    ({ thread, entry }): ManagedWorktreeRemovalCandidate => ({
      entry,
      thread,
      reason: "archived-retention",
    }),
  );

  return [...deletedCandidates, ...archivedRetentionCandidates];
}

const ensureSnapshotsDir = (snapshotsDir: string) =>
  Effect.tryPromise({
    try: () => fs.mkdir(snapshotsDir, { recursive: true, mode: 0o700 }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const snapshotExists = (snapshotPath: string) =>
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
  });

function removeManagedWorktreeSafely(input: {
  readonly snapshotsDir: string;
  readonly candidate: ManagedWorktreeRemovalCandidate;
  readonly git: GitCoreShape;
}): Effect.Effect<boolean, Error> {
  const { entry, thread, reason } = input.candidate;
  const snapshotPath = snapshotOutputPath({
    snapshotsDir: input.snapshotsDir,
    threadId: thread.id,
    worktreePath: entry.path,
  });

  return input.git
    .withMutation(
      entry.workspaceRoot,
      Effect.gen(function* () {
        const alreadySnapshotted = yield* snapshotExists(snapshotPath);
        if (!alreadySnapshotted) {
          yield* input.git.snapshotWorktree({ cwd: entry.path, outputPath: snapshotPath });
        }

        const status = yield* input.git.statusDetails(entry.path).pipe(
          Effect.catch((error) =>
            Effect.logWarning("managed worktree cleanup could not read dirty state", {
              threadId: thread.id,
              worktreePath: entry.path,
              reason,
              error: error instanceof Error ? error.message : String(error),
            }).pipe(Effect.as(null)),
          ),
        );
        if (status?.hasWorkingTreeChanges) {
          yield* Effect.logWarning(
            "managed worktree cleanup skipped dirty worktree; refusing silent data loss",
            {
              threadId: thread.id,
              worktreePath: entry.path,
              reason,
              branch: status.branch,
            },
          );
          return false;
        }

        yield* input.git.removeWorktree({
          cwd: entry.workspaceRoot,
          path: entry.path,
          force: false,
          reclaimTemporaryBranch: true,
        });
        return true;
      }),
    )
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("managed worktree retention skipped an unsafe cleanup", {
          threadId: thread.id,
          worktreePath: entry.path,
          reason,
          error: error instanceof Error ? error.message : String(error),
        }).pipe(Effect.as(false)),
      ),
    );
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
    const removalCandidates = classifyManagedWorktreeRemovalCandidates({
      inventory,
      threads: input.threads,
      canonicalByRecordedPath,
    });
    if (removalCandidates.length === 0) return inventory;

    yield* ensureSnapshotsDir(input.snapshotsDir);
    const removedPaths = new Set<string>();
    yield* Effect.forEach(
      removalCandidates,
      (candidate) =>
        removeManagedWorktreeSafely({
          snapshotsDir: input.snapshotsDir,
          candidate,
          git: input.git,
        }).pipe(
          Effect.tap((removed) =>
            removed ? Effect.sync(() => removedPaths.add(candidate.entry.path)) : Effect.void,
          ),
        ),
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
