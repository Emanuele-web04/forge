// FILE: GitCore.test.ts
// Purpose: Exercises GitCore repository operations, branch/worktree flows, and status summaries.
// Layer: Server Git service tests
// Depends on: Effect test layers plus real temporary Git repositories.
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, PlatformError, Schema, Scope, Stream } from "effect";
import { describe, expect, vi } from "vitest";
import { TestClock } from "effect/testing";

import { collectGitOutput, GitCoreLive, makeGitCore } from "./GitCore.ts";
import { GitCore, type GitCoreShape } from "../Services/GitCore.ts";
import { GitCheckoutDirtyWorktreeError, GitCommandError } from "../Errors.ts";
import { type ProcessRunResult, runProcess } from "../../processRunner.ts";
import { ServerConfig } from "../../config.ts";

// ── Helpers ──

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-git-core-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer);

function makeTmpDir(
  prefix = "git-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function readTextFile(
  filePath: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(filePath);
  });
}

/** Run a raw git command for test setup (not under test). */
function git(
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const result = yield* gitCore.execute({
      operation: "GitCore.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function runTruncatedNodeCommand(input: {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Effect.Effect<ProcessRunResult, Error> {
  return Effect.promise(() =>
    runProcess("node", ["-e", "process.stdout.write('x'.repeat(2000))"], {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 30_000,
      allowNonZeroExit: true,
      maxBufferBytes: input.maxOutputBytes ?? 1_000_000,
      outputMode: "truncate",
    }),
  );
}

const makeIsolatedGitCore = (executeOverride: GitCoreShape["execute"]) =>
  makeGitCore({ executeOverride }).pipe(
    Effect.provide(Layer.provideMerge(ServerConfigLayer, NodeServices.layer)),
  );

/** Create a repo with an initial commit so branches work. */
function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  { initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });
}

function initRepoWithoutCommit(cwd: string): Effect.Effect<void, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
  });
}

function commitWithDate(
  cwd: string,
  fileName: string,
  fileContents: string,
  dateIsoString: string,
  message: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* writeTextFile(path.join(cwd, fileName), fileContents);
    yield* git(cwd, ["add", fileName]);
    yield* git(cwd, ["commit", "-m", message], {
      ...process.env,
      GIT_AUTHOR_DATE: dateIsoString,
      GIT_COMMITTER_DATE: dateIsoString,
    });
  });
}

// ── Tests ──

it.layer(TestLayer)("git integration", (it) => {
  describe("shell process execution", () => {
    it.effect("caps captured output when maxOutputBytes is exceeded", () =>
      Effect.gen(function* () {
        const result = yield* runTruncatedNodeCommand({
          cwd: process.cwd(),
          timeoutMs: 10_000,
          maxOutputBytes: 128,
        });

        expect(result.code).toBe(0);
        expect(result.stdout.length).toBeLessThanOrEqual(128);
        expect(result.stdoutTruncated || result.stderrTruncated).toBe(true);
      }),
    );
  });

  describe("bounded working-tree and ref reads", () => {
    it.effect("streams rename metadata beyond the capture limit for a selected file", () =>
      Effect.gen(function* () {
        const realCore = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const names = Array.from({ length: 24 }, (_, index) => `file-${index}.txt`);
        for (const name of names) {
          yield* writeTextFile(path.join(tmp, name), `${name}\n`.repeat(10));
        }
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "rename sources"]);
        for (const name of names) yield* git(tmp, ["mv", name, `moved-${name}`]);
        const metadata = yield* realCore.execute({
          operation: "test rename metadata",
          cwd: tmp,
          args: ["diff", "--name-status", "-z", "HEAD"],
        });
        expect(metadata.stdout.length).toBeGreaterThan(128);
        const core = yield* makeIsolatedGitCore((input) =>
          realCore.execute({
            ...input,
            ...(input.operation === "GitCore.readWorkingTreePatch.renamePaths"
              ? { maxOutputBytes: 128 }
              : {}),
          }),
        );
        const patch = (yield* core.readWorkingTreePatch(tmp, "moved-file-9.txt")).patch;
        expect(patch).toContain("rename from file-9.txt");
        expect(patch).toContain("rename to moved-file-9.txt");
        expect(patch).not.toContain("moved-file-8.txt");
        expect(patch).not.toContain("new file mode");
      }),
    );

    it.effect("preserves a regular-file to gitlink type change against the ref", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        const sub = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* initRepoWithCommit(sub);
        yield* writeTextFile(path.join(tmp, "vendor"), "old file\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "old file"]);
        yield* git(tmp, ["rm", "vendor"]);
        yield* git(tmp, ["-c", "protocol.file.allow=always", "submodule", "add", sub, "vendor"]);
        const patch = (yield* core.readRefPatch(tmp, "HEAD")).patch;
        expect(patch).toContain("new file mode 160000");
        expect(patch).toContain("+Subproject commit ");
        expect(yield* core.readDiffStats(tmp, "ref", "HEAD")).toEqual({
          additions: 4,
          deletions: 1,
          fileCount: 2,
        });
        yield* git(tmp, ["submodule", "deinit", "-f", "vendor"]);
        expect((yield* core.readRefPatch(tmp, "HEAD")).patch).toContain("new file mode 160000");
        expect(yield* core.readDiffStats(tmp, "ref", "HEAD")).toEqual({
          additions: 4,
          deletions: 1,
          fileCount: 2,
        });
      }),
    );

    it.effect("preserves an updated stage-zero gitlink when the module is uninitialized", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        const sub = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* initRepoWithCommit(sub);
        yield* git(tmp, ["-c", "protocol.file.allow=always", "submodule", "add", sub, "vendor"]);
        yield* git(tmp, ["commit", "-am", "initial module"]);
        const module = path.join(tmp, "vendor");
        yield* git(module, ["config", "user.email", "test@test.com"]);
        yield* git(module, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(module, "next.txt"), "next commit\n");
        yield* git(module, ["add", "."]);
        yield* git(module, ["commit", "-m", "next"]);
        const nextCommit = yield* git(module, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["add", "vendor"]);
        yield* git(tmp, ["submodule", "deinit", "-f", "vendor"]);
        const patch = (yield* core.readRefPatch(tmp, "HEAD")).patch;
        expect(patch).toContain(`+Subproject commit ${nextCommit}`);
        expect(yield* core.readDiffStats(tmp, "ref", "HEAD")).toEqual({
          additions: 1,
          deletions: 1,
          fileCount: 1,
        });
      }),
    );

    for (const edited of [false, true]) {
      it.effect(
        "preserves " + (edited ? "edited" : "pure") + " rename metadata in a destination-only read",
        () =>
          Effect.gen(function* () {
            const core = yield* GitCore;
            const tmp = yield* makeTmpDir();
            yield* initRepoWithCommit(tmp);
            yield* writeTextFile(path.join(tmp, "old.txt"), "unchanged\n".repeat(20));
            yield* git(tmp, ["add", "."]);
            yield* git(tmp, ["commit", "-m", "base"]);
            yield* git(tmp, ["mv", "old.txt", "new.txt"]);
            if (edited) {
              yield* writeTextFile(
                path.join(tmp, "new.txt"),
                "unchanged\n".repeat(19) + "edited\n",
              );
            }
            const fullPatch = (yield* core.readWorkingTreePatch(tmp)).patch;
            expect((yield* core.readWorkingTreePatch(tmp, "new.txt")).patch).toBe(fullPatch);
            expect(fullPatch).toContain("rename from old.txt");
            expect(fullPatch).toContain("rename to new.txt");
          }),
      );
    }

    it.effect("keeps an ignored renamed symbolic link as a link in ref comparisons", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, ".gitignore"), "new-link\n");
        yield* Effect.promise(() => fs.symlink("README.md", path.join(tmp, "old-link")));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "link"]);
        yield* Effect.promise(() =>
          fs.rename(path.join(tmp, "old-link"), path.join(tmp, "new-link")),
        );
        yield* git(tmp, ["add", "-u"]);
        yield* git(tmp, ["add", "-f", "new-link"]);
        const patch = (yield* core.readRefPatch(tmp, "HEAD")).patch;
        expect(patch).toContain("new file mode 120000");
        expect(patch).toContain("+README.md");
        expect(yield* core.readDiffStats(tmp, "ref", "HEAD")).toEqual({
          additions: 1,
          deletions: 1,
          fileCount: 2,
        });
      }),
    );

    it.effect("keeps progress lines after the retained prefix fills across chunks", () =>
      Effect.gen(function* () {
        const lines: string[] = [];
        const output = yield* collectGitOutput(
          { operation: "test output", cwd: process.cwd(), args: ["clone"] },
          Stream.fromIterable(
            ["first\nsecond\n", "third\nfourth\n"].map((text) => new TextEncoder().encode(text)),
          ),
          8,
          (line) =>
            Effect.sync(() => {
              lines.push(line);
            }),
          "truncate",
        );
        expect(output).toBe("first\nse");
        expect(lines).toEqual(["first", "second", "third", "fourth"]);
      }),
    );

    it.effect("preserves NUL-delimited paths across byte chunks beyond the capture limit", () =>
      Effect.gen(function* () {
        const records = ["R100", "old\r\nname", "new é\tname"];
        const bytes = new TextEncoder().encode(records.join("\0") + "\0");
        const received: string[] = [];
        const output = yield* collectGitOutput(
          { operation: "test paths", cwd: process.cwd(), args: ["diff"] },
          Stream.fromIterable(Array.from(bytes, (byte) => Uint8Array.of(byte))),
          16,
          (record) =>
            Effect.sync(() => {
              received.push(record);
            }),
          "truncate",
          "\0",
        );
        expect(output).toBe(new TextDecoder().decode(bytes).slice(0, 16));
        expect(received).toEqual(records);
      }),
    );

    it.effect("includes a force-added ignored rename destination with its file mode", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, ".gitignore"), "renamed.sh\n");
        yield* writeTextFile(path.join(tmp, "old.sh"), "echo unchanged\n".repeat(5));
        yield* Effect.promise(() => fs.chmod(path.join(tmp, "old.sh"), 0o755));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "base"]);
        yield* Effect.promise(() =>
          fs.rename(path.join(tmp, "old.sh"), path.join(tmp, "renamed.sh")),
        );
        yield* git(tmp, ["add", "-u"]);
        yield* git(tmp, ["add", "-f", "renamed.sh"]);
        const patch = (yield* core.readRefPatch(tmp, "HEAD")).patch;
        expect(patch).toContain("b/renamed.sh");
        expect(patch).toContain("new file mode 100755");
        expect(yield* core.readDiffStats(tmp, "ref", "HEAD")).toEqual({
          additions: 5,
          deletions: 5,
          fileCount: 2,
        });
      }),
    );

    for (const initialized of [true, false]) {
      it.effect(
        `includes a new ${initialized ? "initialized" : "uninitialized"} gitlink and preserves the real index`,
        () =>
          Effect.gen(function* () {
            const core = yield* GitCore;
            const tmp = yield* makeTmpDir();
            const sub = yield* makeTmpDir();
            yield* initRepoWithCommit(tmp);
            yield* initRepoWithCommit(sub);
            yield* git(tmp, [
              "-c",
              "protocol.file.allow=always",
              "submodule",
              "add",
              sub,
              "vendor",
            ]);
            if (!initialized) {
              yield* git(tmp, ["submodule", "deinit", "-f", "vendor"]);
            }
            const indexBefore = yield* Effect.promise(() =>
              fs.readFile(path.join(tmp, ".git", "index")),
            );
            const patch = (yield* core.readRefPatch(tmp, "HEAD")).patch;
            expect(patch).toContain("new file mode 160000");
            expect(patch).toContain("+Subproject commit ");
            expect(patch.match(/diff --git a\/vendor b\/vendor/g)).toHaveLength(1);
            expect(yield* core.readDiffStats(tmp, "ref", "HEAD")).toEqual({
              additions: 4,
              deletions: 0,
              fileCount: 2,
            });
            const indexAfter = yield* Effect.promise(() =>
              fs.readFile(path.join(tmp, ".git", "index")),
            );
            expect(indexAfter).toEqual(indexBefore);
          }),
      );
    }

    it.effect("reads literal numeric-colon filenames from index stage zero", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "1:foo.txt"), "literal filename\n");
        yield* git(tmp, ["add", "--", "1:foo.txt"]);
        expect(
          yield* core.readFileAtRev({
            cwd: tmp,
            filePath: "1:foo.txt",
            base: "index",
          }),
        ).toMatchObject({ missing: false, contents: "literal filename\n" });
      }),
    );

    it.effect("bounds tracked and untracked patches to a literal requested file", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "[a].txt"), "before\n");
        yield* writeTextFile(path.join(tmp, "a.txt"), "before\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "files"]);
        yield* writeTextFile(path.join(tmp, "[a].txt"), "selected\n");
        yield* writeTextFile(path.join(tmp, "a.txt"), "unrelated\n");
        yield* writeTextFile(path.join(tmp, "untracked.txt"), "new selected\n");
        const tracked = (yield* core.readWorkingTreePatch(tmp, "[a].txt")).patch;
        expect(tracked).toContain("+selected");
        expect(tracked).not.toContain("unrelated");
        expect(tracked).not.toContain("untracked.txt");
        const untracked = (yield* core.readWorkingTreePatch(tmp, "untracked.txt")).patch;
        expect(untracked).toContain("+new selected");
        expect(untracked).not.toContain("a.txt");
        expect((yield* core.readWorkingTreePatch(tmp, "missing.txt")).patch).toBe("");
      }),
    );

    it.effect("bounds unborn and ignored staged rename destinations without unrelated files", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithoutCommit(tmp);
        yield* writeTextFile(path.join(tmp, "selected.txt"), "selected\n");
        yield* writeTextFile(path.join(tmp, "other.txt"), "other\n");
        yield* git(tmp, ["add", "."]);
        expect((yield* core.readWorkingTreePatch(tmp, "selected.txt")).patch).not.toContain(
          "other.txt",
        );
        yield* writeTextFile(path.join(tmp, ".gitignore"), "renamed.txt\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "base"]);
        yield* Effect.promise(() =>
          fs.rename(path.join(tmp, "selected.txt"), path.join(tmp, "renamed.txt")),
        );
        yield* git(tmp, ["add", "-u"]);
        yield* git(tmp, ["add", "-f", "renamed.txt"]);
        yield* writeTextFile(path.join(tmp, "other.txt"), "unrelated change\n");
        const patch = (yield* core.readWorkingTreePatch(tmp, "renamed.txt")).patch;
        expect(patch).toContain("b/renamed.txt");
        expect(patch).not.toContain("other.txt");
      }),
    );

    it.effect("rejects traversal and directories instead of expanding a file request", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* Effect.promise(() => fs.mkdir(path.join(tmp, "folder")));
        yield* writeTextFile(path.join(tmp, "folder", "child.txt"), "child\n");
        for (const filePath of ["../outside.txt", "/tmp/outside.txt", "folder", "folder/", ""]) {
          const exit = yield* core.readWorkingTreePatch(tmp, filePath).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
        }
      }),
    );
  });

  describe("blameLine", () => {
    it.effect("attributes a committed line at a resolved revision", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sha = yield* git(tmp, ["rev-parse", "HEAD"]);

        const result = yield* core.blameLine({
          cwd: tmp,
          filePath: "README.md",
          line: 1,
          rev: "HEAD",
        });

        expect(result.sha).toBe(sha);
        expect(result.uncommitted).toBe(false);
      }),
    );

    it.effect("blames a deleted line at the branch diff's merge base", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const baseSha = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["checkout", "-b", "feature"]);
        yield* git(tmp, ["branch", `--set-upstream-to=${initialBranch}`]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# rewritten\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "rewrite readme"]);

        const result = yield* core.blameLine({
          cwd: tmp,
          filePath: "README.md",
          line: 1,
          base: "branch",
        });

        expect(result.sha).toBe(baseSha);
      }),
    );

    it.effect("rejects an option-like revision before invoking blame", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const error = yield* core
          .blameLine({
            cwd: tmp,
            filePath: "README.md",
            line: 1,
            rev: "--contents=/etc/passwd",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain("not a valid revision");
      }),
    );

    it.effect("reports lines in a repository without commits as uncommitted", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* core.initRepo({ cwd: tmp });
        yield* writeTextFile(path.join(tmp, "first.ts"), "fresh\n");

        const result = yield* core.blameLine({ cwd: tmp, filePath: "first.ts", line: 1 });

        expect(result.uncommitted).toBe(true);
      }),
    );

    it.effect("reports working-tree lines of a file HEAD does not know as uncommitted", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "untracked.ts"), "fresh\n");

        const result = yield* core.blameLine({ cwd: tmp, filePath: "untracked.ts", line: 1 });

        expect(result.uncommitted).toBe(true);
        expect(result.shortSha).toBe("");
      }),
    );
  });

  describe("readFileAtRev", () => {
    it.effect("reads the committed blob, not the working tree copy", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "src.ts"), "committed\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add src"]);
        yield* writeTextFile(path.join(tmp, "src.ts"), "working tree\n");

        const result = yield* core.readFileAtRev({ cwd: tmp, filePath: "src.ts" });

        expect(result.contents).toBe("committed\n");
        expect(result.missing).toBe(false);
        expect(result.truncated).toBe(false);
        expect(result.resolvedRev).toMatch(/^[0-9a-f]{40}$/);
      }),
    );

    it.effect("reports a path that does not exist at the revision as missing", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "added.ts"), "brand new\n");

        const result = yield* core.readFileAtRev({ cwd: tmp, filePath: "added.ts" });

        expect(result).toMatchObject({ contents: "", missing: true, truncated: false });
      }),
    );

    it.effect("reads the branch base from the upstream merge base", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "src.ts"), "base\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "base"]);
        const mergeBase = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["checkout", "-b", "feature"]);
        yield* git(tmp, ["branch", `--set-upstream-to=${initialBranch}`]);
        yield* writeTextFile(path.join(tmp, "src.ts"), "feature\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "feature"]);

        const result = yield* core.readFileAtRev({
          cwd: tmp,
          filePath: "src.ts",
          base: "branch",
        });

        expect(result.resolvedRev).toBe(mergeBase);
        expect(result.contents).toBe("base\n");
      }),
    );

    it.effect("fails when the requested revision does not resolve", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const error = yield* core
          .readFileAtRev({ cwd: tmp, filePath: "README.md", rev: "deleted-branch" })
          .pipe(Effect.flip);

        expect(error.message).toContain("Cannot resolve");
      }),
    );

    it.effect("reads the staged blob when the base is the index", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "src.ts"), "committed\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add src"]);
        yield* writeTextFile(path.join(tmp, "src.ts"), "staged\n");
        yield* git(tmp, ["add", "src.ts"]);
        yield* writeTextFile(path.join(tmp, "src.ts"), "working tree\n");

        const result = yield* core.readFileAtRev({ cwd: tmp, filePath: "src.ts", base: "index" });

        expect(result.contents).toBe("staged\n");
        expect(result.resolvedRev).toBe("index");
        expect(result.missing).toBe(false);
      }),
    );

    it.effect("reads the branch base from the fallback base when there is no upstream", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "src.ts"), "base\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "base"]);
        const mergeBase = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["checkout", "-b", "feature"]);
        // The branch diff falls back to a default base branch name when the
        // current branch tracks nothing; pin one so the fixture is deterministic.
        yield* git(tmp, ["branch", "-f", "main", mergeBase]);
        yield* writeTextFile(path.join(tmp, "src.ts"), "feature\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "feature"]);

        const result = yield* core.readFileAtRev({
          cwd: tmp,
          filePath: "src.ts",
          base: "branch",
        });

        expect(result.resolvedRev).toBe(mergeBase);
        expect(result.contents).toBe("base\n");
      }),
    );

    it.effect("marks a blob larger than the byte budget as truncated", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "big.txt"), "x".repeat(500));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "big"]);

        const result = yield* core.readFileAtRev({
          cwd: tmp,
          filePath: "big.txt",
          maxBytes: 100,
        });

        expect(result.truncated).toBe(true);
        expect(result.contents.length).toBeLessThanOrEqual(100);
      }),
    );

    it.effect("rejects paths that escape the workspace", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const error = yield* core
          .readFileAtRev({ cwd: tmp, filePath: "../outside.ts" })
          .pipe(Effect.flip);

        expect(error.message).toContain("workspace-relative");
      }),
    );
  });

  // ── initGitRepo ──

  describe("initGitRepo", () => {
    it.effect("creates a valid git repo", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* (yield* GitCore).initRepo({ cwd: tmp });
        expect(existsSync(path.join(tmp, ".git"))).toBe(true);
      }),
    );

    it.effect("listGitBranches reports isRepo: true after init + commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.isRepo).toBe(true);
        expect(result.hasOriginRemote).toBe(false);
        expect(result.branches.length).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  // ── listGitBranches ──

  describe("listGitBranches", () => {
    it.effect("returns isRepo: false for non-git directory", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.isRepo).toBe(false);
        expect(result.hasOriginRemote).toBe(false);
        expect(result.branches).toEqual([]);
      }),
    );

    it.effect("returns the current branch with current: true", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current).toBeDefined();
        expect(current!.current).toBe(true);
      }),
    );

    it.effect("does not include detached HEAD pseudo-refs as branches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["checkout", "--detach", "HEAD"]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.some((branch) => branch.name.startsWith("("))).toBe(false);
        expect(result.branches.some((branch) => branch.current)).toBe(false);
      }),
    );

    it.effect("keeps current branch first and sorts the remaining branches by recency", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "older-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "older-branch" });
        yield* commitWithDate(
          tmp,
          "older.txt",
          "older branch change\n",
          "Thu, 1 Jan 2037 00:00:00 +0000",
          "older branch change",
        );

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: initialBranch });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "newer-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "newer-branch" });
        yield* commitWithDate(
          tmp,
          "newer.txt",
          "newer branch change\n",
          "Fri, 1 Jan 2038 00:00:00 +0000",
          "newer branch change",
        );

        // Switch away to show current branch is pinned, then remaining branches are recency-sorted.
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "older-branch" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches[0]!.name).toBe("older-branch");
        expect(result.branches[1]!.name).toBe("newer-branch");
      }),
    );

    it.effect("keeps default branch right after current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", defaultBranch]);
        yield* git(tmp, ["remote", "set-head", "origin", defaultBranch]);

        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "current-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "current-branch" });
        yield* commitWithDate(
          tmp,
          "current.txt",
          "current change\n",
          "Thu, 1 Jan 2037 00:00:00 +0000",
          "current change",
        );

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: defaultBranch });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "newer-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "newer-branch" });
        yield* commitWithDate(
          tmp,
          "newer.txt",
          "newer change\n",
          "Fri, 1 Jan 2038 00:00:00 +0000",
          "newer change",
        );

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "current-branch" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches[0]!.name).toBe("current-branch");
        expect(result.branches[1]!.name).toBe(defaultBranch);
        expect(result.branches[2]!.name).toBe("newer-branch");
      }),
    );

    it.effect("lists multiple branches after creating them", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-a" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-b" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const names = result.branches.map((b) => b.name);
        expect(names).toContain("feature-a");
        expect(names).toContain("feature-b");
      }),
    );

    it.effect("isDefault is false when no remote exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.every((b) => b.isDefault === false)).toBe(true);
      }),
    );

    it.effect("lists local branches first and remote branches last", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const tmp = yield* makeTmpDir();

        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", defaultBranch]);

        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/local-only" });

        const remoteOnlyBranch = "feature/remote-only";
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: defaultBranch });
        yield* git(tmp, ["checkout", "-b", remoteOnlyBranch]);
        yield* git(tmp, ["push", "-u", "origin", remoteOnlyBranch]);
        yield* git(tmp, ["checkout", defaultBranch]);
        yield* git(tmp, ["branch", "-D", remoteOnlyBranch]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const firstRemoteIndex = result.branches.findIndex((branch) => branch.isRemote);

        expect(result.hasOriginRemote).toBe(true);
        expect(firstRemoteIndex).toBeGreaterThan(0);
        expect(result.branches.slice(0, firstRemoteIndex).every((branch) => !branch.isRemote)).toBe(
          true,
        );
        expect(result.branches.slice(firstRemoteIndex).every((branch) => branch.isRemote)).toBe(
          true,
        );
        expect(
          result.branches.some(
            (branch) => branch.name === "feature/local-only" && !branch.isRemote,
          ),
        ).toBe(true);
        expect(
          result.branches.some(
            (branch) => branch.name === "origin/feature/remote-only" && branch.isRemote,
          ),
        ).toBe(true);
      }),
    );

    it.effect("includes remoteName metadata for remotes with slash in the name", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const tmp = yield* makeTmpDir();
        const remoteName = "my-org/upstream";

        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(tmp, ["remote", "add", remoteName, remote]);
        yield* git(tmp, ["push", "-u", remoteName, defaultBranch]);

        const remoteOnlyBranch = "feature/remote-with-remote-name";
        yield* git(tmp, ["checkout", "-b", remoteOnlyBranch]);
        yield* git(tmp, ["push", "-u", remoteName, remoteOnlyBranch]);
        yield* git(tmp, ["checkout", defaultBranch]);
        yield* git(tmp, ["branch", "-D", remoteOnlyBranch]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const remoteBranch = result.branches.find(
          (branch) => branch.name === `${remoteName}/${remoteOnlyBranch}`,
        );

        expect(remoteBranch).toBeDefined();
        expect(remoteBranch?.isRemote).toBe(true);
        expect(remoteBranch?.remoteName).toBe(remoteName);
      }),
    );
  });

  // ── checkoutGitBranch ──

  describe("checkoutGitBranch", () => {
    it.effect("checks out an existing branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature" });

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current!.name).toBe("feature");
      }),
    );

    it.effect("refreshes upstream behind count after checkout when remote branch advanced", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature-behind";
        yield* (yield* GitCore).createBranch({ cwd: source, branch: featureBranch });
        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: featureBranch });
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: defaultBranch });

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* git(clone, ["checkout", "-b", featureBranch, "--track", `origin/${featureBranch}`]);
        yield* writeTextFile(path.join(clone, "feature.txt"), "feature from remote\n");
        yield* git(clone, ["add", "feature.txt"]);
        yield* git(clone, ["commit", "-m", "remote feature update"]);
        yield* git(clone, ["push", "origin", featureBranch]);

        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: featureBranch });
        const core = yield* GitCore;
        yield* Effect.promise(() =>
          vi.waitFor(
            async () => {
              const details = await Effect.runPromise(core.statusDetails(source));
              expect(details.branch).toBe(featureBranch);
              expect(details.aheadCount).toBe(0);
              expect(details.behindCount).toBe(1);
            },
            { timeout: 20_000 },
          ),
        );
      }),
    );

    it.effect("keeps checkout successful when upstream refresh fails", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature-refresh-failure";
        yield* git(source, ["branch", featureBranch]);
        yield* git(source, ["checkout", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitCore = yield* GitCore;
        let refreshFetchAttempts = 0;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "fetch") {
            refreshFetchAttempts += 1;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.refreshFailure",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "simulated fetch timeout",
              }),
            );
          }
          return realGitCore.execute(input);
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(refreshFetchAttempts).toBe(1);
          }),
        );
        expect(yield* git(source, ["branch", "--show-current"])).toBe(featureBranch);
      }),
    );

    it.effect("refresh fetch is scoped to the checked out branch upstream refspec", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature/scoped-fetch";
        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitCore = yield* GitCore;
        let fetchArgs: readonly string[] | null = null;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "fetch") {
            fetchArgs = [...input.args];
            return Effect.succeed({ code: 0, stdout: "", stderr: "" });
          }
          return realGitCore.execute(input);
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(fetchArgs).not.toBeNull();
          }),
        );

        expect(yield* git(source, ["branch", "--show-current"])).toBe(featureBranch);
        expect(fetchArgs).toEqual([
          "fetch",
          "--quiet",
          "--no-tags",
          "origin",
          `+refs/heads/${featureBranch}:refs/remotes/origin/${featureBranch}`,
        ]);
      }),
    );

    it.effect("returns checkout result before background upstream refresh completes", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature/background-refresh";
        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitCore = yield* GitCore;
        let fetchStarted = false;
        let releaseFetch!: () => void;
        const waitForReleasePromise = new Promise<void>((resolve) => {
          releaseFetch = resolve;
        });
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "fetch") {
            fetchStarted = true;
            return Effect.promise(() =>
              waitForReleasePromise.then(() => ({ code: 0, stdout: "", stderr: "" })),
            );
          }
          return realGitCore.execute(input);
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(fetchStarted).toBe(true);
          }),
        );
        expect(yield* git(source, ["branch", "--show-current"])).toBe(featureBranch);
        releaseFetch();
      }),
    );

    it.effect("throws when branch does not exist", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "nonexistent" }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("does not silently checkout a local branch when a remote ref no longer exists", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        yield* (yield* GitCore).createBranch({ cwd: source, branch: "feature" });

        const checkoutResult = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: source, branch: "origin/feature" }),
        );
        expect(checkoutResult._tag).toBe("Failure");
        expect(yield* git(source, ["branch", "--show-current"])).toBe(defaultBranch);
      }),
    );

    it.effect("checks out a remote tracking branch when remote name contains slashes", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const remoteName = "my-org/upstream";
        const featureBranch = "feature";
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", remoteName, remote]);
        yield* git(source, ["push", "-u", remoteName, defaultBranch]);

        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature content\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature commit"]);
        yield* git(source, ["push", "-u", remoteName, featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);
        yield* git(source, ["branch", "-D", featureBranch]);

        yield* (yield* GitCore).checkoutBranch({
          cwd: source,
          branch: `${remoteName}/${featureBranch}`,
        });

        expect(yield* git(source, ["branch", "--show-current"])).toBe("upstream/feature");
      }),
    );

    it.effect(
      "falls back to detached checkout when --track would conflict with an existing local branch",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const defaultBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", defaultBranch]);

          // Keep local branch but remove tracking so `--track origin/<branch>`
          // would attempt to create an already-existing local branch.
          yield* git(source, ["branch", "--unset-upstream"]);

          yield* (yield* GitCore).checkoutBranch({
            cwd: source,
            branch: `origin/${defaultBranch}`,
          });

          const core = yield* GitCore;
          const status = yield* core.statusDetails(source);
          expect(status.branch).toBeNull();
        }),
    );

    it.effect("throws when checkout would overwrite uncommitted changes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "other" });

        // Create a conflicting change: modify README on current branch
        yield* writeTextFile(path.join(tmp, "README.md"), "modified\n");
        yield* git(tmp, ["add", "README.md"]);

        // First, checkout other branch cleanly
        yield* git(tmp, ["stash"]);
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "other" });
        yield* writeTextFile(path.join(tmp, "README.md"), "other content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "other change"]);

        // Go back to default branch
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => !b.current,
        )!.name;
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: defaultBranch });

        // Make uncommitted changes to the same file
        yield* writeTextFile(path.join(tmp, "README.md"), "conflicting local\n");

        // Checkout should fail due to uncommitted changes
        const result = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "other" }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          const error = result.failure;
          expect(error).toBeInstanceOf(GitCheckoutDirtyWorktreeError);
          if (Schema.is(GitCheckoutDirtyWorktreeError)(error)) {
            expect(error.branch).toBe("other");
            expect(error.conflictingFiles).toContain("README.md");
            expect(error.message).toContain("Uncommitted changes block checkout to other:");
          }
        }
      }),
    );
  });

  describe("stashAndCheckout", () => {
    it.effect("stashes dirty changes, switches branches, and reapplies the stash", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature" });
        yield* writeTextFile(path.join(tmp, "feature.txt"), "feature content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add feature file"]);
        yield* core.checkoutBranch({ cwd: tmp, branch: initialBranch });

        yield* writeTextFile(path.join(tmp, "README.md"), "dirty changes\n");

        yield* core.stashAndCheckout({ cwd: tmp, branch: "feature" });

        const branches = yield* core.listBranches({ cwd: tmp });
        expect(branches.branches.find((branch) => branch.current)?.name).toBe("feature");
        expect(yield* readTextFile(path.join(tmp, "README.md"))).toBe("dirty changes\n");
        expect((yield* git(tmp, ["stash", "list"])).trim()).toBe("");
      }),
    );

    it.effect("drops only the temporary stash it created after a successful reapply", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature" });
        yield* writeTextFile(path.join(tmp, "feature.txt"), "feature content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add feature file"]);
        yield* core.checkoutBranch({ cwd: tmp, branch: initialBranch });

        yield* writeTextFile(path.join(tmp, "kept.txt"), "existing stash\n");
        yield* git(tmp, ["stash", "push", "-u", "-m", "pre-existing stash"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "dirty changes\n");

        yield* core.stashAndCheckout({ cwd: tmp, branch: "feature" });

        const stashList = yield* git(tmp, ["stash", "list"]);
        expect(stashList).toContain("pre-existing stash");
        expect(stashList).not.toContain("synara: stash before switching to feature");
        expect(yield* readTextFile(path.join(tmp, "README.md"))).toBe("dirty changes\n");
      }),
    );

    it.effect("keeps the stash when reapplying dirty changes conflicts", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "conflicting" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "conflicting" });
        yield* writeTextFile(path.join(tmp, "README.md"), "conflicting content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "conflicting change"]);
        yield* core.checkoutBranch({ cwd: tmp, branch: initialBranch });

        yield* writeTextFile(path.join(tmp, "README.md"), "local edits that will conflict\n");

        const result = yield* Effect.result(
          core.stashAndCheckout({ cwd: tmp, branch: "conflicting" }),
        );

        expect(result._tag).toBe("Failure");
        const branches = yield* core.listBranches({ cwd: tmp });
        expect(branches.branches.find((branch) => branch.current)?.name).toBe("conflicting");
        expect(yield* readTextFile(path.join(tmp, "README.md"))).toBe("conflicting content\n");
        expect((yield* git(tmp, ["status", "--short"])).trim()).toBe("");
        expect(yield* git(tmp, ["stash", "list"])).toContain(
          "synara: stash before switching to conflicting",
        );
      }),
    );
  });

  describe("stashDrop", () => {
    it.effect("reads the top stash details", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;
        const { initialBranch } = yield* initRepoWithCommit(tmp);

        yield* writeTextFile(path.join(tmp, "README.md"), "stashed changes\n");
        yield* writeTextFile(path.join(tmp, "new-file.txt"), "new file\n");
        yield* git(tmp, ["stash", "push", "-u", "-m", "test stash"]);

        const info = yield* core.stashInfo({ cwd: tmp });

        expect(info.cwd).toBe(tmp);
        expect(info.branch).toBe(initialBranch);
        expect(info.stashRef).toBe("stash@{0}");
        expect(info.message).toContain("test stash");
        expect(info.files).toContain("README.md");
        expect(info.files).toContain("new-file.txt");
      }),
    );

    it.effect("drops the top stash entry", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;
        yield* initRepoWithCommit(tmp);

        yield* writeTextFile(path.join(tmp, "README.md"), "stashed changes\n");
        yield* git(tmp, ["stash", "push", "-m", "test stash"]);
        expect(yield* git(tmp, ["stash", "list"])).toContain("test stash");

        yield* core.stashDrop({ cwd: tmp, stashRef: "stash@{0}" });

        expect((yield* git(tmp, ["stash", "list"])).trim()).toBe("");
      }),
    );
  });

  describe("removeIndexLock", () => {
    it.effect("removes the repository index lock path reported by git", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;
        yield* initRepoWithCommit(tmp);

        const lockPath = path.join(tmp, ".git", "index.lock");
        yield* writeTextFile(lockPath, "");
        expect(existsSync(lockPath)).toBe(true);

        yield* core.removeIndexLock({ cwd: tmp });

        expect(existsSync(lockPath)).toBe(false);
      }),
    );
  });

  // ── createGitBranch ──

  describe("createGitBranch", () => {
    it.effect("creates a new branch visible in listGitBranches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "new-feature" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.some((b) => b.name === "new-feature")).toBe(true);
      }),
    );

    it.effect("publishes a new branch and sets upstream when requested", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);

        yield* (yield* GitCore).createBranch({
          cwd: tmp,
          branch: "feature/published-branch",
          publish: true,
        });

        expect(
          yield* git(tmp, ["rev-parse", "--abbrev-ref", "feature/published-branch@{upstream}"]),
        ).toBe("origin/feature/published-branch");
        expect(
          yield* git(remote, [
            "show-ref",
            "--verify",
            "--quiet",
            "refs/heads/feature/published-branch",
          ]).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          ),
        ).toBe(true);
      }),
    );

    it.effect("throws when branch already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "dupe" });
        const result = yield* Effect.result(
          (yield* GitCore).createBranch({ cwd: tmp, branch: "dupe" }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("deletes an existing local branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;
        yield* initRepoWithCommit(tmp);
        yield* core.createBranch({ cwd: tmp, branch: "feature/delete-me" });

        yield* core.deleteBranch({ cwd: tmp, branch: "feature/delete-me", force: true });

        const branches = yield* core.listBranches({ cwd: tmp });
        expect(branches.branches.some((branch) => branch.name === "feature/delete-me")).toBe(false);
      }),
    );
  });

  // ── renameGitBranch ──

  describe("renameGitBranch", () => {
    it.effect("renames the current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/old-name" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/old-name" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "feature/old-name",
          newBranch: "feature/new-name",
        });

        expect(renamed.branch).toBe("feature/new-name");

        const branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.some((branch) => branch.name === "feature/old-name")).toBe(false);
        const current = branches.branches.find((branch) => branch.current);
        expect(current?.name).toBe("feature/new-name");
      }),
    );

    it.effect("returns success without git invocation when old/new names match", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const current = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!;

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: current.name,
          newBranch: current.name,
        });

        expect(renamed.branch).toBe(current.name);
      }),
    );

    it.effect("appends numeric suffix when target branch already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "synara/feat/session" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "synara/tmp-working" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "synara/tmp-working" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "synara/tmp-working",
          newBranch: "synara/feat/session",
        });

        expect(renamed.branch).toBe("synara/feat/session-1");
        const branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.some((branch) => branch.name === "synara/feat/session")).toBe(
          true,
        );
        expect(branches.branches.some((branch) => branch.name === "synara/feat/session-1")).toBe(
          true,
        );
        const current = branches.branches.find((branch) => branch.current);
        expect(current?.name).toBe("synara/feat/session-1");
      }),
    );

    it.effect("increments suffix until it finds an available branch name", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "synara/feat/session" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "synara/feat/session-1" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "synara/tmp-working" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "synara/tmp-working" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "synara/tmp-working",
          newBranch: "synara/feat/session",
        });

        expect(renamed.branch).toBe("synara/feat/session-2");
      }),
    );

    it.effect("uses '--' separator for branch rename arguments", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/old-name" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/old-name" });

        const realGitCore = yield* GitCore;
        let renameArgs: ReadonlyArray<string> | null = null;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "branch" && input.args[1] === "-m") {
            renameArgs = [...input.args];
          }
          return realGitCore.execute(input);
        });

        const renamed = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "feature/old-name",
          newBranch: "feature/new-name",
        });

        expect(renamed.branch).toBe("feature/new-name");
        expect(renameArgs).toEqual(["branch", "-m", "--", "feature/old-name", "feature/new-name"]);
      }),
    );
  });

  // ── createGitWorktree + removeGitWorktree ──

  describe("createGitWorktree", () => {
    it.effect("creates a worktree with a new branch from the base branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "worktree-out");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-branch",
          path: wtPath,
        });

        expect(result.worktree.path).toBe(wtPath);
        expect(result.worktree.branch).toBe("wt-branch");
        expect(existsSync(wtPath)).toBe(true);
        expect(existsSync(path.join(wtPath, "README.md"))).toBe(true);

        // Clean up worktree before tmp dir disposal
        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("worktree has the new branch checked out", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-check-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-check",
          path: wtPath,
        });

        // Verify the worktree is on the new branch
        const branchOutput = yield* git(wtPath, ["branch", "--show-current"]);
        expect(branchOutput).toBe("wt-check");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("verifies a clean unchanged worktree through its Git-admin ownership marker", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const wtPath = path.join(tmp, "wt-owned");
        yield* core.createWorktree({
          cwd: tmp,
          branch: initialBranch,
          newBranch: "wt-owned",
          path: wtPath,
        });
        const proof = yield* core.recordWorktreeOwnership({
          path: wtPath,
          branch: "wt-owned",
          token: "operation-token",
        });
        expect(yield* core.verifyWorktreeOwnership({ path: wtPath, proof })).toEqual({
          verified: true,
          reason: null,
        });

        yield* writeTextFile(path.join(wtPath, "untracked.txt"), "do not remove\n");
        expect(yield* core.verifyWorktreeOwnership({ path: wtPath, proof })).toEqual({
          verified: false,
          reason: "worktree state changed",
        });
        yield* core.removeWorktree({ cwd: tmp, path: wtPath, force: true });
        yield* core.deleteBranchIfUnchanged({
          cwd: tmp,
          branch: "wt-owned",
          expectedHead: proof.head,
        });
      }),
    );

    it.effect("verifies ownership of a detached worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const wtPath = path.join(tmp, "wt-detached-owned");
        yield* core.createDetachedWorktree({ cwd: tmp, ref: "HEAD", path: wtPath });

        const proof = yield* core.recordWorktreeOwnership({
          path: wtPath,
          branch: null,
          token: "detached-operation-token",
        });

        expect(proof.branch).toBeNull();
        expect(yield* core.verifyWorktreeOwnership({ path: wtPath, proof })).toEqual({
          verified: true,
          reason: null,
        });
        yield* core.removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("copies checkout changes and .worktreeinclude files into a detached worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, ".gitignore"), ".env\n");
        yield* writeTextFile(path.join(tmp, ".worktreeinclude"), ".env\n");
        yield* git(tmp, ["add", ".gitignore", ".worktreeinclude"]);
        yield* git(tmp, ["commit", "-m", "configure worktree files"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# locally edited\n");
        yield* writeTextFile(path.join(tmp, "notes.txt"), "untracked note\n");
        yield* writeTextFile(path.join(tmp, ".env"), "LOCAL_ONLY=yes\n");

        const core = yield* GitCore;
        const expectedHead = yield* git(tmp, ["rev-parse", "HEAD"]);
        const wtPath = path.join(tmp, "wt-copied-state");
        const result = yield* core.createDetachedWorktree({
          cwd: tmp,
          ref: "HEAD",
          path: wtPath,
          copyChangesFrom: tmp,
        });

        expect(result.worktree).toEqual({ path: wtPath, ref: expectedHead, branch: null });
        expect(yield* readTextFile(path.join(wtPath, "README.md"))).toBe("# locally edited\n");
        expect(yield* readTextFile(path.join(wtPath, "notes.txt"))).toBe("untracked note\n");
        expect(yield* readTextFile(path.join(wtPath, ".env"))).toBe("LOCAL_ONLY=yes\n");

        const proof = yield* core.recordWorktreeOwnership({
          path: wtPath,
          branch: null,
          token: "copied-state-token",
        });
        expect(yield* core.verifyWorktreeOwnership({ path: wtPath, proof })).toEqual({
          verified: true,
          reason: null,
        });
        yield* writeTextFile(path.join(wtPath, ".env"), "LOCAL_ONLY=changed\n");
        expect(yield* core.verifyWorktreeOwnership({ path: wtPath, proof })).toEqual({
          verified: false,
          reason: "worktree state changed",
        });
        yield* core.removeWorktree({ cwd: tmp, path: wtPath, force: true });
      }),
    );

    it.effect("creates a branch-backed managed worktree when newBranch is provided", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const expectedHead = yield* git(tmp, ["rev-parse", "HEAD"]);
        const wtPath = path.join(tmp, "wt-branch-backed");
        const result = yield* core.createDetachedWorktree({
          cwd: tmp,
          ref: "HEAD",
          path: wtPath,
          newBranch: "synara/abcd1234",
        });

        expect(result.worktree).toEqual({
          path: wtPath,
          ref: expectedHead,
          branch: "synara/abcd1234",
        });
        expect(yield* git(wtPath, ["symbolic-ref", "--short", "HEAD"])).toBe("synara/abcd1234");
        expect(yield* git(tmp, ["rev-parse", "refs/heads/synara/abcd1234"])).toBe(expectedHead);

        yield* core.removeWorktree({
          cwd: tmp,
          path: wtPath,
          force: true,
          reclaimTemporaryBranch: true,
        });
        const remainingBranches = yield* git(tmp, ["branch", "--list", "synara/abcd1234"]);
        expect(remainingBranches).toBe("");
      }),
    );

    it.effect("reports setup phases at the real command boundaries", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "notes.txt"), "untracked note\n");
        const core = yield* GitCore;
        const wtPath = path.join(tmp, "wt-phase-events");
        const phases: string[] = [];
        yield* core.createDetachedWorktree(
          {
            cwd: tmp,
            ref: "HEAD",
            path: wtPath,
            newBranch: "synara/ph123456",
            copyChangesFrom: tmp,
          },
          {
            onPhase: (phase) =>
              Effect.sync(() => {
                phases.push(phase);
              }),
          },
        );

        expect(phases).toEqual(["branch", "worktree", "copy-changes"]);
        yield* core.removeWorktree({
          cwd: tmp,
          path: wtPath,
          force: true,
          reclaimTemporaryBranch: true,
        });
      }),
    );

    it.effect("does not report branch creation before preliminary validation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const phases: string[] = [];

        const result = yield* Effect.exit(
          core.createDetachedWorktree(
            {
              cwd: tmp,
              ref: "refs/heads/missing",
              path: path.join(tmp, "wt-invalid-ref"),
              newBranch: "synara/notstarted",
            },
            {
              onPhase: (phase) =>
                Effect.sync(() => {
                  phases.push(phase);
                }),
            },
          ),
        );

        expect(Exit.isFailure(result)).toBe(true);
        expect(phases).toEqual([]);
        expect(yield* git(tmp, ["branch", "--list", "synara/notstarted"])).toBe("");
      }),
    );

    it.effect("deletes the pre-created branch when worktree add fails", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const wtPath = path.join(tmp, "wt-rollback-branch");
        // A plain file at the target path makes `git worktree add` fail after
        // the branch has already been created.
        yield* writeTextFile(wtPath, "occupied\n");

        const result = yield* Effect.exit(
          core.createDetachedWorktree({
            cwd: tmp,
            ref: "HEAD",
            path: wtPath,
            newBranch: "synara/rollback1",
          }),
        );

        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* git(tmp, ["branch", "--list", "synara/rollback1"])).toBe("");
      }),
    );

    it.effect("removeWorktree reclamation never deletes user-named branches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const wtPath = path.join(tmp, "wt-user-branch");
        yield* core.createDetachedWorktree({
          cwd: tmp,
          ref: "HEAD",
          path: wtPath,
          newBranch: "feature/user-owned",
        });

        yield* core.removeWorktree({
          cwd: tmp,
          path: wtPath,
          force: true,
          reclaimTemporaryBranch: true,
        });
        const remainingBranches = yield* git(tmp, ["branch", "--list", "feature/user-owned"]);
        expect(remainingBranches).toContain("feature/user-owned");
      }),
    );

    it.effect("atomically replaces an incomplete worktree snapshot", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "README.md"), "snapshot change\n");
        yield* writeTextFile(path.join(tmp, "untracked.txt"), "preserve me\n");

        const snapshotRoot = yield* makeTmpDir("worktree-snapshot-test-");
        const outputPath = path.join(snapshotRoot, "thread-1");
        yield* Effect.promise(() => fs.mkdir(outputPath, { recursive: true }));
        yield* writeTextFile(path.join(outputPath, "partial.tmp"), "incomplete\n");

        const core = yield* GitCore;
        yield* core.snapshotWorktree({ cwd: tmp, outputPath });

        expect(existsSync(path.join(outputPath, "snapshot.json"))).toBe(true);
        expect(existsSync(path.join(outputPath, "partial.tmp"))).toBe(false);
        expect(yield* readTextFile(path.join(outputPath, "files", "untracked.txt"))).toBe(
          "preserve me\n",
        );
        expect(yield* readTextFile(path.join(outputPath, "changes.patch"))).toContain(
          "snapshot change",
        );
      }),
    );

    it.effect("rejects a same-path same-branch replacement without the original marker", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const wtPath = path.join(tmp, "wt-replaced");
        yield* core.createWorktree({
          cwd: tmp,
          branch: initialBranch,
          newBranch: "wt-replaced",
          path: wtPath,
        });
        const proof = yield* core.recordWorktreeOwnership({
          path: wtPath,
          branch: "wt-replaced",
          token: "original-operation-token",
        });
        yield* core.removeWorktree({ cwd: tmp, path: wtPath, force: true });
        yield* core.deleteBranchIfUnchanged({
          cwd: tmp,
          branch: "wt-replaced",
          expectedHead: proof.head,
        });
        yield* core.createWorktree({
          cwd: tmp,
          branch: initialBranch,
          newBranch: "wt-replaced",
          path: wtPath,
        });

        const verification = yield* core.verifyWorktreeOwnership({ path: wtPath, proof });
        expect(verification.verified).toBe(false);
        expect(verification.reason).toMatch(/Git directory changed|marker is missing/);
        yield* core.removeWorktree({ cwd: tmp, path: wtPath, force: true });
      }),
    );

    it.effect("rejects a moved HEAD and conditionally preserves the changed branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const wtPath = path.join(tmp, "wt-head-moved");
        yield* core.createWorktree({
          cwd: tmp,
          branch: initialBranch,
          newBranch: "wt-head-moved",
          path: wtPath,
        });
        const proof = yield* core.recordWorktreeOwnership({
          path: wtPath,
          branch: "wt-head-moved",
          token: "head-moved-token",
        });
        yield* writeTextFile(path.join(wtPath, "new-commit.txt"), "preserve me\n");
        yield* git(wtPath, ["add", "new-commit.txt"]);
        yield* git(wtPath, ["commit", "-m", "advance owned branch"]);

        expect(yield* core.verifyWorktreeOwnership({ path: wtPath, proof })).toEqual({
          verified: false,
          reason: "worktree HEAD changed",
        });
        yield* core.removeWorktree({ cwd: tmp, path: wtPath, force: false });
        const deletion = yield* Effect.exit(
          core.deleteBranchIfUnchanged({
            cwd: tmp,
            branch: "wt-head-moved",
            expectedHead: proof.head,
          }),
        );
        expect(Exit.isFailure(deletion)).toBe(true);
        expect(
          (yield* core.listBranches({ cwd: tmp })).branches.some(
            (branch) => branch.name === "wt-head-moved",
          ),
        ).toBe(true);
        yield* core.deleteBranch({ cwd: tmp, branch: "wt-head-moved", force: true });
      }),
    );

    it.effect("creates a worktree for an existing branch when newBranch is omitted", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/existing-worktree" });

        const wtPath = path.join(tmp, "wt-existing");
        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: "feature/existing-worktree",
          path: wtPath,
        });

        expect(result.worktree.path).toBe(wtPath);
        expect(result.worktree.branch).toBe("feature/existing-worktree");
        const branchOutput = yield* git(wtPath, ["branch", "--show-current"]);
        expect(branchOutput).toBe("feature/existing-worktree");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("throws when new branch name already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "existing" });

        const wtPath = path.join(tmp, "wt-conflict");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* Effect.result(
          (yield* GitCore).createWorktree({
            cwd: tmp,
            branch: currentBranch,
            newBranch: "existing",
            path: wtPath,
          }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("listGitBranches from worktree cwd reports worktree branch as current", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-list-dir");
        const mainBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: mainBranch,
          newBranch: "wt-list",
          path: wtPath,
        });

        // listGitBranches from the worktree should show wt-list as current
        const wtBranches = yield* (yield* GitCore).listBranches({ cwd: wtPath });
        expect(wtBranches.isRepo).toBe(true);
        const wtCurrent = wtBranches.branches.find((b) => b.current);
        expect(wtCurrent!.name).toBe("wt-list");

        // Main repo should still show the original branch as current
        const mainBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(mainBranch);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("removeGitWorktree cleans up the worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-remove-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-remove",
          path: wtPath,
        });
        expect(existsSync(wtPath)).toBe(true);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
        expect(existsSync(wtPath)).toBe(false);
      }),
    );

    it.effect("removeGitWorktree force removes a dirty worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-dirty-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-dirty",
          path: wtPath,
        });
        expect(existsSync(wtPath)).toBe(true);

        yield* writeTextFile(path.join(wtPath, "README.md"), "dirty change\n");

        const failedRemove = yield* Effect.result(
          (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath }),
        );
        expect(failedRemove._tag).toBe("Failure");
        expect(existsSync(wtPath)).toBe(true);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath, force: true });
        expect(existsSync(wtPath)).toBe(false);
      }),
    );
  });

  // ── Full flow: local branch checkout ──

  describe("full flow: local branch checkout", () => {
    it.effect("init → commit → create branch → checkout → verify current", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-login" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature-login" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current!.name).toBe("feature-login");
      }),
    );
  });

  // ── Full flow: worktree creation from base branch ──

  describe("full flow: worktree creation", () => {
    it.effect("creates worktree with new branch from current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const wtPath = path.join(tmp, "my-worktree");
        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "feature-wt",
          path: wtPath,
        });

        // Worktree exists
        expect(existsSync(result.worktree.path)).toBe(true);

        // Main repo still on original branch
        const mainBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(currentBranch);

        // Worktree is on the new branch
        const wtBranch = yield* git(wtPath, ["branch", "--show-current"]);
        expect(wtBranch).toBe("feature-wt");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );
  });

  describe("fetchPullRequestBranch", () => {
    it.effect("fetches a GitHub pull request ref into a local branch without checkout", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const remoteDir = yield* makeTmpDir("git-remote-");
        yield* git(remoteDir, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remoteDir]);
        yield* git(tmp, ["push", "-u", "origin", initialBranch]);
        yield* git(tmp, ["checkout", "-b", "feature/pr-fetch"]);
        yield* writeTextFile(path.join(tmp, "pr-fetch.txt"), "fetch me\n");
        yield* git(tmp, ["add", "pr-fetch.txt"]);
        yield* git(tmp, ["commit", "-m", "Add PR fetch branch"]);
        yield* git(tmp, ["push", "-u", "origin", "feature/pr-fetch"]);
        yield* git(tmp, ["push", "origin", "HEAD:refs/pull/55/head"]);
        yield* git(tmp, ["checkout", initialBranch]);

        yield* (yield* GitCore).fetchPullRequestBranch({
          cwd: tmp,
          prNumber: 55,
          branch: "feature/pr-fetch",
        });

        const localBranches = yield* git(tmp, ["branch", "--list", "feature/pr-fetch"]);
        expect(localBranches).toContain("feature/pr-fetch");
        const currentBranch = yield* git(tmp, ["branch", "--show-current"]);
        expect(currentBranch).toBe(initialBranch);
      }),
    );
  });

  describe("fetchPullRequestCommit", () => {
    it.effect("rejects a pull-request URL for a repository other than the fetch remote", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["remote", "add", "origin", "https://github.com/acme/current.git"]);

        const exit = yield* (yield* GitCore)
          .fetchPullRequestCommit({
            cwd: tmp,
            prNumber: 42,
            expectedRepositoryNameWithOwner: "acme/other",
          })
          .pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "Pull request URL targets acme/other, but remote origin targets acme/current.",
          );
        }
      }),
    );
  });

  // ── Full flow: thread switching simulation ──

  describe("full flow: thread switching (checkout toggling)", () => {
    it.effect("checkout a → checkout b → checkout a → current matches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "branch-a" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "branch-b" });

        // Simulate switching to thread A's branch
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-a" });
        let branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");

        // Simulate switching to thread B's branch
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-b" });
        branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-b");

        // Switch back to thread A
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-a" });
        branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");
      }),
    );
  });

  // ── Full flow: checkout conflict ──

  describe("full flow: checkout conflict", () => {
    it.effect("uncommitted changes prevent checkout to a diverged branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "diverged" });

        // Make diverged branch have different file content
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "diverged" });
        yield* writeTextFile(path.join(tmp, "README.md"), "diverged content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "diverge"]);

        // Actually, let's just get back to the initial branch explicitly
        const allBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const initialBranch = allBranches.branches.find((b) => b.name !== "diverged")!.name;
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: initialBranch });

        // Make local uncommitted changes to the same file
        yield* writeTextFile(path.join(tmp, "README.md"), "local uncommitted\n");

        // Attempt checkout should fail
        const failedCheckout = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "diverged" }),
        );
        expect(failedCheckout._tag).toBe("Failure");

        // Current branch should still be the initial one
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.find((b) => b.current)!.name).toBe(initialBranch);
      }),
    );
  });

  describe("GitCore", () => {
    it.effect("supports branch lifecycle operations through the service API", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;

        yield* core.initRepo({ cwd: tmp });
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "initial commit"]);

        yield* core.createBranch({ cwd: tmp, branch: "feature/service-api" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/service-api" });
        const branches = yield* core.listBranches({ cwd: tmp });

        expect(branches.isRepo).toBe(true);
        expect(
          branches.branches.find((branch: { current: boolean; name: string }) => branch.current)
            ?.name,
        ).toBe("feature/service-api");
      }),
    );

    it.effect(
      "reuses an existing remote when the target URL only differs by a trailing slash after .git",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const core = yield* GitCore;

          yield* git(tmp, ["remote", "add", "origin", "git@github.com:example-org/synara.git"]);

          const remoteName = yield* core.ensureRemote({
            cwd: tmp,
            preferredName: "origin",
            url: "git@github.com:example-org/synara.git/",
          });

          expect(remoteName).toBe("origin");
          expect((yield* git(tmp, ["remote"])).split("\n").filter(Boolean)).toEqual(["origin"]);
        }),
    );

    it.effect("reports status details and dirty state", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        const clean = yield* core.status({ cwd: tmp });
        expect(clean.hasWorkingTreeChanges).toBe(false);
        expect(clean.branch).toBeTruthy();

        yield* writeTextFile(path.join(tmp, "README.md"), "updated\n");
        const dirty = yield* core.statusDetails(tmp);
        expect(dirty.hasWorkingTreeChanges).toBe(true);
      }),
    );

    it.effect("reads branch identity without requiring full status details", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const tmp = yield* makeTmpDir();
        const nonRepo = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["checkout", "-b", "feature/branch-context"]);
        yield* git(tmp, ["push", "-u", "origin", "feature/branch-context"]);
        const core = yield* GitCore;

        expect(yield* core.readBranchContext(tmp)).toEqual({
          isRepo: true,
          branch: "feature/branch-context",
          upstreamRef: "origin/feature/branch-context",
        });

        yield* git(tmp, ["checkout", "--detach"]);
        expect(yield* core.readBranchContext(tmp)).toEqual({
          isRepo: true,
          branch: null,
          upstreamRef: null,
        });
        expect(yield* core.readBranchContext(nonRepo)).toEqual({
          isRepo: false,
          branch: null,
          upstreamRef: null,
        });
      }),
    );

    it.effect("preserves adversarial filenames in status details", () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileName = "line\nbreak\tname.txt";
        yield* writeTextFile(path.join(tmp, fileName), "before\n");
        yield* git(tmp, ["add", "--", fileName]);
        yield* git(tmp, ["commit", "-m", "add adversarial filename"]);
        yield* writeTextFile(path.join(tmp, fileName), "after\nsecond\n");

        const details = yield* (yield* GitCore).statusDetails(tmp);

        expect(details.workingTree.files).toEqual([
          { path: fileName, insertions: 2, deletions: 1 },
        ]);
      }),
    );

    it.effect("does not resolve upstream before rejecting non-repository directories", () =>
      Effect.gen(function* () {
        const operations: string[] = [];
        const core = yield* makeIsolatedGitCore((input) =>
          Effect.sync(() => {
            operations.push(input.operation);
            if (input.operation === "GitCore.statusDetails.isInsideWorkTree") {
              return {
                code: 128,
                stdout: "",
                stderr: "fatal: not a git repository",
              };
            }
            throw new Error(`Unexpected git command: ${input.operation}`);
          }),
        );

        const details = yield* core.statusDetails("C:\\Users\\Windows");

        expect(details.isRepo).toBe(false);
        expect(operations).toEqual(["GitCore.statusDetails.isInsideWorkTree"]);
      }),
    );

    it.effect("preserves failures from the repository precheck", () =>
      Effect.gen(function* () {
        const precheckError = new GitCommandError({
          operation: "GitCore.statusDetails.isInsideWorkTree",
          command: "git rev-parse --is-inside-work-tree",
          cwd: "C:\\repo",
          detail: "git rev-parse --is-inside-work-tree timed out.",
        });
        const core = yield* makeIsolatedGitCore(() => Effect.fail(precheckError));

        const result = yield* Effect.result(core.statusDetails("C:\\repo"));

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            _tag: "GitCommandError",
            operation: precheckError.operation,
            detail: precheckError.detail,
          });
        }
      }),
    );

    it.effect("rejects unrelated nonzero repository precheck results", () =>
      Effect.gen(function* () {
        const core = yield* makeIsolatedGitCore(() =>
          Effect.succeed({
            code: 128,
            stdout: "",
            stderr: "fatal: detected dubious ownership in repository at 'C:\\repo'",
          }),
        );

        const result = yield* Effect.result(core.statusDetails("C:\\repo"));

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            _tag: "GitCommandError",
            operation: "GitCore.statusDetails.isInsideWorkTree",
            detail: "fatal: detected dubious ownership in repository at 'C:\\repo'",
          });
        }
      }),
    );

    it.effect("keeps missing repository directories on the non-repository fallback", () =>
      Effect.gen(function* () {
        const core = yield* makeIsolatedGitCore(() =>
          Effect.fail(
            new GitCommandError({
              operation: "GitCore.statusDetails.isInsideWorkTree",
              command: "git rev-parse --is-inside-work-tree",
              cwd: "C:\\missing",
              detail: "ENOENT: no such file or directory",
            }),
          ),
        );

        const details = yield* core.statusDetails("C:\\missing");

        expect(details.isRepo).toBe(false);
      }),
    );

    it.effect("reports the tracked branch name without the remote prefix", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const tmp = yield* makeTmpDir();
        const remoteName = "my-org/upstream";
        const branchName = "feature/status-upstream";

        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["remote", "add", remoteName, remote]);
        yield* git(tmp, ["checkout", "-b", branchName]);
        yield* git(tmp, ["push", "-u", remoteName, branchName]);

        const details = yield* (yield* GitCore).statusDetails(tmp);
        expect(details.upstreamRef).toBe(`${remoteName}/${branchName}`);
        expect(details.upstreamBranch).toBe(branchName);
      }),
    );

    it.effect("counts untracked text files in working tree totals", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "README.md"), "updated\n");
        yield* writeTextFile(path.join(tmp, "new-file.ts"), "alpha\nbeta\n");

        const details = yield* core.statusDetails(tmp);
        expect(details.workingTree.insertions).toBe(3);
        expect(details.workingTree.deletions).toBe(1);
        expect(details.workingTree.files).toEqual([
          { path: "new-file.ts", insertions: 2, deletions: 0 },
          { path: "README.md", insertions: 1, deletions: 1 },
        ]);
      }),
    );

    it.effect("uses rename-aware totals when deleted files move into untracked directories", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const fileSystem = yield* FileSystem.FileSystem;

        const originalDir = path.join(tmp, "Views", "Turn");
        const movedDir = path.join(tmp, "Views", "Turn", "Core");
        const originalPath = path.join(originalDir, "TurnView.swift");
        const movedPath = path.join(movedDir, "TurnView.swift");
        const originalContents = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join(
          "\n",
        );

        yield* fileSystem.makeDirectory(originalDir, { recursive: true });
        yield* writeTextFile(originalPath, `${originalContents}\n`);
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add turn view"]);

        yield* fileSystem.makeDirectory(movedDir, { recursive: true });
        yield* fileSystem.rename(originalPath, movedPath);
        yield* writeTextFile(movedPath, `${originalContents}\nnew helper line\n`);

        const details = yield* core.statusDetails(tmp);
        expect(details.workingTree.insertions).toBe(1);
        expect(details.workingTree.deletions).toBe(0);
        expect(details.workingTree.files).toEqual([
          { path: "Views/Turn/Core/TurnView.swift", insertions: 1, deletions: 0 },
        ]);
      }),
    );

    it.effect("reads first-commit working tree patches including unstaged edits", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithoutCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "draft.txt"), "alpha\n");
        yield* git(tmp, ["add", "draft.txt"]);
        yield* writeTextFile(path.join(tmp, "draft.txt"), "alpha\nbeta\n");

        const patch = (yield* core.readWorkingTreePatch(tmp)).patch;
        expect(patch).toContain("diff --git a/draft.txt b/draft.txt");
        expect(patch).toContain("@@ -0,0 +1,2 @@");
        expect(patch).toContain("+alpha");
        expect(patch).toContain("+beta");
      }),
    );

    it.effect("preserves trailing spaces and exact untracked paths in working tree patches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "README.md"), "keep\nlast line  ");
        yield* writeTextFile(path.join(tmp, " spaced file.txt "), "hello\n");

        const patch = (yield* core.readWorkingTreePatch(tmp)).patch;
        expect(patch).toContain("+last line  ");
        expect(patch).toContain("diff --git a/ spaced file.txt  b/ spaced file.txt ");
      }),
    );

    it.effect("reads branch as the aggregate diff while preserving focused scopes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const fileSystem = yield* FileSystem.FileSystem;

        yield* core.createBranch({ cwd: tmp, branch: "feature/diff-scopes" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/diff-scopes" });
        yield* writeTextFile(path.join(tmp, "branch.txt"), "branch change\n");
        yield* git(tmp, ["add", "branch.txt"]);
        yield* git(tmp, ["commit", "-m", "branch change"]);

        yield* writeTextFile(path.join(tmp, "staged.txt"), "staged change\n");
        yield* git(tmp, ["add", "staged.txt"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\nunstaged change\n");
        yield* writeTextFile(path.join(tmp, "untracked.txt"), "untracked change\n");
        yield* fileSystem.writeFile(path.join(tmp, "untracked.bin"), new Uint8Array([0, 1, 2, 3]));

        const branchPatch = (yield* core.readBranchPatch(tmp)).patch;
        expect(branchPatch).toContain("diff --git a/branch.txt b/branch.txt");
        expect(branchPatch).toContain("diff --git a/staged.txt b/staged.txt");
        expect(branchPatch).toContain("diff --git a/README.md b/README.md");
        expect(branchPatch).toContain("diff --git a/untracked.txt b/untracked.txt");

        const stagedPatch = (yield* core.readStagedPatch(tmp)).patch;
        expect(stagedPatch).toContain("diff --git a/staged.txt b/staged.txt");
        expect(stagedPatch).not.toContain("README.md");
        expect(stagedPatch).not.toContain("untracked.txt");

        const unstagedPatch = (yield* core.readUnstagedPatch(tmp)).patch;
        expect(unstagedPatch).toContain("diff --git a/README.md b/README.md");
        expect(unstagedPatch).toContain("diff --git a/untracked.txt b/untracked.txt");
        expect(unstagedPatch).not.toContain("staged.txt");

        const workingTreePatch = (yield* core.readWorkingTreePatch(tmp)).patch;
        expect(workingTreePatch).toContain("diff --git a/staged.txt b/staged.txt");
        expect(workingTreePatch).toContain("+staged change");
        expect(workingTreePatch).toContain("+unstaged change");
        expect(workingTreePatch).toContain("+untracked change");
        expect(workingTreePatch).toContain("diff --git a/untracked.bin b/untracked.bin");
        expect(workingTreePatch).not.toContain("branch.txt");

        const scopeTotals = [
          ["branch", { additions: 4, deletions: 0, fileCount: 5 }],
          ["staged", { additions: 1, deletions: 0, fileCount: 1 }],
          ["unstaged", { additions: 2, deletions: 0, fileCount: 3 }],
          ["workingTree", { additions: 3, deletions: 0, fileCount: 4 }],
        ] as const;
        for (const [scope, expected] of scopeTotals) {
          expect(yield* core.readDiffStats(tmp, scope)).toEqual(expected);
        }
      }),
    );

    it.effect("surfaces tracked numstat failures", () =>
      Effect.gen(function* () {
        const core = yield* makeIsolatedGitCore(() =>
          Effect.succeed({
            code: 128,
            stdout: "",
            stderr: "fatal: bad object",
          }),
        );

        const result = yield* Effect.result(core.readDiffStats("/repo", "staged"));

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            _tag: "GitCommandError",
            operation: "GitCore.readDiffStats.tracked",
            detail: "fatal: bad object",
          });
        }
      }),
    );

    it.effect("surfaces untracked numstat failures instead of undercounting", () =>
      Effect.gen(function* () {
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.operation.endsWith(".untrackedFiles")) {
            return Effect.succeed({ code: 0, stdout: "vanished.txt\0", stderr: "" });
          }
          if (input.operation.endsWith(".untrackedNumstat")) {
            // `--no-index` also exits 1 when the path cannot be read.
            return Effect.succeed({
              code: 1,
              stdout: "",
              stderr: "error: Could not access 'vanished.txt'",
            });
          }
          return Effect.succeed({ code: 0, stdout: "", stderr: "" });
        });

        const result = yield* Effect.result(core.readDiffStats("/repo", "unstaged"));

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            _tag: "GitCommandError",
            operation: "GitCore.readDiffStats.untrackedNumstat",
            detail: "error: Could not access 'vanished.txt'",
          });
        }
      }),
    );

    it.effect(
      "reads large committed additions against a ref without changing other scope limits",
      () =>
        Effect.gen(function* () {
          const core = yield* GitCore;
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const baseSha = yield* git(tmp, ["rev-parse", "HEAD"]);
          const contents = "0123456789abcdef".repeat(75_000) + "\n";
          yield* writeTextFile(path.join(tmp, "large.txt"), contents);

          const unstaged = yield* Effect.result(core.readUnstagedPatch(tmp));
          expect(unstaged._tag).toBe("Failure");
          if (unstaged._tag === "Failure") {
            expect(unstaged.failure.detail).toContain("output exceeded 1000000 bytes");
          }

          yield* git(tmp, ["add", "large.txt"]);
          yield* git(tmp, ["commit", "-m", "add large tracked text"]);
          const indexBefore = yield* Effect.promise(() =>
            fs.readFile(path.join(tmp, ".git/index")),
          );
          const result = yield* core.readRefPatch(tmp, baseSha);
          expect(result.patch).toContain("new file mode 100644");
          expect(result.patch).toContain(`+${contents}`);
          const indexAfter = yield* Effect.promise(() => fs.readFile(path.join(tmp, ".git/index")));
          expect(indexAfter).toEqual(indexBefore);
        }),
    );

    it.effect("keeps reference addition patch capture finite and rejects overflow", () =>
      Effect.gen(function* () {
        const realCore = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const baseSha = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* writeTextFile(path.join(tmp, "addition.txt"), "bounded patch\n".repeat(50));
        yield* git(tmp, ["add", "addition.txt"]);
        yield* git(tmp, ["commit", "-m", "add text"]);
        let requestedLimit: number | undefined;
        let requestedMode: string | undefined;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.operation === "GitCore.readRefPatch.untrackedPatch") {
            requestedLimit = input.maxOutputBytes;
            requestedMode = input.outputMode;
            // Exercise the real collector's overflow path with a small fixture.
            return realCore.execute({ ...input, maxOutputBytes: 128 });
          }
          return realCore.execute(input);
        });
        const result = yield* Effect.result(core.readRefPatch(tmp, baseSha));
        expect(requestedLimit).toBe(10_000_000);
        expect(requestedMode).not.toBe("truncate");
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            operation: "GitCore.readRefPatch.untrackedPatch",
            detail: expect.stringContaining("output exceeded 128 bytes"),
          });
        }
      }),
    );

    it.effect("reads the working tree as a patch against an older commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        const baseSha = yield* git(tmp, ["rev-parse", "HEAD"]);

        yield* writeTextFile(path.join(tmp, "committed.txt"), "committed change\n");
        yield* git(tmp, ["add", "committed.txt"]);
        yield* git(tmp, ["commit", "-m", "committed change"]);

        yield* writeTextFile(path.join(tmp, "staged.txt"), "staged change\n");
        yield* git(tmp, ["add", "staged.txt"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\nunstaged change\n");
        yield* writeTextFile(path.join(tmp, "untracked.txt"), "untracked change\n");

        const refPatch = (yield* core.readRefPatch(tmp, baseSha)).patch;
        expect(refPatch).toContain("diff --git a/committed.txt b/committed.txt");
        expect(refPatch).toContain("diff --git a/staged.txt b/staged.txt");
        expect(refPatch).toContain("diff --git a/README.md b/README.md");
        expect(refPatch).toContain("diff --git a/untracked.txt b/untracked.txt");

        const headPatch = (yield* core.readRefPatch(tmp, "HEAD")).patch;
        expect(headPatch).not.toContain("diff --git a/committed.txt b/committed.txt");
        expect(headPatch).toContain("diff --git a/staged.txt b/staged.txt");
        expect(headPatch).toContain("diff --git a/untracked.txt b/untracked.txt");
      }),
    );

    it.effect("shows a ref-tracked path recreated untracked as one modification", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* writeTextFile(path.join(tmp, "x.txt"), "one\n");
        yield* git(tmp, ["add", "x.txt"]);
        yield* git(tmp, ["commit", "-m", "add x"]);
        const baseSha = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["rm", "-q", "x.txt"]);
        yield* writeTextFile(path.join(tmp, "x.txt"), "two\nthree\n");

        const refPatch = (yield* core.readRefPatch(tmp, baseSha)).patch;
        expect(refPatch.match(/^diff --git a\/x\.txt b\/x\.txt$/gm)).toHaveLength(1);
        expect(refPatch).not.toContain("deleted file mode");
        expect(refPatch).toContain("-one");
        expect(refPatch).toContain("+two");
        expect(refPatch).not.toContain("synara-ref-blob-");

        const stats = yield* core.readDiffStats(tmp, "ref", baseSha);
        expect(stats).toEqual({ additions: 2, deletions: 1, fileCount: 1 });
      }),
    );

    it.effect("drops a ref-tracked path recreated untracked with identical contents", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* writeTextFile(path.join(tmp, "x.txt"), "one\n");
        yield* git(tmp, ["add", "x.txt"]);
        yield* git(tmp, ["commit", "-m", "add x"]);
        const baseSha = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["rm", "-q", "x.txt"]);
        yield* writeTextFile(path.join(tmp, "x.txt"), "one\n");

        const refPatch = (yield* core.readRefPatch(tmp, baseSha)).patch;
        expect(refPatch).not.toContain("x.txt");

        const stats = yield* core.readDiffStats(tmp, "ref", baseSha);
        expect(stats).toEqual({ additions: 0, deletions: 0, fileCount: 0 });
      }),
    );

    it.effect("keeps a tracked but ignored addition in ref diffs", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* writeTextFile(path.join(tmp, ".gitignore"), "built.js\n");
        yield* git(tmp, ["add", ".gitignore"]);
        yield* git(tmp, ["commit", "-m", "ignore build output"]);
        const baseSha = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* writeTextFile(path.join(tmp, "built.js"), "built\n");
        yield* git(tmp, ["add", "-f", "built.js"]);

        const refPatch = (yield* core.readRefPatch(tmp, baseSha)).patch;
        expect(refPatch).toContain("diff --git a/built.js b/built.js");

        const stats = yield* core.readDiffStats(tmp, "ref", baseSha);
        expect(stats).toEqual({ additions: 1, deletions: 0, fileCount: 1 });
      }),
    );

    it.effect("reads a patch against a branch name", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/compare-with" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/compare-with" });
        yield* writeTextFile(path.join(tmp, "feature.txt"), "feature change\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature change"]);

        const patch = (yield* core.readRefPatch(tmp, initialBranch)).patch;
        expect(patch).toContain("diff --git a/feature.txt b/feature.txt");
      }),
    );

    it.effect("fails with a clear error when the compare ref does not resolve", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        const exit = yield* core.readRefPatch(tmp, "does/not/exist").pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const rendered = String(exit.cause);
          expect(rendered).toContain("GitCore.readRefPatch.verifyRef");
          expect(rendered).toContain("Cannot resolve");
          expect(rendered).toContain("does/not/exist");
          expect(rendered).toContain("to a commit in this repository.");
        }
      }),
    );

    it.effect("lists recent commits newest first and tolerates an empty repository", () =>
      Effect.gen(function* () {
        const empty = yield* makeTmpDir();
        yield* initRepoWithoutCommit(empty);
        const core = yield* GitCore;
        expect((yield* core.listRecentCommits({ cwd: empty, limit: 5 })).commits).toEqual([]);

        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "second.txt"), "second\n");
        yield* git(tmp, ["add", "second.txt"]);
        yield* git(tmp, ["commit", "-m", "second commit"]);

        const result = yield* core.listRecentCommits({ cwd: tmp, limit: 5 });
        expect(result.commits).toHaveLength(2);
        expect(result.commits[0]?.subject).toBe("second commit");
        expect(result.commits[1]?.subject).toBe("initial commit");
        expect(result.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(result.commits[0]?.sha.startsWith(result.commits[0].shortSha)).toBe(true);
        expect(result.commits[0]?.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        const limited = yield* core.listRecentCommits({ cwd: tmp, limit: 1 });
        expect(limited.commits).toHaveLength(1);
        expect(limited.commits[0]?.subject).toBe("second commit");
      }),
    );

    it.effect("computes ahead count against base branch when no upstream is configured", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/no-upstream-ahead" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/no-upstream-ahead" });
        yield* writeTextFile(path.join(tmp, "feature.txt"), "ahead of base\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature commit"]);

        const details = yield* core.statusDetails(tmp);
        expect(details.branch).toBe("feature/no-upstream-ahead");
        expect(details.hasUpstream).toBe(false);
        expect(details.aheadCount).toBe(1);
        expect(details.behindCount).toBe(0);
      }),
    );

    it.effect(
      "computes ahead count against origin/default when local default branch is missing",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", initialBranch]);
          yield* git(source, ["checkout", "-b", "feature/remote-base-only"]);
          yield* writeTextFile(
            path.join(source, "feature.txt"),
            `ahead of origin/${initialBranch}\n`,
          );
          yield* git(source, ["add", "feature.txt"]);
          yield* git(source, ["commit", "-m", "feature commit"]);
          yield* git(source, ["branch", "-D", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe("feature/remote-base-only");
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(1);
          expect(details.behindCount).toBe(0);
        }),
    );

    it.effect(
      "computes ahead count against a non-origin remote-prefixed gh-merge-base candidate",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          const remoteName = "fork-seed";
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", remoteName, remote]);
          yield* git(source, ["push", "-u", remoteName, initialBranch]);
          yield* git(source, ["checkout", "-b", "feature/non-origin-merge-base"]);
          yield* git(source, [
            "config",
            "branch.feature/non-origin-merge-base.gh-merge-base",
            `${remoteName}/${initialBranch}`,
          ]);
          yield* writeTextFile(
            path.join(source, "feature.txt"),
            `ahead of ${remoteName}/${initialBranch}\n`,
          );
          yield* git(source, ["add", "feature.txt"]);
          yield* git(source, ["commit", "-m", "feature commit"]);
          yield* git(source, ["branch", "-D", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe("feature/non-origin-merge-base");
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(1);
          expect(details.behindCount).toBe(0);
        }),
    );

    it.effect("skips push when no upstream is configured and branch is not ahead of base", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/no-upstream-no-ahead" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/no-upstream-no-ahead" });

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("skipped_up_to_date");
        expect(pushed.branch).toBe("feature/no-upstream-no-ahead");
        expect(pushed.setUpstream).toBeUndefined();
      }),
    );

    it.effect("pushes with upstream setup when no comparable base branch exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(tmp, ["init", "--initial-branch=trunk"]);
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "hello\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "initial"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["checkout", "-b", "feature/no-base"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe("origin/feature/no-base");
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/no-base",
        );
      }),
    );

    it.effect("pushes with upstream setup to the only configured non-origin remote", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(tmp, ["init", "--initial-branch=main"]);
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "hello\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "initial"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "fork", remote]);
        yield* git(tmp, ["checkout", "-b", "feature/fork-only"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe("fork/feature/fork-only");
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "fork/feature/fork-only",
        );
      }),
    );

    it.effect(
      "pushes with upstream setup when comparable base exists but remote branch is missing",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const remote = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(tmp);
          const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
            (branch) => branch.current,
          )!.name;
          yield* git(tmp, ["remote", "add", "origin", remote]);
          yield* git(tmp, ["push", "-u", "origin", initialBranch]);

          yield* writeTextFile(path.join(tmp, "default-ahead.txt"), "ahead on default\n");
          yield* git(tmp, ["add", "default-ahead.txt"]);
          yield* git(tmp, ["commit", "-m", "default ahead"]);

          const featureBranch = "feature/publish-no-upstream";
          yield* git(tmp, ["checkout", "-b", featureBranch]);

          const core = yield* GitCore;
          const pushed = yield* core.pushCurrentBranch(tmp, null);
          expect(pushed.status).toBe("pushed");
          expect(pushed.setUpstream).toBe(true);
          expect(pushed.upstreamBranch).toBe(`origin/${featureBranch}`);
          expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            `origin/${featureBranch}`,
          );
          expect(yield* git(tmp, ["ls-remote", "--heads", "origin", featureBranch])).toContain(
            featureBranch,
          );
        }),
    );

    it.effect("prefers branch pushRemote over origin when setting upstream", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const origin = yield* makeTmpDir();
        const fork = yield* makeTmpDir();
        yield* git(origin, ["init", "--bare"]);
        yield* git(fork, ["init", "--bare"]);

        yield* initRepoWithCommit(tmp);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(tmp, ["remote", "add", "origin", origin]);
        yield* git(tmp, ["remote", "add", "fork", fork]);
        yield* git(tmp, ["push", "-u", "origin", initialBranch]);

        const featureBranch = "feature/push-remote";
        yield* git(tmp, ["checkout", "-b", featureBranch]);
        yield* git(tmp, ["config", `branch.${featureBranch}.pushRemote`, "fork"]);
        yield* writeTextFile(path.join(tmp, "feature.txt"), "push to fork\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature commit"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe(`fork/${featureBranch}`);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          `fork/${featureBranch}`,
        );
        expect(yield* git(tmp, ["ls-remote", "--heads", "fork", featureBranch])).toContain(
          featureBranch,
        );
      }),
    );

    it.effect(
      "pushes renamed PR worktree branches to their tracked upstream branch even when push.default is current",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const fork = yield* makeTmpDir();
          yield* git(fork, ["init", "--bare"]);

          const { initialBranch } = yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["remote", "add", "jasonLaster", fork]);
          yield* git(tmp, ["checkout", "-b", "statemachine"]);
          yield* writeTextFile(path.join(tmp, "fork.txt"), "fork branch\n");
          yield* git(tmp, ["add", "fork.txt"]);
          yield* git(tmp, ["commit", "-m", "fork branch"]);
          yield* git(tmp, ["push", "-u", "jasonLaster", "statemachine"]);
          yield* git(tmp, ["checkout", initialBranch]);
          yield* git(tmp, ["branch", "-D", "statemachine"]);
          yield* git(tmp, [
            "checkout",
            "-b",
            "synara/pr-488/statemachine",
            "--track",
            "jasonLaster/statemachine",
          ]);
          yield* git(tmp, ["config", "push.default", "current"]);
          yield* writeTextFile(path.join(tmp, "fork.txt"), "updated fork branch\n");
          yield* git(tmp, ["add", "fork.txt"]);
          yield* git(tmp, ["commit", "-m", "update reviewed PR branch"]);

          const core = yield* GitCore;
          const pushed = yield* core.pushCurrentBranch(tmp, null);

          expect(pushed.status).toBe("pushed");
          expect(pushed.setUpstream).toBe(false);
          expect(pushed.upstreamBranch).toBe("jasonLaster/statemachine");
          expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            "jasonLaster/statemachine",
          );
          expect(
            yield* git(tmp, ["ls-remote", "--heads", "jasonLaster", "statemachine"]),
          ).toContain("statemachine");
          expect(
            yield* git(tmp, ["ls-remote", "--heads", "jasonLaster", "synara/pr-488/statemachine"]),
          ).toBe("");
        }),
    );

    it.effect("includes command context when worktree removal fails", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const missingWorktreePath = path.join(tmp, "missing-worktree");

        const removeResult = yield* Effect.result(
          core.removeWorktree({ cwd: tmp, path: missingWorktreePath }),
        );
        expect(removeResult._tag).toBe("Failure");
        if (removeResult._tag !== "Failure") {
          return;
        }
        const message = removeResult.failure.message;
        expect(message).toContain("git worktree remove");
        expect(message).toContain(`cwd: ${tmp}`);
        expect(message).toContain(missingWorktreePath);
      }),
    );

    it.effect(
      "refreshes upstream before statusDetails so behind count reflects remote updates",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          const clone = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", initialBranch]);

          yield* git(clone, ["clone", remote, "."]);
          yield* git(clone, ["config", "user.email", "test@test.com"]);
          yield* git(clone, ["config", "user.name", "Test"]);
          yield* git(clone, [
            "checkout",
            "-B",
            initialBranch,
            "--track",
            `origin/${initialBranch}`,
          ]);
          yield* writeTextFile(path.join(clone, "CHANGELOG.md"), "remote change\n");
          yield* git(clone, ["add", "CHANGELOG.md"]);
          yield* git(clone, ["commit", "-m", "remote update"]);
          yield* git(clone, ["push", "origin", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe(initialBranch);
          expect(details.aheadCount).toBe(0);
          expect(details.behindCount).toBe(1);
        }),
    );

    it.effect(
      "backs off failed upstream fetches and resumes the normal interval after recovery",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);
          yield* initRepoWithCommit(source);
          const realCore = yield* GitCore;
          const branch = (yield* realCore.listBranches({ cwd: source })).branches.find(
            (entry) => entry.current,
          )!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", branch]);
          let fetches = 0;
          let recovered = false;
          const core = yield* makeIsolatedGitCore((input) => {
            if (input.args[0] !== "fetch") return realCore.execute(input);
            fetches += 1;
            return Effect.succeed({
              code: recovered ? 0 : 1,
              stdout: "",
              stderr: recovered ? "" : "unreachable",
            });
          });
          yield* core.statusDetails(source);
          yield* core.statusDetails(source);
          expect(fetches).toBe(1);
          yield* TestClock.adjust("29 seconds");
          yield* core.statusDetails(source);
          expect(fetches).toBe(1);
          yield* TestClock.adjust("1 second");
          yield* core.statusDetails(source);
          expect(fetches).toBe(2);
          yield* TestClock.adjust("59 seconds");
          yield* core.statusDetails(source);
          expect(fetches).toBe(2);
          recovered = true;
          yield* TestClock.adjust("1 second");
          yield* core.statusDetails(source);
          expect(fetches).toBe(3);
          yield* TestClock.adjust("15 seconds");
          yield* core.statusDetails(source);
          expect(fetches).toBe(4);
          recovered = false;
          yield* TestClock.adjust("15 seconds");
          yield* core.statusDetails(source);
          expect(fetches).toBe(5);
          yield* TestClock.adjust("30 seconds");
          yield* core.statusDetails(source);
          expect(fetches).toBe(6);
        }),
    );

    it.effect("returns UI status before its background upstream refresh completes", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(source);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", initialBranch]);

        const realGitCore = yield* GitCore;
        let fetchStarted = false;
        let releaseFetch!: () => void;
        const waitForRelease = new Promise<void>((resolve) => {
          releaseFetch = resolve;
        });
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "fetch") {
            fetchStarted = true;
            return Effect.promise(() =>
              waitForRelease.then(() => ({ code: 0, stdout: "", stderr: "" })),
            );
          }
          return realGitCore.execute(input);
        });
        const fallbackRelease = setTimeout(releaseFetch, 1_000);
        const startedAt = performance.now();
        const status = yield* core.status({ cwd: source });
        const elapsedMs = performance.now() - startedAt;
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(fetchStarted).toBe(true);
          }),
        );
        clearTimeout(fallbackRelease);

        expect(status.branch).toBe(initialBranch);
        expect(elapsedMs).toBeLessThan(500);
        releaseFetch();
      }),
    );

    it.effect("prepares commit context by auto-staging and creates commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "README.md"), "new content\n");
        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary.length).toBeGreaterThan(0);
        expect(context!.stagedPatch.length).toBeGreaterThan(0);

        const created = yield* core.commit(tmp, "Add README update", "- include updated content");
        expect(created.commitSha.length).toBeGreaterThan(0);
        expect(yield* git(tmp, ["log", "-1", "--pretty=%s"])).toBe("Add README update");
      }),
    );

    it.effect("prepareCommitContext stages only selected files when filePaths provided", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "a.txt"), "file a\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "file b\n");

        const context = yield* core.prepareCommitContext(tmp, ["a.txt"]);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("a.txt");
        expect(context!.stagedSummary).not.toContain("b.txt");

        yield* core.commit(tmp, "Add only a.txt", "");

        // b.txt should still be untracked after commit
        const statusAfter = yield* git(tmp, ["status", "--porcelain"]);
        expect(statusAfter).toContain("b.txt");
        expect(statusAfter).not.toContain("a.txt");
      }),
    );

    it.effect("prepareCommitContext stages everything when filePaths is undefined", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "a.txt"), "file a\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "file b\n");

        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("a.txt");
        expect(context!.stagedSummary).toContain("b.txt");
      }),
    );

    it.effect("pushes with upstream setup and then skips when up to date", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/core-push" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/core-push" });

        yield* writeTextFile(path.join(tmp, "feature.txt"), "push me\n");
        const core = yield* GitCore;
        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        yield* core.commit(tmp, "Add feature file", "");

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/core-push",
        );

        const skipped = yield* core.pushCurrentBranch(tmp, null);
        expect(skipped.status).toBe("skipped_up_to_date");
      }),
    );

    it.effect("pulls behind branch and then reports up-to-date", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", initialBranch]);

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(clone, "CHANGELOG.md"), "remote change\n");
        yield* git(clone, ["add", "CHANGELOG.md"]);
        yield* git(clone, ["commit", "-m", "remote update"]);
        yield* git(clone, ["push", "origin", initialBranch]);

        const core = yield* GitCore;
        const pulled = yield* core.pullCurrentBranch(source);
        expect(pulled.status).toBe("pulled");
        expect((yield* core.statusDetails(source)).behindCount).toBe(0);

        const skipped = yield* core.pullCurrentBranch(source);
        expect(skipped.status).toBe("skipped_up_to_date");
      }),
    );

    it.effect("top-level pullGitBranch rejects when no upstream exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* Effect.result((yield* GitCore).pullCurrentBranch(tmp));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.message.toLowerCase()).toContain("no upstream");
        }
      }),
    );

    it.effect("explains local changes that block pull", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", initialBranch]);

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(clone, "README.md"), "remote change\n");
        yield* git(clone, ["add", "README.md"]);
        yield* git(clone, ["commit", "-m", "remote update"]);
        yield* git(clone, ["push", "origin", initialBranch]);

        yield* writeTextFile(path.join(source, "README.md"), "local change\n");

        const result = yield* Effect.result((yield* GitCore).pullCurrentBranch(source));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.detail).toContain("Local changes block pull");
          expect(result.failure.detail).toContain("README.md");
        }
      }),
    );

    it.effect("lists branches when recency lookup fails", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const realGitCore = yield* GitCore;
        let didFailRecency = false;
        const core = yield* makeIsolatedGitCore((input) => {
          if (!didFailRecency && input.args[0] === "for-each-ref") {
            didFailRecency = true;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.listBranchesRecency",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "timeout",
              }),
            );
          }
          return realGitCore.execute(input);
        });

        const result = yield* core.listBranches({ cwd: tmp });

        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches[0]?.current).toBe(true);
        expect(didFailRecency).toBe(true);
      }),
    );

    it.effect("falls back to empty remote branch data when remote lookups fail", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);

        const realGitCore = yield* GitCore;
        let didFailRemoteBranches = false;
        let didFailRemoteNames = false;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args.join(" ") === "branch --no-color --remotes") {
            didFailRemoteBranches = true;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.listBranchesRemoteBranches",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "remote unavailable",
              }),
            );
          }
          if (input.args.join(" ") === "remote") {
            didFailRemoteNames = true;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.listBranchesRemoteNames",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "remote unavailable",
              }),
            );
          }
          return realGitCore.execute(input);
        });

        const result = yield* core.listBranches({ cwd: tmp });

        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches.every((branch) => !branch.isRemote)).toBe(true);
        expect(didFailRemoteBranches).toBe(true);
        expect(didFailRemoteNames).toBe(true);
      }),
    );
  });
});
