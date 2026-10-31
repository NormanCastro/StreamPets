CREATE TABLE "custom_species" (
	"id" text PRIMARY KEY NOT NULL,
	"streamer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"png" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "custom_species" ADD CONSTRAINT "custom_species_streamer_id_streamers_id_fk" FOREIGN KEY ("streamer_id") REFERENCES "public"."streamers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_species_streamer_idx" ON "custom_species" USING btree ("streamer_id");--> statement-breakpoint
CREATE INDEX "custom_species_status_idx" ON "custom_species" USING btree ("status");