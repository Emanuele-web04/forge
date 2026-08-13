// FILE: identity/environmentRegistry.ts
// Purpose: The Postgres-backed EnvironmentRegistry — the directory of
// environments (hosts) accounts register. Provider-independent: rows are
// keyed by opaque organization and user ids, and nothing here knows which
// identity provider issued them.
// Layer: API identity (implementation)
// Depends on: db/schema (hosts).

import type { AccountHost, EnvironmentId } from "@synara/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { hosts } from "../db/schema";
import { EnvironmentAlreadyLinkedError, type EnvironmentRegistry } from "./interfaces";
import { hostEnvironmentLockKey } from "./environmentLock";

type HostRow = typeof hosts.$inferSelect;

export function toAccountHost(row: HostRow): AccountHost {
  return {
    id: row.id,
    environmentId: row.environmentId as EnvironmentId,
    name: row.name,
    platform: row.platform,
    kind: row.kind,
    endpoints: row.endpoints,
    ...(row.appVersion ? { appVersion: row.appVersion } : {}),
    registeredByUserId: row.registeredByUserId,
    ownerUserId: row.ownerUserId,
    discoverable: row.discoverable,
    linked: row.publicKeyJwk !== null,
    keyGeneration: row.keyGeneration,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

/**
 * Whether a failed write was refused by a unique index.
 *
 * The chain is walked rather than the error inspected directly: Drizzle wraps
 * driver errors in a `DrizzleQueryError` that carries no `code` of its own, so
 * reading only the top-level object turns every conflict into an unhandled
 * 500 — which is exactly what a re-linked environment would have become.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (
    let current = error;
    current instanceof Object;
    current = (current as { cause?: unknown }).cause
  ) {
    if ("code" in current && current.code === "23505") return true;
  }
  return false;
}

export function createEnvironmentRegistry(db: NodePgDatabase<typeof schema>): EnvironmentRegistry {
  return {
    async list(orgId) {
      const rows = await db.select().from(hosts).where(eq(hosts.ownerOrgId, orgId));
      return rows.map(toAccountHost);
    },

    async register(orgId, registeredByUserId, request) {
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${hostEnvironmentLockKey(request.environmentId)}, 0))`,
          );
          const [existing] = await tx
            .select()
            .from(hosts)
            .where(and(eq(hosts.ownerOrgId, orgId), eq(hosts.environmentId, request.environmentId)))
            .limit(1);

          if (existing) {
            if (existing.ownerUserId !== registeredByUserId) {
              throw new EnvironmentAlreadyLinkedError();
            }
            const [updated] = await tx
              .update(hosts)
              .set({
                name: request.name,
                platform: request.platform,
                kind: request.kind,
                endpoints: [...request.endpoints],
                appVersion: request.appVersion ?? null,
                lastSeenAt: new Date(),
              })
              .where(eq(hosts.id, existing.id))
              .returning();
            if (!updated) throw new Error("failed to update host row");
            return { host: toAccountHost(updated), created: false };
          }

          const [inserted] = await tx
            .insert(hosts)
            .values({
              ownerOrgId: orgId,
              // Legacy audit stamp only. ownerUserId below is the authorization
              // owner for the additive account-host surface.
              registeredByUserId,
              ownerUserId: registeredByUserId,
              environmentId: request.environmentId,
              name: request.name,
              platform: request.platform,
              kind: request.kind,
              endpoints: [...request.endpoints],
              appVersion: request.appVersion ?? null,
            })
            .returning();
          if (!inserted) throw new Error("failed to insert host row");
          return { host: toAccountHost(inserted), created: true };
        });
      } catch (error) {
        // The unique index over (owner_org_id, environment_id) is the
        // reservation; a violation means a concurrent registration won.
        if (isUniqueViolation(error)) throw new EnvironmentAlreadyLinkedError();
        throw error;
      }
    },

    async update(hostId, request) {
      const [row] = await db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1);
      if (!row) return undefined;

      const [updated] = await db
        .update(hosts)
        .set({
          ...(request.name !== undefined ? { name: request.name } : {}),
          ...(request.endpoints !== undefined ? { endpoints: [...request.endpoints] } : {}),
          ...(request.appVersion !== undefined ? { appVersion: request.appVersion } : {}),
          lastSeenAt: new Date(),
        })
        .where(eq(hosts.id, hostId))
        .returning();
      return updated ? toAccountHost(updated) : undefined;
    },

    async deleteForOrg(hostId, orgId) {
      const deleted = await db
        .delete(hosts)
        .where(and(eq(hosts.id, hostId), eq(hosts.ownerOrgId, orgId)))
        .returning();
      return deleted.length > 0;
    },

    async deleteById(hostId) {
      await db.delete(hosts).where(eq(hosts.id, hostId));
    },
  };
}
