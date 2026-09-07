import { describe, expect, it } from "vitest";

import { resolveSqliteMemoryBudget } from "./sqliteMemoryBudget.ts";

const GIB = 1024 * 1024 * 1024;

describe("resolveSqliteMemoryBudget", () => {
  it("keeps the large-host ceilings on 24 GB and above", () => {
    expect(resolveSqliteMemoryBudget(32 * GIB)).toEqual({
      cacheSizePragma: -262144,
      mmapSizeBytes: GIB,
    });
    expect(resolveSqliteMemoryBudget(24 * GIB)).toEqual(resolveSqliteMemoryBudget(64 * GIB));
  });

  it("halves the budget on 16 GB hosts", () => {
    expect(resolveSqliteMemoryBudget(16 * GIB)).toEqual({
      cacheSizePragma: -131072,
      mmapSizeBytes: 512 * 1024 * 1024,
    });
  });

  it("uses the small budget on 8 GB hosts and for unknown memory", () => {
    const small = { cacheSizePragma: -65536, mmapSizeBytes: 256 * 1024 * 1024 };
    expect(resolveSqliteMemoryBudget(8 * GIB)).toEqual(small);
    expect(resolveSqliteMemoryBudget(0)).toEqual(small);
    expect(resolveSqliteMemoryBudget(Number.NaN)).toEqual(small);
  });
});
