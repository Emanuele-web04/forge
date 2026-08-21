import type { AuthPairingLink } from "@synara/contracts";
import * as Crypto from "node:crypto";
import { DateTime, Duration, Effect, Layer, Option, PubSub, Ref, Stream } from "effect";

import { AuthPairingLinkRepositoryLive } from "../../persistence/Layers/AuthPairingLinks";
import { AuthPairingLinkRepository } from "../../persistence/Services/AuthPairingLinks";
import {
  BootstrapCredentialError,
  BootstrapCredentialService,
  type BootstrapCredentialChange,
  type BootstrapCredentialServiceShape,
  type BootstrapGrant,
  type IssuedBootstrapCredential,
} from "../Services/BootstrapCredentialService";

interface StoredBootstrapGrant extends BootstrapGrant {
  readonly remainingUses: number | "unbounded";
}

const DEFAULT_ONE_TIME_TOKEN_TTL = Duration.minutes(5);
/** Owner startup links have to survive opening the URL on another device. */
export const OWNER_STARTUP_PAIRING_TTL = Duration.hours(24);
const PAIRING_TOKEN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_TOKEN_LENGTH = 12;

const generatePairingToken = (): string => {
  const randomBytes = Crypto.randomBytes(PAIRING_TOKEN_LENGTH);
  return Array.from(randomBytes, (value) => PAIRING_TOKEN_ALPHABET[value & 31]).join("");
};

const toBootstrapCredentialError = (message: string, status: 401 | 500, cause?: unknown) =>
  new BootstrapCredentialError({
    message,
    status,
    ...(cause === undefined ? {} : { cause }),
  });

const OWNER_BOOTSTRAP_SUBJECT = "owner-bootstrap";

const grantFromPairingRow = (row: {
  readonly method: "desktop-bootstrap" | "one-time-token";
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label: string | null;
  readonly expiresAt: DateTime.Utc;
}): BootstrapGrant => ({
  method: row.method,
  role: row.role,
  subject: row.subject,
  ...(row.label ? { label: row.label } : {}),
  expiresAt: row.expiresAt,
});

const isReusableOwnerBootstrap = (row: {
  readonly role: "owner" | "client";
  readonly subject: string;
}): boolean => row.role === "owner" && row.subject === OWNER_BOOTSTRAP_SUBJECT;

const toPairingLink = (row: {
  readonly id: string;
  readonly credential: string;
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label: string | null;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}): AuthPairingLink => ({
  id: row.id,
  credential: row.credential,
  role: row.role,
  subject: row.subject,
  ...(row.label ? { label: row.label } : {}),
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
});

export const makeBootstrapCredentialService = Effect.gen(function* () {
  const pairingLinks = yield* AuthPairingLinkRepository;
  const seededGrantsRef = yield* Ref.make(new Map<string, StoredBootstrapGrant>());
  const changesPubSub = yield* PubSub.unbounded<BootstrapCredentialChange>();

  const emitUpsert = (pairingLink: AuthPairingLink) =>
    PubSub.publish(changesPubSub, {
      type: "pairingLinkUpserted",
      pairingLink,
    }).pipe(Effect.asVoid);

  const emitRemoved = (id: string) =>
    PubSub.publish(changesPubSub, {
      type: "pairingLinkRemoved",
      id,
    }).pipe(Effect.asVoid);

  const listActive: BootstrapCredentialServiceShape["listActive"] = () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const rows = yield* pairingLinks.listActive({ now });
      return rows.map(toPairingLink);
    }).pipe(
      Effect.mapError((cause) =>
        toBootstrapCredentialError("Failed to load active pairing links.", 500, cause),
      ),
    );

  const revoke: BootstrapCredentialServiceShape["revoke"] = (id) =>
    Effect.gen(function* () {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* pairingLinks.revoke({ id, revokedAt });
      if (revoked) yield* emitRemoved(id);
      return revoked;
    }).pipe(
      Effect.mapError((cause) =>
        toBootstrapCredentialError("Failed to revoke pairing link.", 500, cause),
      ),
    );

  const issueOneTimeToken: BootstrapCredentialServiceShape["issueOneTimeToken"] = (input) =>
    Effect.gen(function* () {
      const id = Crypto.randomUUID();
      const credential = generatePairingToken();
      const now = yield* DateTime.now;
      const ttl = input?.ttl ?? DEFAULT_ONE_TIME_TOKEN_TTL;
      const expiresAt = DateTime.addDuration(now, ttl);
      const role = input?.role ?? "client";
      const subject = input?.subject ?? "one-time-token";
      const label = input?.label;

      yield* pairingLinks.create({
        id,
        credential,
        method: "one-time-token",
        role,
        subject,
        label: label ?? null,
        createdAt: now,
        expiresAt,
      });

      const pairingLink = toPairingLink({
        id,
        credential,
        role,
        subject,
        label: label ?? null,
        createdAt: now,
        expiresAt,
      });
      yield* emitUpsert(pairingLink);

      return {
        id,
        credential,
        ...(label ? { label } : {}),
        expiresAt,
      } satisfies IssuedBootstrapCredential;
    }).pipe(
      Effect.mapError((cause) =>
        toBootstrapCredentialError("Failed to issue pairing credential.", 500, cause),
      ),
    );

  const consumeSeededGrant = (
    credential: string,
    now: DateTime.Utc,
  ): Effect.Effect<StoredBootstrapGrant | "expired" | null> =>
    Ref.modify<Map<string, StoredBootstrapGrant>, StoredBootstrapGrant | "expired" | null>(
      seededGrantsRef,
      (current) => {
        const grant = current.get(credential);
        if (!grant) return [null, current] as const;

        const next = new Map(current);
        if (DateTime.isGreaterThanOrEqualTo(now, grant.expiresAt)) {
          next.delete(credential);
          return ["expired", next] as const;
        }

        if (typeof grant.remainingUses === "number") {
          if (grant.remainingUses <= 1) {
            next.delete(credential);
          } else {
            next.set(credential, { ...grant, remainingUses: grant.remainingUses - 1 });
          }
        }

        return [grant, next] as const;
      },
    );

  const resolvePairingGrant = (
    credential: string,
    options: { readonly consumeOneTime: boolean },
  ): Effect.Effect<BootstrapGrant, BootstrapCredentialError> =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;

      if (options.consumeOneTime) {
        const seeded = yield* consumeSeededGrant(credential, now);
        if (seeded === "expired") {
          return yield* toBootstrapCredentialError("Bootstrap credential expired.", 401);
        }
        if (seeded) {
          return {
            method: seeded.method,
            role: seeded.role,
            subject: seeded.subject,
            ...(seeded.label ? { label: seeded.label } : {}),
            expiresAt: seeded.expiresAt,
          } satisfies BootstrapGrant;
        }
      } else {
        const seededMap = yield* Ref.get(seededGrantsRef);
        const seeded = seededMap.get(credential);
        if (seeded) {
          if (DateTime.isGreaterThanOrEqualTo(now, seeded.expiresAt)) {
            return yield* toBootstrapCredentialError("Bootstrap credential expired.", 401);
          }
          return {
            method: seeded.method,
            role: seeded.role,
            subject: seeded.subject,
            ...(seeded.label ? { label: seeded.label } : {}),
            expiresAt: seeded.expiresAt,
          } satisfies BootstrapGrant;
        }
      }

      const matching = yield* pairingLinks.getByCredential({ credential });
      if (Option.isNone(matching)) {
        return yield* toBootstrapCredentialError("Unknown bootstrap credential.", 401);
      }
      const row = matching.value;
      if (row.revokedAt !== null) {
        return yield* toBootstrapCredentialError(
          "Bootstrap credential is no longer available.",
          401,
        );
      }
      if (DateTime.isGreaterThanOrEqualTo(now, row.expiresAt)) {
        return yield* toBootstrapCredentialError("Bootstrap credential expired.", 401);
      }

      // Owner startup links are reusable for 24h so link previews / first opens
      // cannot burn the only chance to pair a phone.
      if (isReusableOwnerBootstrap(row)) {
        return grantFromPairingRow(row);
      }

      if (row.consumedAt !== null) {
        return yield* toBootstrapCredentialError(
          "Bootstrap credential is no longer available.",
          401,
        );
      }

      if (!options.consumeOneTime) {
        return grantFromPairingRow(row);
      }

      const consumed = yield* pairingLinks.consumeAvailable({
        credential,
        consumedAt: now,
        now,
      });

      if (Option.isSome(consumed)) {
        yield* emitRemoved(consumed.value.id);
        return grantFromPairingRow(consumed.value);
      }

      return yield* toBootstrapCredentialError("Bootstrap credential is no longer available.", 401);
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof BootstrapCredentialError
          ? cause
          : toBootstrapCredentialError("Failed to validate bootstrap credential.", 500, cause),
      ),
    );

  const peek: BootstrapCredentialServiceShape["peek"] = (credential) =>
    resolvePairingGrant(credential, { consumeOneTime: false });

  const consume: BootstrapCredentialServiceShape["consume"] = (credential) =>
    resolvePairingGrant(credential, { consumeOneTime: true });

  return {
    issueOneTimeToken,
    listActive,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    peek,
    consume,
  } satisfies BootstrapCredentialServiceShape;
});

export const BootstrapCredentialServiceLive = Layer.effect(
  BootstrapCredentialService,
  makeBootstrapCredentialService,
).pipe(Layer.provideMerge(AuthPairingLinkRepositoryLive));
