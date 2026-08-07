import * as NodeFs from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { createLocalPreviewGrant } from "../../localImageFiles";
import { WorkspaceEntries } from "../Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem";
import { WorkspaceEntriesLive } from "./WorkspaceEntries";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem";
import { WorkspacePathsLive } from "./WorkspacePaths";

const WorkspaceLayer = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive,
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive),
  ),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-workspace-files-" });
});

const writeTextFile = Effect.fn(function* (cwd: string, relativePath: string, contents = "") {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

const makeDirectorySymlink = (target: string, linkPath: string) =>
  NodeFs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/app.ts", "export const value = 1;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/app.ts",
        });

        expect(result).toMatchObject({
          relativePath: "src/app.ts",
          contents: "export const value = 1;\n",
          truncated: false,
          encoding: "utf8",
          lineEnding: "lf",
        });
        expect(result.version).toMatch(/^sha256:[0-9a-f]{64}$/);
      }),
    );

    it.effect("returns a truncated prefix for large files", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "large.txt", "abcdef");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "large.txt",
          maxBytes: 3,
        });

        expect(result).toEqual({
          relativePath: "large.txt",
          contents: "abc",
          truncated: true,
          version: null,
          encoding: null,
          lineEnding: null,
        });
      }),
    );

    it.effect("refuses binary files instead of exposing them as editable text", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* Effect.promise(() =>
          NodeFs.writeFile(path.join(cwd, "binary.dat"), Buffer.from([0x01, 0x00, 0x02])),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "binary.dat" })
          .pipe(Effect.flip);

        expect(error.message).toContain("File appears to be binary");
      }),
    );

    it.effect(
      "reads granted absolute local file paths without remapping them to the workspace",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outside = yield* makeTempDir;
          yield* writeTextFile(outside, "Downloads/report.txt", "local file\n");
          const absolutePath = path.join(outside, "Downloads/report.txt");
          const grant = yield* Effect.promise(() =>
            createLocalPreviewGrant({ requestedPath: absolutePath }),
          );

          const result = yield* workspaceFileSystem.readFile({
            cwd,
            relativePath: absolutePath,
            previewGrant: grant.grant,
          });

          expect(result).toMatchObject({
            relativePath: absolutePath,
            contents: "local file\n",
            truncated: false,
            encoding: "utf8",
            lineEnding: "lf",
          });
          expect(result.version).toMatch(/^sha256:[0-9a-f]{64}$/);
        }),
    );

    it.effect("rejects absolute local file paths without a preview grant", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(outside, "Downloads/report.txt", "local file\n");
        const absolutePath = path.join(outside, "Downloads/report.txt");

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: absolutePath,
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          `Workspace file path must be relative to the project root: ${absolutePath}`,
        );
      }),
    );

    it.effect("resolves a bare filename to its unique nested file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "apps/web/src/lib/chatReferences.test.ts",
          "export const v = 1;\n",
        );

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "chatReferences.test.ts",
        });

        expect(result).toMatchObject({
          relativePath: "apps/web/src/lib/chatReferences.test.ts",
          contents: "export const v = 1;\n",
          truncated: false,
          encoding: "utf8",
          lineEnding: "lf",
        });
        expect(result.version).toMatch(/^sha256:[0-9a-f]{64}$/);
      }),
    );

    it.effect("resolves a partial path tail to its unique nested file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "apps/web/src/lib/chatReferences.ts", "export const v = 2;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "lib/chatReferences.ts",
        });

        expect(result.relativePath).toBe("apps/web/src/lib/chatReferences.ts");
        expect(result.contents).toBe("export const v = 2;\n");
      }),
    );

    it.effect("does not resolve an ambiguous basename to a single file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a/index.ts", "export const a = 1;\n");
        yield* writeTextFile(cwd, "b/index.ts", "export const b = 1;\n");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "index.ts" })
          .pipe(Effect.flip);

        expect(error.message).toContain("ENOENT");
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects symlinks that escape the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(outside, "secret.txt", "top secret\n");
        yield* Effect.promise(() =>
          NodeFs.symlink(path.join(outside, "secret.txt"), path.join(cwd, "innocent.txt")),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "innocent.txt" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: innocent.txt",
        );
      }),
    );

    it.effect("follows symlinks that resolve inside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/app.ts", "export const value = 1;\n");
        yield* Effect.promise(() =>
          NodeFs.symlink(path.join(cwd, "src/app.ts"), path.join(cwd, "alias.ts")),
        );

        const result = yield* workspaceFileSystem.readFile({ cwd, relativePath: "alias.ts" });

        expect(result.contents).toBe("export const value = 1;\n");
        expect(result.truncated).toBe(false);
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result.relativePath).toBe("plans/effect-rpc.md");
        expect(result.version).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("safely saves the loaded version while preserving UTF-8 BOM and CRLF", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "notes.txt");
        yield* Effect.promise(() =>
          NodeFs.writeFile(
            absolutePath,
            Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("one\r\ntwo\r\n")]),
          ),
        );

        const loaded = yield* workspaceFileSystem.readFile({ cwd, relativePath: "notes.txt" });
        expect(loaded).toMatchObject({
          contents: "one\ntwo\n",
          encoding: "utf8-bom",
          lineEnding: "crlf",
          truncated: false,
        });

        const saved = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: loaded.relativePath,
          contents: "one edited\ntwo\n",
          expectedVersion: loaded.version!,
          encoding: loaded.encoding!,
          lineEnding: loaded.lineEnding!,
        });
        const savedBytes = yield* Effect.promise(() => NodeFs.readFile(absolutePath));

        expect(saved.version).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(saved.version).not.toBe(loaded.version);
        expect(savedBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
        expect(savedBytes.subarray(3).toString("utf8")).toBe("one edited\r\ntwo\r\n");
      }),
    );

    it.effect("refuses a guarded save when the file changed after loading", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "shared.txt");
        yield* writeTextFile(cwd, "shared.txt", "loaded\n");
        const loaded = yield* workspaceFileSystem.readFile({ cwd, relativePath: "shared.txt" });
        yield* Effect.promise(() => NodeFs.writeFile(absolutePath, "agent!\n"));

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: loaded.relativePath,
            contents: "manual edit\n",
            expectedVersion: loaded.version!,
            encoding: loaded.encoding!,
            lineEnding: loaded.lineEnding!,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileConflictError");
        expect(error.message).toContain("changed on disk");
        expect(yield* Effect.promise(() => NodeFs.readFile(absolutePath, "utf8"))).toBe("agent!\n");
      }),
    );

    it.effect("refuses a guarded save when the loaded file was deleted", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "removed.txt");
        yield* writeTextFile(cwd, "removed.txt", "loaded\n");
        const loaded = yield* workspaceFileSystem.readFile({ cwd, relativePath: "removed.txt" });
        yield* Effect.promise(() => NodeFs.unlink(absolutePath));

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: loaded.relativePath,
            contents: "manual edit\n",
            expectedVersion: loaded.version!,
            encoding: loaded.encoding!,
            lineEnding: loaded.lineEnding!,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileDeletedError");
        expect(error.message).toContain("removed from disk");
        expect(yield* Effect.promise(() => NodeFs.stat(absolutePath).catch(() => null))).toBeNull();
      }),
    );

    it.effect("surfaces permission failures from guarded saves", () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return;

        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "read-only.txt");
        yield* writeTextFile(cwd, "read-only.txt", "loaded\n");
        const loaded = yield* workspaceFileSystem.readFile({ cwd, relativePath: "read-only.txt" });
        yield* Effect.promise(() => NodeFs.chmod(absolutePath, 0o444));

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: loaded.relativePath,
            contents: "manual edit\n",
            expectedVersion: loaded.version!,
            encoding: loaded.encoding!,
            lineEnding: loaded.lineEnding!,
          })
          .pipe(Effect.flip);

        expect(error.message).toContain("workspaceFileSystem.writeFile failed");
        expect(yield* Effect.promise(() => NodeFs.readFile(absolutePath, "utf8"))).toBe("loaded\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({ cwd, query: "rpc", limit: 10 });
        expect(beforeWrite).toEqual({ entries: [], truncated: false });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({ cwd, query: "rpc", limit: 10 });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
            expectedVersion: `sha256:${"0".repeat(64)}`,
            encoding: "utf8",
            lineEnding: "lf",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("rejects missing files beneath a symlinked parent outside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* Effect.promise(() =>
          makeDirectorySymlink(outside, path.join(cwd, "linked-outside")),
        );

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "linked-outside/new/deep/file.txt",
            contents: "must stay inside\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked-outside/new/deep/file.txt",
        );
        const escapedStat = yield* Effect.promise(() =>
          NodeFs.stat(path.join(outside, "new/deep/file.txt")).catch(() => null),
        );
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("does not replace existing files through an outside symlinked parent", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(outside, "existing.txt", "outside original\n");
        yield* Effect.promise(() =>
          makeDirectorySymlink(outside, path.join(cwd, "linked-outside")),
        );

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "linked-outside/existing.txt",
            contents: "replacement\n",
          })
          .pipe(Effect.flip);
        const saved = yield* Effect.promise(() =>
          NodeFs.readFile(path.join(outside, "existing.txt"), "utf8"),
        );

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked-outside/existing.txt",
        );
        expect(saved).toBe("outside original\n");
      }),
    );

    it.effect("writes missing files through symlinked parents that stay inside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* Effect.promise(() => NodeFs.mkdir(path.join(cwd, "actual")));
        yield* Effect.promise(() =>
          makeDirectorySymlink(path.join(cwd, "actual"), path.join(cwd, "linked-inside")),
        );

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "linked-inside/new/deep/file.txt",
          contents: "allowed\n",
        });
        const saved = yield* Effect.promise(() =>
          NodeFs.readFile(path.join(cwd, "actual/new/deep/file.txt"), "utf8"),
        );

        expect(result.relativePath).toBe("linked-inside/new/deep/file.txt");
        expect(result.version).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(saved).toBe("allowed\n");
      }),
    );

    it.effect("preserves an in-workspace file symlink while replacing its target", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "actual/file.txt", "before\n");
        yield* Effect.promise(() =>
          NodeFs.symlink(path.join(cwd, "actual/file.txt"), path.join(cwd, "alias.txt")),
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "alias.txt",
          contents: "after\n",
        });

        const aliasStat = yield* Effect.promise(() => NodeFs.lstat(path.join(cwd, "alias.txt")));
        const saved = yield* Effect.promise(() =>
          NodeFs.readFile(path.join(cwd, "actual/file.txt"), "utf8"),
        );
        expect(aliasStat.isSymbolicLink()).toBe(true);
        expect(saved).toBe("after\n");
      }),
    );

    it.effect("atomically replaces an existing regular file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "existing.txt", "before\n");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "existing.txt",
          contents: "after\n",
        });

        const saved = yield* Effect.promise(() =>
          NodeFs.readFile(path.join(cwd, "existing.txt"), "utf8"),
        );
        const savedStat = yield* Effect.promise(() => NodeFs.lstat(path.join(cwd, "existing.txt")));
        expect(saved).toBe("after\n");
        expect(savedStat.isFile()).toBe(true);
      }),
    );

    it.effect("preserves exact permissions when replacement creation is masked by umask", () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return;

        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "mode-preserved.txt");
        yield* writeTextFile(cwd, "mode-preserved.txt", "before\n");
        yield* Effect.promise(() => NodeFs.chmod(absolutePath, 0o664));

        yield* Effect.acquireUseRelease(
          Effect.sync(() => process.umask(0o077)),
          () =>
            workspaceFileSystem.writeFile({
              cwd,
              relativePath: "mode-preserved.txt",
              contents: "after\n",
            }),
          (previousUmask) =>
            Effect.sync(() => {
              process.umask(previousUmask);
            }),
        );

        const saved = yield* Effect.promise(() => NodeFs.readFile(absolutePath, "utf8"));
        const savedStat = yield* Effect.promise(() => NodeFs.stat(absolutePath));
        expect(saved).toBe("after\n");
        expect(savedStat.mode & 0o777).toBe(0o664);
      }),
    );

    it.effect("rejects dangling symlink write targets", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        const missingOutsideTarget = path.join(outside, "missing.txt");
        yield* Effect.promise(() =>
          NodeFs.symlink(missingOutsideTarget, path.join(cwd, "dangling.txt")),
        );

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "dangling.txt", contents: "must not escape\n" })
          .pipe(Effect.flip);

        expect(error.message).toContain("workspaceFileSystem.writeFile failed");
        const outsideStat = yield* Effect.promise(() =>
          NodeFs.stat(missingOutsideTarget).catch(() => null),
        );
        const danglingStat = yield* Effect.promise(() =>
          NodeFs.lstat(path.join(cwd, "dangling.txt")),
        );
        expect(outsideStat).toBeNull();
        expect(danglingStat.isSymbolicLink()).toBe(true);
      }),
    );
  });
});
