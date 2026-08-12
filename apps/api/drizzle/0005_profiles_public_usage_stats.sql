CREATE TABLE "usage_model_stats" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"reasoning" text DEFAULT '' NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"turns" bigint DEFAULT 0 NOT NULL,
	"prompts" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_skill_stats" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"runs" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_model_stats_bucket_unique" ON "usage_model_stats" USING btree ("user_id","environment_id","minute","provider","model","reasoning");--> statement-breakpoint
CREATE INDEX "usage_model_stats_user_minute" ON "usage_model_stats" USING btree ("user_id","minute");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_skill_stats_bucket_unique" ON "usage_skill_stats" USING btree ("user_id","environment_id","minute","name","kind");--> statement-breakpoint
CREATE INDEX "usage_skill_stats_user_minute" ON "usage_skill_stats" USING btree ("user_id","minute");