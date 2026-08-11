// FILE: check-readme-truthiness.ts
// Purpose: Parody-safe checker for README claims that conflict with local git facts.

import { execFileSync, type ExecSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface RemoteEntry {
  readonly name: string;
  readonly fetchUrl: string;
}

export interface ReadmeTruthinessEvidence {
  readonly upstreamRef: string | null;
  readonly remotes: readonly RemoteEntry[];
  readonly hasUpstreamRemote: boolean;
}

interface ReadmeClaim {
  readonly line: number;
  readonly text: string;
  readonly pattern: string;
}

export interface ReadmeTruthinessFinding {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly readmeClaims: readonly ReadmeClaim[];
  readonly evidence: readonly string[];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = resolve(REPO_ROOT, "README.md");

const BUILT_FROM_SCRATCH_PATTERNS = [
  /\bbuilt\s+from\s+the\s+ground\s+up\b/i,
  /\bbuilt\s+from\s+scratch\b/i,
  /\bfrom\s+scratch\b/i,
] as const;

const NO_FORK_RELATIONSHIP_PATTERNS = [
  /\bno\s+fork\s+relationship\b/i,
  /\bthis\s+is\s+not\s+a\s+fork\b/i,
  /\bnot\s+a\s+fork\b/i,
  /\bnot\s+technically\s+a\s+fork\b/i,
] as const;

function runGit(args: readonly string[], cwd: string): string | null {
  const options: ExecSyncOptions = {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    const output = execFileSync("git", [...args], options);
    return typeof output === "string" ? output.trim() : output.toString("utf8").trim();
  } catch {
    return null;
  }
}

export function parseUpstreamRemoteSignals(lines: readonly string[]): readonly RemoteEntry[] {
  const remoteLine = /^([^\s]+)\s+([^\s]+)\s+\((fetch|push)\)$/u;
  const remotesByName = new Map<string, string>();

  for (const raw of lines) {
    const match = remoteLine.exec(raw.trim());
    if (!match || match[1] === undefined || match[2] === undefined) continue;
    const [name, url] = [match[1], match[2]!] as const;
    if (!remotesByName.has(name)) {
      remotesByName.set(name, url);
    }
  }

  return [...remotesByName.entries()].map(([name, fetchUrl]) => ({ name, fetchUrl }));
}

export function collectGitEvidence(cwd = process.cwd()): ReadmeTruthinessEvidence {
  const upstreamRef = runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  const remoteLines = runGit(["remote", "-v"], cwd);
  const remotes =
    remoteLines === null || remoteLines.length === 0
      ? []
      : parseUpstreamRemoteSignals(remoteLines.split("\n"));
  const hasUpstreamRemote = remotes.some((remote) => remote.name === "upstream");

  return {
    upstreamRef,
    remotes,
    hasUpstreamRemote,
  };
}

function collectReadmeClaims(readmeContents: string): {
  readonly builtFromScratch: readonly ReadmeClaim[];
  readonly noFork: readonly ReadmeClaim[];
} {
  const builtFromScratch: ReadmeClaim[] = [];
  const noFork: ReadmeClaim[] = [];
  const lines = readmeContents.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    for (const pattern of BUILT_FROM_SCRATCH_PATTERNS) {
      if (pattern.test(line)) {
        builtFromScratch.push({ line: lineNumber, text: line.trim(), pattern: pattern.source });
        break;
      }
    }
    for (const pattern of NO_FORK_RELATIONSHIP_PATTERNS) {
      if (pattern.test(line)) {
        noFork.push({ line: lineNumber, text: line.trim(), pattern: pattern.source });
        break;
      }
    }
  }

  return { builtFromScratch, noFork };
}

function hasUpstreamFact(evidence: ReadmeTruthinessEvidence): boolean {
  const hasAnyRemotes = evidence.remotes.length > 0;
  const hasNonOriginRemote = evidence.remotes.some((remote) => remote.name !== "origin");
  return (
    Boolean(evidence.upstreamRef) ||
    evidence.hasUpstreamRemote ||
    (hasAnyRemotes && hasNonOriginRemote)
  );
}

function formatEvidence(evidence: ReadmeTruthinessEvidence): readonly string[] {
  const remoteLines = evidence.remotes.map((remote) => `${remote.name}: ${remote.fetchUrl}`);
  return [
    evidence.upstreamRef !== null ? `upstream ref: ${evidence.upstreamRef}` : "upstream ref: none",
    remoteLines.length > 0 ? `remotes: ${remoteLines.join(", ")}` : "remotes: none",
  ];
}

export function detectReadmeTruthiness(
  readmeContents: string,
  gitEvidence: ReadmeTruthinessEvidence,
): readonly ReadmeTruthinessFinding[] {
  const claims = collectReadmeClaims(readmeContents);
  const evidence = formatEvidence(gitEvidence);
  const findings: ReadmeTruthinessFinding[] = [];

  if (!hasUpstreamFact(gitEvidence)) {
    return [];
  }

  if (claims.builtFromScratch.length > 0) {
    findings.push({
      id: "technically-ambitious",
      title: "Technically Ambitious",
      message:
        "The README says this was built from the ground up, but local git still remembers where the lineage came from.",
      readmeClaims: claims.builtFromScratch,
      evidence,
    });
  }

  if (claims.noFork.length > 0) {
    findings.push({
      id: "factual-fork-relationship",
      title: "Factual Fork Relationship",
      message:
        "The README calls this unrelated, yet git metadata points to a tracked upstream lineage.",
      readmeClaims: claims.noFork,
      evidence,
    });
  }

  return findings;
}

function renderConsoleFinding(finding: ReadmeTruthinessFinding): void {
  console.error(`- ${finding.title}: ${finding.message}`);
  for (const claim of finding.readmeClaims) {
    console.error(`  - README ${String(claim.line)}: ${claim.text}`);
  }
  for (const source of finding.evidence) {
    console.error(`  - evidence: ${source}`);
  }
}

function main(): void {
  let readmeContents: string;
  try {
    readmeContents = readFileSync(README_PATH, "utf8");
  } catch {
    console.error("README truthiness checker could not read README.md from repository root.");
    process.exitCode = 1;
    return;
  }

  const findings = detectReadmeTruthiness(readmeContents, collectGitEvidence(REPO_ROOT));
  if (findings.length === 0) {
    console.log("README truthiness check passed with nothing suspicious.");
    return;
  }

  console.error("README Truthiness Checker: local facts disagree with README bravado.");
  for (const finding of findings) {
    renderConsoleFinding(finding);
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
