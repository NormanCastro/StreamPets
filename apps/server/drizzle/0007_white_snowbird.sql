CREATE TABLE "species_overrides" (
	"species_id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"tier" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
