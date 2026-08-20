import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./processRunner";

import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectDiscoverScriptsInput,
  ProjectDiscoverScriptsResult,
  ProjectDirectoryEntry,
  ProjectDiscoveredScriptTarget,
  ProjectFileSystemEntry,
  ProjectListDirectoriesInput,
  ProjectListDirectoriesResult,
  ProjectEntry,
  ProjectLocalSearchEntry,
  ProjectPrewarmSearchIndexInput,
  ProjectPrewarmSearchIndexResult,
  ProjectSearchContentInput,
  ProjectSearchContentResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchLocalEntriesInput,
  ProjectSearchLocalEntriesResult,
  PROJECT_SEARCH_CONTENT_MAX_LIMIT,
  PROJECT_SEARCH_CONTENT_MAX_LINE_LENGTH,
  PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH,
} from "@synara/contracts";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@synara/shared/path";
import { normalizeWorkspaceEntrySearchQuery } from "@synara/shared/searchQuery";
import { resolveRealPathWithinRoot } from "./workspace/realPathContainment";

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
const PROJECT_SCRIPT_DISCOVERY_DEFAULT_DEPTH = 2;
const PROJECT_PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const PROJECT_PACKAGE_SCAN_MAX_TARGETS = 80;
const PROJECT_PACKAGE_SCAN_READDIR_CONCURRENCY = 16;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

interface WorkspaceIndex {
  scannedAt: number;
  entries: SearchableWorkspaceEntry[];
  truncated: boolean;
}

interface SearchableWorkspaceEntry extends ProjectEntry {
  normalizedPath: string;
  normalizedName: string;
  /** Number of path segments; used to break score ties towards shallower entries. */
  depth: number;
}

interface RankedWorkspaceEntry {
  entry: SearchableWorkspaceEntry;
  score: number;
}

const workspaceIndexCache = new Map<string, WorkspaceIndex>();
const inFlightWorkspaceIndexBuilds = new Map<string, Promise<WorkspaceIndex>>();

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return undefined;
  }
  return input.slice(0, separatorIndex);
}

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return input;
  }
  return input.slice(separatorIndex + 1);
}

function toSearchableWorkspaceEntry(entry: ProjectEntry): SearchableWorkspaceEntry {
  const normalizedPath = entry.path.toLowerCase();
  let depth = 1;
  for (let index = 0; index < normalizedPath.length; index += 1) {
    if (normalizedPath[index] === "/") depth += 1;
  }
  return {
    ...entry,
    normalizedPath,
    normalizedName: basenameOf(normalizedPath),
    depth,
  };
}

// Local filesystem search keeps its own normalizer instead of the shared
// normalizeWorkspaceEntrySearchQuery: here a leading "." is meaningful — it
// switches the walk to include dotfiles — so only mention/path noise is
// stripped ("@" and "/" prefixes plus "./" pairs) while a dotfile prefix
// like ".env" survives.
function normalizeLocalSearchQuery(input: string): string {
  let query = input.trim();
  while (query.startsWith("@") || query.startsWith("/") || query.startsWith("./")) {
    query = query.startsWith("./") ? query.slice(2) : query.slice(1);
  }
  return query.toLowerCase();
}

function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

function scoreEntry(entry: SearchableWorkspaceEntry, query: string): number | null {
  if (!query) {
    return entry.kind === "directory" ? 0 : 1;
  }

  const { normalizedPath, normalizedName } = entry;

  // Every match on the entry's own name outranks every match that only exists in
  // its ancestry. A single matching directory ("central-icons-fill") otherwise
  // promotes each of its thousands of children to the same score, burying the
  // handful of entries the user actually named.
  if (normalizedName === query) return 0;
  if (normalizedPath === query) return 1;
  if (normalizedName.startsWith(query)) return 2;
  if (normalizedName.includes(query)) return 3;

  const nameFuzzyScore = scoreSubsequenceMatch(normalizedName, query);
  if (nameFuzzyScore !== null) {
    return 100 + nameFuzzyScore;
  }

  if (normalizedPath.startsWith(query)) return 1000;
  if (normalizedPath.includes(`/${query}`)) return 1001;
  if (normalizedPath.includes(query)) return 1002;

  const pathFuzzyScore = scoreSubsequenceMatch(normalizedPath, query);
  if (pathFuzzyScore !== null) {
    return 1100 + pathFuzzyScore;
  }

  return null;
}

function compareRankedWorkspaceEntries(
  left: RankedWorkspaceEntry,
  right: RankedWorkspaceEntry,
): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  // Equally scored entries: surface the shallower one first, so a top-level hit
  // never sits below a deeply nested namesake, then fall back to a stable order.
  const depthDelta = left.entry.depth - right.entry.depth;
  if (depthDelta !== 0) return depthDelta;
  return left.entry.path.localeCompare(right.entry.path);
}

function findInsertionIndex(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
): number {
  let low = 0;
  let high = rankedEntries.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedEntries[middle];
    if (!current) {
      break;
    }

    if (compareRankedWorkspaceEntries(candidate, current) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

function insertRankedEntry(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
  limit: number,
): void {
  if (limit <= 0) {
    return;
  }

  const insertionIndex = findInsertionIndex(rankedEntries, candidate);
  if (rankedEntries.length < limit) {
    rankedEntries.splice(insertionIndex, 0, candidate);
    return;
  }

  if (insertionIndex >= limit) {
    return;
  }

  rankedEntries.splice(insertionIndex, 0, candidate);
  rankedEntries.pop();
}

function isPathInIgnoredDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) return false;
  return IGNORED_DIRECTORY_NAMES.has(firstSegment);
}

type ProjectPackageManager = "bun" | "pnpm" | "yarn" | "npm";

const PROJECT_PACKAGE_MANAGER_LOCKFILES: ReadonlyArray<{
  readonly manager: ProjectPackageManager;
  readonly filenames: readonly string[];
}> = [
  { manager: "bun", filenames: ["bun.lock", "bun.lockb"] },
  { manager: "pnpm", filenames: ["pnpm-lock.yaml"] },
  { manager: "yarn", filenames: ["yarn.lock"] },
  { manager: "npm", filenames: ["package-lock.json", "npm-shrinkwrap.json"] },
];

function normalizeDiscoveryDepth(input: ProjectDiscoverScriptsInput): number {
  const rawDepth = input.depth ?? PROJECT_SCRIPT_DISCOVERY_DEFAULT_DEPTH;
  return Math.max(0, Math.min(3, Math.floor(rawDepth)));
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(packageDir: string): Promise<ProjectPackageManager> {
  for (const candidate of PROJECT_PACKAGE_MANAGER_LOCKFILES) {
    for (const filename of candidate.filenames) {
      if (await pathExists(path.join(packageDir, filename))) {
        return candidate.manager;
      }
    }
  }
  return "npm";
}

function commandForPackageScript(manager: ProjectPackageManager, scriptName: string): string {
  if (manager === "yarn") {
    return `yarn ${scriptName}`;
  }
  return `${manager} run ${scriptName}`;
}

async function collectPackageJsonCandidates(
  cwd: string,
  maxDepth: number,
): Promise<Array<{ absoluteDir: string; relativePath: string }>> {
  const candidates: Array<{ absoluteDir: string; relativePath: string }> = [];
  let pendingDirectories: Array<{ absoluteDir: string; relativePath: string; depth: number }> = [
    { absoluteDir: cwd, relativePath: "", depth: 0 },
  ];

  while (pendingDirectories.length > 0 && candidates.length < PROJECT_PACKAGE_SCAN_MAX_TARGETS) {
    const currentDirectories = pendingDirectories;
    pendingDirectories = [];

    const directoryEntries = await mapWithConcurrency(
      currentDirectories,
      PROJECT_PACKAGE_SCAN_READDIR_CONCURRENCY,
      async (directory) => {
        try {
          const dirents = await fs.readdir(directory.absoluteDir, { withFileTypes: true });
          return { directory, dirents };
        } catch {
          return { directory, dirents: null };
        }
      },
    );

    for (const { directory, dirents } of directoryEntries) {
      if (!dirents) {
        continue;
      }
      if (dirents.some((dirent) => dirent.isFile() && dirent.name === "package.json")) {
        candidates.push({
          absoluteDir: directory.absoluteDir,
          relativePath: directory.relativePath,
        });
        if (candidates.length >= PROJECT_PACKAGE_SCAN_MAX_TARGETS) {
          break;
        }
      }
      if (directory.depth >= maxDepth) {
        continue;
      }
      for (const dirent of dirents.toSorted((left, right) => left.name.localeCompare(right.name))) {
        if (!dirent.isDirectory() || IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
          continue;
        }
        if (dirent.name === "." || dirent.name === "..") {
          continue;
        }
        const childRelativePath = toPosixPath(
          directory.relativePath ? path.join(directory.relativePath, dirent.name) : dirent.name,
        );
        if (isPathInIgnoredDirectory(childRelativePath)) {
          continue;
        }
        pendingDirectories.push({
          absoluteDir: path.join(directory.absoluteDir, dirent.name),
          relativePath: childRelativePath,
          depth: directory.depth + 1,
        });
      }
    }
  }

  return candidates;
}

async function readDiscoveredPackageTarget(input: {
  cwd: string;
  relativePath: string;
}): Promise<ProjectDiscoveredScriptTarget | null> {
  const packageJsonPath = path.join(input.cwd, "package.json");
  const stats = await fs.stat(packageJsonPath).catch(() => null);
  if (!stats?.isFile() || stats.size > PROJECT_PACKAGE_JSON_MAX_BYTES) {
    return null;
  }

  const packageJsonText = await fs.readFile(packageJsonPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const packageRecord = parsed as Record<string, unknown>;
  const rawScripts = packageRecord.scripts;
  if (!rawScripts || typeof rawScripts !== "object" || Array.isArray(rawScripts)) {
    return null;
  }

  const manager = await detectPackageManager(input.cwd);
  const scripts = Object.entries(rawScripts)
    .flatMap(([name, command]) =>
      typeof command === "string" && name.trim().length > 0 && command.trim().length > 0
        ? [
            {
              name: name.trim(),
              command: commandForPackageScript(manager, name.trim()),
            },
          ]
        : [],
    )
    .toSorted((left, right) => left.name.localeCompare(right.name));
  if (scripts.length === 0) {
    return null;
  }

  const packageName =
    typeof packageRecord.name === "string" && packageRecord.name.trim().length > 0
      ? packageRecord.name.trim()
      : null;

  return {
    cwd: input.cwd,
    relativePath: input.relativePath,
    packageJsonPath,
    ...(packageName ? { packageName } : {}),
    scripts,
  };
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  // If output was truncated, the final token can be partial.
  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function directoryAncestorsOf(relativePath: string): string[] {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [];
  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const boundedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length }) as TOutput[];
  let nextIndex = 0;

  const workers = Array.from({ length: boundedConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  const insideWorkTree = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    allowNonZeroExit: true,
    timeoutMs: 5_000,
    maxBufferBytes: 4_096,
  }).catch(() => null);
  return Boolean(
    insideWorkTree && insideWorkTree.code === 0 && insideWorkTree.stdout.trim() === "true",
  );
}

async function filterGitIgnoredPaths(cwd: string, relativePaths: string[]): Promise<string[]> {
  if (relativePaths.length === 0) {
    return relativePaths;
  }

  const ignoredPaths = new Set<string>();
  let chunk: string[] = [];
  let chunkBytes = 0;

  const flushChunk = async (): Promise<boolean> => {
    if (chunk.length === 0) {
      return true;
    }

    const checkIgnore = await runProcess(
      "git",
      [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
      {
        cwd,
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxBufferBytes: 16 * 1024 * 1024,
        outputMode: "truncate",
        stdin: `${chunk.join("\0")}\0`,
      },
    ).catch(() => null);
    chunk = [];
    chunkBytes = 0;

    if (!checkIgnore) {
      return false;
    }

    // git-check-ignore exits with 1 when no paths match.
    if (checkIgnore.code !== 0 && checkIgnore.code !== 1) {
      return false;
    }

    const matchedIgnoredPaths = splitNullSeparatedPaths(
      checkIgnore.stdout,
      Boolean(checkIgnore.stdoutTruncated),
    );
    for (const ignoredPath of matchedIgnoredPaths) {
      ignoredPaths.add(ignoredPath);
    }
    return true;
  };

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (
      chunk.length > 0 &&
      chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES &&
      !(await flushChunk())
    ) {
      return relativePaths;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES && !(await flushChunk())) {
      return relativePaths;
    }
  }

  if (!(await flushChunk())) {
    return relativePaths;
  }

  if (ignoredPaths.size === 0) {
    return relativePaths;
  }

  return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
}

async function buildWorkspaceIndexFromGit(cwd: string): Promise<WorkspaceIndex | null> {
  if (!(await isInsideGitWorkTree(cwd))) {
    return null;
  }

  const listedFiles = await runProcess(
    "git",
    [
      ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    {
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxBufferBytes: 16 * 1024 * 1024,
      outputMode: "truncate",
    },
  ).catch(() => null);
  if (!listedFiles || listedFiles.code !== 0) {
    return null;
  }

  const listedPaths = splitNullSeparatedPaths(
    listedFiles.stdout,
    Boolean(listedFiles.stdoutTruncated),
  )
    .map((entry) => toPosixPath(entry))
    .filter((entry) => entry.length > 0 && !isPathInIgnoredDirectory(entry));
  const filePaths = await filterGitIgnoredPaths(cwd, listedPaths);

  const directorySet = new Set<string>();
  for (const filePath of filePaths) {
    for (const directoryPath of directoryAncestorsOf(filePath)) {
      if (!isPathInIgnoredDirectory(directoryPath)) {
        directorySet.add(directoryPath);
      }
    }
  }

  const directoryEntries = [...directorySet]
    .toSorted((left, right) => left.localeCompare(right))
    .map(
      (directoryPath): ProjectEntry => ({
        path: directoryPath,
        kind: "directory",
        parentPath: parentPathOf(directoryPath),
      }),
    )
    .map(toSearchableWorkspaceEntry);
  const fileEntries = [...new Set(filePaths)]
    .toSorted((left, right) => left.localeCompare(right))
    .map(
      (filePath): ProjectEntry => ({
        path: filePath,
        kind: "file",
        parentPath: parentPathOf(filePath),
      }),
    )
    .map(toSearchableWorkspaceEntry);

  const entries = [...directoryEntries, ...fileEntries];
  return {
    scannedAt: Date.now(),
    entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
    truncated: Boolean(listedFiles.stdoutTruncated) || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
  };
}

async function buildWorkspaceIndex(cwd: string): Promise<WorkspaceIndex> {
  const gitIndexed = await buildWorkspaceIndexFromGit(cwd);
  if (gitIndexed) {
    return gitIndexed;
  }
  const shouldFilterWithGitIgnore = await isInsideGitWorkTree(cwd);

  let pendingDirectories: string[] = [""];
  const entries: SearchableWorkspaceEntry[] = [];
  let truncated = false;

  while (pendingDirectories.length > 0 && !truncated) {
    const currentDirectories = pendingDirectories;
    pendingDirectories = [];
    const directoryEntries = await mapWithConcurrency(
      currentDirectories,
      WORKSPACE_SCAN_READDIR_CONCURRENCY,
      async (relativeDir) => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        try {
          const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
          return { relativeDir, dirents };
        } catch (error) {
          if (!relativeDir) {
            throw new Error(
              `Unable to scan workspace entries at '${cwd}': ${error instanceof Error ? error.message : "unknown error"}`,
              { cause: error },
            );
          }
          return { relativeDir, dirents: null };
        }
      },
    );

    const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
      const { relativeDir, dirents } = directoryEntry;
      if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

      dirents.sort((left, right) => left.name.localeCompare(right.name));
      const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
      for (const dirent of dirents) {
        if (!dirent.name || dirent.name === "." || dirent.name === "..") {
          continue;
        }
        if (dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
          continue;
        }
        if (!dirent.isDirectory() && !dirent.isFile()) {
          continue;
        }

        const relativePath = toPosixPath(
          relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
        );
        if (isPathInIgnoredDirectory(relativePath)) {
          continue;
        }
        candidates.push({ dirent, relativePath });
      }
      return candidates;
    });

    const candidatePaths = candidateEntriesByDirectory.flatMap((candidateEntries) =>
      candidateEntries.map((entry) => entry.relativePath),
    );
    const allowedPathSet = shouldFilterWithGitIgnore
      ? new Set(await filterGitIgnoredPaths(cwd, candidatePaths))
      : null;

    for (const candidateEntries of candidateEntriesByDirectory) {
      for (const candidate of candidateEntries) {
        if (allowedPathSet && !allowedPathSet.has(candidate.relativePath)) {
          continue;
        }

        const entry = toSearchableWorkspaceEntry({
          path: candidate.relativePath,
          kind: candidate.dirent.isDirectory() ? "directory" : "file",
          parentPath: parentPathOf(candidate.relativePath),
        });
        entries.push(entry);

        if (candidate.dirent.isDirectory()) {
          pendingDirectories.push(candidate.relativePath);
        }

        if (entries.length >= WORKSPACE_INDEX_MAX_ENTRIES) {
          truncated = true;
          break;
        }
      }

      if (truncated) {
        break;
      }
    }
  }

  return {
    scannedAt: Date.now(),
    entries,
    truncated,
  };
}

// Bumped on every invalidation so a build that STARTED before the
// invalidation can never re-populate the cache with a pre-invalidation
// snapshot when it completes. One counter per cwd ever invalidated — same
// cardinality as projects, so the map needs no eviction.
const workspaceIndexGenerations = new Map<string, number>();

async function getWorkspaceIndex(cwd: string): Promise<WorkspaceIndex> {
  const cached = workspaceIndexCache.get(cwd);
  if (cached && Date.now() - cached.scannedAt < WORKSPACE_CACHE_TTL_MS) {
    return cached;
  }

  const inFlight = inFlightWorkspaceIndexBuilds.get(cwd);
  if (inFlight) {
    return inFlight;
  }

  const generation = workspaceIndexGenerations.get(cwd) ?? 0;
  const nextPromise = buildWorkspaceIndex(cwd)
    .then((next) => {
      if ((workspaceIndexGenerations.get(cwd) ?? 0) === generation) {
        workspaceIndexCache.set(cwd, next);
        while (workspaceIndexCache.size > WORKSPACE_CACHE_MAX_KEYS) {
          const oldestKey = workspaceIndexCache.keys().next().value;
          if (!oldestKey) break;
          workspaceIndexCache.delete(oldestKey);
        }
      }
      return next;
    })
    .finally(() => {
      // Only clear our own registration: an invalidation may have replaced it
      // with a newer in-flight build, which must stay awaitable.
      if (inFlightWorkspaceIndexBuilds.get(cwd) === nextPromise) {
        inFlightWorkspaceIndexBuilds.delete(cwd);
      }
    });
  inFlightWorkspaceIndexBuilds.set(cwd, nextPromise);
  return nextPromise;
}

export function clearWorkspaceIndexCache(cwd: string): void {
  workspaceIndexCache.delete(cwd);
  inFlightWorkspaceIndexBuilds.delete(cwd);
  workspaceIndexGenerations.set(cwd, (workspaceIndexGenerations.get(cwd) ?? 0) + 1);
}

// Kick off the workspace index build without waiting for it. The search
// palette calls this when it opens; getWorkspaceIndex caches the in-flight
// build, so the first real query awaits the same promise instead of paying
// for a cold index scan on the first keystroke.
export function prewarmWorkspaceSearchIndex(
  input: ProjectPrewarmSearchIndexInput,
): ProjectPrewarmSearchIndexResult {
  void getWorkspaceIndex(input.cwd).catch(() => undefined);
  return { started: true };
}

function expandHomePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveBrowseTarget(input: FilesystemBrowseInput): string {
  if (process.platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    throw new Error("Windows-style paths are only supported on Windows.");
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath));
  }

  if (!input.cwd) {
    throw new Error("Relative filesystem browse paths require a current project.");
  }

  return path.resolve(expandHomePath(input.cwd), input.partialPath);
}

export async function browseWorkspaceEntries(
  input: FilesystemBrowseInput,
): Promise<FilesystemBrowseResult> {
  const resolvedInputPath = resolveBrowseTarget(input);
  const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
  const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
  const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

  const dirents = await fs.readdir(parentPath, { withFileTypes: true });

  const showHidden = endsWithSeparator || prefix.startsWith(".");
  const lowerPrefix = prefix.toLowerCase();

  return {
    parentPath,
    entries: dirents
      .filter(
        (dirent) =>
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith(".")),
      )
      .map((dirent) => ({
        name: dirent.name,
        fullPath: path.join(parentPath, dirent.name),
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function searchWorkspaceEntries(
  input: ProjectSearchEntriesInput,
): Promise<ProjectSearchEntriesResult> {
  const index = await getWorkspaceIndex(input.cwd);
  const normalizedQuery = normalizeWorkspaceEntrySearchQuery(input.query);
  const limit = Math.max(0, Math.floor(input.limit));
  const rankedEntries: RankedWorkspaceEntry[] = [];
  let matchedEntryCount = 0;

  for (const entry of index.entries) {
    if (input.kind && entry.kind !== input.kind) {
      continue;
    }

    const score = scoreEntry(entry, normalizedQuery);
    if (score === null) {
      continue;
    }

    matchedEntryCount += 1;
    insertRankedEntry(rankedEntries, { entry, score }, limit);
  }

  return {
    entries: rankedEntries.map((candidate) => candidate.entry),
    truncated: index.truncated || matchedEntryCount > limit,
  };
}

const CONTENT_SEARCH_DEFAULT_LIMIT = 50;
// Bounds shared with the contracts schema so a request the client considers
// valid can never fail schema decode here.
const CONTENT_SEARCH_MAX_LIMIT = PROJECT_SEARCH_CONTENT_MAX_LIMIT;
const CONTENT_SEARCH_MIN_QUERY_LENGTH = PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH;
const CONTENT_SEARCH_MAX_FILE_BYTES = 512 * 1024;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 5;
const CONTENT_SEARCH_TIME_BUDGET_MS = 4_000;
const CONTENT_SEARCH_LINE_READ_CONCURRENCY = 8;
const CONTENT_SEARCH_MAX_LINE_LENGTH = PROJECT_SEARCH_CONTENT_MAX_LINE_LENGTH;

// A file is treated as binary when its first 8 KiB contains a null byte.
const CONTENT_SEARCH_BINARY_SNIFF_BYTES = 8 * 1024;

interface ContentSearchMatch {
  path: string;
  lineNumber: number;
  lineText: string;
}

function buildContentLineText(line: string): string {
  const trimmed = line.trimEnd();
  if (trimmed.length <= CONTENT_SEARCH_MAX_LINE_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, CONTENT_SEARCH_MAX_LINE_LENGTH - 1)}…`;
}

async function searchFileContent(
  cwd: string,
  relativePath: string,
  normalizedQuery: string,
): Promise<ContentSearchMatch[] | null> {
  const absolutePath = await resolveRealPathWithinRoot(cwd, path.join(cwd, relativePath)).catch(
    () => null,
  );
  if (!absolutePath) {
    return null;
  }
  let fileHandle: Awaited<ReturnType<typeof fs.open>>;
  try {
    fileHandle = await fs.open(absolutePath, "r");
  } catch {
    return null;
  }

  try {
    const stats = await fileHandle.stat();
    if (!stats.isFile() || stats.size === 0 || stats.size > CONTENT_SEARCH_MAX_FILE_BYTES) {
      return null;
    }

    const sniffLength = Math.min(stats.size, CONTENT_SEARCH_BINARY_SNIFF_BYTES);
    const sniffBuffer = Buffer.alloc(sniffLength);
    await fileHandle.read(sniffBuffer, 0, sniffLength, 0);
    if (sniffBuffer.includes(0)) {
      return null;
    }

    const contents = await fileHandle.readFile("utf8");
    // Whole-file miss check before the line split: most files don't contain
    // the query at all, and skipping the split + per-line scan cuts 50-68% off
    // scan cost for typical queries (measured on this repo). The pathological
    // case — a query matching a third of all files — pays ~36% extra on the
    // files it hits, but the overall collect limit stops the scan after a
    // handful of such files anyway.
    if (!contents.toLowerCase().includes(normalizedQuery)) {
      return [];
    }
    const lines = contents.split("\n");
    const matches: ContentSearchMatch[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      if (!line.toLowerCase().includes(normalizedQuery)) continue;
      matches.push({
        path: relativePath,
        lineNumber: index + 1,
        lineText: buildContentLineText(line),
      });
      if (matches.length >= CONTENT_SEARCH_MAX_MATCHES_PER_FILE) {
        break;
      }
    }
    return matches;
  } catch {
    return null;
  } finally {
    await fileHandle.close().catch(() => undefined);
  }
}

// Grep-style keyword search over the project's tracked workspace files.
// Reuses the workspace index (git ls-files when available) so the file set
// respects .gitignore, then scans file contents with a hard time budget and
// per-file match caps so a query in a large repository stays responsive.
export async function searchWorkspaceContent(
  input: ProjectSearchContentInput,
): Promise<ProjectSearchContentResult> {
  const normalizedQuery = input.query.trim().toLowerCase();
  if (normalizedQuery.length < CONTENT_SEARCH_MIN_QUERY_LENGTH) {
    return { matches: [], truncated: false };
  }

  const limit = Math.max(
    1,
    Math.min(input.limit ?? CONTENT_SEARCH_DEFAULT_LIMIT, CONTENT_SEARCH_MAX_LIMIT),
  );

  const index = await getWorkspaceIndex(input.cwd);
  // Scan every indexed file: the time budget is the only scan bound. A fixed
  // file-count cap over the localeCompare-sorted index would permanently
  // exclude directories late in the alphabet, silently, on every query.
  const filePaths = index.entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path);

  const deadline = Date.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
  const collected: ContentSearchMatch[] = [];
  let scannedFiles = 0;
  let truncated = index.truncated;

  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(CONTENT_SEARCH_LINE_READ_CONCURRENCY, filePaths.length)) },
    async () => {
      while (nextIndex < filePaths.length) {
        if (Date.now() > deadline) {
          truncated = true;
          break;
        }
        const currentIndex = nextIndex;
        nextIndex += 1;
        const fileMatches = await searchFileContent(
          input.cwd,
          filePaths[currentIndex] as string,
          normalizedQuery,
        );
        scannedFiles += 1;
        if (fileMatches && fileMatches.length > 0) {
          collected.push(...fileMatches);
        }
      }
    },
  );
  await Promise.all(workers);

  if (Date.now() > deadline) {
    truncated = true;
  }

  const orderedMatches = collected
    .toSorted((left, right) => {
      const pathDelta = left.path.localeCompare(right.path);
      if (pathDelta !== 0) return pathDelta;
      return left.lineNumber - right.lineNumber;
    })
    .slice(0, limit);

  return {
    matches: orderedMatches,
    truncated: truncated || collected.length > limit || scannedFiles < filePaths.length,
  };
}

// Resolve a workspace-relative reference that omits its leading directories.
// Agents (and rendered chat links) frequently cite a file by just its basename
// (e.g. `chatReferences.test.ts`) or a partial tail (`lib/chatReferences.ts`),
// which resolves to a non-existent path under the workspace root. Match it
// against the tracked workspace index by exact path or `/`-anchored suffix and
// only resolve when exactly one file matches, so an ambiguous name (many
// `index.ts`) stays unresolved rather than opening the wrong file.
export async function resolveWorkspaceFileBySuffix(input: {
  cwd: string;
  relativePath: string;
}): Promise<string | null> {
  const normalized = toPosixPath(input.relativePath.trim()).replace(/^\/+/, "");
  if (normalized.length === 0) {
    return null;
  }

  const index = await getWorkspaceIndex(input.cwd);
  const suffix = `/${normalized}`;
  let match: string | null = null;
  for (const entry of index.entries) {
    if (entry.kind !== "file") {
      continue;
    }
    if (entry.path === normalized || entry.path.endsWith(suffix)) {
      if (match !== null) {
        return null;
      }
      match = entry.path;
    }
  }
  return match;
}

export async function discoverProjectScripts(
  input: ProjectDiscoverScriptsInput,
): Promise<ProjectDiscoverScriptsResult> {
  const cwd = path.resolve(expandHomePath(input.cwd));
  const maxDepth = normalizeDiscoveryDepth(input);
  const candidates = await collectPackageJsonCandidates(cwd, maxDepth);
  const targets = await mapWithConcurrency(
    candidates,
    PROJECT_PACKAGE_SCAN_READDIR_CONCURRENCY,
    (candidate) =>
      readDiscoveredPackageTarget({
        cwd: candidate.absoluteDir,
        relativePath: candidate.relativePath,
      }),
  );

  return {
    targets: targets
      .filter((target): target is ProjectDiscoveredScriptTarget => target !== null)
      .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath)),
  };
}

async function directoryHasChildDirectories(absolutePath: string): Promise<boolean> {
  try {
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    return dirents.some(
      (dirent) => dirent.isDirectory() && dirent.name !== "." && dirent.name !== "..",
    );
  } catch {
    return false;
  }
}

// Resolve a client-supplied relative directory against the workspace root and
// refuse anything that escapes it (absolute paths, "..", "a/../../b", ...).
// Same containment rule as WorkspacePaths.resolveRelativePathWithinRoot, but
// the workspace root itself (empty relative path) is a valid listing target.
function resolveDirectoryWithinRoot(cwd: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || isWindowsAbsolutePath(relativePath)) {
    throw new Error("Directory path is outside the workspace root.");
  }
  const absolutePath = path.resolve(cwd, relativePath);
  const relativeToRoot = path.relative(cwd, absolutePath);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("Directory path is outside the workspace root.");
  }
  return absolutePath;
}

export async function listWorkspaceDirectories(
  input: ProjectListDirectoriesInput,
): Promise<ProjectListDirectoriesResult> {
  const relativePath = input.relativePath?.trim() ?? "";
  const resolvedTarget = relativePath
    ? resolveDirectoryWithinRoot(input.cwd, relativePath)
    : input.cwd;
  // String containment above cannot see symlinks; re-check on canonical paths.
  const targetDirectory = await resolveRealPathWithinRoot(input.cwd, resolvedTarget);
  if (targetDirectory === null) {
    throw new Error("Directory path is outside the workspace root.");
  }
  const dirents = await fs.readdir(targetDirectory, { withFileTypes: true });
  const entries = await mapWithConcurrency(
    dirents
      .filter(
        (dirent) =>
          dirent.name.length > 0 &&
          dirent.name !== "." &&
          dirent.name !== ".." &&
          dirent.name !== ".git" &&
          (dirent.isDirectory() || (input.includeFiles === true && dirent.isFile())),
      )
      .toSorted((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      }),
    16,
    async (dirent) => {
      const childRelativePath = toPosixPath(
        relativePath ? path.join(relativePath, dirent.name) : dirent.name,
      );
      if (dirent.isDirectory()) {
        const childAbsolutePath = path.join(input.cwd, childRelativePath);
        return {
          path: childRelativePath,
          name: dirent.name,
          kind: "directory",
          ...(relativePath ? { parentPath: relativePath } : {}),
          hasChildren: await directoryHasChildDirectories(childAbsolutePath),
        } satisfies ProjectDirectoryEntry & ProjectFileSystemEntry;
      }
      return {
        path: childRelativePath,
        name: dirent.name,
        kind: "file",
        ...(relativePath ? { parentPath: relativePath } : {}),
      } satisfies ProjectFileSystemEntry;
    },
  );

  return { entries };
}

const LOCAL_SEARCH_MAX_DEPTH = 6;
const LOCAL_SEARCH_DEFAULT_LIMIT = 50;
const LOCAL_SEARCH_TIME_BUDGET_MS = 600;
const LOCAL_SEARCH_READDIR_CONCURRENCY = 16;
// Directory names to skip during recursive local search. These are either
// high-volume caches or user-private areas that would blow up a walk without
// producing useful matches for a composer mention.
const LOCAL_SEARCH_IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".DS_Store",
  ".Trash",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  ".convex",
  ".pnpm-store",
  ".yarn",
  ".gradle",
  ".m2",
  ".nuget",
  ".bundle",
  "Library",
  "Pods",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);

interface RankedLocalSearchEntry {
  entry: ProjectLocalSearchEntry;
  score: number;
}

function compareRankedLocalSearchEntries(
  left: RankedLocalSearchEntry,
  right: RankedLocalSearchEntry,
): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  return left.entry.path.localeCompare(right.entry.path);
}

function insertRankedLocalEntry(
  ranked: RankedLocalSearchEntry[],
  candidate: RankedLocalSearchEntry,
  limit: number,
): void {
  if (limit <= 0) return;

  let low = 0;
  let high = ranked.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = ranked[middle];
    if (!current) break;
    if (compareRankedLocalSearchEntries(candidate, current) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  if (ranked.length < limit) {
    ranked.splice(low, 0, candidate);
    return;
  }
  if (low >= limit) return;
  ranked.splice(low, 0, candidate);
  ranked.pop();
}

function scoreLocalName(name: string, query: string): number | null {
  const normalizedName = name.toLowerCase();
  if (normalizedName === query) return 0;
  if (normalizedName.startsWith(query)) return 2;
  if (normalizedName.includes(query)) return 5;
  const fuzzy = scoreSubsequenceMatch(normalizedName, query);
  if (fuzzy !== null) return 100 + fuzzy;
  return null;
}

export async function searchLocalEntries(
  input: ProjectSearchLocalEntriesInput,
): Promise<ProjectSearchLocalEntriesResult> {
  const normalizedQuery = normalizeLocalSearchQuery(input.query);
  if (normalizedQuery.length === 0) {
    return { entries: [], truncated: false };
  }

  const limit = Math.max(
    1,
    Math.min(input.limit ?? LOCAL_SEARCH_DEFAULT_LIMIT, LOCAL_SEARCH_DEFAULT_LIMIT),
  );
  const includeFiles = input.includeFiles !== false;
  // When the user explicitly searches for a dotfile prefix (`.ss`, `.en`) surface
  // hidden entries; otherwise skip them so the walk is bounded and predictable.
  const includeDotfiles = normalizedQuery.startsWith(".");
  const deadline = Date.now() + LOCAL_SEARCH_TIME_BUDGET_MS;

  const ranked: RankedLocalSearchEntry[] = [];
  let truncated = false;
  let currentLevel: Array<{ absolutePath: string; depth: number }> = [
    { absolutePath: input.rootPath, depth: 0 },
  ];

  while (currentLevel.length > 0) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }

    const nextLevel: Array<{ absolutePath: string; depth: number }> = [];
    await mapWithConcurrency(
      currentLevel,
      LOCAL_SEARCH_READDIR_CONCURRENCY,
      async ({ absolutePath, depth }) => {
        if (Date.now() > deadline) return;
        let dirents: Dirent[];
        try {
          dirents = await fs.readdir(absolutePath, { withFileTypes: true });
        } catch {
          return;
        }

        for (const dirent of dirents) {
          const name = dirent.name;
          if (!name || name === "." || name === "..") continue;
          if (LOCAL_SEARCH_IGNORED_DIRECTORY_NAMES.has(name)) continue;
          if (!includeDotfiles && name.startsWith(".")) continue;

          const isDirectory = dirent.isDirectory();
          const isFile = dirent.isFile();
          if (!isDirectory && !isFile) continue;
          if (!includeFiles && !isDirectory) continue;

          const childAbsolutePath = path.join(absolutePath, name);

          const score = scoreLocalName(name, normalizedQuery);
          if (score !== null) {
            insertRankedLocalEntry(
              ranked,
              {
                entry: {
                  path: childAbsolutePath,
                  name,
                  kind: isDirectory ? "directory" : "file",
                  parentPath: absolutePath,
                },
                score,
              },
              limit,
            );
          }

          if (isDirectory && depth + 1 < LOCAL_SEARCH_MAX_DEPTH) {
            nextLevel.push({ absolutePath: childAbsolutePath, depth: depth + 1 });
          }
        }
      },
    );

    currentLevel = nextLevel;
  }

  return {
    entries: ranked.map((candidate) => candidate.entry),
    truncated,
  };
}
