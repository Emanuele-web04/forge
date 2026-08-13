import {
  DEVICE_REGISTER_JWT_TYP,
  DEVICE_REGISTER_MAX_AGE_SECONDS,
  DeviceRegisterClaims,
  SYNARA_DEVICE_ISSUER,
  type AccountDevice,
} from "@synara/contracts";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Schema } from "effect";
import { decodeJwt } from "jose";
import type * as schema from "../db/schema";
import { devices, hosts } from "../db/schema";
import { isUniqueViolation } from "./environmentRegistry";
import { HostAuthDomainError, type DeviceRegistry } from "./interfaces";
import { publicJwkThumbprint, verifyJwtWithEmbeddedJwk } from "./signing";
import { writeRevocationEvents } from "./revocationLog";

type DeviceRow = typeof devices.$inferSelect;

function toAccountDevice(row: DeviceRow): AccountDevice {
  return {
    id: row.id,
    publicKeyJwk: row.publicKeyJwk,
    jkt: row.jkt,
    displayName: row.displayName,
    platform: row.platform,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export function createDeviceRegistry(
  db: NodePgDatabase<typeof schema>,
  apiIssuer: string,
): DeviceRegistry {
  return {
    async register(userId, proof) {
      let claims: typeof DeviceRegisterClaims.Type;
      let jkt: string;
      try {
        claims = Schema.decodeUnknownSync(DeviceRegisterClaims)(decodeJwt(proof));
        if (claims.sub !== userId || claims.iss !== SYNARA_DEVICE_ISSUER) {
          throw new Error("Device proof identity does not match the session");
        }
        await verifyJwtWithEmbeddedJwk(proof, {
          typ: DEVICE_REGISTER_JWT_TYP,
          audience: apiIssuer,
          issuer: SYNARA_DEVICE_ISSUER,
          algorithms: ["ES256", "EdDSA"],
          maxAgeSeconds: DEVICE_REGISTER_MAX_AGE_SECONDS,
          publicKeyJwk: claims.publicKeyJwk,
        });
        jkt = await publicJwkThumbprint(claims.publicKeyJwk);
      } catch {
        throw new HostAuthDomainError(401, "bad_proof", "Device proof is invalid");
      }

      const upsert = async (): Promise<DeviceRow> => {
        const [active] = await db
          .select()
          .from(devices)
          .where(and(eq(devices.userId, userId), eq(devices.jkt, jkt), isNull(devices.revokedAt)))
          .limit(1);
        if (active) {
          const [updated] = await db
            .update(devices)
            .set({
              publicKeyJwk: claims.publicKeyJwk,
              displayName: claims.displayName,
              platform: claims.platform,
            })
            .where(and(eq(devices.id, active.id), isNull(devices.revokedAt)))
            .returning();
          if (updated) return updated;
          // It was revoked after the select. Fall through and create the new
          // active row promised by the re-registration contract.
        }
        const [inserted] = await db
          .insert(devices)
          .values({
            userId,
            publicKeyJwk: claims.publicKeyJwk,
            jkt,
            displayName: claims.displayName,
            platform: claims.platform,
          })
          .returning();
        if (!inserted) throw new Error("Device insert returned no row");
        return inserted;
      };

      try {
        return toAccountDevice(await upsert());
      } catch (error) {
        // Concurrent first registration: the active partial unique index is
        // the reservation. Retry as the upsert's update branch.
        if (isUniqueViolation(error)) return toAccountDevice(await upsert());
        throw error;
      }
    },

    async list(userId) {
      return (await db.select().from(devices).where(eq(devices.userId, userId))).map(
        toAccountDevice,
      );
    },

    async revoke(userId, deviceId, affectedOrgIds) {
      const row = await db.transaction(async (tx) => {
        const [revoked] = await tx
          .update(devices)
          .set({ revokedAt: new Date() })
          .where(
            and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)),
          )
          .returning();
        if (!revoked) return undefined;
        const uniqueOrgIds = [...new Set(affectedOrgIds)];
        const affectedHosts =
          uniqueOrgIds.length > 0
            ? await tx
                .select({ id: hosts.id })
                .from(hosts)
                .where(inArray(hosts.ownerOrgId, uniqueOrgIds))
            : [];
        if (affectedHosts.length > 0) {
          await writeRevocationEvents(
            tx,
            affectedHosts.map((host) => ({
              hostId: host.id,
              kind: "device_revoked" as const,
              subject: revoked.jkt,
            })),
          );
        }
        return revoked;
      });
      return row ? toAccountDevice(row) : undefined;
    },
  };
}
