import type { DevicePublicKeyJwk, HostPublicKeyJwk } from "@synara/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type HostEndpoint = { url: string; transport: "lan" | "tailscale" };

export const hosts = pgTable(
  "hosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // WorkOS organization id. Owner-or-discoverable authorization combines
    // this membership scope with ownerUserId below.
    // Identity and membership live in WorkOS, so there is no local table to
    // reference; orphaned rows are tolerated until WorkOS webhook cleanup is
    // built (future work).
    ownerOrgId: text("owner_org_id").notNull(),
    // The user who owns and authorizes access to this host.
    ownerUserId: text("owner_user_id").notNull(),
    environmentId: text("environment_id").notNull(),
    name: text("name").notNull(),
    platform: text("platform", { enum: ["darwin", "linux", "windows"] }).notNull(),
    kind: text("kind", { enum: ["local", "ssh-managed"] }).notNull(),
    endpoints: jsonb("endpoints").$type<HostEndpoint[]>().notNull().default([]),
    appVersion: text("app_version"),
    discoverable: boolean("discoverable").notNull().default(true),
    publicKeyJwk: jsonb("public_key_jwk").$type<HostPublicKeyJwk>(),
    keyGeneration: integer("key_generation").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("hosts_owner_org_environment_unique").on(table.ownerOrgId, table.environmentId),
    index("hosts_owner_user_idx").on(table.ownerUserId),
    // completeLink sweeps same-environment rows by (environment_id,
    // owner_user_id); without this the sweep seq-scans hosts inside the
    // linking critical section.
    index("hosts_environment_idx").on(table.environmentId),
  ],
);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    publicKeyJwk: jsonb("public_key_jwk").$type<DevicePublicKeyJwk>().notNull(),
    jkt: text("jkt").notNull(),
    displayName: text("display_name").notNull(),
    platform: text("platform", {
      enum: ["darwin", "ios", "linux", "windows", "web"],
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("devices_user_jkt_active_unique")
      .on(table.userId, table.jkt)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const linkChallenges = pgTable(
  "link_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nonce: text("nonce").notNull(),
    ownerUserId: text("owner_user_id"),
    ownerOrgId: text("owner_org_id"),
    // Deliberately no FK. Complete consumes challenge -> host, while host
    // deletion otherwise locks host -> challenge for ON DELETE SET NULL and
    // the inverse order can deadlock. A missing host is resolved explicitly.
    hostId: uuid("host_id"),
    environmentId: text("environment_id"),
    deviceCodeHash: text("device_code_hash"),
    userCode: text("user_code"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("link_challenges_device_code_hash_unique").on(table.deviceCodeHash),
    // Expired challenges are deleted before issuance. This unique index then
    // reserves every code still present, which is at least as strict as
    // uniqueness among unexpired rows without relying on volatile now() in
    // a Postgres partial-index predicate.
    uniqueIndex("link_challenges_user_code_unique").on(table.userCode),
    index("link_challenges_expires_at_idx").on(table.expiresAt),
  ],
);

export const revocationEvents = pgTable(
  "revocation_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Deliberately no foreign key: unlink/delete events must outlive the host.
    hostId: uuid("host_id").notNull(),
    kind: text("kind", {
      enum: ["discoverability_off", "org_departure", "device_revoked", "host_unlinked"],
    }).notNull(),
    subject: text("subject"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("revocation_events_created_at_idx").on(table.createdAt)],
);

/**
 * The part of a user's identity Synara owns. Keyed by WorkOS user id because
 * WorkOS is the authority on who someone is — this table only holds what
 * WorkOS has no opinion about. A row existing is what "onboarding completed"
 * means; there is deliberately no separate flag to drift from it.
 *
 * There is no foreign key to a users table for the same reason `hosts` has
 * none: identity lives in WorkOS, so orphaned rows are tolerated until webhook
 * cleanup exists (future work).
 */
export const profiles = pgTable("profiles", {
  userId: text("user_id").primaryKey(),
  // Lowercase by contract: the schema pattern rejects any non-lowercase
  // handle at decode, so the unique index over the stored value only ever
  // sees folded spellings — which is what makes the reservation real rather
  // than one that "Dylan" and "dylan" could both pass.
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarColor: text("avatar_color").notNull(),
  // Opt-in, default private: a profile is served at trysynara.com/@handle
  // exactly when its owner flipped this on.
  public: boolean("public").notNull().default(false),
  // The owner's UTC offset at last profile save, so public day/hour
  // bucketing shows the owner's rhythm rather than the viewer's clock.
  utcOffsetMinutes: integer("utc_offset_minutes").notNull().default(0),
  // Where the avatar comes from. 'sso' mirrors the identity provider's
  // picture, 'uploaded' serves the object behind avatar_key, 'placeholder'
  // shows no image at all (the client renders initials on avatar_color).
  // 'uploaded' is only ever written by the upload route — PUT /profile may
  // not claim it, or a caller could point at a key no upload created.
  avatarSource: text("avatar_source", { enum: ["sso", "uploaded", "placeholder"] })
    .notNull()
    .default("sso"),
  // Object key of the uploaded avatar in S3-compatible storage, or NULL when
  // nothing was uploaded. Content-addressed (hash of the bytes), so replacing
  // an avatar writes a new key and best-effort deletes this one.
  avatarKey: text("avatar_key"),
  // Write-behind cache of the identity provider's avatar URL, refreshed on
  // /me whenever it drifts. Exists so the PUBLIC profile route can serve an
  // 'sso' avatar without ever calling the identity provider — the public
  // read must stay provider-free.
  avatarSsoUrl: text("avatar_sso_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-minute model-attributed usage counters — the account-side mirror of the
 * local profile stats, at the same depth (provider, model, reasoning) and
 * with NO content: a row is a key plus counters, never a trace.
 *
 * Rows hold ABSOLUTE values and are upserted, not incremented: one
 * environment is the only writer of its own minute-buckets and re-pushes a
 * bucket as it grows, so `ON CONFLICT DO UPDATE` makes retries and
 * mid-minute re-pushes idempotent where increments would double-count.
 *
 * `reasoning` is part of the key, so "no reasoning" is stored as the empty
 * string rather than NULL — Postgres unique indexes treat NULLs as
 * distinct, which would let duplicate no-reasoning buckets accumulate. The
 * route maps the wire's null to '' on write and back on read.
 */
export const usageModelStats = pgTable(
  "usage_model_stats",
  {
    userId: text("user_id").notNull(),
    // Denormalized from the pushing session so future team views can
    // aggregate by workspace without a WorkOS round trip per row.
    orgId: text("org_id").notNull(),
    environmentId: text("environment_id").notNull(),
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** '' means "ran without a reasoning setting"; see the table comment. */
    reasoning: text("reasoning").notNull().default(""),
    tokens: bigint("tokens", { mode: "number" }).notNull().default(0),
    turns: bigint("turns", { mode: "number" }).notNull().default(0),
    prompts: bigint("prompts", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("usage_model_stats_bucket_unique").on(
      table.userId,
      table.environmentId,
      table.minute,
      table.provider,
      table.model,
      table.reasoning,
    ),
    index("usage_model_stats_user_minute").on(table.userId, table.minute),
  ],
);

/**
 * Per-minute skill/agent run counters. Synced for the owner's own
 * account-side dashboard and NEVER served publicly: which skills someone
 * runs reveals what they work on, where the model mix only reveals how much.
 */
export const usageSkillStats = pgTable(
  "usage_skill_stats",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    environmentId: text("environment_id").notNull(),
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["skill", "agent"] }).notNull(),
    runs: bigint("runs", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("usage_skill_stats_bucket_unique").on(
      table.userId,
      table.environmentId,
      table.minute,
      table.name,
      table.kind,
    ),
    index("usage_skill_stats_user_minute").on(table.userId, table.minute),
  ],
);
