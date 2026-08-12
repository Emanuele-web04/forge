import { sql } from "drizzle-orm";
import {
  bigint,
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

export type HostEndpoint = { url: string; transport: "lan" | "tailscale" | "public" };

export const hosts = pgTable(
  "hosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // WorkOS organization id, and the only key authorization is decided on: a
    // caller reaches a host exactly when their token is scoped to this org.
    // Identity and membership live in WorkOS, so there is no local table to
    // reference; orphaned rows are tolerated until WorkOS webhook cleanup is
    // built (future work).
    ownerOrgId: text("owner_org_id").notNull(),
    // WorkOS user id of whoever ran the registration. Audit only — it must
    // never be read as an access check, or a user who left the organization
    // would keep reaching the hosts they happened to register.
    registeredByUserId: text("registered_by_user_id").notNull(),
    environmentId: text("environment_id").notNull(),
    name: text("name").notNull(),
    platform: text("platform", { enum: ["darwin", "linux", "windows"] }).notNull(),
    kind: text("kind", { enum: ["local", "ssh-managed"] }).notNull(),
    endpoints: jsonb("endpoints").$type<HostEndpoint[]>().notNull().default([]),
    appVersion: text("app_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("hosts_owner_org_environment_unique").on(table.ownerOrgId, table.environmentId),
  ],
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

export const hostTokens = pgTable(
  "host_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostId: uuid("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // One live credential per host, enforced by the database rather than by
    // rotation happening to run alone: rotation is revoke-then-insert, and
    // without this a race (or a bug) could leave a host with two valid
    // tokens. Partial over `revoked_at IS NULL` so history rows are exempt.
    uniqueIndex("host_tokens_one_active_per_host")
      .on(table.hostId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);
