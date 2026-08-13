import {
  DEVICE_USER_CODE_ALPHABET,
  HOST_LINK_JWT_TYP,
  HOST_LINK_MAX_AGE_SECONDS,
  HOST_PROOF_JWT_TYP,
  HOST_PROOF_MAX_AGE_SECONDS,
  HostLinkClaims,
  HostProofClaims,
  LinkedAccountHost,
  type LinkStartRequest,
} from "@synara/contracts";
import { and, eq, gt, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Schema } from "effect";
import { decodeJwt } from "jose";
import { createHash, randomBytes } from "node:crypto";
import type * as schema from "../db/schema";
import { hosts, linkChallenges } from "../db/schema";
import { isUniqueViolation, toAccountHost } from "./hostRecords";
import { hostEnvironmentLockKey } from "./environmentLock";
import { HostAuthDomainError, type HostKeyRegistry, type HostRecord } from "./interfaces";
import { verifyJwtWithEmbeddedJwk } from "./signing";
import { writeRevocationEvents } from "./revocationLog";

const LINK_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const USER_CODE_ALPHABET = DEVICE_USER_CODE_ALPHABET;

function nonce(): string {
  return randomBytes(32).toString("base64url");
}

function userCode(): string {
  const bytes = randomBytes(8);
  return [...bytes].map((value) => USER_CODE_ALPHABET[value & 31]).join("");
}

function deviceCodeHash(deviceCode: string): string {
  return createHash("sha256").update(deviceCode).digest("hex");
}

/**
 * Expired challenges are swept opportunistically, but rows that still carry
 * a device code are kept for a grace period: a polling CLI whose code just
 * expired must be told `challenge_expired`, and deleting the row would turn
 * that into a misleading `challenge_consumed`.
 */
const EXPIRED_CHALLENGE_GRACE_MS = 60 * 60 * 1000;
function expiredCleanupCutoff(): Date {
  return new Date(Date.now() - EXPIRED_CHALLENGE_GRACE_MS);
}

/** The one row→HostRecord projection, shared with the route layer. */
export function hostRecordFromRow(row: typeof hosts.$inferSelect): HostRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    environmentId: row.environmentId,
    publicKeyJwk: row.publicKeyJwk,
    keyGeneration: row.keyGeneration,
    discoverable: row.discoverable,
  };
}

type LinkFailure = { ok: false; error: HostAuthDomainError };
const failed = (error: HostAuthDomainError): LinkFailure => ({ ok: false, error });

/** Route-layer dispatch check; the parse itself lives in withAuthenticatedHost. */
export function isHostProofAuthorization(authorization: string | undefined | null): boolean {
  return HOST_PROOF_SCHEME.test(authorization ?? "");
}
const HOST_PROOF_SCHEME = /^HostProof\s+(.+)$/i;

type UnlinkScope =
  | { hostId: string }
  | { environmentId: string; ownerUserId: string; excludeHostId: string };

/**
 * The one unlink mutation: key cleared + discoverability off + generation
 * bump + host_unlinked event, atomically. Every unlink path must go through
 * here so a host can never end up half-unlinked.
 */
async function unlinkHostRows(
  tx: {
    update: NodePgDatabase<typeof schema>["update"];
    insert: NodePgDatabase<typeof schema>["insert"];
  },
  scope: UnlinkScope,
): Promise<(typeof hosts.$inferSelect)[]> {
  // Only a linked row is unlinkable: re-unlinking would bump key_generation
  // and emit another event for no state change.
  const where =
    "hostId" in scope
      ? and(eq(hosts.id, scope.hostId), isNotNull(hosts.publicKeyJwk))
      : and(
          eq(hosts.environmentId, scope.environmentId),
          eq(hosts.ownerUserId, scope.ownerUserId),
          ne(hosts.id, scope.excludeHostId),
          isNotNull(hosts.publicKeyJwk),
        );
  const unlinked = await tx
    .update(hosts)
    .set({
      publicKeyJwk: null,
      discoverable: false,
      keyGeneration: sql`${hosts.keyGeneration} + 1`,
    })
    .where(where)
    .returning();
  if (unlinked.length > 0) {
    await writeRevocationEvents(
      tx,
      unlinked.map((host) => ({ hostId: host.id, kind: "host_unlinked" as const })),
    );
  }
  return unlinked;
}

export function createHostKeyRegistry(
  db: NodePgDatabase<typeof schema>,
  apiIssuer: string,
): HostKeyRegistry {
  type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

  async function withAuthenticatedHost<T>(
    authorization: string | undefined | null,
    expectedHostId: string,
    action: (tx: Transaction, row: typeof hosts.$inferSelect, host: HostRecord) => Promise<T>,
  ): Promise<T> {
    const match = authorization ? /^HostProof\s+(.+)$/i.exec(authorization) : null;
    const proof = match?.[1];
    if (!proof) throw new HostAuthDomainError(401, "unauthorized", "Host proof required");
    let claims: typeof HostProofClaims.Type;
    try {
      claims = Schema.decodeUnknownSync(HostProofClaims)(decodeJwt(proof));
    } catch {
      throw new HostAuthDomainError(401, "bad_proof", "Host proof is invalid");
    }
    if (claims.sub !== expectedHostId) {
      throw new HostAuthDomainError(401, "unauthorized", "Host proof does not match this host");
    }
    return db.transaction(async (tx) => {
      // The lock is held through the protected action. A relink/unlink cannot
      // land after proof verification but before the effect or signed ticket.
      const [row] = await tx
        .select()
        .from(hosts)
        .where(eq(hosts.id, claims.sub))
        .limit(1)
        .for("update");
      if (!row?.publicKeyJwk) {
        throw new HostAuthDomainError(401, "host_not_linked", "Host is not linked");
      }
      try {
        await verifyJwtWithEmbeddedJwk(proof, {
          typ: HOST_PROOF_JWT_TYP,
          audience: apiIssuer,
          issuer: `synara-host:${row.environmentId}`,
          algorithms: ["EdDSA"],
          maxAgeSeconds: HOST_PROOF_MAX_AGE_SECONDS,
          publicKeyJwk: row.publicKeyJwk,
        });
      } catch {
        throw new HostAuthDomainError(401, "bad_proof", "Host proof is invalid");
      }
      if (claims.keyGeneration !== row.keyGeneration) {
        throw new HostAuthDomainError(401, "bad_proof", "Host proof key generation is stale");
      }
      // Fleet hosts poll proof-authed routes constantly; rewriting the row
      // each time is pure MVCC churn. One-minute granularity is plenty for a
      // historical-metadata column, and actions that update the row anyway
      // (replaceEndpoints) carry their own fresh lastSeenAt.
      await tx
        .update(hosts)
        .set({ lastSeenAt: new Date() })
        .where(and(eq(hosts.id, row.id), lt(hosts.lastSeenAt, new Date(Date.now() - 60_000))));
      return action(tx, row, hostRecordFromRow(row));
    });
  }

  return {
    async startLink(owner, request) {
      const expiresAt = new Date(Date.now() + LINK_CHALLENGE_TTL_MS);
      // Opportunistic expiry cleanup runs before the transaction so a backlog
      // sweep never extends the advisory-lock hold below.
      await db
        .delete(linkChallenges)
        .where(
          or(
            and(lt(linkChallenges.expiresAt, new Date()), isNull(linkChallenges.deviceCodeHash)),
            lt(linkChallenges.expiresAt, expiredCleanupCutoff()),
          ),
        );
      return db.transaction(async (tx) => {
        let hostId: string | undefined;
        if (request.environmentId) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${hostEnvironmentLockKey(request.environmentId)}, 0))`,
          );
          const [existing] = await tx
            .select()
            .from(hosts)
            .where(
              and(
                eq(hosts.ownerOrgId, owner.orgId),
                eq(hosts.environmentId, request.environmentId),
              ),
            )
            .limit(1);
          if (existing) {
            if (existing.ownerUserId !== owner.userId) {
              throw new HostAuthDomainError(
                409,
                "environment_already_linked",
                "This environment belongs to another user",
              );
            }
            hostId = existing.id;
          } else {
            if (
              request.name === undefined ||
              request.platform === undefined ||
              request.kind === undefined
            ) {
              throw new HostAuthDomainError(
                400,
                "validation_failed",
                "name, platform, and kind are required when creating a host row",
              );
            }
            const [inserted] = await tx
              .insert(hosts)
              .values({
                ownerUserId: owner.userId,
                ownerOrgId: owner.orgId,
                environmentId: request.environmentId,
                name: request.name,
                platform: request.platform,
                kind: request.kind,
                endpoints: [],
                discoverable: true,
                publicKeyJwk: null,
                keyGeneration: 0,
              })
              .returning({ id: hosts.id });
            if (!inserted) throw new Error("Host insert returned no row");
            hostId = inserted.id;
          }
        }

        const [challenge] = await tx
          .insert(linkChallenges)
          .values({
            nonce: nonce(),
            ownerUserId: owner.userId,
            ownerOrgId: owner.orgId,
            hostId: hostId ?? null,
            environmentId: request.environmentId ?? null,
            expiresAt,
          })
          .returning();
        if (!challenge) throw new Error("Challenge insert returned no row");
        return {
          challengeId: challenge.id,
          nonce: challenge.nonce,
          ...(hostId ? { hostId } : {}),
          expiresAt: challenge.expiresAt.toISOString(),
        };
      });
    },

    async completeLink(request) {
      const outcome = await db.transaction(async (tx) => {
        const now = new Date();
        const [challenge] = await tx
          .update(linkChallenges)
          .set({ consumedAt: now })
          .where(
            and(
              eq(linkChallenges.id, request.challengeId),
              isNull(linkChallenges.consumedAt),
              gt(linkChallenges.expiresAt, now),
            ),
          )
          .returning();
        if (!challenge) {
          const [existing] = await tx
            .select()
            .from(linkChallenges)
            .where(eq(linkChallenges.id, request.challengeId))
            .limit(1);
          return failed(
            existing?.consumedAt
              ? new HostAuthDomainError(409, "challenge_consumed", "Challenge was already used")
              : new HostAuthDomainError(400, "challenge_expired", "Challenge expired"),
          );
        }

        let claims: typeof HostLinkClaims.Type;
        try {
          claims = Schema.decodeUnknownSync(HostLinkClaims)(decodeJwt(request.proof));
          await verifyJwtWithEmbeddedJwk(request.proof, {
            typ: HOST_LINK_JWT_TYP,
            audience: apiIssuer,
            issuer: `synara-host:${claims.sub}`,
            algorithms: ["EdDSA"],
            maxAgeSeconds: HOST_LINK_MAX_AGE_SECONDS,
            publicKeyJwk: claims.publicKeyJwk,
          });
        } catch {
          return failed(new HostAuthDomainError(401, "bad_proof", "Host link proof is invalid"));
        }
        if (claims.challengeId !== request.challengeId || claims.nonce !== challenge.nonce) {
          return failed(
            new HostAuthDomainError(401, "bad_proof", "Host link proof does not match challenge"),
          );
        }
        if (
          !challenge.ownerUserId ||
          !challenge.ownerOrgId ||
          (!challenge.approvedAt && challenge.deviceCodeHash !== null)
        ) {
          return failed(
            new HostAuthDomainError(428, "approval_pending", "Device link is not approved"),
          );
        }
        const environmentId = challenge.environmentId ?? claims.sub;
        if (challenge.environmentId && challenge.environmentId !== claims.sub) {
          return failed(
            new HostAuthDomainError(401, "bad_proof", "Host environment does not match challenge"),
          );
        }

        await tx.execute(
          // Linking is globally exclusive per machine identity, not merely
          // per organization. Otherwise two cross-org completes can both
          // observe the other's placeholder as unlinked and leave two live
          // keys, violating the one-account-at-a-time invariant.
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${hostEnvironmentLockKey(environmentId)}, 0))`,
        );
        let target = challenge.hostId
          ? (await tx.select().from(hosts).where(eq(hosts.id, challenge.hostId)).limit(1))[0]
          : undefined;
        // The bound placeholder may have been deleted after start. Resolve
        // the unique org/environment slot again before deciding to insert.
        target ??= (
          await tx
            .select()
            .from(hosts)
            .where(
              and(
                eq(hosts.ownerOrgId, challenge.ownerOrgId),
                eq(hosts.environmentId, environmentId),
              ),
            )
            .limit(1)
        )[0];
        if (target && target.ownerUserId !== challenge.ownerUserId) {
          return failed(
            new HostAuthDomainError(
              409,
              "environment_already_linked",
              "This environment belongs to another user",
            ),
          );
        }
        if (!target) {
          const [inserted] = await tx
            .insert(hosts)
            .values({
              ownerUserId: challenge.ownerUserId,
              ownerOrgId: challenge.ownerOrgId,
              environmentId,
              name: claims.name,
              platform: claims.platform,
              kind: "local",
              endpoints: [],
              discoverable: true,
              keyGeneration: 0,
            })
            .returning();
          target = inserted;
        }
        if (!target) throw new Error("Host resolution returned no row");

        // The one-machine-one-slot sweep is scoped to rows the SAME user
        // owns. The environment id is self-asserted by the proof, so a
        // cross-user sweep would let anyone who learns a visible
        // environmentId force-unlink another user's host from an unrelated
        // org. A machine re-linked under a different account leaves the old
        // owner's row holding a key the machine no longer has — functionally
        // dead, removed by the old owner via unlink/delete.
        await unlinkHostRows(tx, {
          environmentId,
          ownerUserId: challenge.ownerUserId,
          excludeHostId: target.id,
        });

        const [linked] = await tx
          .update(hosts)
          .set({
            publicKeyJwk: claims.publicKeyJwk,
            keyGeneration: sql`GREATEST(${hosts.keyGeneration}, 0) + 1`,
            name: claims.name,
            platform: claims.platform,
            appVersion: claims.appVersion ?? null,
            lastSeenAt: now,
          })
          .where(eq(hosts.id, target.id))
          .returning();
        if (!linked) throw new Error("Host link update returned no row");
        return {
          ok: true as const,
          response: {
            host: Schema.decodeUnknownSync(LinkedAccountHost)(toAccountHost(linked)),
          },
        };
      });
      if (!outcome.ok) throw outcome.error;
      return outcome.response;
    },

    async startDeviceLink(verificationUri) {
      await db
        .delete(linkChallenges)
        .where(
          or(
            and(lt(linkChallenges.expiresAt, new Date()), isNull(linkChallenges.deviceCodeHash)),
            lt(linkChallenges.expiresAt, expiredCleanupCutoff()),
          ),
        );
      const expiresAt = new Date(Date.now() + LINK_CHALLENGE_TTL_MS);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const credential = randomBytes(32).toString("base64url");
        try {
          const [challenge] = await db
            .insert(linkChallenges)
            .values({
              nonce: nonce(),
              deviceCodeHash: deviceCodeHash(credential),
              userCode: userCode(),
              expiresAt,
            })
            .returning();
          if (!challenge?.userCode) throw new Error("Device challenge insert returned no code");
          return {
            deviceCode: credential,
            userCode: challenge.userCode,
            verificationUri,
            expiresAt: challenge.expiresAt.toISOString(),
            interval: 5 as const,
          };
        } catch (error) {
          if (!isUniqueViolation(error) || attempt === 4) throw error;
        }
      }
      throw new Error("Could not reserve a device code");
    },

    async approveDeviceLink(owner, code) {
      const now = new Date();
      const [approved] = await db
        .update(linkChallenges)
        .set({ ownerUserId: owner.userId, ownerOrgId: owner.orgId, approvedAt: now })
        .where(
          and(
            eq(linkChallenges.userCode, code),
            gt(linkChallenges.expiresAt, now),
            isNull(linkChallenges.approvedAt),
            isNull(linkChallenges.consumedAt),
          ),
        )
        .returning();
      if (!approved)
        throw new HostAuthDomainError(400, "challenge_expired", "Code is invalid or expired");
    },

    async exchangeDeviceCode(deviceCode) {
      const hash = deviceCodeHash(deviceCode);
      const now = new Date();
      const [challenge] = await db
        .update(linkChallenges)
        .set({ deviceCodeHash: null })
        .where(
          and(
            eq(linkChallenges.deviceCodeHash, hash),
            gt(linkChallenges.expiresAt, now),
            isNotNull(linkChallenges.approvedAt),
            isNull(linkChallenges.consumedAt),
          ),
        )
        .returning();
      if (challenge) return { challengeId: challenge.id, nonce: challenge.nonce };
      const [pending] = await db
        .select()
        .from(linkChallenges)
        .where(eq(linkChallenges.deviceCodeHash, hash))
        .limit(1);
      if (pending && pending.expiresAt > now && !pending.approvedAt) {
        throw new HostAuthDomainError(428, "approval_pending", "Device link approval is pending");
      }
      throw new HostAuthDomainError(
        pending ? 400 : 409,
        pending ? "challenge_expired" : "challenge_consumed",
        pending ? "Device code expired" : "Device code was already exchanged",
      );
    },

    withAuthenticatedHost(authorization, expectedHostId, action) {
      return withAuthenticatedHost(authorization, expectedHostId, async (_tx, _row, host) =>
        action(host),
      );
    },

    replaceEndpoints(authorization, hostId, endpoints) {
      return withAuthenticatedHost(authorization, hostId, async (tx) => {
        const [row] = await tx
          .update(hosts)
          .set({ endpoints: [...endpoints], lastSeenAt: new Date() })
          .where(eq(hosts.id, hostId))
          .returning();
        if (!row) throw new HostAuthDomainError(404, "host_not_found", "Host not found");
        return toAccountHost(row);
      });
    },

    async unlink(hostId) {
      const row = await db.transaction(async (tx) => {
        const [unlinked] = await unlinkHostRows(tx, { hostId });
        if (unlinked) return unlinked;
        // No row updated means either the host is gone or it was already
        // unlinked. Unlinking is idempotent: report the settled state rather
        // than a spurious 404 or a second revocation event.
        const [existing] = await tx.select().from(hosts).where(eq(hosts.id, hostId)).limit(1);
        return existing;
      });
      if (!row) throw new HostAuthDomainError(404, "host_not_found", "Host not found");
      return toAccountHost(row);
    },

    unlinkWithProof(authorization, hostId) {
      // withAuthenticatedHost already refuses unlinked hosts, so a proof-
      // authenticated caller always finds a linked row to unlink.
      return withAuthenticatedHost(authorization, hostId, async (tx) => {
        const [updated] = await unlinkHostRows(tx, { hostId });
        if (!updated) throw new HostAuthDomainError(404, "host_not_found", "Host not found");
        return toAccountHost(updated);
      });
    },
  };
}
