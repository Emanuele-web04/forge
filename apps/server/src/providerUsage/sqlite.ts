// FILE: providerUsage/sqlite.ts
// Purpose: Read-only SQLite access for provider usage fetchers — key/value lookups from VS
// Code-style `ItemTable` databases (e.g. Cursor's state.vscdb) and generic read-only SELECTs
// (e.g. the OpenCode Go `opencode.db` message archive). Mirrors the bun:sqlite / node:sqlite
// runtime branching used in homeMigration.ts so it works under both runtimes. Defensive:
// `readItemTableValues` returns {} on any failure; `readSqliteRows` throws so callers can
// distinguish "no rows" from "database unreadable".

// Loaded dynamically so bundlers don't try to resolve the runtime-only "bun:sqlite" specifier.
const importRuntimeModule = (specifier: string): Promise<unknown> =>
  Function("specifier", "return import(specifier)")(specifier) as Promise<unknown>;

interface ReadonlyStatement {
  get: (...params: ReadonlyArray<unknown>) => unknown;
  all: (...params: ReadonlyArray<unknown>) => ReadonlyArray<Record<string, unknown>>;
}

interface ReadonlyDatabase {
  query?: (sql: string) => ReadonlyStatement; // bun:sqlite
  prepare?: (sql: string) => ReadonlyStatement; // node:sqlite
  close: () => unknown;
}

async function openReadOnlyDatabase(dbPath: string): Promise<ReadonlyDatabase> {
  if (process.versions.bun !== undefined) {
    const { Database } = (await importRuntimeModule("bun:sqlite")) as {
      Database: new (path: string, options: { readonly: boolean }) => ReadonlyDatabase;
    };
    return new Database(dbPath, { readonly: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true }) as unknown as ReadonlyDatabase;
}

function coerceCell(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  return undefined;
}

/**
 * Look up several keys from an `ItemTable(key, value)` SQLite DB in one open. Returns a map of
 * the keys that were found. Never throws; missing DB / locked DB / missing table -> {}.
 */
export async function readItemTableValues(input: {
  dbPath: string;
  keys: ReadonlyArray<string>;
}): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let database: ReadonlyDatabase | null = null;
  try {
    database = await openReadOnlyDatabase(input.dbPath);
    const sql = "SELECT value FROM ItemTable WHERE key = ?";
    const statement = database.query?.(sql) ?? database.prepare?.(sql);
    if (!statement) {
      return result;
    }
    for (const key of input.keys) {
      const row = statement.get(key) as { value?: unknown } | null | undefined;
      const value = coerceCell(row?.value);
      if (value !== undefined) {
        result[key] = value;
      }
    }
  } catch {
    return result;
  } finally {
    try {
      database?.close();
    } catch {
      // ignore close failures
    }
  }
  return result;
}

/**
 * Run a read-only SELECT and return every row as a string-keyed object. Unlike
 * `readItemTableValues` this propagates failures (missing/malformed DB, bad SQL, a WAL read
 * error) so callers can tell "query returned no rows" apart from "database unreadable" — the
 * OpenCode fetcher needs that distinction to report errors instead of blank usage.
 */
export async function readSqliteRows(input: {
  dbPath: string;
  sql: string;
  params?: ReadonlyArray<unknown>;
}): Promise<ReadonlyArray<Record<string, unknown>>> {
  let database: ReadonlyDatabase | null = null;
  try {
    database = await openReadOnlyDatabase(input.dbPath);
    const statement = database.query?.(input.sql) ?? database.prepare?.(input.sql);
    if (!statement) {
      throw new Error(`Unsupported sqlite runtime for ${input.dbPath}`);
    }
    return statement.all(...(input.params ?? []));
  } finally {
    try {
      database?.close();
    } catch {
      // ignore close failures
    }
  }
}
