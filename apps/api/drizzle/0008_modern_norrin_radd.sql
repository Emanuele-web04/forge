CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"public_key_jwk" jsonb NOT NULL,
	"jkt" text NOT NULL,
	"display_name" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "link_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce" text NOT NULL,
	"owner_user_id" text,
	"owner_org_id" text,
	"host_id" uuid,
	"environment_id" text,
	"device_code_hash" text,
	"user_code" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "revocation_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Generated as ADD ... NOT NULL, then hand-edited so populated pre-v2
-- databases can migrate. registered_by_user_id is the only existing
-- ownership signal; Slice C's forced re-link establishes live ownership.
ALTER TABLE "hosts" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
UPDATE "hosts" SET "owner_user_id" = "registered_by_user_id";--> statement-breakpoint
ALTER TABLE "hosts" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "discoverable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "public_key_jwk" jsonb;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "key_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The relay is no longer stored as an endpoint. Strip only those objects and
-- preserve every LAN/Tailscale endpoint already present.
UPDATE "hosts"
SET "endpoints" = COALESCE(
	(
		SELECT jsonb_agg("item")
		FROM jsonb_array_elements("hosts"."endpoints") AS "endpoint"("item")
		WHERE "item"->>'transport' <> 'public'
	),
	'[]'::jsonb
);--> statement-breakpoint
CREATE UNIQUE INDEX "devices_user_jkt_active_unique" ON "devices" USING btree ("user_id","jkt") WHERE "devices"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "link_challenges_device_code_hash_unique" ON "link_challenges" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "link_challenges_user_code_unique" ON "link_challenges" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "link_challenges_expires_at_idx" ON "link_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "revocation_events_created_at_idx" ON "revocation_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "hosts_owner_user_idx" ON "hosts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "hosts_environment_idx" ON "hosts" USING btree ("environment_id");
