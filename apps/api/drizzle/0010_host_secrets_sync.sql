CREATE TABLE "host_secret_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_secrets" (
	"host_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_key_wraps" (
	"recipient_device_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"wrap" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "host_secret_versions_host_version_unique" ON "host_secret_versions" USING btree ("host_id","version");--> statement-breakpoint
CREATE INDEX "host_secrets_owner_user_idx" ON "host_secrets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "sync_key_wraps_owner_user_idx" ON "sync_key_wraps" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "sync_key_wraps_expires_at_idx" ON "sync_key_wraps" USING btree ("expires_at");