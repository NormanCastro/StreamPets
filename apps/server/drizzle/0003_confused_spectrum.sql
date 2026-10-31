ALTER TABLE "allowed_channels" ADD COLUMN "key_hash" text;--> statement-breakpoint
ALTER TABLE "allowed_channels" ADD COLUMN "key_prefix" text;--> statement-breakpoint
ALTER TABLE "allowed_channels" ADD COLUMN "key_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "allowed_channels" ADD CONSTRAINT "allowed_channels_key_hash_unique" UNIQUE("key_hash");