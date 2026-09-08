-- Hand-edited after `drizzle-kit generate` to prepend the TRUNCATE below.
--
-- Host ownership moves from the WorkOS user to the WorkOS organization. There
-- is no backfill: deriving an owning org for an existing row would mean
-- provisioning a personal organization per user from inside a migration, and
-- the generated `ADD COLUMN ... NOT NULL` without a default cannot run over
-- populated rows anyway. This service is pre-release with no data worth
-- keeping, so every host is dropped and re-registered by its CLI on the next
-- `synara auth`. The cascade takes host_tokens with it, which is correct — a
-- host token names a host row that no longer exists.
--
-- This is deliberately destructive. Do not copy the pattern once the service
-- has real users.
TRUNCATE TABLE "hosts" CASCADE;--> statement-breakpoint
DROP INDEX "hosts_user_environment_unique";--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "owner_org_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "registered_by_user_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hosts_owner_org_environment_unique" ON "hosts" USING btree ("owner_org_id","environment_id");--> statement-breakpoint
ALTER TABLE "hosts" DROP COLUMN "user_id";
