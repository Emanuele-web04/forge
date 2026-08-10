import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  __timestampUnitProbeCountForTests,
  scanGrokLocalActivity,
  scanLocalProviderActivity,
} from "./machineActivity.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeDatabase(
  rows: ReadonlyArray<{
    id: string;
    sessionId: string;
    createdAt: number;
    data: Record<string, unknown>;
  }>,
): Promise<string> {
  const directory = await mkdtemp(nodePath.join(tmpdir(), "synara-machine-"));
  tempDirs.push(directory);
  const path = nodePath.join(directory, "opencode.db");
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
  const insert = database.prepare(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(row.id, row.sessionId, row.createdAt, JSON.stringify(row.data));
  }
  database.close();
  return path;
}

async function makeCappedDatabase(nowMs: number): Promise<string> {
  const directory = await mkdtemp(nodePath.join(tmpdir(), "synara-machine-cap-"));
  tempDirs.push(directory);
  const path = nodePath.join(directory, "opencode.db");
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
  const insert = database.prepare(`
    WITH RECURSIVE sequence(index_value) AS (
      SELECT 0
      UNION ALL
      SELECT index_value + 1 FROM sequence WHERE index_value < 50000
    )
    INSERT INTO message (id, session_id, time_created, data)
    SELECT
      'capped-' || index_value,
      'session-' || (index_value % 5),
      ? - (index_value * 1_000),
      ?
    FROM sequence
  `);
  insert.run(
    nowMs,
    JSON.stringify({ role: "assistant", modelID: "bounded-model", tokens: { input: 1 } }),
  );
  database.close();
  return path;
}

async function makeDatabaseCollection(count: number): Promise<string> {
  const directory = await mkdtemp(nodePath.join(tmpdir(), "synara-machine-databases-"));
  tempDirs.push(directory);
  for (let index = 0; index < count; index += 1) {
    const database = new DatabaseSync(nodePath.join(directory, `opencode-${index}.db`));
    database.exec(
      "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
    );
    database.close();
  }
  return directory;
}

describe("scanLocalProviderActivity", () => {
  it("deduplicates OpenCode messages and groups measured tokens by upstream and model", async () => {
    const nowMs = Date.parse("2026-08-09T00:00:00.000Z");
    const db = await makeDatabase([
      {
        id: "message-1",
        sessionId: "session-a",
        createdAt: nowMs - 2 * 60 * 60 * 1_000,
        data: {
          role: "assistant",
          providerID: "opencode-go",
          modelID: "deepseek-v4-flash",
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 4 } },
          cost: 0.12,
        },
      },
      {
        id: "message-2",
        sessionId: "session-b",
        createdAt: nowMs - 8 * 24 * 60 * 60 * 1_000,
        data: {
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-opus",
          tokens: { input: 500, output: 50 },
          cost: 0.5,
        },
      },
    ]);
    const duplicateDb = await makeDatabase([
      {
        id: "message-1",
        sessionId: "session-a",
        createdAt: nowMs - 2 * 60 * 60 * 1_000,
        data: {
          role: "assistant",
          providerID: "opencode-go",
          modelID: "deepseek-v4-flash",
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 4 } },
          cost: 0.12,
        },
      },
    ]);

    const result = await scanLocalProviderActivity({
      provider: "opencode",
      homeDir: "/tmp/synara-test-home",
      databasePaths: [db, duplicateDb],
      nowMs,
    });

    expect(result?.status).toBe("ok");
    expect(result?.scope).toBe("machine");
    expect(result?.source).toBe("opencode-local-sqlite");
    expect(result?.breakdown).toEqual([
      expect.objectContaining({
        model: "claude-opus",
        upstreamProviderId: "anthropic",
        sessions: 1,
        tokens: expect.objectContaining({ total: 550 }),
      }),
      expect.objectContaining({
        model: "deepseek-v4-flash",
        upstreamProviderId: "opencode-go",
        sessions: 1,
        tokens: expect.objectContaining({ total: 159, cacheWrite: 4 }),
      }),
    ]);
    expect(result?.periods.find((period) => period.id === "24h")).toEqual(
      expect.objectContaining({
        sessions: 1,
        tokens: expect.objectContaining({ total: 159 }),
        recordedCostUsd: 0.12,
      }),
    );
    expect(result?.periods.find((period) => period.id === "30d")).toEqual(
      expect.objectContaining({ sessions: 2, recordedCostUsd: 0.62 }),
    );
  });

  it("keeps an honest unavailable state when a known database has no token-bearing messages", async () => {
    const db = await makeDatabase([]);
    const result = await scanLocalProviderActivity({
      provider: "kilo",
      homeDir: "/tmp/synara-test-home",
      databasePaths: [db],
      nowMs: Date.parse("2026-08-09T00:00:00.000Z"),
    });
    expect(result).toEqual(
      expect.objectContaining({
        status: "unavailable",
        scope: "machine",
        source: "kilo-local-sqlite",
        periods: [],
      }),
    );
  });

  it("finds Windows APPDATA databases and includes legacy second timestamps", async () => {
    const nowMs = Date.parse("2026-08-09T00:00:00.000Z");
    const db = await makeDatabase([
      {
        id: "legacy-seconds",
        sessionId: "windows-session",
        createdAt: Math.trunc((nowMs - 2 * 60 * 60 * 1_000) / 1_000),
        data: {
          role: "assistant",
          providerID: "opencode-go",
          modelID: "deepseek-v4-flash",
          tokens: { input: 20, output: 5 },
        },
      },
    ]);
    const appData = await mkdtemp(nodePath.join(tmpdir(), "synara-appdata-"));
    tempDirs.push(appData);
    const targetDirectory = nodePath.join(appData, "opencode");
    await mkdir(targetDirectory, { recursive: true });
    const targetPath = nodePath.join(targetDirectory, "opencode.db");
    await rename(db, targetPath);

    const result = await scanLocalProviderActivity({
      provider: "opencode",
      homeDir: nodePath.join(appData, "home"),
      env: { APPDATA: appData },
      nowMs,
    });

    expect(result?.status).toBe("ok");
    expect(result?.periods.find((period) => period.id === "24h")).toEqual(
      expect.objectContaining({
        sessions: 1,
        tokens: expect.objectContaining({ total: 25 }),
      }),
    );
  });

  it("marks a database as partial when the bounded scan cap is reached", async () => {
    const nowMs = Date.parse("2026-08-09T00:00:00.000Z");
    const db = await makeCappedDatabase(nowMs);

    const result = await scanLocalProviderActivity({
      provider: "opencode",
      homeDir: "/tmp/synara-test-home",
      databasePaths: [db],
      nowMs,
    });

    expect(result?.status).toBe("partial");
    expect(result?.detail).toMatch(/scan cap/iu);
    expect(result?.periods.find((period) => period.id === "30d")?.tokens.total).toBe(50_000);
  });

  it("marks the activity partial when the database-count cap is reached", async () => {
    const databaseDirectory = await makeDatabaseCollection(13);
    const result = await scanLocalProviderActivity({
      provider: "opencode",
      homeDir: "/tmp/synara-test-home",
      env: { OPENCODE_DATA_DIR: databaseDirectory },
      nowMs: Date.parse("2026-08-09T00:00:00.000Z"),
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "partial",
        detail: expect.stringContaining("12 local databases"),
      }),
    );
  });

  it("reports a definitive error when every local database fails to read", async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "synara-machine-corrupt-"));
    tempDirs.push(directory);
    const corruptPath = nodePath.join(directory, "opencode.db");
    await writeFile(corruptPath, "this is not a sqlite database");

    const result = await scanLocalProviderActivity({
      provider: "opencode",
      homeDir: "/tmp/synara-test-home",
      databasePaths: [corruptPath],
      nowMs: Date.parse("2026-08-09T00:00:00.000Z"),
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        scope: "machine",
        periods: [],
        detail: expect.stringContaining(corruptPath),
      }),
    );
  });

  it("keeps totals partial and states only the failure count when some databases fail", async () => {
    const nowMs = Date.parse("2026-08-09T00:00:00.000Z");
    const goodDb = await makeDatabase([
      {
        id: "message-ok",
        sessionId: "session-ok",
        createdAt: nowMs - 60 * 60 * 1_000,
        data: {
          role: "assistant",
          providerID: "opencode-go",
          modelID: "good-model",
          tokens: { input: 10, output: 5 },
        },
      },
    ]);
    const directory = await mkdtemp(nodePath.join(tmpdir(), "synara-machine-corrupt-"));
    tempDirs.push(directory);
    const corruptPath = nodePath.join(directory, "opencode-2.db");
    await writeFile(corruptPath, "not a database either");

    const result = await scanLocalProviderActivity({
      provider: "opencode",
      homeDir: "/tmp/synara-test-home",
      databasePaths: [goodDb, corruptPath],
      nowMs,
    });

    expect(result?.status).toBe("partial");
    expect(result?.detail).toMatch(/1 local database could not be read; totals may be incomplete/u);
    // The partial state carries the failure count, not the machine path.
    expect(result?.detail).not.toContain(corruptPath);
    expect(result?.periods.find((period) => period.id === "24h")?.tokens.total).toBe(15);
  });

  it("keeps an empty but readable database as unavailable rather than an error", async () => {
    const db = await makeDatabase([]);
    const result = await scanLocalProviderActivity({
      provider: "opencode",
      homeDir: "/tmp/synara-test-home",
      databasePaths: [db],
      nowMs: Date.parse("2026-08-09T00:00:00.000Z"),
    });
    expect(result).toEqual(
      expect.objectContaining({
        status: "unavailable",
        periods: [],
      }),
    );
  });

  it("caches the detected timestamp unit while a database is unchanged", async () => {
    const nowMs = Date.parse("2026-08-09T00:00:00.000Z");
    const db = await makeDatabase([
      {
        id: "probe-msg",
        sessionId: "probe-session",
        createdAt: nowMs - 2 * 60 * 60 * 1_000,
        data: {
          role: "assistant",
          providerID: "opencode-go",
          modelID: "probe-model",
          tokens: { input: 7 },
        },
      },
    ]);
    const before = __timestampUnitProbeCountForTests();
    const first = await scanLocalProviderActivity({
      provider: "opencode",
      homeDir: "/tmp/synara-test-home",
      databasePaths: [db],
      nowMs,
    });
    const afterFirst = __timestampUnitProbeCountForTests();
    expect(afterFirst).toBe(before + 1);
    expect(first?.status).toBe("ok");

    // Unchanged mtime: the second refresh must not re-probe the unit.
    const second = await scanLocalProviderActivity({
      provider: "opencode",
      homeDir: "/tmp/synara-test-home",
      databasePaths: [db],
      nowMs,
    });
    expect(__timestampUnitProbeCountForTests()).toBe(afterFirst);
    expect(second?.status).toBe("ok");

    // A changed mtime re-probes the unit once.
    await utimes(db, new Date(nowMs + 60_000), new Date(nowMs + 60_000));
    await scanLocalProviderActivity({
      provider: "opencode",
      homeDir: "/tmp/synara-test-home",
      databasePaths: [db],
      nowMs,
    });
    expect(__timestampUnitProbeCountForTests()).toBe(afterFirst + 1);
  });
});

describe("scanGrokLocalActivity", () => {
  it("reads Grok signals.json files into token samples", async () => {
    const homeDir = await mkdtemp(nodePath.join(tmpdir(), "synara-grok-"));
    tempDirs.push(homeDir);
    const sessionRoot = nodePath.join(homeDir, ".grok", "sessions", "encoded-cwd", "session-a");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(
      nodePath.join(sessionRoot, "signals.json"),
      JSON.stringify({
        totalTokensBeforeCompaction: 40_000,
        contextTokensUsed: 190_244,
        primaryModelId: "deepseek-v4-flash",
        turnCount: 1,
      }),
      "utf8",
    );
    await utimes(
      nodePath.join(sessionRoot, "signals.json"),
      new Date(nowMsForGrok - 60_000),
      new Date(nowMsForGrok - 60_000),
    );

    const activity = await scanGrokLocalActivity({ homeDir, nowMs: nowMsForGrok });
    expect(activity?.status).toBe("ok");
    expect(activity?.source).toBe("grok-session-signals");
    expect(activity?.periods[2]?.tokens.total).toBe(230_244);
    expect(activity?.periods[2]?.sessions).toBe(1);
    expect(activity?.breakdown[0]).toMatchObject({
      model: "deepseek-v4-flash",
      tokens: { total: 230_244 },
    });
  });

  it("returns null when no signals.json is present", async () => {
    const homeDir = await mkdtemp(nodePath.join(tmpdir(), "synara-grok-empty-"));
    tempDirs.push(homeDir);
    await mkdir(nodePath.join(homeDir, ".grok", "sessions"), { recursive: true });
    const activity = await scanGrokLocalActivity({ homeDir, nowMs: nowMsForGrok });
    expect(activity).toBeNull();
  });

  it("ignores signal files older than the 30-day window", async () => {
    const homeDir = await mkdtemp(nodePath.join(tmpdir(), "synara-grok-old-"));
    tempDirs.push(homeDir);
    const sessionRoot = nodePath.join(homeDir, ".grok", "sessions", "cwd", "old-session");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(
      nodePath.join(sessionRoot, "signals.json"),
      JSON.stringify({ contextTokensUsed: 10_000 }),
      "utf8",
    );
    await utimes(
      nodePath.join(sessionRoot, "signals.json"),
      new Date(nowMsForGrok - 45 * 24 * 60 * 60 * 1_000),
      new Date(nowMsForGrok - 45 * 24 * 60 * 60 * 1_000),
    );
    const activity = await scanGrokLocalActivity({ homeDir, nowMs: nowMsForGrok });
    expect(activity).toBeNull();
  });
});

const nowMsForGrok = Date.parse("2026-08-09T00:00:00.000Z");
