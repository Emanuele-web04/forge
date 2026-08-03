import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./index";
import { runMigrations } from "./migrate";
import { hosts, user } from "./schema";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("schema", () => {
  beforeAll(async () => {
    await runMigrations(url!);
  });

  it("enforces unique (userId, environmentId)", async () => {
    const { db, pool } = createDb(url!);
    const [u] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        name: "t",
        email: `${crypto.randomUUID()}@x.com`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    const row = {
      userId: u!.id,
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
