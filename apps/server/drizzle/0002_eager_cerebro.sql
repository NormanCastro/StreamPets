CREATE TABLE "species_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allowed_channel_id" uuid NOT NULL,
	"species_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "species_access_channel_species_uq" UNIQUE("allowed_channel_id","species_id")
);
--> statement-breakpoint
ALTER TABLE "allowed_channels" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "species_access" ADD CONSTRAINT "species_access_allowed_channel_id_allowed_channels_id_fk" FOREIGN KEY ("allowed_channel_id") REFERENCES "public"."allowed_channels"("id") ON DELETE cascade ON UPDATE no action;