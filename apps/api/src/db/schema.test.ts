import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./index";
import { runMigrations } from "./migrate";
import { hosts } from "./schema";

const url = process.env.TEST_DATABASE_URL;

function hostRow(overrides: Partial<typeof hosts.$inferInsert> = {}) {
  return {
    // WorkOS ids are opaque strings with no local row behind them.
    ownerOrgId: `org_${crypto.randomUUID()}`,
    registeredByUserId: `user_${crypto.randomUUID()}`,
    environmentId: "env-1",
    name: "MacBook",
    platform: "darwin" as const,
    kind: "local" as const,
    endpoints: [],
    ...overrides,
  };
}

describe.skipIf(!url)("schema", () => {
  beforeAll(async () => {
    await runMigrations(url!);
  });

  it("enforces unique (ownerOrgId, environmentId)", async () => {
    const { db, pool } = createDb(url!);
    try {
      const row = hostRow();
      await db.insert(hosts).values(row);
      await expect(db.insert(hosts).values(row)).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });

  // The key that changed in 0002. Two organizations describing the same
  // machine is the ordinary case once a machine can be linked from more than
  // one workspace, and the old (user, environment) index did not allow it.
  it("lets two organizations register the same environment id", async () => {
    const { db, pool } = createDb(url!);
    try {
      const environmentId = `env_${crypto.randomUUID()}`;
      const registeredByUserId = `user_${crypto.randomUUID()}`;
      await db.insert(hosts).values(hostRow({ environmentId, registeredByUserId }));
      await expect(
        db.insert(hosts).values(hostRow({ environmentId, registeredByUserId })),
      ).resolves.toBeDefined();
    } finally {
      await pool.end();
    }
  });
});
