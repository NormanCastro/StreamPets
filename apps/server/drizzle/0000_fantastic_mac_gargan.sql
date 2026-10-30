CREATE TABLE "overlays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"streamer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "overlays_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "pets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"streamer_id" uuid NOT NULL,
	"viewer_id" uuid NOT NULL,
	"species_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pets_viewer_id_unique" UNIQUE("viewer_id")
);
--> statement-breakpoint
CREATE TABLE "streamer_settings" (
	"streamer_id" uuid PRIMARY KEY NOT NULL,
	"ignored_logins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ignore_streamer" boolean DEFAULT true NOT NULL,
	"default_species_id" text,
	"subs_only" boolean DEFAULT false NOT NULL,
	"max_pets" integer DEFAULT 20 NOT NULL,
	"idle_timeout_sec" integer DEFAULT 300 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "streamers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitch_user_id" text,
	"login" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "streamers_twitch_user_id_unique" UNIQUE("twitch_user_id"),
	CONSTRAINT "streamers_login_unique" UNIQUE("login")
);
--> statement-breakpoint
CREATE TABLE "viewers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"streamer_id" uuid NOT NULL,
	"twitch_user_id" text NOT NULL,
	"login" text NOT NULL,
	"display_name" text NOT NULL,
	"is_subscriber" boolean DEFAULT false NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "viewers_id_streamer_uq" UNIQUE("id","streamer_id")
);
--> statement-breakpoint
ALTER TABLE "overlays" ADD CONSTRAINT "overlays_streamer_id_streamers_id_fk" FOREIGN KEY ("streamer_id") REFERENCES "public"."streamers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pets" ADD CONSTRAINT "pets_viewer_streamer_fk" FOREIGN KEY ("viewer_id","streamer_id") REFERENCES "public"."viewers"("id","streamer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streamer_settings" ADD CONSTRAINT "streamer_settings_streamer_id_streamers_id_fk" FOREIGN KEY ("streamer_id") REFERENCES "public"."streamers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewers" ADD CONSTRAINT "viewers_streamer_id_streamers_id_fk" FOREIGN KEY ("streamer_id") REFERENCES "public"."streamers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "overlays_streamer_idx" ON "overlays" USING btree ("streamer_id");--> statement-breakpoint
CREATE INDEX "pets_streamer_idx" ON "pets" USING btree ("streamer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "viewers_streamer_twitch_uq" ON "viewers" USING btree ("streamer_id","twitch_user_id");--> statement-breakpoint
CREATE INDEX "viewers_streamer_login_idx" ON "viewers" USING btree ("streamer_id","login");