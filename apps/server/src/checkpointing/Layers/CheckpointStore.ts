/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements hidden Git-ref checkpoint capture/restore directly with
 * Effect-native child process execution (`effect/unstable/process`).
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { randomUUID } from "node:crypto";

import { Cause, Deferred, Effect, Exit, Layer, FileSystem, Option, Path, Semaphore } from "effect";

import { CheckpointInvariantError, type CheckpointStoreError } from "../Errors.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@synara/contracts";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

// Individual git commands are already bounded by GitCore's default timeout;
// this aggregate cap exists to unstick the shared in-flight capture slot if a
// step without its own bound (e.g. temp-dir filesystem work) hangs. It exceeds
// the worst per-command-capped chain, so it never truncates a capture the
// per-command timeouts would allow.
const CHECKPOINT_CAPTURE_TIMEOUT_MS = 180_000;

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitCore;
  const captureLock = yield* Semaphore.make(1);
  const inFlightCaptures = new Map<string, Deferred.Deferred<void, CheckpointStoreError>>();

  // Normalize the cwd so captures for the same repo reached via differently
  // written paths (trailing slash, relative segments) share one in-flight slot.
  const captureKey = (input: { readonly cwd: string; readonly checkpointRef: CheckpointRef }) =>
    `${path.resolve(input.cwd)}\0${input.checkpointRef}`;

  const resolveHeadCommit = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const hasHeadCommit = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.hasHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.code === 0));

  const resolveCheckpointCommit = (
    cwd: string,
    checkpointRef: CheckpointRef,
  ): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    git
      .execute({
        operation: "CheckpointStore.isGitRepository",
        cwd,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"),
        Effect.catch(() => Effect.succeed(false)),
      );

  const captureCheckpointOnce: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.captureCheckpoint";

      // Checked inside the single-flight owner (see captureCheckpoint) so the
      // existence probe and the capture cannot interleave with another capture
      // for the same (cwd, checkpointRef).
      if (input.skipIfExists) {
        const existingCommit = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);
        if (existingCommit !== null) {
          return;
        }
      }

      yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ prefix: "synara-fs-checkpoint-" }),
        (tempDir) =>
          Effect.gen(function* () {
            const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
            const commitEnv: NodeJS.ProcessEnv = {
              ...process.env,
              GIT_INDEX_FILE: tempIndexPath,
              GIT_AUTHOR_NAME: "Synara",
              GIT_AUTHOR_EMAIL: "synara@users.noreply.github.com",
              GIT_COMMITTER_NAME: "Synara",
              GIT_COMMITTER_EMAIL: "synara@users.noreply.github.com",
            };

            const headExists = yield* hasHeadCommit(input.cwd);
            if (headExists) {
              yield* git.execute({
                operation,
                cwd: input.cwd,
                args: ["read-tree", "HEAD"],
                env: commitEnv,
              });
            }

            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["add", "-A", "--", "."],
              env: commitEnv,
            });

            const writeTreeResult = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["write-tree"],
              env: commitEnv,
            });
            const treeOid = writeTreeResult.stdout.trim();
            if (treeOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git write-tree",
                cwd: input.cwd,
                detail: "git write-tree returned an empty tree oid.",
              });
            }

            const message = `Synara checkpoint ref=${input.checkpointRef}`;
            const commitTreeResult = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["commit-tree", treeOid, "-m", message],
              env: commitEnv,
            });
            const commitOid = commitTreeResult.stdout.trim();
            if (commitOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git commit-tree",
                cwd: input.cwd,
                detail: "git commit-tree returned an empty commit oid.",
              });
            }

            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["update-ref", input.checkpointRef, commitOid],
            });
          }),
        (tempDir) => fs.remove(tempDir, { recursive: true }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.fail(
              new CheckpointInvariantError({
                operation: "CheckpointStore.captureCheckpoint",
                detail: "Failed to capture checkpoint.",
                cause: error,
              }),
            ),
        }),
      );
    });

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const key = captureKey(input);
      const registration = yield* captureLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = inFlightCaptures.get(key);
          if (existing) {
            return { owner: false as const, deferred: existing };
          }
          const deferred = yield* Deferred.make<void, CheckpointStoreError>();
          inFlightCaptures.set(key, deferred);
          return { owner: true as const, deferred };
        }),
      );

      if (!registration.owner) {
        return yield* Deferred.await(registration.deferred);
      }

      // Let the git capture remain interruptible, but always notify waiters
      // and clear the shared in-flight slot before this owner fiber exits.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            restore(
              captureCheckpointOnce(input).pipe(
                Effect.timeoutOption(CHECKPOINT_CAPTURE_TIMEOUT_MS),
                Effect.flatMap((completed) =>
                  Option.isSome(completed)
                    ? Effect.void
                    : Effect.fail(
                        new CheckpointInvariantError({
                          operation: "CheckpointStore.captureCheckpoint",
                          detail: `Checkpoint capture timed out after ${CHECKPOINT_CAPTURE_TIMEOUT_MS}ms.`,
                        }),
                      ),
                ),
              ),
            ),
          );
          // Waiters joined an in-flight capture they do not control; replaying the
          // owner's raw interrupt cause would make callers treat it as their own
          // fiber being interrupted. Surface a typed error instead.
          const waiterExit =
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              ? Exit.fail(
                  new CheckpointInvariantError({
                    operation: "CheckpointStore.captureCheckpoint",
                    detail: "Checkpoint capture was interrupted before completion.",
                  }),
                )
              : exit;
          yield* Deferred.done(registration.deferred, waiterExit);
          yield* captureLock.withPermits(1)(Effect.sync(() => inFlightCaptures.delete(key)));
          if (Exit.isFailure(exit)) {
            return yield* Effect.failCause(exit.cause);
          }
        }),
      );
    });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
      Effect.map((commit) => commit !== null),
    );

  const copyCheckpointRef: CheckpointStoreShape["copyCheckpointRef"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.copyCheckpointRef";
      const commitOid = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
      if (!commitOid) {
        return false;
      }

      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["update-ref", input.toCheckpointRef, commitOid],
      });
      return true;
    });

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.restoreCheckpoint";

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
      });
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", "--", "."],
      });

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["reset", "--quiet", "--", "."],
        });
      }

      return true;
    });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.diffCheckpoints";

      let [fromCommitOid, toCommitOid] = yield* Effect.all(
        [
          resolveCheckpointCommit(input.cwd, input.fromCheckpointRef),
          resolveCheckpointCommit(input.cwd, input.toCheckpointRef),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromCommitOid && input.fallbackFromToHead === true) {
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (headCommit) {
          fromCommitOid = headCommit;
        }
      }

      if (!fromCommitOid || !toCommitOid) {
        return yield* new GitCommandError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      const result = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          "--patch",
          "--minimal",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          fromCommitOid,
          toCommitOid,
        ],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });

      return result.stdout;
    });

  // Rolls the working tree back to `treeOid` for the provided paths without
  // touching the repository index: paths absent from the tree did not exist
  // before the aborted apply, so they are deleted instead of restored.
  const restoreWorktreePathsFromTree = (input: {
    readonly cwd: string;
    readonly treeOid: string;
    readonly paths: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.restoreWorktreePathsFromTree";
      if (input.paths.length === 0) {
        return;
      }

      const trackedResult = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["ls-tree", "-r", "--name-only", "-z", input.treeOid, "--", ...input.paths],
        allowNonZeroExit: true,
      });
      const trackedPaths = trackedResult.stdout.split("\0").filter((entry) => entry.length > 0);
      if (trackedPaths.length > 0) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["restore", "--source", input.treeOid, "--worktree", "--", ...trackedPaths],
        });
      }

      const trackedPathSet = new Set(trackedPaths);
      yield* Effect.forEach(
        input.paths.filter((entry) => !trackedPathSet.has(entry)),
        (relativePath) => fs.remove(path.join(input.cwd, relativePath), { force: true }),
        { discard: true },
      );
    });

  // Fallback for undo when the working tree drifted after the checkpoint: a
  // plain `git apply --reverse` is all-or-nothing, so any unrelated edit in a
  // touched hunk aborts the whole undo.
  //
  // `git apply --3way` implies `--index` and therefore refuses to run while the
  // working tree differs from the index. Point it at a throwaway index that
  // mirrors the current working tree so the merge can run; the repository index
  // stays untouched and the caller's `git reset` remains its only writer.
  const applyReverseWithThreeWayMerge = (input: {
    readonly cwd: string;
    readonly tempDir: string;
    readonly patchPath: string;
    readonly affectedPaths: ReadonlyArray<string>;
    readonly strictApplyStderr: string;
  }) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.reverseCheckpointDiff";
      const mergeIndexEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: path.join(input.tempDir, `undo-index-${randomUUID()}`),
      };

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["read-tree", "HEAD"],
          env: mergeIndexEnv,
        });
      }
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["add", "-A", "--", "."],
        env: mergeIndexEnv,
      });
      // Snapshot of the pre-attempt working tree, used to undo a conflicted
      // 3-way apply (which writes conflict markers before failing).
      const preAttemptTreeResult = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["write-tree"],
        env: mergeIndexEnv,
      });
      const preAttemptTreeOid = preAttemptTreeResult.stdout.trim();

      const applied = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["apply", "--reverse", "--3way", "--whitespace=nowarn", "--", input.patchPath],
        env: mergeIndexEnv,
        allowNonZeroExit: true,
      });
      if (applied.code === 0) {
        return;
      }

      if (preAttemptTreeOid.length > 0) {
        yield* restoreWorktreePathsFromTree({
          cwd: input.cwd,
          treeOid: preAttemptTreeOid,
          paths: input.affectedPaths,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to roll back a conflicted checkpoint undo", {
              cwd: input.cwd,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }

      return yield* new GitCommandError({
        operation,
        command: "git apply --reverse --3way",
        cwd: input.cwd,
        detail: [
          "Undo could not be applied because the workspace changed since this checkpoint.",
          input.strictApplyStderr.trim(),
          applied.stderr.trim(),
        ]
          .filter((part) => part.length > 0)
          .join(" "),
      });
    });

  const reverseCheckpointDiff: CheckpointStoreShape["reverseCheckpointDiff"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.reverseCheckpointDiff";
      const [fromCommitOid, toCommitOid] = yield* Effect.all(
        [
          resolveCheckpointCommit(input.cwd, input.fromCheckpointRef),
          resolveCheckpointCommit(input.cwd, input.toCheckpointRef),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromCommitOid || !toCommitOid) {
        return false;
      }

      const diff = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          "--patch",
          "--binary",
          "--full-index",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          fromCommitOid,
          toCommitOid,
        ],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });
      if (diff.stdout.length === 0) {
        return true;
      }

      const changedPaths = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["diff", "--name-only", "--no-renames", "-z", fromCommitOid, toCommitOid],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });
      const affectedPaths = changedPaths.stdout.split("\0").filter((entry) => entry.length > 0);

      return yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ prefix: "synara-checkpoint-undo-" }),
        (tempDir) =>
          Effect.gen(function* () {
            const patchPath = path.join(tempDir, "turn.patch");
            yield* fs.writeFileString(patchPath, diff.stdout);
            const strictApply = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["apply", "--reverse", "--whitespace=nowarn", "--", patchPath],
              allowNonZeroExit: true,
            });
            if (strictApply.code !== 0) {
              yield* applyReverseWithThreeWayMerge({
                cwd: input.cwd,
                tempDir,
                patchPath,
                affectedPaths,
                strictApplyStderr: strictApply.stderr,
              });
            }
            if (affectedPaths.length > 0) {
              const resetExit = yield* Effect.exit(
                git.execute({
                  operation,
                  cwd: input.cwd,
                  args: ["reset", "--quiet", fromCommitOid, "--", ...affectedPaths],
                }),
              );
              if (Exit.isFailure(resetExit)) {
                yield* git.execute({
                  operation,
                  cwd: input.cwd,
                  args: ["apply", "--whitespace=nowarn", "--", patchPath],
                });
                return yield* Effect.failCause(resetExit.cause);
              }
            }
            return true;
          }),
        (tempDir) => fs.remove(tempDir, { recursive: true }),
      ).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new CheckpointInvariantError({
              operation,
              detail: "Failed to prepare the checkpoint patch for undo.",
              cause: error,
            }),
          ),
        ),
      );
    });

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.deleteCheckpointRefs";

      // Ref deletion writes contend on packed-refs.lock, so a concurrent delete
      // can lose the lock race. `allowNonZeroExit` keeps one loser from
      // abandoning the rest of the batch, but the exit codes must still be
      // inspected: silently discarding them made every caller's cleanup error
      // handling unreachable. Deleting an already-absent ref exits 0, so the
      // "missing refs are tolerated" contract is unaffected.
      const results = yield* Effect.forEach(input.checkpointRefs, (checkpointRef) =>
        git
          .execute({
            operation,
            cwd: input.cwd,
            args: ["update-ref", "-d", checkpointRef],
            allowNonZeroExit: true,
          })
          .pipe(Effect.map((result) => ({ checkpointRef, result }))),
      );

      const failures = results.filter((entry) => entry.result.code !== 0);
      if (failures.length === 0) {
        return;
      }

      return yield* new GitCommandError({
        operation,
        command: "git update-ref -d",
        cwd: input.cwd,
        detail: `Failed to delete ${failures.length} of ${results.length} checkpoint ref(s): ${failures
          .map(
            (entry) =>
              `${entry.checkpointRef} (${entry.result.stderr.trim() || `exit code ${entry.result.code}`})`,
          )
          .join("; ")}`,
      });
    });

  return {
    isGitRepository,
    captureCheckpoint,
    copyCheckpointRef,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    reverseCheckpointDiff,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
