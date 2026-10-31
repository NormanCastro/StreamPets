CREATE TABLE "species_disabled" (
	"species_id" text PRIMARY KEY NOT NULL,
	"disabled_at" timestamp with time zone DEFAULT now() NOT NULL
);
