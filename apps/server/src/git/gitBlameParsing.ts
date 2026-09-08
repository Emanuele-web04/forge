import type { GitBlameLineResult } from "@synara/contracts";

// Object IDs are 40 hex characters for SHA-1 repositories and 64 for SHA-256.
const BLAME_HEADER_PATTERN = /^([0-9a-f]{40,64}) \d+ \d+(?: \d+)?$/;
const UNCOMMITTED_SHA_PATTERN = /^0{40,64}$/;
const SHORT_SHA_LENGTH = 7;

function stripAngleBrackets(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
}

function formatUnixSecondsAsIso(value: string): string {
  const seconds = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(seconds)) return "";
  // Git can emit timestamps outside JavaScript's supported Date range; guard so
  // a single exotic commit cannot fail the whole blame request.
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function readField(line: string, field: string): string | null {
  const prefix = `${field} `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

export function parseGitBlamePorcelain(stdout: string): GitBlameLineResult | null {
  let sha: string | null = null;
  let author = "";
  let authorEmail = "";
  let authorTime = "";
  let summary = "";

  for (const line of stdout.split("\n")) {
    if (line.startsWith("\t")) break;
    if (sha === null) {
      sha = BLAME_HEADER_PATTERN.exec(line)?.[1] ?? null;
      continue;
    }
    const authorMailValue = readField(line, "author-mail");
    if (authorMailValue !== null) {
      authorEmail = stripAngleBrackets(authorMailValue);
      continue;
    }
    const authorTimeValue = readField(line, "author-time");
    if (authorTimeValue !== null) {
      authorTime = formatUnixSecondsAsIso(authorTimeValue);
      continue;
    }
    const authorValue = readField(line, "author");
    if (authorValue !== null) {
      author = authorValue.trim();
      continue;
    }
    const summaryValue = readField(line, "summary");
    if (summaryValue !== null) {
      summary = summaryValue.trim();
    }
  }

  if (sha === null) return null;

  const uncommitted = UNCOMMITTED_SHA_PATTERN.test(sha);
  return {
    sha,
    shortSha: uncommitted ? "" : sha.slice(0, SHORT_SHA_LENGTH),
    author,
    authorEmail,
    authorTime,
    summary: uncommitted ? "" : summary,
    uncommitted,
  };
}
