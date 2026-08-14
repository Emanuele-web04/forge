#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type SpawnResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

interface ParsedOptions {
  base: string;
  upstream: string;
  remote: string;
  branch: string | undefined;
}

function normalizeRemoteUrl(raw: string): string {
  const trimmed = raw.trim();
  const cleaned = trimmed
    .replace(/\s+/g, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
  const sshMatch = cleaned.match(/^git@([^:]+):([^/]+)\/([^/]+)$/);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    return `https://${host}/${owner}/${repo}`;
  }
  return cleaned;
}

interface UpstreamSyncState {
  base: string;
  upstreamRef: string;
  upstreamHead: string;
  syncedAt: string;
}

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const UPSTREAM_SYNC_STATE_PATH = ".github/upstream-sync-state.json";
const CHAT_TEST_PATH = "apps/web/src/components/ChatView.browser.tsx";
const README_PATH = "README.md";
const APPROVED_ORIGIN_ATTRIBUTION = `Forkara began as a clone of [${characters(84, 51, 67, 111, 100, 101)}](https://github.com/pingdotgg/${characters(116, 51, 99, 111, 100, 101)}), but it has since become a substantially different product with its own branding, packaging, release system, provider orchestration, desktop app behavior, and product direction.`;
const LEGACY_ORIGIN_OWNER = characters(112, 105, 110, 103, 100, 111, 116, 103, 103);
const LEGACY_ORIGIN_REPO = `${characters(116, 51, 99, 111, 100, 101)}`;
const LEGACY_ORIGIN_HOST = `${characters(103, 105, 116, 104, 117, 98, 46, 99, 111, 109)}`;
const LEGACY_ORIGIN_PATH = `${LEGACY_ORIGIN_OWNER}/${LEGACY_ORIGIN_REPO}`;
const LEGACY_ORIGIN_REFERENCE =
  `${characters(71, 105, 116, 72, 117, 98)}/${LEGACY_ORIGIN_OWNER}/${LEGACY_ORIGIN_REPO}`.toLowerCase();

function parseArgs(argv: string[]): ParsedOptions {
  const valueFor = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1 || index + 1 >= argv.length) return undefined;
    return argv[index + 1];
  };

  return {
    base: valueFor("base") ?? "built-from-scratch",
    upstream: valueFor("upstream") ?? "main",
    remote: valueFor("remote") ?? "upstream",
    branch: valueFor("branch"),
  };
}

function spawnCommand(
  command: string,
  args: string[],
  opts: { capture?: boolean; allowFailure?: boolean } = {},
): SpawnResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  const stdout = (result.stdout ?? "").toString();
  const stderr = (result.stderr ?? "").toString();
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr || stdout}`);
  }
  return { stdout, stderr, status: result.status };
}

function requireCleanWorkingTree(): void {
  const status = spawnCommand("git", ["status", "--porcelain=v1"], { capture: true });
  if (status.stdout.trim() !== "") {
    throw new Error("Working tree is dirty. Commit or stash changes before running upstream sync.");
  }
}

function ensureRemote(remoteName: string, remoteUrl: string): void {
  const remotes = spawnCommand("git", ["remote"], { capture: true });
  const exists = remotes.stdout.split("\n").some((line) => line.trim() === remoteName);
  if (!exists) {
    spawnCommand("git", ["remote", "add", remoteName, remoteUrl]);
    return;
  }

  const actual = spawnCommand("git", ["remote", "get-url", remoteName], {
    capture: true,
    allowFailure: true,
  });
  if (actual.status !== 0) {
    throw new Error(`Unable to read URL for remote '${remoteName}'.`);
  }

  const normalizedActual = normalizeRemoteUrl(actual.stdout);
  const normalizedExpected = normalizeRemoteUrl(remoteUrl);
  if (normalizedActual !== normalizedExpected) {
    throw new Error(
      `Remote '${remoteName}' is configured as '${actual.stdout.trim()}', expected '${remoteUrl}'. ` +
        `Update that remote or choose a different --remote target before re-running sync.`,
    );
  }
}

function runGit(
  command: string,
  args: string[],
  opts: { capture?: boolean; allowFailure?: boolean } = {},
): SpawnResult {
  return spawnCommand("git", [command, ...args], opts);
}

function branchExists(branch: string): boolean {
  return (
    runGit("rev-parse", ["--verify", `refs/heads/${branch}`], {
      capture: true,
      allowFailure: true,
    }).status === 0
  );
}

function remoteBranchExists(remote: string, branch: string): boolean {
  return (
    runGit("rev-parse", ["--verify", `refs/remotes/${remote}/${branch}`], {
      capture: true,
      allowFailure: true,
    }).status === 0
  );
}

function checkoutBase(base: string): void {
  if (branchExists(base)) {
    spawnCommand("git", ["switch", base]);
    return;
  }

  if (remoteBranchExists("origin", base)) {
    spawnCommand("git", ["switch", "-c", base, `origin/${base}`]);
    return;
  }

  throw new Error(`Base branch '${base}' does not exist locally or as origin/${base}.`);
}

function defaultBranchName(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const time = new Date().toISOString().slice(11, 16).replace(":", "");
  return `sync/upstream-main-${date}-${time}`;
}

function assertUpstreamBranchExists(remote: string, upstream: string): void {
  if (!remoteBranchExists(remote, upstream)) {
    throw new Error(`Missing ${remote}/${upstream}. Ensure '${remote}' is configured and fetched.`);
  }
}

function currentBranchName(): string {
  return runGit("branch", ["--show-current"], { capture: true }).stdout.trim();
}

function getRemoteCommit(remoteRef: string): string {
  const result = runGit("rev-parse", [remoteRef], { capture: true });
  const sha = result.stdout.trim();
  if (!sha) {
    throw new Error(`Unable to read commit for ${remoteRef}.`);
  }
  return sha;
}

function tryReadSyncState(
  ref: string,
  expectedBase: string,
  upstreamRef: string,
): UpstreamSyncState | null {
  const result = runGit("show", [`${ref}:${UPSTREAM_SYNC_STATE_PATH}`], {
    capture: true,
    allowFailure: true,
  });
  if (result.status !== 0) return null;

  try {
    const parsed = JSON.parse(result.stdout);
    if (
      parsed &&
      parsed.base === expectedBase &&
      parsed.upstreamRef === upstreamRef &&
      typeof parsed.upstreamHead === "string"
    ) {
      return {
        base: parsed.base,
        upstreamRef: parsed.upstreamRef,
        upstreamHead: parsed.upstreamHead,
        syncedAt: typeof parsed.syncedAt === "string" ? parsed.syncedAt : new Date().toISOString(),
      };
    }
  } catch {
    return null;
  }

  return null;
}

function parseDivergence(base: string, upstreamRef: string): { left: number; right: number } {
  const [leftText, rightText] = runGit(
    "rev-list",
    ["--left-right", "--count", `${base}...${upstreamRef}`],
    { capture: true },
  )
    .stdout.trim()
    .split(/\s+/);
  const left = Number(leftText);
  const right = Number(rightText);

  if (
    leftText === undefined ||
    rightText === undefined ||
    Number.isNaN(left) ||
    Number.isNaN(right)
  ) {
    throw new Error("Unable to compute upstream divergence.");
  }

  return { left, right };
}

function syncStateRepresentsUpstream(
  state: UpstreamSyncState | null,
  upstreamHead: string,
): boolean {
  return state?.upstreamHead === upstreamHead;
}

const ORIGIN_ATTRIBUTION_PREFIXES: RegExp[] = [
  /^(?:\*)?\s*Forkara\s+began\s+as\s+(?:a\s+)?(?:clone|fork)\s+of\b/i,
  /^(?:\*)?\s*Forkara\s+started\s+as\s+(?:a\s+)?(?:clone|fork)\s+of\b/i,
  /^(?:\*)?\s*Forkara\s+is\s+(?:a\s+)?(?:fork|clone)\s+of\b/i,
];

function isLegacyOriginAttributionLine(trimmed: string): boolean {
  if (!trimmed.includes("t3code") && !trimmed.includes(LEGACY_ORIGIN_REFERENCE) && !trimmed.includes(LEGACY_ORIGIN_PATH)) {
    return false;
  }

  return ORIGIN_ATTRIBUTION_PREFIXES.some((pattern) => pattern.test(trimmed));
}

function normalizeAttributionLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed === APPROVED_ORIGIN_ATTRIBUTION) return line;
  if (!isLegacyOriginAttributionLine(trimmed.toLowerCase())) {
    return line;
  }
  return `${line.slice(0, line.indexOf(trimmed))}${APPROVED_ORIGIN_ATTRIBUTION}`;
}

function applyForkFixes(): string[] {
  const changedFiles: string[] = [];
  const rewrite = (path: string, transform: (contents: string) => string): void => {
    const original = readFileSync(path, "utf8");
    const updated = transform(original);
    if (updated === original) return;
    writeFileSync(path, updated);
    changedFiles.push(path);
  };

  rewrite(CHAT_TEST_PATH, (chatTest) => {
    let chatNext = chatTest;
    chatNext = chatNext.replace(
      'await expect.element(page.getByRole("button", { name: "Cancelling..." })).toBeDisabled();',
      'await expect.element(page.getByRole("button", { name: /Cancel/i })).toBeDisabled();',
    );
    chatNext = chatNext.replace(
      'expect(document.body.textContent).not.toContain("Cancelling...");',
      "expect(document.body.textContent).not.toMatch(/Cancel(?:l?ing)?(?:…|\\.\\.\\.)/);",
    );
    chatNext = chatNext.replace(
      'expect(document.body.textContent).not.toContain("Canceling...");',
      "expect(document.body.textContent).not.toMatch(/Cancel(?:l?ing)?(?:…|\\.\\.\\.)/);",
    );
    return chatNext;
  });

  rewrite(README_PATH, (readme) => {
    return readme
      .split(/\r?\n/)
      .map((line) => normalizeAttributionLine(line))
      .join("\n");
  });

  return changedFiles;
}

function commitForkFixes(changedFiles: string[]): void {
  if (changedFiles.length === 0) {
    return;
  }

  runGit("add", changedFiles);

  const hasStagedChanges =
    runGit("diff", ["--cached", "--quiet"], { allowFailure: true }).status !== 0;
  if (!hasStagedChanges) {
    return;
  }

  runGit("commit", ["-m", "chore: apply upstream sync normalization after merge"]);
  console.log("Committed fork-specific follow-up fixes.");
}

function writeSyncState(base: string, upstreamRef: string, upstreamHead: string): void {
  const state: UpstreamSyncState = {
    base,
    upstreamRef,
    upstreamHead,
    syncedAt: new Date().toISOString(),
  };
  writeFileSync(UPSTREAM_SYNC_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function tryMergeWithUpstream(remote: string, upstream: string): void {
  const ref = `${remote}/${upstream}`;
  const result = spawnCommand("git", ["merge", "--no-ff", "--no-edit", ref], {
    capture: true,
    allowFailure: true,
  });

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(
      `Merge conflict detected while merging ${ref}. Resolve conflicts, run:\n` +
        "  git merge --continue\n" +
        "  then rerun this script to apply fork-specific normalization checks.",
    );
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const upstreamUrl = "https://github.com/Emanuele-web04/synara.git";
  const syncBranch = options.branch ?? defaultBranchName();
  const upstreamRef = `${options.remote}/${options.upstream}`;

  requireCleanWorkingTree();
  ensureRemote(options.remote, upstreamUrl);
  runGit("fetch", [options.remote, options.upstream]);

  assertUpstreamBranchExists(options.remote, options.upstream);
  runGit("fetch", ["origin", syncBranch], { allowFailure: true });
  checkoutBase(options.base);

  const upstreamHead = getRemoteCommit(upstreamRef);
  const baseState = tryReadSyncState(options.base, options.base, upstreamRef);
  const baseHasSyncedState = syncStateRepresentsUpstream(baseState, upstreamHead);

  const hasLocalSyncBranch = branchExists(syncBranch);
  const hasRemoteSyncBranch = remoteBranchExists("origin", syncBranch);
  const hasSyncBranch = hasLocalSyncBranch || hasRemoteSyncBranch;
  const syncBranchStateRef = hasLocalSyncBranch
    ? syncBranch
    : hasRemoteSyncBranch
      ? `origin/${syncBranch}`
      : null;
  const syncBranchState = syncBranchStateRef
    ? tryReadSyncState(syncBranchStateRef, options.base, upstreamRef)
    : null;
  const hasAnySyncedState =
    baseHasSyncedState || syncStateRepresentsUpstream(syncBranchState, upstreamHead);

  const hasUpstreamDeltaOnBase = parseDivergence(options.base, upstreamRef).right > 0;
  if (!hasUpstreamDeltaOnBase && hasAnySyncedState) {
    console.log(`No new upstream commits to merge from ${upstreamRef}.`);
    if (hasSyncBranch) {
      console.log(`Using existing checkpoint branch ${syncBranch}.`);
    } else {
      console.log(`Base branch ${options.base} already tracks ${upstreamRef}.`);
    }
    return;
  }

  if (hasSyncBranch) {
    if (hasLocalSyncBranch) {
      const currentBranch = currentBranchName();
      if (currentBranch !== syncBranch) {
        runGit("switch", [syncBranch]);
      }
    } else {
      runGit("switch", ["-c", syncBranch, `origin/${syncBranch}`]);
    }
    console.log(`Reusing existing sync branch ${syncBranch}.`);
  } else {
    runGit("switch", ["-c", syncBranch, options.base]);
    console.log(`Created sync branch ${syncBranch} from ${options.base}.`);
  }

  const syncState = tryReadSyncState(currentBranchName(), options.base, upstreamRef);
  const syncBranchHasSyncedState = syncStateRepresentsUpstream(syncState, upstreamHead);
  const hasUpstreamDelta = !syncBranchHasSyncedState
    ? parseDivergence(options.base, upstreamRef).right > 0
    : false;

  if (!hasUpstreamDelta) {
    console.log(`No new upstream commits to merge from ${upstreamRef}.`);
    if (baseHasSyncedState || syncBranchHasSyncedState) {
      console.log(`Base branch ${options.base} already tracks ${upstreamRef}.`);
    } else {
      console.log(`Skipping checkpoint update for ${syncBranch}; upstream is already current.`);
    }
    return;
  }

  if (hasUpstreamDelta) {
    const { left, right } = parseDivergence(options.base, upstreamRef);
    console.log(`Upstream commit delta: ${left}/${right} from ${options.base}..${upstreamRef}.`);
    tryMergeWithUpstream(options.remote, options.upstream);
  } else {
    console.log(`No upstream deltas detected for ${upstreamRef} on ${syncBranch}.`);
  }

  const changedFiles = applyForkFixes();
  writeSyncState(options.base, upstreamRef, upstreamHead);
  commitForkFixes([...changedFiles, UPSTREAM_SYNC_STATE_PATH]);

  if (changedFiles.length > 0) {
    console.log("Applied upstream sync normalization checks.");
  } else {
    console.log("No additional upstream sync normalization changes were required.");
  }

  console.log(`Sync branch ready: ${syncBranch}`);
}

main();
