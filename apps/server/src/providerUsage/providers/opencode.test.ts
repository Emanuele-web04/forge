// FILE: providerUsage/providers/opencode.test.ts
// Purpose: Covers the OpenCode native usage fetcher — the pure row normalization + window
// aggregation, and the fetcher against a real (temp) opencode.db so the SQL and DB-path
// resolution are exercised end to end. A missing DB must read as healthy-but-empty, while an
// unreadable DB must surface as an error rather than silently blank usage.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildOpenCodeUsageLines,
  normalizeOpenCodeMessageRows,
  opencodeUsageFetcher,
  type OpenCodeMessageUsageRow,
} from "./opencode";

const NOW_MS = 1_780_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-opencode-usage-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeCtx(homeDir: string, env: NodeJS.ProcessEnv = {}) {
  return {
    homeDir,
    env,
    platform: "darwin" as const,
    nowMs: NOW_MS,
  };
}

function row(input: {
  sessionId?: string;
  timestampMs: number;
  tokens?: number;
  cost?: number;
}): OpenCodeMessageUsageRow {
  return {
    sessionId: input.sessionId ?? "ses_default",
    timestampMs: input.timestampMs,
    tokens: input.tokens ?? 1_000,
    cost: input.cost ?? 0,
  };
}

/** Create an OpenCode Go `message` table and insert rows with the same JSON shape the CLI writes. */
function writeOpenCodeDb(input: {
  homeDir: string;
  rows: ReadonlyArray<{
    id?: string;
    sessionId: string;
    role?: string;
    tokens?: number;
    cost?: number;
    createdAtMs: number;
  }>;
}): string {
  const dbPath = nodePath.join(input.homeDir, ".local", "share", "opencode", "opencode.db");
  mkdirSync(nodePath.dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX message_session_time_created_id_idx
        ON message (session_id, time_created, id);
    `);
    const insert = database.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    input.rows.forEach((row, index) => {
      const id = row.id ?? `msg_${index}_${row.createdAtMs}_${row.sessionId}`;
      const data = JSON.stringify({
        role: row.role ?? "assistant",
        tokens: { total: row.tokens ?? 1_000 },
        cost: row.cost ?? 0,
        time: { created: row.createdAtMs },
      });
      insert.run(id, row.sessionId, row.createdAtMs, row.createdAtMs, data);
    });
  } finally {
    database.close();
  }
  return dbPath;
}

describe("normalizeOpenCodeMessageRows", () => {
  it("drops rows without a usable timestamp or token total", () => {
    const rows = normalizeOpenCodeMessageRows([
      { time_created: NOW_MS, tokens: 500, cost: 0.1, session_id: "ses_a" },
      { time_created: NOW_MS, tokens: undefined, cost: 0.1, session_id: "ses_a" },
      { time_created: "not-a-number", tokens: 500, cost: 0.1, session_id: "ses_a" },
      { time_created: -1, tokens: 500, cost: 0.1, session_id: "ses_a" },
    ]);
    expect(rows).toEqual([{ sessionId: "ses_a", timestampMs: NOW_MS, tokens: 500, cost: 0.1 }]);
  });

  it("coerces non-string session ids", () => {
    const rows = normalizeOpenCodeMessageRows([
      { time_created: NOW_MS, tokens: 100, cost: 0, session_id: 123 },
    ]);
    expect(rows[0]?.sessionId).toBe("123");
  });
});

describe("buildOpenCodeUsageLines", () => {
  it("returns no lines for an empty row set", () => {
    expect(buildOpenCodeUsageLines({ rows: [], nowMs: NOW_MS })).toEqual([]);
  });

  it("buckets tokens and sessions into 24h/7d/30d windows", () => {
    const lines = buildOpenCodeUsageLines({
      nowMs: NOW_MS,
      rows: [
        row({ sessionId: "ses_a", timestampMs: NOW_MS - 1 * HOUR_MS, tokens: 1_000 }),
        row({ sessionId: "ses_b", timestampMs: NOW_MS - 2 * DAY_MS, tokens: 2_000 }),
        row({ sessionId: "ses_a", timestampMs: NOW_MS - 20 * DAY_MS, tokens: 4_000 }),
      ],
    });

    const byLabel = new Map(lines.map((line) => [line.label, line]));
    expect(byLabel.get("24h")?.value).toBe("1K tokens");
    expect(byLabel.get("24h")?.subtitle).toBe("1 recent session");
    expect(byLabel.get("7d")?.value).toBe("3K tokens");
    expect(byLabel.get("7d")?.subtitle).toBe("2 recent sessions");
    expect(byLabel.get("30d")?.value).toBe("7K tokens");
    expect(byLabel.get("30d")?.subtitle).toBe("2 recent sessions");
  });

  it("appends a Spend line only when 30d cost is positive", () => {
    const withCost = buildOpenCodeUsageLines({
      nowMs: NOW_MS,
      rows: [row({ timestampMs: NOW_MS, tokens: 100, cost: 1.5 })],
    });
    expect(withCost.at(-1)).toEqual({
      label: "Spend",
      value: "$1.50",
      subtitle: "last 30d",
    });

    const withoutCost = buildOpenCodeUsageLines({
      nowMs: NOW_MS,
      rows: [row({ timestampMs: NOW_MS, tokens: 100, cost: 0 })],
    });
    expect(withoutCost.some((line) => line.label === "Spend")).toBe(false);
  });
});

describe("opencodeUsageFetcher", () => {
  it("reports a healthy empty snapshot when no database exists", async () => {
    const snapshot = await opencodeUsageFetcher.fetch(makeCtx(makeTempDir()));
    expect(snapshot.status).toBe("ok");
    expect(snapshot.source).toBe("opencode-native-db");
    expect(snapshot.usageLines).toEqual([]);
  });

  it("aggregates a real opencode.db into usage lines", async () => {
    const homeDir = makeTempDir();
    writeOpenCodeDb({
      homeDir,
      rows: [
        { sessionId: "ses_a", createdAtMs: NOW_MS - HOUR_MS, tokens: 1_000, cost: 0.5 },
        { sessionId: "ses_a", createdAtMs: NOW_MS - HOUR_MS, tokens: 500, cost: 0.25 },
        { sessionId: "ses_b", createdAtMs: NOW_MS - 2 * DAY_MS, tokens: 2_000, cost: 0.1 },
      ],
    });

    const snapshot = await opencodeUsageFetcher.fetch(makeCtx(homeDir));
    expect(snapshot.status).toBe("ok");
    const byLabel = new Map(snapshot.usageLines.map((line) => [line.label, line]));
    expect(byLabel.get("24h")?.value).toBe("1.5K tokens");
    expect(byLabel.get("24h")?.subtitle).toBe("1 recent session");
    expect(byLabel.get("7d")?.value).toBe("3.5K tokens");
    expect(byLabel.get("30d")?.value).toBe("3.5K tokens");
    expect(byLabel.get("Spend")?.value).toBe("$0.85");
  });

  it("ignores user messages and rows without token usage", async () => {
    const homeDir = makeTempDir();
    writeOpenCodeDb({
      homeDir,
      rows: [
        { sessionId: "ses_a", role: "user", createdAtMs: NOW_MS, tokens: 999_999 },
        { sessionId: "ses_b", createdAtMs: NOW_MS, tokens: 1_000, cost: 0.01 },
      ],
    });

    const snapshot = await opencodeUsageFetcher.fetch(makeCtx(homeDir));
    expect(snapshot.status).toBe("ok");
    expect(snapshot.usageLines[0]?.value).toBe("1K tokens");
  });

  it("honors XDG_DATA_HOME for the database path", async () => {
    const xdgRoot = makeTempDir();
    const dbPath = nodePath.join(xdgRoot, "opencode", "opencode.db");
    mkdirSync(nodePath.dirname(dbPath), { recursive: true });
    const database = new DatabaseSync(dbPath);
    database.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
    );
    database
      .prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "msg_1",
        "ses_a",
        NOW_MS,
        NOW_MS,
        JSON.stringify({
          role: "assistant",
          tokens: { total: 42 },
          cost: 0,
          time: { created: NOW_MS },
        }),
      );
    database.close();

    const snapshot = await opencodeUsageFetcher.fetch(
      makeCtx(makeTempDir(), { XDG_DATA_HOME: xdgRoot }),
    );
    expect(snapshot.status).toBe("ok");
    expect(snapshot.usageLines[0]?.value).toBe("42 tokens");
  });

  it("returns an error snapshot when the database cannot be read", async () => {
    const homeDir = makeTempDir();
    // A directory where the DB file should be: exists, but is not a readable SQLite DB.
    mkdirSync(nodePath.join(homeDir, ".local", "share", "opencode"), { recursive: true });
    writeFileSync(
      nodePath.join(homeDir, ".local", "share", "opencode", "opencode.db"),
      "not sqlite",
    );

    const snapshot = await opencodeUsageFetcher.fetch(makeCtx(homeDir));
    expect(snapshot.status).toBe("error");
    expect(snapshot.detail).toMatch(/local usage database/);
  });

  it("derives a cache key from the resolved database path", async () => {
    const homeDir = makeTempDir();
    expect(await opencodeUsageFetcher.cacheKey?.(makeCtx(homeDir))).toBe(`${homeDir}:none`);
    writeOpenCodeDb({ homeDir, rows: [{ sessionId: "ses_a", createdAtMs: NOW_MS }] });
    const key = await opencodeUsageFetcher.cacheKey?.(makeCtx(homeDir));
    expect(key).toMatch(/opencode\.db$/);
  });
});
