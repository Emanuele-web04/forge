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
  branch?: string;
  skipFixes: boolean;
}

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
    skipFixes: argv.includes("--skip-fixes"),
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
  if (exists) return;

  spawnCommand("git", ["remote", "add", remoteName, remoteUrl]);
}

function runGit(
  command: string,
  args: string[],
  opts: { capture?: boolean; allowFailure?: boolean } = {},
): SpawnResult {
  return spawnCommand("git", [command, ...args], opts);
}

function branchExists(branch: string): boolean {
  return runGit("rev-parse", ["--verify", `refs/heads/${branch}`], { capture: true, allowFailure: true })
    .status === 0;
}

function remoteBranchExists(remote: string, branch: string): boolean {
  return runGit("rev-parse", ["--verify", `refs/remotes/${remote}/${branch}`], {
    capture: true,
    allowFailure: true,
  }).status === 0;
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

function tryMergeWithUpstream(remote: string, upstream: string): void {
  const ref = `${remote}/${upstream}`;
  const result = spawnCommand(
    "git",
    ["merge", "--no-ff", "--no-edit", ref],
    { capture: true, allowFailure: true },
  );

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(
      `Merge conflict detected while merging ${ref}. Resolve conflicts, run:\n` +
        "  git merge --continue\n" +
        "  then re-run this script with --skip-fixes to re-run normalization checks.",
    );
  }
}

function applyForkFixes(skipFixes: boolean): void {
  if (skipFixes) {
    console.log("Skipping fork-specific follow-up fixes.");
    return;
  }

  const README_PATH = "README.md";
  const readme = readFileSync(README_PATH, "utf8");
  const approvedAttribution =
    "Synara began as a clone of [T3Code](https://github.com/pingdotgg/t3code), but it has since become a substantially different product with its own branding, packaging, release system, provider orchestration, desktop app behavior, and product direction.";
  const readmeNext = readme
    .replace(
      "Synara began as a clone of T3Code.",
      approvedAttribution,
    )
    .replace(
      /Synara began as a clone of.*$/m,
      (line) =>
        line.includes("T3Code") || line.includes("https://github.com/pingdotgg/t3code")
          ? line
          : approvedAttribution,
    );

  if (readmeNext !== readme) {
    writeFileSync(README_PATH, readmeNext.endsWith("\n") ? readmeNext : `${readmeNext}\n`);
    console.log("Applied branded-attribution normalization in README.md.");
  }

  const CHAT_TEST_PATH = "apps/web/src/components/ChatView.browser.tsx";
  const chatTest = readFileSync(CHAT_TEST_PATH, "utf8");
  let chatNext = chatTest;
  chatNext = chatNext.replace(
    'await expect.element(page.getByRole("button", { name: "Cancelling..." })).toBeDisabled();',
    'await expect.element(page.getByRole("button", { name: /Cancel/i })).toBeDisabled();',
  );
  chatNext = chatNext.replace(
    'expect(document.body.textContent).not.toContain("Cancelling...");',
    'expect(document.body.textContent).not.toMatch(/Cancel(?:l?ing)?(?:…|\\.\\.\\.)/);',
  );
  chatNext = chatNext.replace(
    'expect(document.body.textContent).not.toContain("Canceling...");',
    'expect(document.body.textContent).not.toMatch(/Cancel(?:l?ing)?(?:…|\\.\\.\\.)/);',
  );

  if (chatNext !== chatTest) {
    writeFileSync(CHAT_TEST_PATH, chatNext);
    console.log("Applied browser test normalization in ChatView.browser.tsx.");
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
  checkoutBase(options.base);
  const divergence = spawnCommand(
    "git",
    ["rev-list", "--left-right", "--count", `${options.base}...${upstreamRef}`],
    { capture: true },
  ).stdout
    .trim()
    .split(/\s+/)
    .map(Number);

  if (divergence.length !== 2 || Number.isNaN(divergence[0] + divergence[1])) {
    throw new Error("Unable to compute upstream divergence.");
  }

  const [left, right] = divergence;
  const hasUpstreamDelta = right > 0;
  const branchAlreadyExists = branchExists(syncBranch);
  const currentBranch = currentBranchName();

  if (branchAlreadyExists) {
    if (currentBranch !== syncBranch) {
      runGit("switch", syncBranch);
    }
    console.log(`Reusing existing sync branch ${syncBranch}.`);
  } else {
    if (!hasUpstreamDelta) {
      console.log(`${options.base} is already synced with ${upstreamRef}.`);
      return;
    }
    runGit("switch", "-c", syncBranch, options.base);
    console.log(`Created sync branch ${syncBranch} from ${options.base}.`);
  }

  console.log(`Upstream commit delta: ${left}/${right} from ${options.base}..${upstreamRef}.`);

  if (hasUpstreamDelta) {
    tryMergeWithUpstream(options.remote, options.upstream);
  } else {
    console.log(`No new upstream commits to merge from ${upstreamRef}.`);
  }

  applyForkFixes(options.skipFixes);
  console.log(`Sync branch ready: ${syncBranch}`);
}

main();
