import { randomUUID } from "node:crypto";
import { eq, isNull, and } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../db";
import { runMigrations } from "../db/migrate";
import { hostTokens, hosts } from "../db/schema";
import { createDeviceCredentialStore, hashHostToken } from "./deviceCredentialStore";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("deviceCredentialStore rotation", () => {
  const databaseUrl = TEST_DATABASE_URL as string;
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    await runMigrations(databaseUrl);
    ({ db, pool } = createDb(databaseUrl));
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertHost(): Promise<string> {
    const [row] = await db
      .insert(hosts)
      .values({
        ownerOrgId: `org_${randomUUID()}`,
        registeredByUserId: `user_${randomUUID()}`,
        environmentId: randomUUID(),
        name: "Rotation Test Host",
        platform: "darwin",
        kind: "local",
        endpoints: [],
      })
      .returning();
    if (!row) throw new Error("failed to insert host");
    return row.id;
  }

  function activeTokens(hostId: string) {
    return db
      .select()
      .from(hostTokens)
      .where(and(eq(hostTokens.hostId, hostId), isNull(hostTokens.revokedAt)));
  }

  // Rotation is revoke-then-mint inside one transaction serialized per host:
  // however two rotations interleave, the end state is exactly one active
  // token — the last minted — and both returned tokens exist as rows (the
  // loser's revoked). The partial unique index would refuse any state with
  // two actives even if the serialization failed.
  it("two concurrent rotations of one host end with exactly one active token", async () => {
    const store = createDeviceCredentialStore(db);
    const hostId = await insertHost();

    const [first, second] = await Promise.all([store.rotate(hostId), store.rotate(hostId)]);

    const active = await activeTokens(hostId);
    expect(active).toHaveLength(1);
    expect([hashHostToken(first), hashHostToken(second)]).toContain(active[0]?.tokenHash);

    // Exactly one of the two authenticates; the other is revoked, not gone.
    const results = await Promise.all(
      [first, second].map((token) => store.authenticate(`Bearer ${token}`)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error === "token_revoked")).toHaveLength(
      1,
    );
  });

  // Atomicity: a failure between the revoke and the insert must roll the
  // revoke back, so the host keeps its previously valid credential instead of
  // being stranded with zero. The same transaction shape rotate() uses is
  // driven directly here and aborted after the revoke.
  it("a failure mid-rotation leaves the previous token active", async () => {
    const store = createDeviceCredentialStore(db);
    const hostId = await insertHost();
    const original = await store.rotate(hostId);

    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(hostTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(hostTokens.hostId, hostId), isNull(hostTokens.revokedAt)));
        throw new Error("simulated crash between revoke and mint");
      }),
    ).rejects.toThrow(/simulated crash/);

    const active = await activeTokens(hostId);
    expect(active).toHaveLength(1);
    expect(active[0]?.tokenHash).toBe(hashHostToken(original));
    expect(await store.authenticate(`Bearer ${original}`)).toMatchObject({ ok: true, hostId });
  });

  // The database-level backstop: even code that bypasses rotate() cannot
  // create a second active credential for a host.
  it("refuses a second active token for one host at the database level", async () => {
    const store = createDeviceCredentialStore(db);
    const hostId = await insertHost();
    await store.rotate(hostId);

    await expect(
      db.insert(hostTokens).values({ hostId, tokenHash: hashHostToken("rogue") }),
    ).rejects.toThrow();
  });
});
