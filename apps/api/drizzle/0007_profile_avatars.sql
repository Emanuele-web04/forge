ALTER TABLE "profiles" ADD COLUMN "avatar_source" text DEFAULT 'sso' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "avatar_key" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "avatar_sso_url" text;