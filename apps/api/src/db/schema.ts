import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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

export const hostTokens = pgTable("host_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
