import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { hostTokens } from "../db/schema";
import { HOST_TOKEN_PREFIX, hashHostToken } from "../hostTokens";

export type HostAuthResult =
  | { ok: true; hostId: string }
  | { ok: false; status: 401; error: "unauthorized" }
  | { ok: false; status: 403; error: "token_revoked" };

export function extractBearerToken(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

/** Resolves a `synhost_...` bearer token to its owning host, or a typed failure. */
export async function authenticateHostToken(
  db: NodePgDatabase<typeof schema>,
  authorizationHeader: string | undefined | null,
): Promise<HostAuthResult> {
  const token = extractBearerToken(authorizationHeader);
  if (!token || !token.startsWith(HOST_TOKEN_PREFIX)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const hash = hashHostToken(token);
  const [row] = await db.select().from(hostTokens).where(eq(hostTokens.tokenHash, hash)).limit(1);
  if (!row) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  if (row.revokedAt) {
    return { ok: false, status: 403, error: "token_revoked" };
  }

  // Fire-and-forget; a failed last-used bump must never block the request.
  db.update(hostTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(hostTokens.id, row.id))
    .then(
      () => {},
      () => {},
    );

  return { ok: true, hostId: row.hostId };
}

export function isHostTokenHeader(header: string | undefined | null): boolean {
  const token = extractBearerToken(header);
  return Boolean(token?.startsWith(HOST_TOKEN_PREFIX));
}
