import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./index";
import { runMigrations } from "./migrate";
import { hosts } from "./schema";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("schema", () => {
  beforeAll(async () => {
    await runMigrations(url!);
  });

  it("enforces unique (userId, environmentId)", async () => {
    const { db, pool } = createDb(url!);
    const row = {
      // WorkOS user ids are opaque strings with no local row behind them.
      userId: `user_${crypto.randomUUID()}`,
      environmentId: "env-1",
      name: "MacBook",
      platform: "darwin" as const,
      kind: "local" as const,
      endpoints: [],
    };
    await db.insert(hosts).values(row);
    await expect(db.insert(hosts).values(row)).rejects.toThrow();
    await pool.end();
  });
});
