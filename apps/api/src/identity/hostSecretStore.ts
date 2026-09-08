// FILE: identity/hostSecretStore.ts
// Purpose: Storage for end-to-end encrypted Host Secrets and the pairing
// wraps that deliver the Sync Key (ADR 0004, spec slice E §3). Everything
// here moves opaque bytes: the only field this module interprets is
// `version`, and only to compare it.
// Layer: API identity (store)
// Depends on: db/schema, contracts. Deliberately NOT on the crypto core —
// the service must be incapable of opening what it stores.

import {
  HOST_SECRET_HISTORY_LIMIT,
  type StoredHostSecret,
  type SyncKeyWrap,
} from "@synara/contracts";
import { and, desc, eq, lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { hostSecretVersions, hostSecrets, syncKeyWraps } from "../db/schema";
import type { HostSecretStore } from "./interfaces";

/**
 * How long an undelivered pairing wrap stays fetchable. Pairing is a
 * hands-on flow — both devices are in front of the user, comparing a
 * verification code — so anything not collected within the hour is an
 * abandoned attempt, not a slow one. Short enough that a wrap uploaded to the
 * wrong device (a mistyped pairing) stops being addressable quickly.
 */
export const SYNC_KEY_WRAP_TTL_MS = 60 * 60 * 1000;

type HostSecretRow = typeof hostSecrets.$inferSelect;

type HostSecretDeleter = Pick<NodePgDatabase<typeof schema>, "delete">;

/**
 * Removes a host's secrets and their history on the CALLER's transaction —
 * the deliberate counterpart to the missing foreign key.
 *
 * The tables carry no FK to `hosts` (mirroring `revocation_events`), so
 * nothing removes these rows implicitly and deletion ORDER can never destroy
 * them. That makes the cleanup an explicit statement in the host-delete
 * transaction: the rows go when the owner says the host goes, and at no other
 * time. Exported like `writeRevocationEvents` so the host-delete route can
 * run it inside its own transaction rather than as a second, separately
 * failable round trip.
 */
export async function deleteHostSecretRows(
  writer: HostSecretDeleter,
  hostId: string,
): Promise<void> {
  await writer.delete(hostSecrets).where(eq(hostSecrets.hostId, hostId));
  await writer.delete(hostSecretVersions).where(eq(hostSecretVersions.hostId, hostId));
}

/**
 * The version an absent row reports. A first write therefore sends
 * `expectedVersion: 0`, which makes "create" and "update" the same
 * compare-and-swap rather than two paths that could disagree about who wins a
 * race.
 */
export const HOST_SECRET_ABSENT_VERSION = 0;

function toStoredHostSecret(row: HostSecretRow): StoredHostSecret {
  return {
    ciphertext: row.ciphertext,
    iv: row.iv,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createHostSecretStore(db: NodePgDatabase<typeof schema>): HostSecretStore {
  return {
    async read(hostId, ownerUserId) {
      const [row] = await db
        .select()
        .from(hostSecrets)
        .where(and(eq(hostSecrets.hostId, hostId), eq(hostSecrets.ownerUserId, ownerUserId)))
        .limit(1);
      return row ? toStoredHostSecret(row) : null;
    },

    async write(input) {
      return db.transaction(async (tx) => {
        // FOR UPDATE, not an optimistic UPDATE ... WHERE version = n: the
        // write also pushes the previous row into history and trims it, and
        // two writers interleaving those statements would produce a history
        // whose contents depend on statement order. The lock makes the whole
        // compare-swap-archive-trim sequence atomic, so concurrent writers
        // serialize and exactly one observes the expected version.
        const [current] = await tx
          .select()
          .from(hostSecrets)
          .where(eq(hostSecrets.hostId, input.hostId))
          .limit(1)
          .for("update");

        // An existing row owned by someone else is reported as a conflict at
        // its stored version rather than as a distinct error: the route has
        // already established that the caller owns the HOST, so this can only
        // mean ownership transferred between the check and the write, and the
        // caller's cure is the same as any other stale write — re-read.
        const currentVersion = current?.version ?? HOST_SECRET_ABSENT_VERSION;
        if (
          currentVersion !== input.expectedVersion ||
          (current !== undefined && current.ownerUserId !== input.ownerUserId)
        ) {
          return { ok: false as const, currentVersion };
        }

        if (current) {
          // Archive BEFORE overwriting, inside the same transaction: a failed
          // trim or insert must take the overwrite down with it, or the
          // superseded ciphertext is gone with nothing recording that it was
          // supposed to be recoverable.
          await tx.insert(hostSecretVersions).values({
            hostId: current.hostId,
            ownerUserId: current.ownerUserId,
            ciphertext: current.ciphertext,
            iv: current.iv,
            version: current.version,
            updatedAt: current.updatedAt,
          });
          // Trim to the newest HOST_SECRET_HISTORY_LIMIT by version. Keyed on
          // version rather than id or timestamp because version is the only
          // one that is both unique per host and meaningfully ordered — two
          // rows can share a wall-clock millisecond, and ids would tie the
          // retention rule to insertion order across a restore.
          const [cutoff] = await tx
            .select({ version: hostSecretVersions.version })
            .from(hostSecretVersions)
            .where(eq(hostSecretVersions.hostId, current.hostId))
            .orderBy(desc(hostSecretVersions.version))
            .limit(1)
            .offset(HOST_SECRET_HISTORY_LIMIT - 1);
          if (cutoff) {
            await tx
              .delete(hostSecretVersions)
              .where(
                and(
                  eq(hostSecretVersions.hostId, current.hostId),
                  lt(hostSecretVersions.version, cutoff.version),
                ),
              );
          }
        }

        const values = {
          hostId: input.hostId,
          ownerUserId: input.ownerUserId,
          ciphertext: input.envelope.ciphertext,
          iv: input.envelope.iv,
          version: input.envelope.version,
          updatedAt: new Date(),
        };
        // onConflictDoUpdate rather than a branch on `current`: the row is
        // locked, but an absent row has nothing to lock, so two first-writers
        // can both reach here. The unique key turns that race into an upsert
        // instead of a 500 — and the version check above still means only one
        // of them can have passed CAS.
        const [row] = await tx
          .insert(hostSecrets)
          .values(values)
          .onConflictDoUpdate({
            target: hostSecrets.hostId,
            set: {
              ownerUserId: values.ownerUserId,
              ciphertext: values.ciphertext,
              iv: values.iv,
              version: values.version,
              updatedAt: values.updatedAt,
            },
            // Guards the one race the lock cannot: a concurrent first write
            // that inserted between the SELECT and here. Without it the loser
            // would overwrite the winner at the same version.
            setWhere: eq(hostSecrets.version, input.expectedVersion),
          })
          .returning();
        if (!row) {
          // `setWhere` refused: a concurrent first write landed between the
          // SELECT and here. Re-read to report the version that actually
          // won — answering `expectedVersion` would hand the client back the
          // stale value it just failed with and spin it in a retry loop.
          const [winner] = await tx
            .select({ version: hostSecrets.version })
            .from(hostSecrets)
            .where(eq(hostSecrets.hostId, input.hostId))
            .limit(1);
          return {
            ok: false as const,
            currentVersion: winner?.version ?? HOST_SECRET_ABSENT_VERSION,
          };
        }
        return { ok: true as const, secret: toStoredHostSecret(row) };
      });
    },

    async history(hostId, ownerUserId) {
      const rows = await db
        .select()
        .from(hostSecretVersions)
        .where(
          and(
            eq(hostSecretVersions.hostId, hostId),
            eq(hostSecretVersions.ownerUserId, ownerUserId),
          ),
        )
        .orderBy(desc(hostSecretVersions.version))
        .limit(HOST_SECRET_HISTORY_LIMIT);
      return rows.map((row) => ({
        ciphertext: row.ciphertext,
        iv: row.iv,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      }));
    },

    async putWrap(input) {
      const expiresAt = new Date(Date.now() + SYNC_KEY_WRAP_TTL_MS);
      // Opportunistic expiry sweep on the write path, matching how link
      // challenges are cleaned: pairing uploads are rare, so this is the
      // cheapest place to keep abandoned wraps from accumulating without
      // adding a scheduler nobody would notice had stopped.
      await db.delete(syncKeyWraps).where(lt(syncKeyWraps.expiresAt, new Date()));
      // Replace rather than queue: a device has at most one wrap waiting, so
      // a retried pairing always delivers the newest attempt and a stalled
      // one cannot accumulate rows.
      await db
        .insert(syncKeyWraps)
        .values({
          recipientDeviceId: input.recipientDeviceId,
          ownerUserId: input.ownerUserId,
          wrap: input.wrap,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: syncKeyWraps.recipientDeviceId,
          set: {
            ownerUserId: input.ownerUserId,
            wrap: input.wrap,
            createdAt: new Date(),
            expiresAt,
          },
        });
      return { expiresAt: expiresAt.toISOString() };
    },

    async takeWrap(recipientDeviceId, ownerUserId) {
      // Single delivery, enforced by DELETE ... RETURNING: fetch and consume
      // are one statement, so two racing readers cannot both receive the
      // wrap — only the one whose delete removed the row gets a row back.
      // A separate SELECT-then-DELETE would deliver twice under concurrency,
      // which is exactly the property pairing must not have.
      const rows = await db
        .delete(syncKeyWraps)
        .where(
          and(
            eq(syncKeyWraps.recipientDeviceId, recipientDeviceId),
            eq(syncKeyWraps.ownerUserId, ownerUserId),
          ),
        )
        .returning();
      const row = rows[0];
      if (!row) return null;
      // Expired rows are consumed (the delete already happened) but not
      // served: an abandoned pairing must not complete an hour later against
      // a device the user has since had second thoughts about.
      if (row.expiresAt.getTime() <= Date.now()) return null;
      return { wrap: row.wrap as SyncKeyWrap, createdAt: row.createdAt.toISOString() };
    },
  };
}
