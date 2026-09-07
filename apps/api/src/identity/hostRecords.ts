import type { AccountHost, EnvironmentId } from "@synara/contracts";

import { hosts } from "../db/schema";

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
    ownerUserId: row.ownerUserId,
    discoverable: row.discoverable,
    linked: row.publicKeyJwk !== null,
    keyGeneration: row.keyGeneration,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

/** Drizzle wraps PostgreSQL errors, so inspect the complete cause chain. */
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
