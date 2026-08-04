// FILE: GitCore.ts
// Purpose: Implements low-level Git operations used by server orchestration and UI status.
// Layer: Server Git service
// Exports: GitCoreLive plus makeGitCore test factory.
import {
  Cache,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@synara/shared/githubRepository";
import { decodeJsonResult } from "@synara/shared/schemaJson";

import { GitCheckoutDirtyWorktreeError, GitCommandError } from "../Errors.ts";
import {
  countTextFileLines,
  normalizeConfiguredMergeBranch,
  parseGitStatusPorcelain,
  summarizeGitNumstatOutputs,
} from "../gitStatusParsing.ts";
import {
  GitCore,
  type ExecuteGitProgress,
  type GitCommitOptions,
  type GitCoreShape,
  type ExecuteGitInput,
  type ExecuteGitResult,
} from "../Services/GitCore.ts";
import { ServerConfig } from "../../config.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const EMPTY_TREE_OBJECT_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const WORKING_TREE_DIFF_TIMEOUT_MS = 15_000;
const MAX_UNTRACKED_DIFF_CONCURRENCY = 4;
const MAX_QUEUED_REPOSITORY_MUTATIONS = 64;
const MOVE_AWARE_WORKING_TREE_STATUS_TIMEOUT_MS = 15_000;
const AUTO_DETACHED_WORKTREE_DIRNAME = "synara";
const WORKTREE_OWNERSHIP_MARKER = "synara-agent-gateway-owner.json";
const WORKTREE_TRANSFER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const NON_REPOSITORY_STATUS_DETAILS = Object.freeze({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  upstreamBranch: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
});

type TraceTailState = {
  processedChars: number;
  remainder: string;
};

class StatusUpstreamRefreshCacheKey extends Data.Class<{
  cwd: string;
  upstreamRef: string;
  remoteName: string;
  upstreamBranch: string;
}> {}

interface ExecuteGitOptions {
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  progress?: ExecuteGitProgress | undefined;
  maxOutputBytes?: number | undefined;
  outputMode?: "error" | "truncate" | undefined;
}

type WorkingTreeStatSummary = ReturnType<typeof summarizeGitNumstatOutputs>;

function resolveGitPath(cwd: string, gitPath: string): string {
  return nodePath.isAbsolute(gitPath) ? gitPath : nodePath.join(cwd, gitPath);
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === code
  );
}

function joinPatchSegments(segments: ReadonlyArray<string>): string {
  let combined = "";
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (combined.length > 0 && !combined.endsWith("\n")) {
      combined += "\n";
    }
    combined += segment;
    if (!combined.endsWith("\n")) {
      combined += "\n";
    }
  }
  return combined;
}

function parseBranchLine(line: string): { name: string; current: boolean } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const name = trimmed.replace(/^[*+]\s+/, "");
  // Exclude symbolic refs like: "origin/HEAD -> origin/main".
  // Exclude detached HEAD pseudo-refs like: "(HEAD detached at origin/main)".
  if (name.includes(" -> ") || name.startsWith("(")) return null;

  return {
    name,
    current: trimmed.startsWith("* "),
  };
}

function parseRemoteNames(stdout: string): ReadonlyArray<string> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted((a, b) => b.length - a.length);
}

function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

function normalizeRemoteUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function parseRemoteRefWithRemoteNames(
  branchName: string,
  remoteNames: ReadonlyArray<string>,
): { remoteRef: string; remoteName: string; localBranch: string } | null {
  const trimmedBranchName = branchName.trim();
  if (trimmedBranchName.length === 0) return null;

  for (const remoteName of remoteNames) {
    const remotePrefix = `${remoteName}/`;
    if (!trimmedBranchName.startsWith(remotePrefix)) {
      continue;
    }
    const localBranch = trimmedBranchName.slice(remotePrefix.length).trim();
    if (localBranch.length === 0) {
      return null;
    }
    return {
      remoteRef: trimmedBranchName,
      remoteName,
      localBranch,
    };
  }

  return null;
}

function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const upstreamBranch = upstreamBranchRaw.trim();
    if (branchName.length === 0 || upstreamBranch.length === 0) {
      continue;
    }
    if (upstreamBranch === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function isMissingGitCwdError(error: GitCommandError): boolean {
  const normalized = `${error.detail}\n${error.message}`.toLowerCase();
  return (
    normalized.includes("no such file or directory") ||
    normalized.includes("notfound: filesystem.access") ||
    normalized.includes("enoent") ||
    normalized.includes("not a directory")
  );
}

function parseDefaultBranchFromRemoteHeadRef(value: string, remoteName: string): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const branch = trimmed.slice(prefix.length).trim();
  return branch.length > 0 ? branch : null;
}

function createGitCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const DIRTY_WORKTREE_PATTERN =
  /Your local changes to the following files would be overwritten by (?:checkout|merge):\s*([\s\S]*?)Please commit your changes or stash them/;
const UNTRACKED_OVERWRITE_PATTERN =
  /The following untracked working tree files would be overwritten by (?:checkout|merge):\s*([\s\S]*?)Please move or remove them/;

function parseDirtyWorktreeFiles(stderr: string): string[] | null {
  const match = DIRTY_WORKTREE_PATTERN.exec(stderr) ?? UNTRACKED_OVERWRITE_PATTERN.exec(stderr);
  if (!match?.[1]) return null;
  const files = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return files.length > 0 ? files : null;
}

function explainPullBlockedByLocalChanges(error: GitCommandError): string | null {
  const files = parseDirtyWorktreeFiles(error.detail);
  if (!files) return null;
  const fileList = files.map((file) => `  - ${file}`).join("\n");
  return `Local changes block pull. Commit or stash these files first:\n${fileList}`;
}

function parseNonEmptyLineList(input: string): string[] {
  return input
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

type StashEntry = {
  ref: string;
  hash: string;
};

function parseStashEntries(input: string): StashEntry[] {
  return parseNonEmptyLineList(input).flatMap((line) => {
    const [ref, hash] = line.split(" ");
    return ref && hash ? [{ ref, hash }] : [];
  });
}

function toGitCommandError(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    Schema.is(GitCommandError)(cause)
      ? cause
      : new GitCommandError({
          operation: input.operation,
          command: commandLabel(input.args),
          cwd: input.cwd,
          detail: `${cause instanceof Error && cause.message.length > 0 ? cause.message : "Unknown error"} - ${detail}`,
          ...(cause !== undefined ? { cause } : {}),
        });
}

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);

const createTrace2Monitor = Effect.fn(function* (
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: ExecuteGitProgress | undefined,
): Effect.fn.Return<
  Trace2Monitor,
  PlatformError.PlatformError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const traceFilePath = yield* fs.makeTempFileScoped({
    prefix: `synara-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  const traceTailState = yield* Ref.make<TraceTailState>({
    processedChars: 0,
    remainder: "",
  });

  const handleTraceLine = (line: string) =>
    Effect.gen(function* () {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0) {
        return;
      }

      const traceRecord = decodeJsonResult(Trace2Record)(trimmedLine);
      if (Result.isFailure(traceRecord)) {
        yield* Effect.logDebug(
          `GitCore.trace2: failed to parse trace line for ${commandLabel(input.args)} in ${input.cwd}`,
          traceRecord.failure,
        );
        return;
      }

      if (traceRecord.success.child_class !== "hook") {
        return;
      }

      const event = traceRecord.success.event;
      const childKey = trace2ChildKey(traceRecord.success);
      if (childKey === null) {
        return;
      }
      const started = hookStartByChildKey.get(childKey);
      const hookNameFromEvent =
        typeof traceRecord.success.hook_name === "string"
          ? traceRecord.success.hook_name.trim()
          : "";
      const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
      if (hookName.length === 0) {
        return;
      }

      if (event === "child_start") {
        hookStartByChildKey.set(childKey, { hookName, startedAtMs: Date.now() });
        if (progress.onHookStarted) {
          yield* progress.onHookStarted(hookName);
        }
        return;
      }

      if (event === "child_exit") {
        hookStartByChildKey.delete(childKey);
        if (progress.onHookFinished) {
          const code = traceRecord.success.code;
          yield* progress.onHookFinished({
            hookName: started?.hookName ?? hookName,
            exitCode: typeof code === "number" && Number.isInteger(code) ? code : null,
            durationMs: started ? Math.max(0, Date.now() - started.startedAtMs) : null,
          });
        }
      }
    });

  const deltaMutex = yield* Semaphore.make(1);
  const readTraceDelta = deltaMutex.withPermit(
    fs.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          Ref.modify(traceTailState, ({ processedChars, remainder }) => {
            if (contents.length <= processedChars) {
              return [[], { processedChars, remainder }];
            }

            const appended = contents.slice(processedChars);
            const combined = remainder + appended;
            const lines = combined.split("\n");
            const nextRemainder = lines.pop() ?? "";

            return [
              lines.map((line) => line.replace(/\r$/, "")),
              {
                processedChars: contents.length,
                remainder: nextRemainder,
              },
            ];
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, handleTraceLine, { discard: true })),
          ),
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fs.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    const isTargetTraceEvent =
      eventPath === traceFilePath ||
      eventPath === traceFileName ||
      path.basename(eventPath) === traceFileName;
    if (!isTargetTraceEvent) return Effect.void;
    return readTraceDelta;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* readTraceDelta;
      const finalLine = yield* Ref.modify(traceTailState, ({ processedChars, remainder }) => [
        remainder.trim(),
        {
          processedChars,
          remainder: "",
        },
      ]);
      if (finalLine.length > 0) {
        yield* handleTraceLine(finalLine);
      }
    }),
  );

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: readTraceDelta,
  };
});

export const collectGitOutput = Effect.fn(function* <E>(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
  outputMode: "error" | "truncate",
): Effect.fn.Return<string, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let lineBuffer = "";

  const emitCompleteLines = (flush: boolean) =>
    Effect.gen(function* () {
      let separatorIndex = lineBuffer.search(/[\r\n]/);
      while (separatorIndex >= 0) {
        const line = lineBuffer.slice(0, separatorIndex);
        const separatorWidth =
          lineBuffer[separatorIndex] === "\r" && lineBuffer[separatorIndex + 1] === "\n" ? 2 : 1;
        lineBuffer = lineBuffer.slice(separatorIndex + separatorWidth);
        if (line.length > 0 && onLine) {
          yield* onLine(line);
        }
        separatorIndex = lineBuffer.search(/[\r\n]/);
      }

      if (flush) {
        const trailing = lineBuffer.replace(/\r$/, "");
        lineBuffer = "";
        if (trailing.length > 0 && onLine) {
          yield* onLine(trailing);
        }
      }
    });

  yield* Stream.runForEach(stream, (chunk) =>
    Effect.gen(function* () {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes && outputMode === "error") {
        return yield* new GitCommandError({
          operation: input.operation,
          command: commandLabel(input.args),
          cwd: input.cwd,
          detail: `${commandLabel(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
        });
      }
      const decoded = decoder.decode(chunk, { stream: true });
      if (text.length < maxOutputBytes) {
        text += decoded.slice(0, maxOutputBytes - text.length);
      }
      lineBuffer += decoded;
      yield* emitCompleteLines(false);
      if (outputMode === "truncate" && lineBuffer.length > maxOutputBytes) {
        lineBuffer = lineBuffer.slice(-maxOutputBytes);
      }
    }),
  ).pipe(Effect.mapError(toGitCommandError(input, "output stream failed.")));

  const remainder = decoder.decode();
  if (text.length < maxOutputBytes) {
    text += remainder.slice(0, maxOutputBytes - text.length);
  }
  lineBuffer += remainder;
  yield* emitCompleteLines(true);
  return text;
});

export const makeGitCore = (options?: { executeOverride?: GitCoreShape["execute"] }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { worktreesDir } = yield* ServerConfig;
    const statusRefreshScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );

    const buildGeneratedDetachedWorktreePath = () =>
      Effect.gen(function* () {
        // Keep auto-generated detached worktrees short and opaque so the
        // filesystem path stays stable-looking regardless of the source ref.
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const shortId = randomUUID().replace(/-/g, "").slice(0, 4);
          const candidateParent = path.join(worktreesDir, shortId);
          const candidatePath = path.join(candidateParent, AUTO_DETACHED_WORKTREE_DIRNAME);
          if (yield* fileSystem.exists(candidatePath)) {
            continue;
          }
          yield* fileSystem.makeDirectory(candidateParent, { recursive: true });
          return candidatePath;
        }

        const fallbackId = randomUUID().replace(/-/g, "");
        const fallbackParent = path.join(worktreesDir, fallbackId);
        yield* fileSystem.makeDirectory(fallbackParent, { recursive: true });
        return path.join(fallbackParent, AUTO_DETACHED_WORKTREE_DIRNAME);
      });

    let execute: GitCoreShape["execute"];

    if (options?.executeOverride) {
      execute = options.executeOverride;
    } else {
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      execute = Effect.fnUntraced(function* (input) {
        const commandInput = {
          ...input,
          args: [...input.args],
        } as const;
        const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        const outputMode = input.outputMode ?? "error";

        const commandEffect = Effect.gen(function* () {
          const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
            Effect.provideService(Path.Path, path),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.mapError(toGitCommandError(commandInput, "failed to create trace2 monitor.")),
          );
          const child = yield* commandSpawner
            .spawn(
              ChildProcess.make("git", commandInput.args, {
                cwd: commandInput.cwd,
                env: {
                  ...process.env,
                  ...input.env,
                  ...trace2Monitor.env,
                },
              }),
            )
            .pipe(Effect.mapError(toGitCommandError(commandInput, "failed to spawn.")));
          // Keep cancellation ownership explicit even though spawn is already
          // Scope-bound: an RPC interruption closes this Scope and kills the child
          // before execute settles. The spawner's own finalizer safely handles the
          // second cleanup attempt.
          yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectGitOutput(
                commandInput,
                child.stdout,
                maxOutputBytes,
                input.progress?.onStdoutLine,
                outputMode,
              ),
              collectGitOutput(
                commandInput,
                child.stderr,
                maxOutputBytes,
                input.progress?.onStderrLine,
                outputMode,
              ),
              child.exitCode.pipe(
                Effect.map((value) => Number(value)),
                Effect.mapError(toGitCommandError(commandInput, "failed to report exit code.")),
              ),
            ],
            { concurrency: "unbounded" },
          );
          yield* trace2Monitor.flush;

          if (!input.allowNonZeroExit && exitCode !== 0) {
            const trimmedStderr = stderr.trim();
            return yield* new GitCommandError({
              operation: commandInput.operation,
              command: commandLabel(commandInput.args),
              cwd: commandInput.cwd,
              detail:
                trimmedStderr.length > 0
                  ? `${commandLabel(commandInput.args)} failed: ${trimmedStderr}`
                  : `${commandLabel(commandInput.args)} failed with code ${exitCode}.`,
            });
          }

          return { code: exitCode, stdout, stderr } satisfies ExecuteGitResult;
        });

        return yield* commandEffect.pipe(
          Effect.scoped,
          Effect.timeoutOption(timeoutMs),
          Effect.flatMap((result) =>
            Option.match(result, {
              onNone: () =>
                Effect.fail(
                  new GitCommandError({
                    operation: commandInput.operation,
                    command: commandLabel(commandInput.args),
                    cwd: commandInput.cwd,
                    detail: `${commandLabel(commandInput.args)} timed out.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
      });
    }

    const executeGit = (
      operation: string,
      cwd: string,
      args: readonly string[],
      options: ExecuteGitOptions = {},
    ): Effect.Effect<{ code: number; stdout: string; stderr: string }, GitCommandError> =>
      execute({
        operation,
        cwd,
        args,
        allowNonZeroExit: true,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.progress ? { progress: options.progress } : {}),
        ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
        ...(options.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
      }).pipe(
        Effect.flatMap((result) => {
          if (options.allowNonZeroExit || result.code === 0) {
            return Effect.succeed(result);
          }
          const stderr = result.stderr.trim();
          if (stderr.length > 0) {
            return Effect.fail(createGitCommandError(operation, cwd, args, stderr));
          }
          if (options.fallbackErrorMessage) {
            return Effect.fail(
              createGitCommandError(operation, cwd, args, options.fallbackErrorMessage),
            );
          }
          return Effect.fail(
            createGitCommandError(
              operation,
              cwd,
              args,
              `${commandLabel(args)} failed: code=${result.code ?? "null"}`,
            ),
          );
        }),
      );

    const runGit = (
      operation: string,
      cwd: string,
      args: readonly string[],
      allowNonZeroExit = false,
    ): Effect.Effect<void, GitCommandError> =>
      executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

    const runGitStdout = (
      operation: string,
      cwd: string,
      args: readonly string[],
      allowNonZeroExit = false,
    ): Effect.Effect<string, GitCommandError> =>
      executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
        Effect.map((result) => result.stdout),
      );

    const repositoryMutationLocks = new Map<string, Semaphore.Semaphore>();
    const repositoryMutationCounts = new Map<string, number>();
    const repositoryMutationMapLock = yield* Semaphore.make(1);
    const resolveRepositoryMutationKey = (cwd: string) =>
      executeGit("GitCore.withMutation.commonDir", cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((commonDir) =>
          Effect.tryPromise(() => nodeFs.realpath(nodePath.resolve(cwd, commonDir))),
        ),
        Effect.catch(() =>
          Effect.tryPromise(() => nodeFs.realpath(cwd)).pipe(
            Effect.catch(() => Effect.succeed(nodePath.resolve(cwd))),
          ),
        ),
      );
    const withMutation: GitCoreShape["withMutation"] = (cwd, effect) =>
      Effect.gen(function* () {
        const key = yield* resolveRepositoryMutationKey(cwd);
        const lock = yield* repositoryMutationMapLock.withPermit(
          Effect.gen(function* () {
            const count = repositoryMutationCounts.get(key) ?? 0;
            if (count >= MAX_QUEUED_REPOSITORY_MUTATIONS) {
              return yield* new GitCommandError({
                operation: "GitCore.withMutation",
                command: "repository mutation queue",
                cwd,
                detail: "Repository mutation queue is full.",
              });
            }
            let existing = repositoryMutationLocks.get(key);
            if (!existing) {
              existing = yield* Semaphore.make(1);
              repositoryMutationLocks.set(key, existing);
            }
            repositoryMutationCounts.set(key, count + 1);
            return existing;
          }),
        );
        return yield* lock.withPermit(effect).pipe(
          Effect.ensuring(
            repositoryMutationMapLock.withPermit(
              Effect.sync(() => {
                const remaining = (repositoryMutationCounts.get(key) ?? 1) - 1;
                if (remaining <= 0) {
                  repositoryMutationCounts.delete(key);
                  repositoryMutationLocks.delete(key);
                } else {
                  repositoryMutationCounts.set(key, remaining);
                }
              }),
            ),
          ),
        );
      });

    const readMoveAwareWorkingTreeSummary = (
      cwd: string,
    ): Effect.Effect<WorkingTreeStatSummary | null, never> =>
      Effect.scoped(
        Effect.gen(function* () {
          const indexPathRaw = yield* runGitStdout(
            "GitCore.statusDetails.moveAwareIndexPath",
            cwd,
            ["rev-parse", "--git-path", "index"],
          ).pipe(Effect.map((stdout) => stdout.trim()));
          if (indexPathRaw.length === 0) {
            return null;
          }

          const tempIndexDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: `synara-git-status-index-${process.pid}-`,
          });
          const tempIndexPath = nodePath.join(tempIndexDir, "index");
          yield* Effect.tryPromise(() =>
            nodeFs.copyFile(resolveGitPath(cwd, indexPathRaw), tempIndexPath),
          ).pipe(
            Effect.catch((cause) =>
              hasNodeErrorCode(cause, "ENOENT") ? Effect.void : Effect.fail(cause),
            ),
          );

          const tempIndexEnv = { GIT_INDEX_FILE: tempIndexPath };
          // Stage into a copied index only; this lets Git detect directory refactors
          // without touching the user's real staging area.
          yield* executeGit(
            "GitCore.statusDetails.moveAwareAddAll",
            cwd,
            ["add", "-A", "--", ":/"],
            {
              env: tempIndexEnv,
              timeoutMs: MOVE_AWARE_WORKING_TREE_STATUS_TIMEOUT_MS,
              fallbackErrorMessage: "git add -A failed while summarizing working tree status",
            },
          );

          const numstatStdout = yield* executeGit(
            "GitCore.statusDetails.moveAwareNumstat",
            cwd,
            ["diff", "--cached", "--numstat", "-z", "--find-renames"],
            {
              env: tempIndexEnv,
              allowNonZeroExit: true,
              timeoutMs: MOVE_AWARE_WORKING_TREE_STATUS_TIMEOUT_MS,
            },
          ).pipe(Effect.map((result) => result.stdout));

          return summarizeGitNumstatOutputs([numstatStdout]);
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logDebug(
            "GitCore.statusDetails: move-aware working tree summary failed",
            cause,
          ).pipe(Effect.as(null)),
        ),
      );

    const listStashEntries = (
      operation: string,
      cwd: string,
    ): Effect.Effect<StashEntry[], GitCommandError> =>
      executeGit(operation, cwd, ["stash", "list", "--format=%gd %H"], {
        timeoutMs: 10_000,
      }).pipe(Effect.map((result) => parseStashEntries(result.stdout)));

    const dropStashByHash = (cwd: string, hash: string): Effect.Effect<void, GitCommandError> =>
      Effect.gen(function* () {
        const entries = yield* listStashEntries("GitCore.dropStashByHash.list", cwd);
        const entry = entries.find((candidate) => candidate.hash === hash);
        if (!entry) return;
        yield* executeGit("GitCore.dropStashByHash.drop", cwd, ["stash", "drop", entry.ref], {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git stash drop failed",
        });
      });

    const branchExists = (cwd: string, branch: string): Effect.Effect<boolean, GitCommandError> =>
      executeGit(
        "GitCore.branchExists",
        cwd,
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        },
      ).pipe(Effect.map((result) => result.code === 0));

    const resolveAvailableBranchName = (
      cwd: string,
      desiredBranch: string,
    ): Effect.Effect<string, GitCommandError> =>
      Effect.gen(function* () {
        const isDesiredTaken = yield* branchExists(cwd, desiredBranch);
        if (!isDesiredTaken) {
          return desiredBranch;
        }

        for (let suffix = 1; suffix <= 100; suffix += 1) {
          const candidate = `${desiredBranch}-${suffix}`;
          const isCandidateTaken = yield* branchExists(cwd, candidate);
          if (!isCandidateTaken) {
            return candidate;
          }
        }

        return yield* createGitCommandError(
          "GitCore.renameBranch",
          cwd,
          ["branch", "-m", "--", desiredBranch],
          `Could not find an available branch name for '${desiredBranch}'.`,
        );
      });

    const resolveCurrentUpstream = (
      cwd: string,
    ): Effect.Effect<
      { upstreamRef: string; remoteName: string; upstreamBranch: string } | null,
      GitCommandError
    > =>
      Effect.gen(function* () {
        const upstreamRef = yield* runGitStdout(
          "GitCore.resolveCurrentUpstream",
          cwd,
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));

        if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
          return null;
        }

        const separatorIndex = upstreamRef.indexOf("/");
        if (separatorIndex <= 0) {
          return null;
        }
        const remoteName = upstreamRef.slice(0, separatorIndex);
        const upstreamBranch = upstreamRef.slice(separatorIndex + 1);
        if (remoteName.length === 0 || upstreamBranch.length === 0) {
          return null;
        }

        return {
          upstreamRef,
          remoteName,
          upstreamBranch,
        };
      });

    const fetchUpstreamRef = (
      cwd: string,
      upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
    ): Effect.Effect<void, GitCommandError> => {
      const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
      return runGit(
        "GitCore.fetchUpstreamRef",
        cwd,
        ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec],
        true,
      );
    };

    const fetchUpstreamRefForStatus = (
      cwd: string,
      upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
    ): Effect.Effect<void, GitCommandError> => {
      const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
      return executeGit(
        "GitCore.fetchUpstreamRefForStatus",
        cwd,
        ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec],
        {
          allowNonZeroExit: true,
          timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
        },
      ).pipe(Effect.asVoid);
    };

    const statusUpstreamRefreshCache = yield* Cache.makeWith({
      capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
      lookup: (cacheKey: StatusUpstreamRefreshCacheKey) =>
        Effect.gen(function* () {
          yield* fetchUpstreamRefForStatus(cacheKey.cwd, {
            upstreamRef: cacheKey.upstreamRef,
            remoteName: cacheKey.remoteName,
            upstreamBranch: cacheKey.upstreamBranch,
          });
          return true as const;
        }),
      // Keep successful refreshes warm; drop failures immediately so next request can retry.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? STATUS_UPSTREAM_REFRESH_INTERVAL : Duration.zero,
    });

    const refreshStatusUpstreamIfStale = (cwd: string): Effect.Effect<void, GitCommandError> =>
      Effect.gen(function* () {
        const upstream = yield* resolveCurrentUpstream(cwd);
        if (!upstream) return;
        yield* Cache.get(
          statusUpstreamRefreshCache,
          new StatusUpstreamRefreshCacheKey({
            cwd,
            upstreamRef: upstream.upstreamRef,
            remoteName: upstream.remoteName,
            upstreamBranch: upstream.upstreamBranch,
          }),
        );
      });

    const refreshCheckedOutBranchUpstream = (cwd: string): Effect.Effect<void, GitCommandError> =>
      Effect.gen(function* () {
        const upstream = yield* resolveCurrentUpstream(cwd);
        if (!upstream) return;
        yield* fetchUpstreamRef(cwd, upstream);
      });

    const resolveDefaultBranchName = (
      cwd: string,
      remoteName: string,
    ): Effect.Effect<string | null, GitCommandError> =>
      executeGit(
        "GitCore.resolveDefaultBranchName",
        cwd,
        ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
        { allowNonZeroExit: true },
      ).pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
        }),
      );

    const remoteBranchExists = (
      cwd: string,
      remoteName: string,
      branch: string,
    ): Effect.Effect<boolean, GitCommandError> =>
      executeGit(
        "GitCore.remoteBranchExists",
        cwd,
        ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${branch}`],
        {
          allowNonZeroExit: true,
        },
      ).pipe(Effect.map((result) => result.code === 0));

    const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
      executeGit("GitCore.originRemoteExists", cwd, ["remote", "get-url", "origin"], {
        allowNonZeroExit: true,
      }).pipe(Effect.map((result) => result.code === 0));

    const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
      runGitStdout("GitCore.listRemoteNames", cwd, ["remote"]).pipe(
        Effect.map((stdout) => parseRemoteNames(stdout).toReversed()),
      );

    const resolvePrimaryRemoteName = (cwd: string): Effect.Effect<string, GitCommandError> =>
      Effect.gen(function* () {
        if (yield* originRemoteExists(cwd)) {
          return "origin";
        }
        const remotes = yield* listRemoteNames(cwd);
        const [firstRemote] = remotes;
        if (firstRemote) {
          return firstRemote;
        }
        return yield* createGitCommandError(
          "GitCore.resolvePrimaryRemoteName",
          cwd,
          ["remote"],
          "No git remote is configured for this repository.",
        );
      });

    const resolvePushRemoteName = (
      cwd: string,
      branch: string,
    ): Effect.Effect<string | null, GitCommandError> =>
      Effect.gen(function* () {
        const branchPushRemote = yield* runGitStdout(
          "GitCore.resolvePushRemoteName.branchPushRemote",
          cwd,
          ["config", "--get", `branch.${branch}.pushRemote`],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));
        if (branchPushRemote.length > 0) {
          return branchPushRemote;
        }

        const pushDefaultRemote = yield* runGitStdout(
          "GitCore.resolvePushRemoteName.remotePushDefault",
          cwd,
          ["config", "--get", "remote.pushDefault"],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));
        if (pushDefaultRemote.length > 0) {
          return pushDefaultRemote;
        }

        return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null)));
      });

    const ensureRemote: GitCoreShape["ensureRemote"] = (input) =>
      Effect.gen(function* () {
        const preferredName = sanitizeRemoteName(input.preferredName);
        const normalizedTargetUrl = normalizeRemoteUrl(input.url);
        const remoteFetchUrls = yield* runGitStdout(
          "GitCore.ensureRemote.listRemoteUrls",
          input.cwd,
          ["remote", "-v"],
        ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

        for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
          if (normalizeRemoteUrl(remoteUrl) === normalizedTargetUrl) {
            return remoteName;
          }
        }

        let remoteName = preferredName;
        let suffix = 1;
        while (remoteFetchUrls.has(remoteName)) {
          remoteName = `${preferredName}-${suffix}`;
          suffix += 1;
        }

        yield* runGit("GitCore.ensureRemote.add", input.cwd, [
          "remote",
          "add",
          remoteName,
          input.url,
        ]);
        return remoteName;
      });

    const resolveBaseBranchForNoUpstream = (
      cwd: string,
      branch: string,
    ): Effect.Effect<string | null, GitCommandError> =>
      Effect.gen(function* () {
        const configuredBaseBranch = yield* runGitStdout(
          "GitCore.resolveBaseBranchForNoUpstream.config",
          cwd,
          ["config", "--get", `branch.${branch}.gh-merge-base`],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));

        const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        const defaultBranch =
          primaryRemoteName === null
            ? null
            : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
        const candidates = [
          configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
          defaultBranch,
          ...DEFAULT_BASE_BRANCH_CANDIDATES,
        ];

        for (const candidate of candidates) {
          if (!candidate) {
            continue;
          }

          const remotePrefix =
            primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
          const normalizedCandidate = candidate.startsWith("origin/")
            ? candidate.slice("origin/".length)
            : remotePrefix && candidate.startsWith(remotePrefix)
              ? candidate.slice(remotePrefix.length)
              : candidate;
          if (normalizedCandidate.length === 0 || normalizedCandidate === branch) {
            continue;
          }

          if (yield* branchExists(cwd, normalizedCandidate)) {
            return normalizedCandidate;
          }

          if (
            primaryRemoteName &&
            (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
          ) {
            return `${primaryRemoteName}/${normalizedCandidate}`;
          }
        }

        return null;
      });

    const computeAheadCountAgainstBase = (
      cwd: string,
      branch: string,
    ): Effect.Effect<number, GitCommandError> =>
      Effect.gen(function* () {
        const baseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch);
        if (!baseBranch) {
          return 0;
        }

        const result = yield* executeGit(
          "GitCore.computeAheadCountAgainstBase",
          cwd,
          ["rev-list", "--count", `${baseBranch}..HEAD`],
          { allowNonZeroExit: true },
        );
        if (result.code !== 0) {
          return 0;
        }

        const parsed = Number.parseInt(result.stdout.trim(), 10);
        return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
      });

    const readBranchRecency = (cwd: string): Effect.Effect<Map<string, number>, GitCommandError> =>
      Effect.gen(function* () {
        const branchRecency = yield* executeGit(
          "GitCore.readBranchRecency",
          cwd,
          [
            "for-each-ref",
            "--format=%(refname:short)%09%(committerdate:unix)",
            "refs/heads",
            "refs/remotes",
          ],
          {
            timeoutMs: 15_000,
            allowNonZeroExit: true,
          },
        );

        const branchLastCommit = new Map<string, number>();
        if (branchRecency.code !== 0) {
          return branchLastCommit;
        }

        for (const line of branchRecency.stdout.split("\n")) {
          if (line.length === 0) {
            continue;
          }
          const [name, lastCommitRaw] = line.split("\t");
          if (!name) {
            continue;
          }
          const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
          branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
        }

        return branchLastCommit;
      });

    const readStatusDetails = (cwd: string, refreshUpstream: boolean) =>
      Effect.gen(function* () {
        const operation = "GitCore.statusDetails.isInsideWorkTree";
        const args = ["rev-parse", "--is-inside-work-tree"] as const;
        const isInsideWorkTree = yield* executeGit(operation, cwd, args, {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        }).pipe(
          Effect.flatMap((result) => {
            if (result.code === 0) {
              return Effect.succeed(result.stdout.trim() === "true");
            }
            if (
              result.code === 128 &&
              result.stderr.toLowerCase().includes("not a git repository")
            ) {
              return Effect.succeed(false);
            }
            return Effect.fail(
              createGitCommandError(
                operation,
                cwd,
                args,
                result.stderr.trim() || `${commandLabel(args)} failed: code=${result.code}`,
              ),
            );
          }),
          Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(false)),
        );
        if (!isInsideWorkTree) {
          return NON_REPOSITORY_STATUS_DETAILS;
        }

        if (refreshUpstream) {
          yield* refreshStatusUpstreamIfStale(cwd).pipe(
            Effect.catchIf(isMissingGitCwdError, () => Effect.void),
            Effect.ignoreCause({ log: true }),
          );
        }

        const statusStdout = yield* runGitStdout("GitCore.statusDetails.status", cwd, [
          "status",
          "--porcelain=2",
          "--branch",
          "-z",
        ]).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));
        if (statusStdout === null) {
          return NON_REPOSITORY_STATUS_DETAILS;
        }

        const parsedStatus = parseGitStatusPorcelain(statusStdout);
        const branch = parsedStatus.branch;
        const upstreamRef = parsedStatus.upstreamRef;
        let upstreamBranch: string | null = null;
        let aheadCount = parsedStatus.aheadCount;
        let behindCount = parsedStatus.behindCount;
        const {
          hasWorkingTreeChanges,
          hasTrackedDeletion,
          hasUntrackedDirectory,
          changedFilesWithoutNumstat,
          untrackedFilesWithoutNumstat,
        } = parsedStatus;

        if (branch && upstreamRef) {
          upstreamBranch = yield* runGitStdout(
            "GitCore.statusDetails.upstreamMergeBranch",
            cwd,
            ["config", "--get", `branch.${branch}.merge`],
            true,
          ).pipe(
            Effect.map(normalizeConfiguredMergeBranch),
            Effect.catch(() => Effect.succeed(null)),
          );
        }

        if (!upstreamRef && branch) {
          aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
            Effect.catch(() => Effect.succeed(0)),
          );
          behindCount = 0;
        }

        // Repo-level metadata for the status panel: whether an `origin` remote is configured
        // and whether the current branch is the repo's default branch. Resolved from the same
        // helpers `listGitBranches` uses so the two stay consistent; each lookup degrades to a
        // safe default on failure so it never breaks the status read. `resolvePrimaryRemoteName`
        // returns "origin" only when that remote exists, so it doubles as the origin check.
        const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        const defaultBranchName =
          primaryRemoteName === null
            ? null
            : yield* resolveDefaultBranchName(cwd, primaryRemoteName).pipe(
                Effect.catch(() => Effect.succeed(null)),
              );
        const repoMetadata = {
          isRepo: true,
          hasOriginRemote: primaryRemoteName === "origin",
          isDefaultBranch:
            branch !== null && defaultBranchName !== null && branch === defaultBranchName,
        } as const;

        const moveAwareWorkingTree =
          hasWorkingTreeChanges &&
          untrackedFilesWithoutNumstat.size > 0 &&
          (hasTrackedDeletion || hasUntrackedDirectory)
            ? yield* readMoveAwareWorkingTreeSummary(cwd)
            : null;
        if (moveAwareWorkingTree) {
          return {
            ...repoMetadata,
            branch,
            upstreamRef,
            upstreamBranch,
            hasWorkingTreeChanges,
            workingTree: moveAwareWorkingTree,
            hasUpstream: upstreamRef !== null,
            aheadCount,
            behindCount,
          };
        }

        const numstatOutputs = yield* Effect.all(
          [
            runGitStdout("GitCore.statusDetails.unstagedNumstat", cwd, ["diff", "--numstat", "-z"]),
            runGitStdout("GitCore.statusDetails.stagedNumstat", cwd, [
              "diff",
              "--cached",
              "--numstat",
              "-z",
            ]),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));
        if (numstatOutputs === null) {
          return NON_REPOSITORY_STATUS_DETAILS;
        }

        const [unstagedNumstatStdout, stagedNumstatStdout] = numstatOutputs;
        const workingTree = summarizeGitNumstatOutputs([
          stagedNumstatStdout,
          unstagedNumstatStdout,
        ]);
        const files = [...workingTree.files];
        const numstatFilePaths = new Set(files.map((file) => file.path));
        const filePathsWithStats = new Set(numstatFilePaths);
        let insertions = workingTree.insertions;
        let deletions = workingTree.deletions;

        for (const filePath of changedFilesWithoutNumstat) {
          if (filePathsWithStats.has(filePath)) continue;

          const insertions = untrackedFilesWithoutNumstat.has(filePath)
            ? yield* Effect.tryPromise(() => nodeFs.readFile(nodePath.join(cwd, filePath))).pipe(
                Effect.map((contents) => countTextFileLines(new Uint8Array(contents))),
                Effect.catch(() => Effect.succeed(0)),
              )
            : 0;

          files.push({ path: filePath, insertions, deletions: 0 });
          filePathsWithStats.add(filePath);
        }
        files.sort((a, b) => a.path.localeCompare(b.path));

        for (const file of files) {
          if (numstatFilePaths.has(file.path)) continue;
          insertions += file.insertions;
          deletions += file.deletions;
        }

        return {
          ...repoMetadata,
          branch,
          upstreamRef,
          upstreamBranch,
          hasWorkingTreeChanges,
          workingTree: {
            files,
            insertions,
            deletions,
          },
          hasUpstream: upstreamRef !== null,
          aheadCount,
          behindCount,
        };
      });

    const statusDetails: GitCoreShape["statusDetails"] = (cwd) => readStatusDetails(cwd, true);

    const status: GitCoreShape["status"] = (input) =>
      Effect.gen(function* () {
        const details = yield* readStatusDetails(input.cwd, false);
        if (details.hasUpstream) {
          yield* refreshStatusUpstreamIfStale(input.cwd).pipe(
            Effect.catchIf(isMissingGitCwdError, () => Effect.void),
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(statusRefreshScope),
          );
        }
        return {
          branch: details.branch,
          hasWorkingTreeChanges: details.hasWorkingTreeChanges,
          workingTree: details.workingTree,
          hasUpstream: details.hasUpstream,
          upstreamBranch: details.upstreamBranch,
          aheadCount: details.aheadCount,
          behindCount: details.behindCount,
          pr: null,
        };
      });

    const readUntrackedPatches = (cwd: string, operationPrefix: string) =>
      runGitStdout(
        `${operationPrefix}.untrackedFiles`,
        cwd,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        true,
      ).pipe(
        Effect.map((stdout) => stdout.split("\0").filter((entry) => entry.length > 0)),
        Effect.flatMap((untrackedFiles) =>
          Effect.forEach(
            untrackedFiles,
            (filePath) =>
              // Git diff omits untracked files, so synthesize a normal patch for each one.
              executeGit(
                `${operationPrefix}.untrackedPatch`,
                cwd,
                [
                  "diff",
                  "--no-index",
                  "--patch",
                  "--no-color",
                  "--src-prefix=a/",
                  "--dst-prefix=b/",
                  "--",
                  "/dev/null",
                  filePath,
                ],
                {
                  allowNonZeroExit: true,
                  timeoutMs: WORKING_TREE_DIFF_TIMEOUT_MS,
                },
              ).pipe(Effect.map((result) => result.stdout)),
            { concurrency: MAX_UNTRACKED_DIFF_CONCURRENCY },
          ),
        ),
      );

    const readUnstagedPatch: GitCoreShape["readUnstagedPatch"] = (cwd) =>
      Effect.gen(function* () {
        const trackedPatch = yield* executeGit(
          "GitCore.readUnstagedPatch.trackedPatch",
          cwd,
          ["diff", "--patch", "--no-color", "--no-ext-diff"],
          {
            allowNonZeroExit: true,
            timeoutMs: WORKING_TREE_DIFF_TIMEOUT_MS,
          },
        ).pipe(Effect.map((result) => result.stdout));
        const untrackedPatches = yield* readUntrackedPatches(cwd, "GitCore.readUnstagedPatch");

        return {
          patch: joinPatchSegments([trackedPatch, ...untrackedPatches]),
        };
      });

    const readStagedPatch: GitCoreShape["readStagedPatch"] = (cwd) =>
      executeGit(
        "GitCore.readStagedPatch",
        cwd,
        ["diff", "--cached", "--patch", "--no-color", "--no-ext-diff"],
        {
          allowNonZeroExit: true,
          timeoutMs: WORKING_TREE_DIFF_TIMEOUT_MS,
        },
      ).pipe(Effect.map((result) => ({ patch: result.stdout })));

    const readWorkingTreePatch: GitCoreShape["readWorkingTreePatch"] = (cwd) =>
      Effect.gen(function* () {
        const headExists = yield* executeGit(
          "GitCore.readWorkingTreePatch.headExists",
          cwd,
          ["rev-parse", "--verify", "HEAD"],
          { allowNonZeroExit: true },
        ).pipe(Effect.map((result) => result.code === 0));

        const trackedPatch = yield* executeGit(
          "GitCore.readWorkingTreePatch.trackedPatch",
          cwd,
          headExists
            ? ["diff", "--patch", "--no-color", "--no-ext-diff", "HEAD"]
            : ["diff", "--patch", "--no-color", "--no-ext-diff", EMPTY_TREE_OBJECT_ID],
          {
            allowNonZeroExit: true,
            timeoutMs: WORKING_TREE_DIFF_TIMEOUT_MS,
          },
        ).pipe(Effect.map((result) => result.stdout));

        const untrackedPatches = yield* readUntrackedPatches(cwd, "GitCore.readWorkingTreePatch");

        return {
          patch: joinPatchSegments([trackedPatch, ...untrackedPatches]),
        };
      });

    const readBranchPatch: GitCoreShape["readBranchPatch"] = (cwd) =>
      Effect.gen(function* () {
        const details = yield* statusDetails(cwd);
        const baseBranch =
          details.upstreamRef ??
          (details.branch
            ? yield* resolveBaseBranchForNoUpstream(cwd, details.branch).pipe(
                Effect.catch(() => Effect.succeed(null)),
              )
            : null);
        if (!baseBranch) {
          return yield* createGitCommandError(
            "GitCore.readBranchPatch.base",
            cwd,
            ["merge-base", "<base>", "HEAD"],
            "Cannot resolve a base branch for the current branch diff.",
          );
        }

        const mergeBase = yield* executeGit(
          "GitCore.readBranchPatch.mergeBase",
          cwd,
          ["merge-base", baseBranch, "HEAD"],
          {
            fallbackErrorMessage: "Cannot resolve the merge base for the current branch diff.",
          },
        ).pipe(Effect.map((result) => result.stdout.trim()));
        if (mergeBase.length === 0) {
          return yield* createGitCommandError(
            "GitCore.readBranchPatch.mergeBase",
            cwd,
            ["merge-base", baseBranch, "HEAD"],
            "Cannot resolve the merge base for the current branch diff.",
          );
        }

        const trackedPatch = yield* executeGit(
          "GitCore.readBranchPatch.trackedPatch",
          cwd,
          ["diff", "--patch", "--minimal", "--no-color", "--no-ext-diff", mergeBase],
          {
            timeoutMs: WORKING_TREE_DIFF_TIMEOUT_MS,
            maxOutputBytes: 10_000_000,
          },
        ).pipe(Effect.map((result) => result.stdout));
        const untrackedPatches = yield* readUntrackedPatches(cwd, "GitCore.readBranchPatch");

        return {
          patch: joinPatchSegments([trackedPatch, ...untrackedPatches]),
        };
      });

    const prepareCommitContext: GitCoreShape["prepareCommitContext"] = (cwd, filePaths) =>
      Effect.gen(function* () {
        if (filePaths && filePaths.length > 0) {
          yield* runGit("GitCore.prepareCommitContext.reset", cwd, ["reset"]).pipe(
            Effect.catch(() => Effect.void),
          );
          yield* runGit("GitCore.prepareCommitContext.addSelected", cwd, [
            "add",
            "-A",
            "--",
            ...filePaths,
          ]);
        } else {
          yield* runGit("GitCore.prepareCommitContext.addAll", cwd, ["add", "-A"]);
        }

        const stagedSummary = yield* runGitStdout(
          "GitCore.prepareCommitContext.stagedSummary",
          cwd,
          ["diff", "--cached", "--name-status"],
        ).pipe(Effect.map((stdout) => stdout.trim()));
        if (stagedSummary.length === 0) {
          return null;
        }

        const stagedPatch = yield* runGitStdout("GitCore.prepareCommitContext.stagedPatch", cwd, [
          "diff",
          "--cached",
          "--patch",
          "--minimal",
        ]);

        return {
          stagedSummary,
          stagedPatch,
        };
      });

    const commit: GitCoreShape["commit"] = (cwd, subject, body, options?: GitCommitOptions) =>
      Effect.gen(function* () {
        const args = ["commit", "-m", subject];
        const trimmedBody = body.trim();
        if (trimmedBody.length > 0) {
          args.push("-m", trimmedBody);
        }
        const progress = options?.progress
          ? {
              ...(options.progress.onOutputLine
                ? {
                    onStdoutLine: (line: string) =>
                      options.progress?.onOutputLine?.({ stream: "stdout", text: line }) ??
                      Effect.void,
                    onStderrLine: (line: string) =>
                      options.progress?.onOutputLine?.({ stream: "stderr", text: line }) ??
                      Effect.void,
                  }
                : {}),
              ...(options.progress.onHookStarted
                ? { onHookStarted: options.progress.onHookStarted }
                : {}),
              ...(options.progress.onHookFinished
                ? { onHookFinished: options.progress.onHookFinished }
                : {}),
            }
          : null;
        yield* executeGit("GitCore.commit.commit", cwd, args, {
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(progress ? { progress } : {}),
        }).pipe(Effect.asVoid);
        const commitSha = yield* runGitStdout("GitCore.commit.revParseHead", cwd, [
          "rev-parse",
          "HEAD",
        ]).pipe(Effect.map((stdout) => stdout.trim()));

        return { commitSha };
      });

    const pushCurrentBranch: GitCoreShape["pushCurrentBranch"] = (cwd, fallbackBranch) =>
      Effect.gen(function* () {
        const details = yield* statusDetails(cwd);
        const branch = details.branch ?? fallbackBranch;
        if (!branch) {
          return yield* createGitCommandError(
            "GitCore.pushCurrentBranch",
            cwd,
            ["push"],
            "Cannot push from detached HEAD.",
          );
        }

        const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
        if (hasNoLocalDelta) {
          if (details.hasUpstream) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
              ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
            };
          }

          const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (comparableBaseBranch) {
            const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
              Effect.catch(() => Effect.succeed(null)),
            );
            if (!publishRemoteName) {
              return {
                status: "skipped_up_to_date" as const,
                branch,
              };
            }

            const hasRemoteBranch = yield* remoteBranchExists(cwd, publishRemoteName, branch).pipe(
              Effect.catch(() => Effect.succeed(false)),
            );
            if (hasRemoteBranch) {
              return {
                status: "skipped_up_to_date" as const,
                branch,
              };
            }
          }
        }

        if (!details.hasUpstream) {
          const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
          if (!publishRemoteName) {
            return yield* createGitCommandError(
              "GitCore.pushCurrentBranch",
              cwd,
              ["push"],
              "Cannot push because no git remote is configured for this repository.",
            );
          }
          yield* runGit("GitCore.pushCurrentBranch.pushWithUpstream", cwd, [
            "push",
            "-u",
            publishRemoteName,
            branch,
          ]);
          return {
            status: "pushed" as const,
            branch,
            upstreamBranch: `${publishRemoteName}/${branch}`,
            setUpstream: true,
          };
        }

        const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (currentUpstream) {
          yield* runGit("GitCore.pushCurrentBranch.pushUpstream", cwd, [
            "push",
            currentUpstream.remoteName,
            `HEAD:${currentUpstream.upstreamBranch}`,
          ]);
          return {
            status: "pushed" as const,
            branch,
            upstreamBranch: currentUpstream.upstreamRef,
            setUpstream: false,
          };
        }

        yield* runGit("GitCore.pushCurrentBranch.push", cwd, ["push"]);
        return {
          status: "pushed" as const,
          branch,
          ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
          setUpstream: false,
        };
      });

    const pullCurrentBranch: GitCoreShape["pullCurrentBranch"] = (cwd) =>
      Effect.gen(function* () {
        const details = yield* statusDetails(cwd);
        const branch = details.branch;
        if (!branch) {
          return yield* createGitCommandError(
            "GitCore.pullCurrentBranch",
            cwd,
            ["pull", "--ff-only"],
            "Cannot pull from detached HEAD.",
          );
        }
        if (!details.hasUpstream) {
          return yield* createGitCommandError(
            "GitCore.pullCurrentBranch",
            cwd,
            ["pull", "--ff-only"],
            "Current branch has no upstream configured. Push with upstream first.",
          );
        }
        const beforeSha = yield* runGitStdout(
          "GitCore.pullCurrentBranch.beforeSha",
          cwd,
          ["rev-parse", "HEAD"],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));
        yield* executeGit("GitCore.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
          timeoutMs: 30_000,
          fallbackErrorMessage: "git pull failed",
        }).pipe(
          Effect.mapError((error) => {
            const friendlyDetail = explainPullBlockedByLocalChanges(error);
            if (!friendlyDetail) return error;
            return createGitCommandError(
              "GitCore.pullCurrentBranch.pull",
              cwd,
              ["pull", "--ff-only"],
              friendlyDetail,
              error,
            );
          }),
        );
        const afterSha = yield* runGitStdout(
          "GitCore.pullCurrentBranch.afterSha",
          cwd,
          ["rev-parse", "HEAD"],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));

        const refreshed = yield* statusDetails(cwd);
        return {
          status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
          branch,
          upstreamBranch: refreshed.upstreamRef,
        };
      });

    const readRangeContext: GitCoreShape["readRangeContext"] = (cwd, baseBranch) =>
      Effect.gen(function* () {
        const range = `${baseBranch}..HEAD`;
        const [commitSummary, diffSummary, diffPatchResult] = yield* Effect.all(
          [
            runGitStdout("GitCore.readRangeContext.log", cwd, ["log", "--oneline", range]),
            runGitStdout("GitCore.readRangeContext.diffStat", cwd, ["diff", "--stat", range]),
            execute({
              operation: "GitCore.readRangeContext.diffPatch",
              cwd,
              args: ["diff", "--patch", "--minimal", range],
              maxOutputBytes: 10_000_000,
            }),
          ],
          { concurrency: "unbounded" },
        );
        const diffPatch = diffPatchResult.stdout;

        return {
          commitSummary,
          diffSummary,
          diffPatch,
        };
      });

    const readConfigValue: GitCoreShape["readConfigValue"] = (cwd, key) =>
      runGitStdout("GitCore.readConfigValue", cwd, ["config", "--get", key], true).pipe(
        Effect.map((stdout) => stdout.trim()),
        Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
      );

    const listBranches: GitCoreShape["listBranches"] = (input) =>
      Effect.gen(function* () {
        const branchRecencyPromise = readBranchRecency(input.cwd).pipe(
          Effect.catch(() => Effect.succeed(new Map<string, number>())),
        );
        const localBranchResult = yield* executeGit(
          "GitCore.listBranches.branchNoColor",
          input.cwd,
          ["branch", "--no-color"],
          {
            timeoutMs: 10_000,
            allowNonZeroExit: true,
          },
        ).pipe(
          Effect.catchIf(isMissingGitCwdError, () =>
            Effect.succeed({
              code: 128,
              stdout: "",
              stderr: "fatal: not a git repository",
            }),
          ),
        );

        if (localBranchResult.code !== 0) {
          const stderr = localBranchResult.stderr.trim();
          if (stderr.toLowerCase().includes("not a git repository")) {
            return { branches: [], isRepo: false, hasOriginRemote: false };
          }
          return yield* createGitCommandError(
            "GitCore.listBranches",
            input.cwd,
            ["branch", "--no-color"],
            stderr || "git branch failed",
          );
        }

        const remoteBranchResultEffect = executeGit(
          "GitCore.listBranches.remoteBranches",
          input.cwd,
          ["branch", "--no-color", "--remotes"],
          {
            timeoutMs: 10_000,
            allowNonZeroExit: true,
          },
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `GitCore.listBranches: remote branch lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote branch list.`,
            ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
          ),
        );

        const remoteNamesResultEffect = executeGit(
          "GitCore.listBranches.remoteNames",
          input.cwd,
          ["remote"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `GitCore.listBranches: remote name lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote name list.`,
            ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
          ),
        );

        const branchMetadata = yield* Effect.all(
          [
            executeGit(
              "GitCore.listBranches.defaultRef",
              input.cwd,
              ["symbolic-ref", "refs/remotes/origin/HEAD"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ),
            executeGit(
              "GitCore.listBranches.worktreeList",
              input.cwd,
              ["worktree", "list", "--porcelain"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ),
            remoteBranchResultEffect,
            remoteNamesResultEffect,
            branchRecencyPromise,
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));
        if (branchMetadata === null) {
          return { branches: [], isRepo: false, hasOriginRemote: false };
        }

        const [defaultRef, worktreeList, remoteBranchResult, remoteNamesResult, branchLastCommit] =
          branchMetadata;

        const remoteNames =
          remoteNamesResult.code === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
        if (remoteBranchResult.code !== 0 && remoteBranchResult.stderr.trim().length > 0) {
          yield* Effect.logWarning(
            `GitCore.listBranches: remote branch lookup returned code ${remoteBranchResult.code} for ${input.cwd}: ${remoteBranchResult.stderr.trim()}. Falling back to an empty remote branch list.`,
          );
        }
        if (remoteNamesResult.code !== 0 && remoteNamesResult.stderr.trim().length > 0) {
          yield* Effect.logWarning(
            `GitCore.listBranches: remote name lookup returned code ${remoteNamesResult.code} for ${input.cwd}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
          );
        }

        const defaultBranch =
          defaultRef.code === 0
            ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
            : null;

        const worktreeMap = new Map<string, string>();
        if (worktreeList.code === 0) {
          let currentPath: string | null = null;
          for (const line of worktreeList.stdout.split("\n")) {
            if (line.startsWith("worktree ")) {
              const candidatePath = line.slice("worktree ".length);
              const exists = yield* fileSystem.stat(candidatePath).pipe(
                Effect.map(() => true),
                Effect.catch(() => Effect.succeed(false)),
              );
              currentPath = exists ? candidatePath : null;
            } else if (line.startsWith("branch refs/heads/") && currentPath) {
              worktreeMap.set(line.slice("branch refs/heads/".length), currentPath);
            } else if (line === "") {
              currentPath = null;
            }
          }
        }

        const localBranches = localBranchResult.stdout
          .split("\n")
          .map(parseBranchLine)
          .filter((branch): branch is { name: string; current: boolean } => branch !== null)
          .map((branch) => ({
            name: branch.name,
            current: branch.current,
            isRemote: false,
            isDefault: branch.name === defaultBranch,
            worktreePath: worktreeMap.get(branch.name) ?? null,
          }))
          .toSorted((a, b) => {
            const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
            const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
            if (aPriority !== bPriority) return aPriority - bPriority;

            const aLastCommit = branchLastCommit.get(a.name) ?? 0;
            const bLastCommit = branchLastCommit.get(b.name) ?? 0;
            if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
            return a.name.localeCompare(b.name);
          });

        const remoteBranches =
          remoteBranchResult.code === 0
            ? remoteBranchResult.stdout
                .split("\n")
                .map(parseBranchLine)
                .filter((branch): branch is { name: string; current: boolean } => branch !== null)
                .map((branch) => {
                  const parsedRemoteRef = parseRemoteRefWithRemoteNames(branch.name, remoteNames);
                  const remoteBranch: {
                    name: string;
                    current: boolean;
                    isRemote: boolean;
                    remoteName?: string;
                    isDefault: boolean;
                    worktreePath: string | null;
                  } = {
                    name: branch.name,
                    current: false,
                    isRemote: true,
                    isDefault: false,
                    worktreePath: null,
                  };
                  if (parsedRemoteRef) {
                    remoteBranch.remoteName = parsedRemoteRef.remoteName;
                  }
                  return remoteBranch;
                })
                .toSorted((a, b) => {
                  const aLastCommit = branchLastCommit.get(a.name) ?? 0;
                  const bLastCommit = branchLastCommit.get(b.name) ?? 0;
                  if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
                  return a.name.localeCompare(b.name);
                })
            : [];

        const branches = [...localBranches, ...remoteBranches];

        return { branches, isRepo: true, hasOriginRemote: remoteNames.includes("origin") };
      });

    const createWorktree: GitCoreShape["createWorktree"] = (input) =>
      Effect.gen(function* () {
        const targetBranch = input.newBranch ?? input.branch;
        const sanitizedBranch = targetBranch.replace(/\//g, "-");
        const repoName = path.basename(input.cwd);
        const worktreePath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);
        const args = input.newBranch
          ? ["worktree", "add", "-b", input.newBranch, worktreePath, input.branch]
          : ["worktree", "add", worktreePath, input.branch];

        yield* executeGit("GitCore.createWorktree", input.cwd, args, {
          fallbackErrorMessage: "git worktree add failed",
        });

        return {
          worktree: {
            path: worktreePath,
            branch: targetBranch,
          },
        };
      });

    const parseNullSeparatedPaths = (stdout: string): ReadonlyArray<string> =>
      stdout
        .split("\0")
        .filter((entry) => entry.length > 0)
        .filter(
          (entry) =>
            !nodePath.isAbsolute(entry) &&
            entry !== ".." &&
            !entry.startsWith(`..${nodePath.sep}`) &&
            !entry.split(/[\\/]/u).includes(".."),
        );

    const updateHashFromFile = async (
      hash: ReturnType<typeof createHash>,
      filePath: string,
    ): Promise<void> => {
      for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
      }
    };

    const listWorktreeTransferPaths = (cwd: string) =>
      Effect.gen(function* () {
        const untracked = yield* executeGit(
          "GitCore.listWorktreeTransferPaths.untracked",
          cwd,
          ["ls-files", "--others", "--exclude-standard", "-z"],
          { maxOutputBytes: WORKTREE_TRANSFER_MAX_OUTPUT_BYTES },
        ).pipe(Effect.map((result) => parseNullSeparatedPaths(result.stdout)));
        const includeFile = nodePath.join(cwd, ".worktreeinclude");
        const hasIncludeFile = yield* Effect.tryPromise({
          try: () =>
            nodeFs
              .stat(includeFile)
              .then((entry) => entry.isFile())
              .catch((cause: unknown) => {
                if (hasNodeErrorCode(cause, "ENOENT")) return false;
                throw cause;
              }),
          catch: (cause) =>
            createGitCommandError(
              "GitCore.listWorktreeTransferPaths",
              cwd,
              ["worktree", "include", "read"],
              "could not inspect .worktreeinclude.",
              cause,
            ),
        });
        const included = hasIncludeFile
          ? yield* executeGit(
              "GitCore.listWorktreeTransferPaths.included",
              cwd,
              ["ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude", "-z"],
              { maxOutputBytes: WORKTREE_TRANSFER_MAX_OUTPUT_BYTES },
            ).pipe(Effect.map((result) => parseNullSeparatedPaths(result.stdout)))
          : [];
        return [...new Set([...untracked, ...included])].sort();
      });

    const readWorktreeStateHash = (cwd: string) =>
      Effect.gen(function* () {
        const [staged, unstaged, transferPaths] = yield* Effect.all(
          [
            executeGit(
              "GitCore.readWorktreeStateHash.staged",
              cwd,
              ["diff", "--cached", "--binary", "--full-index", "HEAD", "--"],
              { maxOutputBytes: WORKTREE_TRANSFER_MAX_OUTPUT_BYTES },
            ),
            executeGit(
              "GitCore.readWorktreeStateHash.unstaged",
              cwd,
              ["diff", "--binary", "--full-index", "--"],
              { maxOutputBytes: WORKTREE_TRANSFER_MAX_OUTPUT_BYTES },
            ),
            listWorktreeTransferPaths(cwd),
          ],
          { concurrency: "unbounded" },
        );
        return yield* Effect.tryPromise({
          try: async () => {
            const hash = createHash("sha256");
            hash.update("staged\0").update(staged.stdout);
            hash.update("unstaged\0").update(unstaged.stdout);
            for (const relativePath of transferPaths) {
              const absolutePath = nodePath.join(cwd, relativePath);
              const entry = await nodeFs.lstat(absolutePath);
              hash.update("path\0").update(relativePath).update("\0");
              if (entry.isSymbolicLink()) {
                hash.update("symlink\0").update(await nodeFs.readlink(absolutePath));
              } else if (entry.isFile()) {
                hash.update("file\0");
                await updateHashFromFile(hash, absolutePath);
              } else {
                hash.update("other\0").update(String(entry.mode));
              }
            }
            return hash.digest("hex");
          },
          catch: (cause) =>
            createGitCommandError(
              "GitCore.readWorktreeStateHash",
              cwd,
              ["worktree", "state", "hash"],
              "could not fingerprint the linked worktree state.",
              cause,
            ),
        });
      });

    const copyCheckoutChanges = (sourceCwd: string, worktreePath: string) =>
      Effect.gen(function* () {
        const [patch, listedTransferPaths] = yield* Effect.all(
          [
            executeGit(
              "GitCore.copyCheckoutChanges.patch",
              sourceCwd,
              ["diff", "--binary", "--full-index", "HEAD", "--"],
              { maxOutputBytes: WORKTREE_TRANSFER_MAX_OUTPUT_BYTES },
            ).pipe(Effect.map((result) => result.stdout)),
            listWorktreeTransferPaths(sourceCwd),
          ],
          { concurrency: "unbounded" },
        );
        const transferPaths = listedTransferPaths.filter((relativePath) => {
          const relativeToTarget = nodePath.relative(
            worktreePath,
            nodePath.join(sourceCwd, relativePath),
          );
          return (
            relativeToTarget === ".." ||
            relativeToTarget.startsWith(`..${nodePath.sep}`) ||
            nodePath.isAbsolute(relativeToTarget)
          );
        });

        if (patch.length > 0) {
          yield* Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () => nodeFs.mkdtemp(nodePath.join(tmpdir(), "synara-worktree-patch-")),
              catch: (cause) =>
                createGitCommandError(
                  "GitCore.copyCheckoutChanges",
                  sourceCwd,
                  ["worktree", "copy", "changes"],
                  "could not create a temporary patch directory.",
                  cause,
                ),
            }),
            (temporaryDirectory) =>
              Effect.gen(function* () {
                const patchPath = nodePath.join(temporaryDirectory, "changes.patch");
                yield* Effect.tryPromise({
                  try: () => nodeFs.writeFile(patchPath, patch, "utf8"),
                  catch: (cause) =>
                    createGitCommandError(
                      "GitCore.copyCheckoutChanges",
                      sourceCwd,
                      ["worktree", "copy", "changes"],
                      "could not write the temporary worktree patch.",
                      cause,
                    ),
                });
                yield* executeGit(
                  "GitCore.copyCheckoutChanges.apply",
                  worktreePath,
                  ["apply", "--whitespace=nowarn", patchPath],
                  { timeoutMs: 30_000 },
                );
              }),
            (temporaryDirectory) =>
              Effect.promise(() =>
                nodeFs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {}),
              ),
          );
        }

        yield* Effect.forEach(
          transferPaths,
          (relativePath) =>
            Effect.tryPromise({
              try: async () => {
                const sourcePath = nodePath.join(sourceCwd, relativePath);
                const targetPath = nodePath.join(worktreePath, relativePath);
                await nodeFs.mkdir(nodePath.dirname(targetPath), { recursive: true });
                await nodeFs.cp(sourcePath, targetPath, {
                  recursive: true,
                  force: false,
                  errorOnExist: true,
                  preserveTimestamps: true,
                });
              },
              catch: (cause) =>
                createGitCommandError(
                  "GitCore.copyCheckoutChanges",
                  sourceCwd,
                  ["worktree", "copy", relativePath],
                  `could not copy ${relativePath} into the detached worktree.`,
                  cause,
                ),
            }),
          { discard: true, concurrency: 4 },
        );
      });

    const snapshotWorktree: GitCoreShape["snapshotWorktree"] = (input) =>
      Effect.gen(function* () {
        const [patch, transferPaths, head] = yield* Effect.all(
          [
            executeGit(
              "GitCore.snapshotWorktree.patch",
              input.cwd,
              ["diff", "--binary", "--full-index", "HEAD", "--"],
              { maxOutputBytes: WORKTREE_TRANSFER_MAX_OUTPUT_BYTES },
            ).pipe(Effect.map((result) => result.stdout)),
            listWorktreeTransferPaths(input.cwd),
            executeGit("GitCore.snapshotWorktree.head", input.cwd, [
              "rev-parse",
              "--verify",
              "HEAD^{commit}",
            ]).pipe(Effect.map((result) => result.stdout.trim())),
          ],
          { concurrency: "unbounded" },
        );
        yield* Effect.tryPromise({
          try: async () => {
            const outputParent = nodePath.dirname(input.outputPath);
            const temporaryPath = await nodeFs.mkdtemp(
              nodePath.join(outputParent, `${nodePath.basename(input.outputPath)}.tmp-`),
            );
            try {
              await nodeFs.chmod(temporaryPath, 0o700);
              await nodeFs.writeFile(nodePath.join(temporaryPath, "changes.patch"), patch, {
                encoding: "utf8",
                mode: 0o600,
              });
              const filesRoot = nodePath.join(temporaryPath, "files");
              for (const relativePath of transferPaths) {
                const targetPath = nodePath.join(filesRoot, relativePath);
                await nodeFs.mkdir(nodePath.dirname(targetPath), {
                  recursive: true,
                  mode: 0o700,
                });
                await nodeFs.cp(nodePath.join(input.cwd, relativePath), targetPath, {
                  recursive: true,
                  force: false,
                  errorOnExist: true,
                  preserveTimestamps: true,
                });
              }
              await nodeFs.writeFile(
                nodePath.join(temporaryPath, "snapshot.json"),
                JSON.stringify(
                  {
                    sourceWorktree: input.cwd,
                    head,
                    copiedPaths: transferPaths,
                    createdAt: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
                { encoding: "utf8", mode: 0o600 },
              );
              await nodeFs.rm(input.outputPath, { recursive: true, force: true });
              await nodeFs.rename(temporaryPath, input.outputPath);
            } finally {
              await nodeFs.rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
            }
          },
          catch: (cause) =>
            createGitCommandError(
              "GitCore.snapshotWorktree",
              input.cwd,
              ["worktree", "snapshot", input.outputPath],
              "could not snapshot the managed worktree.",
              cause,
            ),
        });
      });

    const readWorktreeIdentity = (worktreePath: string) =>
      Effect.gen(function* () {
        const gitDirResult = yield* executeGit(
          "GitCore.readWorktreeIdentity.gitDir",
          worktreePath,
          ["rev-parse", "--absolute-git-dir"],
        );
        const branchResult = yield* executeGit(
          "GitCore.readWorktreeIdentity.branch",
          worktreePath,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          { allowNonZeroExit: true },
        );
        const headResult = yield* executeGit("GitCore.readWorktreeIdentity.head", worktreePath, [
          "rev-parse",
          "--verify",
          "HEAD",
        ]);
        const statusResult = yield* executeGit(
          "GitCore.readWorktreeIdentity.status",
          worktreePath,
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        );
        const rawGitDir = gitDirResult.stdout.trim();
        const gitDir = yield* Effect.tryPromise({
          try: () => nodeFs.realpath(rawGitDir),
          catch: (cause) =>
            createGitCommandError(
              "GitCore.readWorktreeIdentity.gitDir",
              worktreePath,
              ["rev-parse", "--absolute-git-dir"],
              "could not canonicalize the linked worktree Git directory.",
              cause,
            ),
        });
        return {
          gitDir,
          branch: branchResult.code === 0 ? branchResult.stdout.trim() || null : null,
          head: headResult.stdout.trim(),
          clean: statusResult.stdout.length === 0,
        };
      });

    const recordWorktreeOwnership: GitCoreShape["recordWorktreeOwnership"] = (input) =>
      Effect.gen(function* () {
        const identity = yield* readWorktreeIdentity(input.path);
        if (identity.branch !== input.branch) {
          return yield* new GitCommandError({
            operation: "GitCore.recordWorktreeOwnership",
            command: "git worktree ownership record",
            cwd: input.path,
            detail: `Expected ${input.branch ? `branch ${input.branch}` : "detached HEAD"}, found ${
              identity.branch ? `branch ${identity.branch}` : "detached HEAD"
            }.`,
          });
        }
        const stateHash = yield* readWorktreeStateHash(input.path);
        const proof = {
          token: input.token,
          gitDir: identity.gitDir,
          branch: identity.branch,
          head: identity.head,
          stateHash,
        };
        const markerPath = nodePath.join(identity.gitDir, WORKTREE_OWNERSHIP_MARKER);
        yield* Effect.tryPromise({
          try: () =>
            nodeFs.writeFile(markerPath, JSON.stringify(proof), {
              encoding: "utf8",
              flag: "wx",
              mode: 0o600,
            }),
          catch: (cause) =>
            createGitCommandError(
              "GitCore.recordWorktreeOwnership",
              input.path,
              ["worktree", "ownership", "record"],
              "could not persist the linked worktree ownership marker.",
              cause,
            ),
        });
        return proof;
      });

    const verifyWorktreeOwnership: GitCoreShape["verifyWorktreeOwnership"] = (input) =>
      Effect.gen(function* () {
        const identity = yield* readWorktreeIdentity(input.path);
        if (identity.gitDir !== input.proof.gitDir) {
          return { verified: false, reason: "linked worktree Git directory changed" };
        }
        const markerPath = nodePath.join(identity.gitDir, WORKTREE_OWNERSHIP_MARKER);
        const markerText = yield* Effect.tryPromise({
          try: () =>
            nodeFs.readFile(markerPath, "utf8").catch((cause: unknown) => {
              if (hasNodeErrorCode(cause, "ENOENT")) return null;
              throw cause;
            }),
          catch: (cause) =>
            createGitCommandError(
              "GitCore.verifyWorktreeOwnership",
              input.path,
              ["worktree", "ownership", "verify"],
              "could not read the linked worktree ownership marker.",
              cause,
            ),
        });
        if (markerText === null) {
          return { verified: false, reason: "ownership marker is missing" };
        }
        let marker: unknown;
        try {
          marker = JSON.parse(markerText);
        } catch {
          return { verified: false, reason: "ownership marker is invalid" };
        }
        if (
          typeof marker !== "object" ||
          marker === null ||
          !("token" in marker) ||
          marker.token !== input.proof.token ||
          !("gitDir" in marker) ||
          marker.gitDir !== input.proof.gitDir ||
          !("branch" in marker) ||
          marker.branch !== input.proof.branch ||
          !("head" in marker) ||
          marker.head !== input.proof.head ||
          (input.proof.stateHash === undefined
            ? "stateHash" in marker
            : !("stateHash" in marker) || marker.stateHash !== input.proof.stateHash)
        ) {
          return { verified: false, reason: "ownership marker does not match" };
        }
        if (identity.branch !== input.proof.branch) {
          return { verified: false, reason: "worktree branch changed" };
        }
        if (identity.head !== input.proof.head) {
          return { verified: false, reason: "worktree HEAD changed" };
        }
        if (input.proof.stateHash === undefined) {
          if (!identity.clean) {
            return { verified: false, reason: "worktree has uncommitted changes" };
          }
        } else {
          const stateHash = yield* readWorktreeStateHash(input.path);
          if (stateHash !== input.proof.stateHash) {
            return { verified: false, reason: "worktree state changed" };
          }
        }
        return { verified: true, reason: null };
      });

    const createDetachedWorktree: GitCoreShape["createDetachedWorktree"] = (input) =>
      Effect.gen(function* () {
        const refResult = yield* executeGit(
          "GitCore.createDetachedWorktree.resolveRef",
          input.cwd,
          ["rev-parse", "--verify", "--end-of-options", `${input.ref}^{commit}`],
        );
        const resolvedRef = refResult.stdout.trim();
        if (input.copyChangesFrom) {
          const sourceHead = yield* executeGit(
            "GitCore.createDetachedWorktree.resolveCopySource",
            input.copyChangesFrom,
            ["rev-parse", "--verify", "HEAD^{commit}"],
          ).pipe(Effect.map((result) => result.stdout.trim()));
          if (sourceHead !== resolvedRef) {
            return yield* createGitCommandError(
              "GitCore.createDetachedWorktree",
              input.cwd,
              ["worktree", "add", "--detach", "<path>", input.ref],
              "Cannot copy checkout changes because the selected ref is not that checkout's HEAD.",
            );
          }
        }
        const worktreePath =
          input.path ??
          (yield* buildGeneratedDetachedWorktreePath().pipe(
            Effect.mapError((cause: unknown) =>
              createGitCommandError(
                "GitCore.createDetachedWorktree",
                input.cwd,
                ["worktree", "add", "--detach", "<generated>", input.ref],
                "failed to prepare detached worktree path.",
                cause,
              ),
            ),
          ));

        yield* executeGit("GitCore.createDetachedWorktree", input.cwd, [
          "worktree",
          "add",
          "--detach",
          worktreePath,
          resolvedRef,
        ]);

        if (input.copyChangesFrom) {
          yield* copyCheckoutChanges(input.copyChangesFrom, worktreePath).pipe(
            Effect.onError(() =>
              executeGit(
                "GitCore.createDetachedWorktree.rollback",
                input.cwd,
                ["worktree", "remove", "--force", worktreePath],
                { allowNonZeroExit: true },
              ).pipe(Effect.ignore),
            ),
          );
        }

        return {
          worktree: {
            path: worktreePath,
            ref: resolvedRef,
            branch: null,
          },
        };
      });

    const fetchPullRequestBranch: GitCoreShape["fetchPullRequestBranch"] = (input) =>
      Effect.gen(function* () {
        const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
        yield* executeGit(
          "GitCore.fetchPullRequestBranch",
          input.cwd,
          [
            "fetch",
            "--quiet",
            "--no-tags",
            remoteName,
            `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
          ],
          {
            fallbackErrorMessage: "git fetch pull request branch failed",
          },
        );
      }).pipe(Effect.asVoid);

    const fetchPullRequestCommit: GitCoreShape["fetchPullRequestCommit"] = (input) =>
      Effect.gen(function* () {
        const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
        if (input.expectedRepositoryNameWithOwner) {
          const remoteUrl = yield* runGitStdout(
            "GitCore.fetchPullRequestCommit.remoteUrl",
            input.cwd,
            ["remote", "get-url", remoteName],
          );
          const actualRepositoryNameWithOwner =
            parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
          if (
            actualRepositoryNameWithOwner?.toLowerCase() !==
            input.expectedRepositoryNameWithOwner.toLowerCase()
          ) {
            return yield* createGitCommandError(
              "GitCore.fetchPullRequestCommit.remoteMismatch",
              input.cwd,
              ["remote", "get-url", remoteName],
              `Pull request URL targets ${input.expectedRepositoryNameWithOwner}, but remote ${remoteName} targets ${actualRepositoryNameWithOwner ?? "a non-GitHub repository"}.`,
            );
          }
        }
        yield* executeGit(
          "GitCore.fetchPullRequestCommit",
          input.cwd,
          ["fetch", "--quiet", "--no-tags", remoteName, `refs/pull/${input.prNumber}/head`],
          { fallbackErrorMessage: "git fetch pull request head failed" },
        );
        return yield* executeGit("GitCore.fetchPullRequestCommit.resolve", input.cwd, [
          "rev-parse",
          "--verify",
          "FETCH_HEAD^{commit}",
        ]).pipe(Effect.map((result) => result.stdout.trim()));
      });

    const fetchRemoteBranch: GitCoreShape["fetchRemoteBranch"] = (input) =>
      Effect.gen(function* () {
        yield* runGit("GitCore.fetchRemoteBranch.fetch", input.cwd, [
          "fetch",
          "--quiet",
          "--no-tags",
          input.remoteName,
          `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
        ]);

        const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
        const targetRef = `${input.remoteName}/${input.remoteBranch}`;
        yield* runGit(
          "GitCore.fetchRemoteBranch.materialize",
          input.cwd,
          localBranchAlreadyExists
            ? ["branch", "--force", input.localBranch, targetRef]
            : ["branch", input.localBranch, targetRef],
        );
      }).pipe(Effect.asVoid);

    const setBranchUpstream: GitCoreShape["setBranchUpstream"] = (input) =>
      runGit("GitCore.setBranchUpstream", input.cwd, [
        "branch",
        "--set-upstream-to",
        `${input.remoteName}/${input.remoteBranch}`,
        input.branch,
      ]);

    const removeWorktree: GitCoreShape["removeWorktree"] = (input) =>
      Effect.gen(function* () {
        const args = ["worktree", "remove"];
        if (input.force) {
          args.push("--force");
        }
        args.push(input.path);
        yield* executeGit("GitCore.removeWorktree", input.cwd, args, {
          timeoutMs: 15_000,
          fallbackErrorMessage: "git worktree remove failed",
        }).pipe(
          Effect.mapError((error) =>
            createGitCommandError(
              "GitCore.removeWorktree",
              input.cwd,
              args,
              `${commandLabel(args)} failed (cwd: ${input.cwd}): ${error instanceof Error ? error.message : String(error)}`,
              error,
            ),
          ),
        );
      });

    const deleteBranch: GitCoreShape["deleteBranch"] = (input) =>
      Effect.gen(function* () {
        const args = ["branch", input.force ? "-D" : "-d", "--", input.branch];
        yield* executeGit("GitCore.deleteBranch", input.cwd, args, {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git branch delete failed",
        }).pipe(
          Effect.mapError((error) =>
            createGitCommandError(
              "GitCore.deleteBranch",
              input.cwd,
              args,
              `${commandLabel(args)} failed (cwd: ${input.cwd}): ${error instanceof Error ? error.message : String(error)}`,
              error,
            ),
          ),
        );
      });

    const deleteBranchIfUnchanged: GitCoreShape["deleteBranchIfUnchanged"] = (input) =>
      executeGit("GitCore.deleteBranchIfUnchanged", input.cwd, [
        "update-ref",
        "-d",
        `refs/heads/${input.branch}`,
        input.expectedHead,
      ]).pipe(Effect.asVoid);

    const renameBranch: GitCoreShape["renameBranch"] = (input) =>
      Effect.gen(function* () {
        if (input.oldBranch === input.newBranch) {
          return { branch: input.newBranch };
        }
        const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

        yield* executeGit(
          "GitCore.renameBranch",
          input.cwd,
          ["branch", "-m", "--", input.oldBranch, targetBranch],
          {
            timeoutMs: 10_000,
            fallbackErrorMessage: "git branch rename failed",
          },
        );

        return { branch: targetBranch };
      });

    // Publish branch refs immediately so GitHub-backed workflows can see new worktree branches.
    const publishBranch: GitCoreShape["publishBranch"] = (input) =>
      Effect.gen(function* () {
        const remoteName = yield* resolvePushRemoteName(input.cwd, input.branch);
        if (!remoteName) {
          return yield* createGitCommandError(
            "GitCore.publishBranch",
            input.cwd,
            ["push", "-u", "<remote>", input.branch],
            "Cannot publish branch because no git remote is configured for this repository.",
          );
        }
        yield* executeGit(
          "GitCore.publishBranch",
          input.cwd,
          ["push", "-u", remoteName, input.branch],
          {
            timeoutMs: 30_000,
            fallbackErrorMessage: "git branch publish failed",
          },
        );
      }).pipe(Effect.asVoid);

    const createBranch: GitCoreShape["createBranch"] = (input) =>
      Effect.gen(function* () {
        yield* executeGit("GitCore.createBranch", input.cwd, ["branch", input.branch], {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git branch create failed",
        });
        if (input.publish === true) {
          yield* publishBranch({ cwd: input.cwd, branch: input.branch });
        }
      }).pipe(Effect.asVoid);

    const resolveCheckoutBranchArgs = (input: {
      cwd: string;
      branch: string;
    }): Effect.Effect<readonly string[], GitCommandError> =>
      Effect.gen(function* () {
        const [localInputExists, remoteExists] = yield* Effect.all(
          [
            executeGit(
              "GitCore.checkoutBranch.localInputExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.code === 0)),
            executeGit(
              "GitCore.checkoutBranch.remoteExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/remotes/${input.branch}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.code === 0)),
          ],
          { concurrency: "unbounded" },
        );

        const localTrackingBranch = remoteExists
          ? yield* executeGit(
              "GitCore.checkoutBranch.localTrackingBranch",
              input.cwd,
              ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(
              Effect.map((result) =>
                result.code === 0
                  ? parseTrackingBranchByUpstreamRef(result.stdout, input.branch)
                  : null,
              ),
            )
          : null;

        const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.branch);
        const localTrackedBranchTargetExists =
          remoteExists && localTrackedBranchCandidate
            ? yield* executeGit(
                "GitCore.checkoutBranch.localTrackedBranchTargetExists",
                input.cwd,
                ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
                {
                  timeoutMs: 5_000,
                  allowNonZeroExit: true,
                },
              ).pipe(Effect.map((result) => result.code === 0))
            : false;

        const checkoutArgs = localInputExists
          ? ["checkout", input.branch]
          : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
            ? ["checkout", input.branch]
            : remoteExists && !localTrackingBranch
              ? ["checkout", "--track", input.branch]
              : remoteExists && localTrackingBranch
                ? ["checkout", localTrackingBranch]
                : ["checkout", input.branch];

        return checkoutArgs;
      });

    const checkoutBranch: GitCoreShape["checkoutBranch"] = (input) =>
      Effect.gen(function* () {
        const checkoutArgs = yield* resolveCheckoutBranchArgs(input);
        const result = yield* executeGit(
          "GitCore.checkoutBranch.checkout",
          input.cwd,
          checkoutArgs,
          {
            timeoutMs: 10_000,
            allowNonZeroExit: true,
            fallbackErrorMessage: "git checkout failed",
          },
        );
        if (result.code !== 0) {
          const conflictingFiles = parseDirtyWorktreeFiles(result.stderr);
          if (conflictingFiles) {
            return yield* new GitCheckoutDirtyWorktreeError({
              branch: input.branch,
              cwd: input.cwd,
              conflictingFiles,
            });
          }
          const stderr = result.stderr.trim();
          return yield* createGitCommandError(
            "GitCore.checkoutBranch.checkout",
            input.cwd,
            checkoutArgs,
            stderr.length > 0 ? stderr : "git checkout failed",
          );
        }

        // Refresh upstream refs in the background so checkout remains responsive.
        yield* Effect.forkScoped(
          refreshCheckedOutBranchUpstream(input.cwd).pipe(Effect.ignoreCause({ log: true })),
        );
      });

    const stashAndCheckout: GitCoreShape["stashAndCheckout"] = (input) =>
      Effect.gen(function* () {
        const stashBefore = yield* listStashEntries(
          "GitCore.stashAndCheckout.stashListBefore",
          input.cwd,
        );

        yield* executeGit(
          "GitCore.stashAndCheckout.stashPush",
          input.cwd,
          ["stash", "push", "-u", "-m", `synara: stash before switching to ${input.branch}`],
          {
            timeoutMs: 30_000,
            fallbackErrorMessage: "git stash failed",
          },
        );

        const stashAfter = yield* listStashEntries(
          "GitCore.stashAndCheckout.stashListAfter",
          input.cwd,
        );
        const stashBeforeHashes = new Set(stashBefore.map((entry) => entry.hash));
        const createdStash =
          stashAfter.find((entry) => !stashBeforeHashes.has(entry.hash)) ??
          (stashAfter.length > stashBefore.length ? stashAfter[0] : undefined);

        const checkoutResult = yield* Effect.exit(checkoutBranch(input));
        if (Exit.isFailure(checkoutResult)) {
          if (createdStash) {
            const restoreResult = yield* executeGit(
              "GitCore.stashAndCheckout.restoreAfterCheckoutFailure.apply",
              input.cwd,
              ["stash", "apply", createdStash.hash],
              { timeoutMs: 30_000, allowNonZeroExit: true },
            );
            if (restoreResult.code === 0) {
              yield* dropStashByHash(input.cwd, createdStash.hash).pipe(
                Effect.catchTag("GitCommandError", (error) =>
                  Effect.logWarning(
                    `Could not drop restored stash ${createdStash.hash}: ${error.message}`,
                  ),
                ),
              );
            }
          }
          return yield* Effect.failCause(checkoutResult.cause);
        }

        if (!createdStash) return;

        // Apply first, then drop only after success so failed/conflicted reapplies keep the stash intact.
        const applyResult = yield* executeGit(
          "GitCore.stashAndCheckout.stashApply",
          input.cwd,
          ["stash", "apply", createdStash.hash],
          { timeoutMs: 30_000, allowNonZeroExit: true },
        );
        if (applyResult.code === 0) {
          yield* dropStashByHash(input.cwd, createdStash.hash).pipe(
            Effect.catchTag("GitCommandError", (error) =>
              Effect.logWarning(
                `Could not drop reapplied stash ${createdStash.hash}: ${error.message}`,
              ),
            ),
          );
          return;
        }

        yield* executeGit(
          "GitCore.stashAndCheckout.abortConflictedApply",
          input.cwd,
          ["reset", "--hard"],
          { timeoutMs: 30_000, allowNonZeroExit: true },
        ).pipe(Effect.ignore);
        yield* executeGit(
          "GitCore.stashAndCheckout.cleanConflictedApply",
          input.cwd,
          ["clean", "-fd"],
          { timeoutMs: 30_000, allowNonZeroExit: true },
        ).pipe(Effect.ignore);

        return yield* createGitCommandError(
          "GitCore.stashAndCheckout.stashApply",
          input.cwd,
          ["stash", "apply", createdStash.hash],
          "Stash could not be applied. Your changes are still saved in the stash.",
        );
      });

    const stashDrop: GitCoreShape["stashDrop"] = (input) =>
      executeGit("GitCore.stashDrop", input.cwd, ["stash", "drop", input.stashRef], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git stash drop failed",
      }).pipe(Effect.asVoid);

    const stashInfo: GitCoreShape["stashInfo"] = (input) =>
      Effect.gen(function* () {
        const stashLine = (yield* runGitStdout("GitCore.stashInfo.list", input.cwd, [
          "stash",
          "list",
          "-n",
          "1",
          "--format=%gd%x09%gs",
        ])).trim();
        const separatorIndex = stashLine.indexOf("\t");
        const stashRef =
          separatorIndex >= 0 ? stashLine.slice(0, separatorIndex).trim() : stashLine.trim();
        const message =
          separatorIndex >= 0 ? stashLine.slice(separatorIndex + 1).trim() : stashLine.trim();
        if (stashRef.length === 0 || message.length === 0) {
          return yield* createGitCommandError(
            "GitCore.stashInfo",
            input.cwd,
            ["stash", "list", "-n", "1", "--format=%gd%x09%gs"],
            "No stash entry is available.",
          );
        }

        const branchOutput = yield* runGitStdout("GitCore.stashInfo.branch", input.cwd, [
          "branch",
          "--show-current",
        ]).pipe(Effect.catch(() => Effect.succeed("")));
        const filesOutput = yield* runGitStdout("GitCore.stashInfo.files", input.cwd, [
          "stash",
          "show",
          "--include-untracked",
          "--name-only",
          stashRef,
        ]).pipe(Effect.catch(() => Effect.succeed("")));

        return {
          cwd: input.cwd,
          branch: branchOutput.trim() || null,
          stashRef,
          message,
          files: parseNonEmptyLineList(filesOutput),
        };
      });

    const removeIndexLock: GitCoreShape["removeIndexLock"] = (input) =>
      Effect.gen(function* () {
        const lockPathOutput = yield* runGitStdout(
          "GitCore.removeIndexLock.resolvePath",
          input.cwd,
          ["rev-parse", "--git-path", "index.lock"],
        );
        const rawLockPath = lockPathOutput.trim();
        if (rawLockPath.length === 0 || nodePath.basename(rawLockPath) !== "index.lock") {
          return yield* createGitCommandError(
            "GitCore.removeIndexLock",
            input.cwd,
            ["rev-parse", "--git-path", "index.lock"],
            "Git did not return a valid index lock path.",
          );
        }

        const lockPath = nodePath.isAbsolute(rawLockPath)
          ? rawLockPath
          : nodePath.resolve(input.cwd, rawLockPath);
        yield* fileSystem
          .remove(lockPath)
          .pipe(
            Effect.mapError((cause) =>
              createGitCommandError(
                "GitCore.removeIndexLock",
                input.cwd,
                ["rm", lockPath],
                cause.message,
                cause,
              ),
            ),
          );
      });

    const initRepo: GitCoreShape["initRepo"] = (input) =>
      executeGit("GitCore.initRepo", input.cwd, ["init"], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git init failed",
      }).pipe(Effect.asVoid);

    const listLocalBranchNames: GitCoreShape["listLocalBranchNames"] = (cwd) =>
      runGitStdout("GitCore.listLocalBranchNames", cwd, [
        "branch",
        "--list",
        "--format=%(refname:short)",
      ]).pipe(
        Effect.map((stdout) =>
          stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        ),
      );

    const stageFiles: GitCoreShape["stageFiles"] = (cwd, paths) =>
      runGit("GitCore.stageFiles", cwd, ["add", "--", ...paths]);

    const unstageFiles: GitCoreShape["unstageFiles"] = (cwd, paths) =>
      Effect.gen(function* () {
        // `git reset` resolves against HEAD, which does not exist before the first
        // commit. Fall back to `git rm --cached` so newly staged files can still be
        // unstaged in a freshly initialized repository.
        const headExists = yield* executeGit(
          "GitCore.unstageFiles.headExists",
          cwd,
          ["rev-parse", "--verify", "HEAD"],
          { allowNonZeroExit: true },
        ).pipe(Effect.map((result) => result.code === 0));

        yield* runGit(
          "GitCore.unstageFiles",
          cwd,
          headExists
            ? ["reset", "-q", "HEAD", "--", ...paths]
            : ["rm", "--cached", "-q", "--", ...paths],
        );
      });

    return {
      withMutation,
      execute,
      status,
      statusDetails,
      readWorkingTreePatch,
      readUnstagedPatch,
      readStagedPatch,
      readBranchPatch,
      prepareCommitContext,
      commit,
      pushCurrentBranch,
      pullCurrentBranch,
      readRangeContext,
      readConfigValue,
      listBranches,
      createWorktree,
      recordWorktreeOwnership,
      verifyWorktreeOwnership,
      snapshotWorktree,
      createDetachedWorktree,
      fetchPullRequestBranch,
      fetchPullRequestCommit,
      ensureRemote,
      fetchRemoteBranch,
      setBranchUpstream,
      removeWorktree,
      deleteBranch,
      deleteBranchIfUnchanged,
      renameBranch,
      createBranch,
      publishBranch,
      checkoutBranch,
      stashAndCheckout,
      stashDrop,
      stashInfo,
      removeIndexLock,
      initRepo,
      listLocalBranchNames,
      stageFiles,
      unstageFiles,
    } satisfies GitCoreShape;
  });

export const GitCoreLive = Layer.effect(GitCore, makeGitCore());
