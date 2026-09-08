import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  __listRecentClaudeTranscriptFilesForTests,
  __loadClaudeUsageSnapshotForTests,
  __loadCodexUsageSnapshotForTests,
  __readClaudeUsageSamplesForTests,
  __resolveClaudeProjectsRootsForTests,
  __selectRecentFilesForTests,
} from "./providerUsageSnapshot.ts";

const tempDirs: string[] = [];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function writeCodexSessionFile(input: {
  codexHomeDir: string;
  eventTimeMs: number;
  events: ReadonlyArray<{ timestampIso: string; totalTokens: number }>;
}): Promise<string> {
  const date = new Date(input.eventTimeMs);
  const dayDir = nodePath.join(
    input.codexHomeDir,
    "sessions",
    `${date.getUTCFullYear()}`,
    `${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
    `${String(date.getUTCDate()).padStart(2, "0")}`,
  );
  await mkdir(dayDir, { recursive: true });
  const path = nodePath.join(dayDir, "session-a.jsonl");
  const lines = input.events.map((event) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: event.timestampIso,
      payload: {
        type: "token_count",
        total_token_usage: { total_tokens: event.totalTokens },
        rate_limits: { primary: { used_percent: 12 } },
      },
    }),
  );
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

async function writeClaudeTranscript(path: string, sample: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(sample)}\n`);
}

describe("provider usage archive bounds", () => {
  it("reports when recent-file discovery omits candidates at its cap", () => {
    const selection = __selectRecentFilesForTests(
      [
        { path: "older.jsonl", mtimeMs: 1 },
        { path: "newer.jsonl", mtimeMs: 3 },
        { path: "middle.jsonl", mtimeMs: 2 },
      ],
      2,
    );

    expect(selection).toEqual({
      paths: ["newer.jsonl", "middle.jsonl"],
      truncated: true,
      oversized: false,
    });
  });

  it("checks both documented Claude roots unless an explicit config root is set", () => {
    expect(__resolveClaudeProjectsRootsForTests("/home/tester", {})).toEqual([
      "/home/tester/.config/claude/projects",
      "/home/tester/.claude/projects",
    ]);
    expect(
      __resolveClaudeProjectsRootsForTests("/home/tester", {
        CLAUDE_CONFIG_DIR: "/custom/claude",
      }),
    ).toEqual(["/custom/claude/projects"]);
  });
});

describe("Codex session token series", () => {
  it("buckets per-event deltas instead of attributing the session lifetime total", async () => {
    const t0 = Date.parse("2026-07-01T00:00:00.000Z");
    const directory = await mkdtemp(nodePath.join(tmpdir(), "synara-codex-series-"));
    tempDirs.push(directory);
    const codexHomeDir = nodePath.join(directory, ".codex");
    await writeCodexSessionFile({
      codexHomeDir,
      eventTimeMs: t0 + 8 * ONE_DAY_MS,
      events: [
        { timestampIso: new Date(t0).toISOString(), totalTokens: 100 },
        { timestampIso: new Date(t0 + ONE_DAY_MS).toISOString(), totalTokens: 150 },
        { timestampIso: new Date(t0 + 8 * ONE_DAY_MS).toISOString(), totalTokens: 250 },
      ],
    });

    const nowMs = t0 + 8 * ONE_DAY_MS;
    const snapshot = await __loadCodexUsageSnapshotForTests({
      homeDir: "/home/tester",
      env: { CODEX_HOME: codexHomeDir },
      nowMs,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usageLines).toEqual([
      { label: "24h", value: "100 tokens", subtitle: "1 recent session" },
      { label: "7d", value: "150 tokens", subtitle: "1 recent session" },
      { label: "30d", value: "250 tokens", subtitle: "1 recent session" },
    ]);
    // Machine activity mirrors the same later-event attribution rule.
    expect(snapshot?.activity?.periods.find((period) => period.id === "24h")?.tokens.total).toBe(
      100,
    );
    expect(snapshot?.activity?.periods.find((period) => period.id === "30d")?.tokens.total).toBe(
      250,
    );
  });
});

describe("Claude activity window and dedup", () => {
  it("keeps months-old Claude samples out of the 30-day machine activity", async () => {
    const nowMs = Date.parse("2026-08-09T00:00:00.000Z");
    const directory = await mkdtemp(nodePath.join(tmpdir(), "synara-claude-window-"));
    tempDirs.push(directory);
    const homeDir = nodePath.join(directory, "home");
    const projectsRoot = nodePath.join(homeDir, ".claude", "projects");
    await mkdir(nodePath.join(projectsRoot, "default"), { recursive: true });

    await writeClaudeTranscript(nodePath.join(projectsRoot, "default", "recent.jsonl"), {
      type: "assistant",
      sessionId: "session-recent",
      timestamp: new Date(nowMs - ONE_DAY_MS).toISOString(),
      message: { model: "claude-sonnet-4-5", usage: { input_tokens: 30, output_tokens: 10 } },
    });
    await writeClaudeTranscript(nodePath.join(projectsRoot, "default", "old.jsonl"), {
      type: "assistant",
      sessionId: "session-old",
      timestamp: new Date(nowMs - 45 * ONE_DAY_MS).toISOString(),
      message: { model: "claude-sonnet-4-5", usage: { input_tokens: 500, output_tokens: 50 } },
    });

    const snapshot = await __loadClaudeUsageSnapshotForTests({ homeDir, nowMs });

    expect(snapshot).not.toBeNull();
    // The 45-day-old sample must not inflate the "30 days" period.
    expect(snapshot?.activity?.periods.find((period) => period.id === "30d")?.tokens.total).toBe(
      40,
    );
    expect(snapshot?.usageLines.find((line) => line.label === "30d")?.value).toBe("40 tokens");
  });

  it("counts copied Claude transcripts once through the shared sample-key set", async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "synara-claude-dedup-"));
    tempDirs.push(directory);
    const line = {
      type: "assistant",
      sessionId: "session-dedup",
      requestId: "request-1",
      timestamp: "2026-08-08T12:00:00.000Z",
      message: { model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5 } },
    };
    const first = nodePath.join(directory, "first.jsonl");
    const second = nodePath.join(directory, "second.jsonl");
    await writeClaudeTranscript(first, line);
    await writeClaudeTranscript(second, line);

    const sharedSeenKeys = new Set<string>();
    const fromFirst = await __readClaudeUsageSamplesForTests(first, sharedSeenKeys);
    const fromSecond = await __readClaudeUsageSamplesForTests(second, sharedSeenKeys);

    expect(fromFirst).toHaveLength(1);
    expect(fromSecond).toHaveLength(0);
  });

  it("collapses symlinked Claude transcript roots into one scanned file", async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "synara-claude-symlink-"));
    tempDirs.push(directory);
    const rootA = nodePath.join(directory, "root-a");
    const rootB = nodePath.join(directory, "root-b");
    await mkdir(nodePath.join(rootA, "project"), { recursive: true });
    await mkdir(nodePath.join(rootB, "project"), { recursive: true });
    const realFile = nodePath.join(rootA, "project", "transcript.jsonl");
    await writeClaudeTranscript(realFile, { type: "assistant", sessionId: "s" });
    await symlink(realFile, nodePath.join(rootB, "project", "transcript.jsonl"));

    const files = await __listRecentClaudeTranscriptFilesForTests([rootA, rootB]);
    expect(files.paths).toHaveLength(1);
    // realpath resolves the /var -> /private/var canonical form on macOS.
    expect(files.paths[0]).toBe(await realpath(realFile));
  });
});
