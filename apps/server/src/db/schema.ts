import { relations, sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Cada streamer es un "inquilino". Todo lo demás cuelga de streamers.id y las claves foráneas
 * compuestas impiden mezclar datos de dos streamers a nivel de base de datos.
 */
export const streamers = pgTable("streamers", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Se completa cuando exista el login con Twitch (OAuth). */
  twitchUserId: text("twitch_user_id").unique(),
  login: text("login").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

export const streamerSettings = pgTable("streamer_settings", {
  streamerId: uuid("streamer_id")
    .primaryKey()
    .references(() => streamers.id, { onDelete: "cascade" }),
  /** Logins (minúsculas) que nunca reciben mascota: bots, etc. */
  ignoredLogins: jsonb("ignored_logins").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  ignoreStreamer: boolean("ignore_streamer").notNull().default(true),
  /** Si es null se elige al azar entre las especies disponibles. */
  defaultSpeciesId: text("default_species_id"),
  subsOnly: boolean("subs_only").notNull().default(false),
  maxPets: integer("max_pets").notNull().default(20),
  /** Segundos sin escribir tras los cuales la mascota se retira de pantalla. */
  idleTimeoutSec: integer("idle_timeout_sec").notNull().default(300),
});

/** Un overlay = una URL para OBS. Solo guardamos el hash del token, nunca el token. */
export const overlays = pgTable(
  "overlays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    streamerId: uuid("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** Primeros caracteres del token, solo para reconocerlo en el dashboard. */
    tokenPrefix: text("token_prefix").notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("overlays_streamer_idx").on(t.streamerId)],
);

export const viewers = pgTable(
  "viewers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    streamerId: uuid("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    /** ID numérico de Twitch (estable aunque la persona cambie de nombre). */
    twitchUserId: text("twitch_user_id").notNull(),
    login: text("login").notNull(),
    displayName: text("display_name").notNull(),
    isSubscriber: boolean("is_subscriber").notNull().default(false),
    messageCount: integer("message_count").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("viewers_streamer_twitch_uq").on(t.streamerId, t.twitchUserId),
    // Necesario para la clave foránea compuesta de pets.
    unique("viewers_id_streamer_uq").on(t.id, t.streamerId),
    index("viewers_streamer_login_idx").on(t.streamerId, t.login),
  ],
);

export const pets = pgTable(
  "pets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    streamerId: uuid("streamer_id").notNull(),
    viewerId: uuid("viewer_id").notNull().unique(),
    speciesId: text("species_id").notNull(),
    /** false = este espectador no tiene mascota (y no se le vuelve a crear). */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "pets_viewer_streamer_fk",
      columns: [t.viewerId, t.streamerId],
      foreignColumns: [viewers.id, viewers.streamerId],
    }).onDelete("cascade"),
    index("pets_streamer_idx").on(t.streamerId),
  ],
);

export const streamersRelations = relations(streamers, ({ many, one }) => ({
  viewers: many(viewers),
  overlays: many(overlays),
  settings: one(streamerSettings),
}));

export type StreamerRow = typeof streamers.$inferSelect;
export type SettingsRow = typeof streamerSettings.$inferSelect;
export type OverlayRow = typeof overlays.$inferSelect;
export type ViewerRow = typeof viewers.$inferSelect;
export type PetRow = typeof pets.$inferSelect;
