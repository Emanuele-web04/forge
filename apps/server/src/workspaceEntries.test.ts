import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, assert, describe, expect, it, vi } from "vitest";

import * as ProcessRunner from "./processRunner";
import {
  clearWorkspaceIndexCache,
  discoverProjectScripts,
  listWorkspaceDirectories,
  searchLocalEntries,
  searchWorkspaceContent,
  searchWorkspaceEntries,
  resolveWorkspaceFileReferences,
} from "./workspaceEntries";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(cwd: string, relativePath: string, contents = ""): void {
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, "utf8");
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

describe("searchWorkspaceEntries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns files and directories relative to cwd", async () => {
    const cwd = makeTempDir("synara-workspace-entries-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/index.ts");
    writeFile(cwd, "README.md");
    writeFile(cwd, ".git/HEAD");
    writeFile(cwd, "node_modules/pkg/index.js");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/components");
    assert.include(paths, "src/components/Composer.tsx");
    assert.include(paths, "README.md");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".git")));
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith("node_modules")));
    assert.isFalse(result.truncated);
  });

  it("filters and ranks entries by query", async () => {
    const cwd = makeTempDir("synara-workspace-query-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "compo", limit: 5 });

    assert.isAbove(result.entries.length, 0);
    assert.isTrue(result.entries.some((entry) => entry.path === "src/components"));
    assert.isTrue(result.entries.every((entry) => entry.path.toLowerCase().includes("compo")));
  });

  it("ranks name matches above entries that only match through an ancestor directory", async () => {
    const cwd = makeTempDir("synara-workspace-name-first-");
    writeFile(cwd, "apps/web/src/lib/central-icons.tsx");
    writeFile(cwd, "apps/web/public/central-icons-fill/3d.svg");
    writeFile(cwd, "apps/web/public/central-icons-fill/4k.svg");
    writeFile(cwd, "apps/web/public/central-icons-reversed/at.svg");

    const result = await searchWorkspaceEntries({ cwd, query: "cent", kind: "file", limit: 10 });
    const paths = result.entries.map((entry) => entry.path);

    assert.strictEqual(paths[0], "apps/web/src/lib/central-icons.tsx");
    // The directory-only matches still appear, just after everything named "cent…".
    assert.include(paths, "apps/web/public/central-icons-fill/3d.svg");
  });

  it("breaks score ties towards shallower entries", async () => {
    const cwd = makeTempDir("synara-workspace-depth-tiebreak-");
    writeFile(cwd, "zz/deep/nested/config.ts");
    writeFile(cwd, "config.ts");

    const result = await searchWorkspaceEntries({ cwd, query: "config.ts", limit: 10 });

    assert.strictEqual(result.entries[0]?.path, "config.ts");
  });

  it("can restrict search results to files before ranking", async () => {
    const cwd = makeTempDir("synara-workspace-kind-filter-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/components/guide.md");

    const result = await searchWorkspaceEntries({ cwd, query: "compo", kind: "file", limit: 10 });

    assert.isAbove(result.entries.length, 0);
    assert.isTrue(result.entries.every((entry) => entry.kind === "file"));
    assert.isFalse(result.entries.some((entry) => entry.path === "src/components"));
    assert.include(
      result.entries.map((entry) => entry.path),
      "src/components/Composer.tsx",
    );
  });

  it("supports fuzzy subsequence queries for composer path search", async () => {
    const cwd = makeTempDir("synara-workspace-fuzzy-query-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "cmp", limit: 10 });
    const paths = result.entries.map((entry) => entry.path);

    assert.isAbove(result.entries.length, 0);
    assert.include(paths, "src/components");
    assert.include(paths, "src/components/Composer.tsx");
  });

  it("tracks truncation without sorting every fuzzy match", async () => {
    const cwd = makeTempDir("synara-workspace-fuzzy-limit-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "cmp", limit: 1 });

    assert.lengthOf(result.entries, 1);
    assert.isTrue(result.truncated);
  });

  it("excludes gitignored paths for git repositories", async () => {
    const cwd = makeTempDir("synara-workspace-gitignore-");
    runGit(cwd, ["init"]);
    writeFile(cwd, ".gitignore", ".convex/\nconvex/\nignored.txt\n");
    writeFile(cwd, "src/keep.ts", "export {};");
    writeFile(cwd, "ignored.txt", "ignore me");
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "convex/UOoS-l/convex_local_storage/modules/data.json", "{}");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.notInclude(paths, "ignored.txt");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith("convex/")));
  });

  it("excludes tracked paths that match ignore rules", async () => {
    const cwd = makeTempDir("synara-workspace-tracked-gitignore-");
    runGit(cwd, ["init"]);
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "src/keep.ts", "export {};");
    runGit(cwd, ["add", ".convex/local-storage/data.json", "src/keep.ts"]);
    writeFile(cwd, ".gitignore", ".convex/\n");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
  });

  it("disables fsmonitor and untracked cache helpers during git workspace indexing", async () => {
    const cwd = makeTempDir("synara-workspace-hardened-git-");

    const runProcessSpy = vi.spyOn(ProcessRunner, "runProcess");
    runProcessSpy.mockImplementation(async (command, args) => {
      if (command !== "git") {
        throw new Error(`Unexpected command: ${command}`);
      }
      if (args.includes("rev-parse")) {
        return {
          stdout: "true\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      if (args.includes("ls-files")) {
        return {
          stdout: "src/keep.ts\0ignored.txt\0",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      if (args.includes("check-ignore")) {
        return {
          stdout: "ignored.txt\0",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    const gitCalls = runProcessSpy.mock.calls
      .filter(([command]) => command === "git")
      .map(([, args]) => args);

    assert.include(paths, "src/keep.ts");
    assert.notInclude(paths, "ignored.txt");
    assert.deepInclude(gitCalls, [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    assert.deepInclude(gitCalls, [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "check-ignore",
      "--no-index",
      "-z",
      "--stdin",
    ]);
  });

  it("excludes .convex in non-git workspaces", async () => {
    const cwd = makeTempDir("synara-workspace-non-git-convex-");
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "src/keep.ts", "export {};");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
  });

  it("deduplicates concurrent index builds for the same cwd", async () => {
    const cwd = makeTempDir("synara-workspace-concurrent-build-");
    writeFile(cwd, "src/components/Composer.tsx");

    let rootReadCount = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      if (args[0] === cwd) {
        rootReadCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    await Promise.all([
      searchWorkspaceEntries({ cwd, query: "", limit: 100 }),
      searchWorkspaceEntries({ cwd, query: "comp", limit: 100 }),
      searchWorkspaceEntries({ cwd, query: "src", limit: 100 }),
    ]);

    assert.equal(rootReadCount, 1);
  });

  it("resolves exact and unique suffix references from one workspace index", async () => {
    const cwd = makeTempDir("synara-workspace-reference-batch-");
    writeFile(cwd, "src/index.ts");
    writeFile(cwd, "apps/web/src/unique.ts");
    writeFile(cwd, "apps/server/src/shared.ts");
    writeFile(cwd, "apps/web/src/shared.ts");

    const result = await resolveWorkspaceFileReferences({
      cwd,
      relativePaths: ["src/index.ts", "unique.ts", "shared.ts", "missing.ts", "../outside.ts"],
    });

    expect(result.relativePaths).toEqual([
      "src/index.ts",
      "apps/web/src/unique.ts",
      null,
      null,
      null,
    ]);
  });

  it("limits concurrent directory reads while walking the filesystem", async () => {
    const cwd = makeTempDir("synara-workspace-read-concurrency-");
    for (let index = 0; index < 80; index += 1) {
      writeFile(cwd, `group-${index}/entry-${index}.ts`, "export {};");
    }

    let activeReads = 0;
    let peakReads = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      const target = args[0];
      if (typeof target === "string" && target.startsWith(cwd)) {
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 4));
        try {
          return await originalReaddir(...args);
        } finally {
          activeReads -= 1;
        }
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    await searchWorkspaceEntries({ cwd, query: "", limit: 200 });

    assert.isAtMost(peakReads, 32);
  });

  it("does not let a build that started before invalidation repopulate the cache", async () => {
    const cwd = makeTempDir("synara-workspace-invalidate-race-");
    writeFile(cwd, "before.ts");

    let rootReadCount = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      if (args[0] === cwd) {
        rootReadCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    const staleBuild = searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    clearWorkspaceIndexCache(cwd);
    await staleBuild;

    // The pre-invalidation build must not have re-seeded the cache, so this
    // search triggers a fresh walk instead of serving the stale snapshot.
    await searchWorkspaceEntries({ cwd, query: "", limit: 100 });

    assert.equal(rootReadCount, 2);
  });
});

describe("searchLocalEntries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces dotfiles when the query keeps a leading dot", async () => {
    const rootPath = makeTempDir("synara-local-dotfiles-");
    writeFile(rootPath, ".env", "SECRET=1");
    writeFile(rootPath, "envelope.txt");

    const dotResult = await searchLocalEntries({ rootPath, query: ".env" });
    assert.include(
      dotResult.entries.map((entry) => entry.name),
      ".env",
    );

    const plainResult = await searchLocalEntries({ rootPath, query: "env" });
    const plainNames = plainResult.entries.map((entry) => entry.name);
    assert.notInclude(plainNames, ".env");
    assert.include(plainNames, "envelope.txt");
  });

  it("strips mention and path-noise prefixes without eating a dotfile prefix", async () => {
    const rootPath = makeTempDir("synara-local-prefix-");
    writeFile(rootPath, ".env", "SECRET=1");
    writeFile(rootPath, "projects/demo.txt");

    const mentionResult = await searchLocalEntries({ rootPath, query: "@.env" });
    assert.include(
      mentionResult.entries.map((entry) => entry.name),
      ".env",
    );

    const pathResult = await searchLocalEntries({ rootPath, query: "./proj" });
    assert.include(
      pathResult.entries.map((entry) => entry.name),
      "projects",
    );
  });
});

describe("listWorkspaceDirectories", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can include files after directories for local recursive browsing", async () => {
    const cwd = makeTempDir("synara-workspace-list-directories-");
    writeFile(cwd, "docs/guide.md", "# guide");
    writeFile(cwd, "docs/api/reference.txt", "api");
    writeFile(cwd, "README.md", "root");

    const result = await listWorkspaceDirectories({ cwd, includeFiles: true });

    expect(result.entries).toEqual([
      { path: "docs", name: "docs", kind: "directory", hasChildren: true },
      { path: "README.md", name: "README.md", kind: "file" },
    ]);
  });

  it("rejects relative paths that escape the workspace root", async () => {
    const cwd = makeTempDir("synara-workspace-list-directories-");
    writeFile(cwd, "docs/guide.md", "# guide");

    for (const relativePath of ["..", "../..", "docs/../../etc", "/etc"]) {
      await expect(
        listWorkspaceDirectories({ cwd, includeFiles: true, relativePath }),
      ).rejects.toThrow("outside the workspace root");
    }

    // Traversal that stays contained inside the root is still allowed.
    const contained = await listWorkspaceDirectories({
      cwd,
      includeFiles: true,
      relativePath: "docs/../docs",
    });
    expect(contained.entries.map((entry) => entry.name)).toEqual(["guide.md"]);
  });

  it("rejects symlinked directories that escape the workspace root", async () => {
    const cwd = makeTempDir("synara-workspace-list-directories-");
    const outside = makeTempDir("synara-workspace-list-outside-");
    writeFile(outside, "secret.txt", "top secret");
    fs.symlinkSync(outside, path.join(cwd, "innocent"));

    await expect(
      listWorkspaceDirectories({ cwd, includeFiles: true, relativePath: "innocent" }),
    ).rejects.toThrow("outside the workspace root");

    // A symlink that resolves inside the root is still allowed.
    writeFile(cwd, "docs/guide.md", "# guide");
    fs.symlinkSync(path.join(cwd, "docs"), path.join(cwd, "docs-alias"));
    const contained = await listWorkspaceDirectories({
      cwd,
      includeFiles: true,
      relativePath: "docs-alias",
    });
    expect(contained.entries.map((entry) => entry.name)).toEqual(["guide.md"]);
  });
});

describe("discoverProjectScripts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers root package scripts with lockfile-selected commands", async () => {
    const cwd = makeTempDir("synara-script-discovery-root-");
    writeFile(
      cwd,
      "package.json",
      JSON.stringify({ name: "root-app", scripts: { dev: "vite", start: "vite --host" } }),
    );
    writeFile(cwd, "bun.lock", "");

    const result = await discoverProjectScripts({ cwd });

    expect(result.targets).toEqual([
      {
        cwd,
        relativePath: "",
        packageJsonPath: path.join(cwd, "package.json"),
        packageName: "root-app",
        scripts: [
          { name: "dev", command: "bun run dev" },
          { name: "start", command: "bun run start" },
        ],
      },
    ]);
  });

  it("discovers shallow nested package scripts", async () => {
    const cwd = makeTempDir("synara-script-discovery-nested-");
    writeFile(cwd, "apps/web/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "apps/web/pnpm-lock.yaml", "");

    const result = await discoverProjectScripts({ cwd, depth: 2 });

    expect(result.targets).toEqual([
      {
        cwd: path.join(cwd, "apps/web"),
        relativePath: "apps/web",
        packageJsonPath: path.join(cwd, "apps/web/package.json"),
        scripts: [{ name: "dev", command: "pnpm run dev" }],
      },
    ]);
  });

  it("ignores invalid package json files", async () => {
    const cwd = makeTempDir("synara-script-discovery-invalid-");
    writeFile(cwd, "package.json", "{ nope");
    writeFile(cwd, "apps/ok/package.json", JSON.stringify({ scripts: { start: "vite" } }));

    const result = await discoverProjectScripts({ cwd, depth: 2 });

    expect(result.targets.map((target) => target.relativePath)).toEqual(["apps/ok"]);
  });

  it("skips ignored package directories", async () => {
    const cwd = makeTempDir("synara-script-discovery-ignored-");
    writeFile(cwd, "node_modules/pkg/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "dist/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "packages/app/package.json", JSON.stringify({ scripts: { dev: "vite" } }));

    const result = await discoverProjectScripts({ cwd, depth: 2 });

    expect(result.targets.map((target) => target.relativePath)).toEqual(["packages/app"]);
  });

  it("prefers package manager lockfiles in discovery order", async () => {
    const cwd = makeTempDir("synara-script-discovery-package-manager-");
    writeFile(cwd, "apps/bun/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "apps/bun/bun.lockb", "");
    writeFile(cwd, "apps/pnpm/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "apps/pnpm/pnpm-lock.yaml", "");
    writeFile(cwd, "apps/yarn/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "apps/yarn/yarn.lock", "");
    writeFile(cwd, "apps/npm/package.json", JSON.stringify({ scripts: { dev: "vite" } }));

    const result = await discoverProjectScripts({ cwd, depth: 2 });
    const commandsByPath = new Map(
      result.targets.map((target) => [target.relativePath, target.scripts[0]?.command]),
    );

    expect(commandsByPath.get("apps/bun")).toBe("bun run dev");
    expect(commandsByPath.get("apps/pnpm")).toBe("pnpm run dev");
    expect(commandsByPath.get("apps/yarn")).toBe("yarn dev");
    expect(commandsByPath.get("apps/npm")).toBe("npm run dev");
  });
});

describe("searchWorkspaceContent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds matching lines with path, line number, and text", async () => {
    const cwd = makeTempDir("synara-content-search-basic-");
    writeFile(
      cwd,
      "src/index.ts",
      "export const a = 1;\nexport function findMe() {\n  return true;\n}\n",
    );
    writeFile(cwd, "src/other.ts", "const FINDME = 'x';\n");
    writeFile(cwd, "README.md", "not a match\n");

    const result = await searchWorkspaceContent({ cwd, query: "findme" });

    expect(result.truncated).toBe(false);
    expect(result.matches).toEqual([
      { path: "src/index.ts", lineNumber: 2, lineText: "export function findMe() {" },
      { path: "src/other.ts", lineNumber: 1, lineText: "const FINDME = 'x';" },
    ]);
  });

  it("returns no matches for queries shorter than two characters", async () => {
    const cwd = makeTempDir("synara-content-search-short-query-");
    writeFile(cwd, "a.ts", "x\n");

    const result = await searchWorkspaceContent({ cwd, query: "x" });

    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("skips binary files", async () => {
    const cwd = makeTempDir("synara-content-search-binary-");
    writeFile(cwd, "text.ts", "needle in text\n");
    writeFile(cwd, "blob.bin", "");
    fs.writeFileSync(path.join(cwd, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const result = await searchWorkspaceContent({ cwd, query: "needle" });

    expect(result.matches).toEqual([
      { path: "text.ts", lineNumber: 1, lineText: "needle in text" },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "does not follow tracked symlinks outside the workspace",
    async () => {
      const cwd = makeTempDir("synara-content-search-symlink-");
      const outside = makeTempDir("synara-content-search-outside-");
      writeFile(outside, "secret.txt", "outside needle\n");
      runGit(cwd, ["init"]);
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(cwd, "linked-secret.txt"));
      runGit(cwd, ["add", "linked-secret.txt"]);

      const result = await searchWorkspaceContent({ cwd, query: "needle" });

      expect(result.matches).toEqual([]);
    },
  );

  it("caps per-file matches so one hot file cannot crowd out others", async () => {
    const cwd = makeTempDir("synara-content-search-per-file-cap-");
    const hotLines = Array.from({ length: 10 }, () => "hot needle line\n").join("");
    writeFile(cwd, "hot.ts", hotLines);
    writeFile(cwd, "cold.ts", "needle in cold file\n");

    const result = await searchWorkspaceContent({ cwd, query: "needle" });

    const hotMatches = result.matches.filter((match) => match.path === "hot.ts");
    expect(hotMatches.length).toBeLessThanOrEqual(5);
    expect(result.matches.some((match) => match.path === "cold.ts")).toBe(true);
  });

  it("truncates when matches exceed the requested limit", async () => {
    const cwd = makeTempDir("synara-content-search-limit-");
    for (let index = 0; index < 20; index += 1) {
      writeFile(cwd, `src/file${index}.ts`, `needle ${index}\n`);
    }

    const result = await searchWorkspaceContent({ cwd, query: "needle", limit: 5 });

    expect(result.matches.length).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
  });

  it("scans files past the first 2000 in alphabetical order", async () => {
    // Regression guard: a fixed file-count cap applied to the sorted index
    // used to permanently exclude files late in the alphabet from every query.
    const cwd = makeTempDir("synara-content-search-no-count-cap-");
    fs.mkdirSync(path.join(cwd, "bulk"), { recursive: true });
    for (let index = 0; index < 2_000; index += 1) {
      fs.writeFileSync(
        path.join(cwd, "bulk", `filler-${String(index).padStart(4, "0")}.txt`),
        "nothing here\n",
      );
    }
    writeFile(cwd, "zzz-last.txt", "needle at the end of the alphabet\n");

    const result = await searchWorkspaceContent({ cwd, query: "needle" });

    expect(result.matches).toEqual([
      { path: "zzz-last.txt", lineNumber: 1, lineText: "needle at the end of the alphabet" },
    ]);
    expect(result.truncated).toBe(false);
  });
});
