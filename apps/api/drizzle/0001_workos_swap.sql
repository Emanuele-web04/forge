-- Hand-edited after `drizzle-kit generate`: the generated order put the hosts
-- FK drop last, where `DROP TABLE "user" CASCADE` had already removed the
-- constraint and the ALTER errored. The FK drop moves to the front.
ALTER TABLE "hosts" DROP CONSTRAINT "hosts_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "account" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "device_code" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jwks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verification" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "account" CASCADE;--> statement-breakpoint
DROP TABLE "device_code" CASCADE;--> statement-breakpoint
DROP TABLE "jwks" CASCADE;--> statement-breakpoint
DROP TABLE "session" CASCADE;--> statement-breakpoint
DROP TABLE "user" CASCADE;--> statement-breakpoint
DROP TABLE "verification" CASCADE;
