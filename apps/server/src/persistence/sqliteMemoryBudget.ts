// FILE: sqliteMemoryBudget.ts
// Purpose: Sizes SQLite's page cache and mmap window to the host's physical memory.
// Layer: Persistence tuning (pure; no runtime dependencies).

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface SqliteMemoryBudget {
  /** `PRAGMA cache_size` value: negative KiB, i.e. `-(bytes / 1024)`. */
  readonly cacheSizePragma: number;
  /** `PRAGMA mmap_size` value in bytes. */
  readonly mmapSizeBytes: number;
}

/**
 * The event log alone can exceed a gigabyte, so the 2 MB SQLite default page
 * cache thrashes during projector replay and large snapshot reads. Big hosts
 * get a 256 MB cache plus a 1 GiB mmap window. Both are on-demand ceilings, but
 * mmap'd pages and the heap cache still compete with the renderer and provider
 * CLIs for physical memory: on an 8 GB laptop the same ceilings push the
 * machine into swap during startup, which is far slower than SQLite re-reading
 * a page from disk. Scale the budget with what the host actually has.
 */
export function resolveSqliteMemoryBudget(totalMemoryBytes: number): SqliteMemoryBudget {
  const total = Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 ? totalMemoryBytes : 0;
  if (total >= 24 * GIB) {
    return { cacheSizePragma: -(256 * MIB) / 1024, mmapSizeBytes: 1 * GIB };
  }
  if (total >= 12 * GIB) {
    return { cacheSizePragma: -(128 * MIB) / 1024, mmapSizeBytes: 512 * MIB };
  }
  return { cacheSizePragma: -(64 * MIB) / 1024, mmapSizeBytes: 256 * MIB };
}
