// FILE: identity/deviceCredentialStore.ts
// Purpose: The Postgres-backed DeviceCredentialStore — mints, verifies, and
// revokes the `synhost_` host tokens machines authenticate their own record
// updates with. Provider-independent: the same store serves every identity
// provider, because host credentials are Synara's, not the provider's.
// Layer: API identity (implementation)
// Depends on: node:crypto, db/schema (host_tokens).

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { hostTokens } from "../db/schema";
import type { DeviceCredentialAuthResult, DeviceCredentialStore } from "./interfaces";

export const HOST_TOKEN_PREFIX = "synhost_";

export function hashHostToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintHostToken(): { token: string; hash: string } {
  const token = `${HOST_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashHostToken(token) };
}

export function extractBearerToken(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

export function createDeviceCredentialStore(
  db: NodePgDatabase<typeof schema>,
): DeviceCredentialStore {
  return {
    async rotate(hostId) {
      // Revoke-then-mint in that order, so a crash between the two leaves the
      // host without a token (recoverable by re-registering) rather than with
      // two live ones.
      await db
        .update(hostTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(hostTokens.hostId, hostId), isNull(hostTokens.revokedAt)));
      const { token, hash } = mintHostToken();
      await db.insert(hostTokens).values({ hostId, tokenHash: hash });
      return token;
    },

    async authenticate(authorizationHeader): Promise<DeviceCredentialAuthResult> {
      const token = extractBearerToken(authorizationHeader);
      if (!token || !token.startsWith(HOST_TOKEN_PREFIX)) {
        return { ok: false, status: 401, error: "unauthorized" };
      }

      const hash = hashHostToken(token);
      const [row] = await db
        .select()
        .from(hostTokens)
        .where(eq(hostTokens.tokenHash, hash))
        .limit(1);
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
    },

    isDeviceCredential(authorizationHeader) {
      const token = extractBearerToken(authorizationHeader);
      return Boolean(token?.startsWith(HOST_TOKEN_PREFIX));
    },
  };
}
