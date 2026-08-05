import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export type HostEndpoint = { url: string; transport: "lan" | "tailscale" | "public" };

export const hosts = pgTable(
  "hosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // WorkOS user id. Identity lives in WorkOS, so there is no local user table
    // to reference — orphan cleanup happens through WorkOS webhooks, not an FK.
    userId: text("user_id").notNull(),
    environmentId: text("environment_id").notNull(),
    name: text("name").notNull(),
    platform: text("platform", { enum: ["darwin", "linux", "windows"] }).notNull(),
    kind: text("kind", { enum: ["local", "ssh-managed"] }).notNull(),
    endpoints: jsonb("endpoints").$type<HostEndpoint[]>().notNull().default([]),
    appVersion: text("app_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("hosts_user_environment_unique").on(table.userId, table.environmentId)],
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
