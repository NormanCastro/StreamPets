import { relations, sql } from "drizzle-orm";
import {
  boolean,
  customType,
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
  /** Se completa en el primer ingreso con Twitch (OAuth). */
  twitchUserId: text("twitch_user_id").unique(),
  login: text("login").notNull().unique(),
  displayName: text("display_name").notNull(),
  /** Foto de perfil de Twitch (se actualiza en cada ingreso con Twitch). */
  avatarUrl: text("avatar_url"),
  createdAt: createdAt(),
});

/**
 * Canales a los que se permite registrarse. La autorización es por login de Twitch hasta el primer
 * ingreso; ahí se fija el id numérico (estable) y desde entonces manda el id: si alguien más toma ese
 * login después, no hereda el acceso.
 */
export const allowedChannels = pgTable("allowed_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  login: text("login").notNull().unique(),
  twitchUserId: text("twitch_user_id").unique(),
  /** "free" o "premium": decide qué especies de nivel premium puede usar el canal. */
  plan: text("plan").notNull().default("free"),
  /** Clave personal de respaldo para entrar sin Twitch. Solo se guarda su hash; el prefijo sirve para reconocerla. */
  keyHash: text("key_hash").unique(),
  keyPrefix: text("key_prefix"),
  keyCreatedAt: timestamp("key_created_at", { withTimezone: true }),
  createdAt: createdAt(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

/** Especies exclusivas que un canal tiene permitidas (se conservan aunque el canal aún no haya entrado). */
export const speciesAccess = pgTable(
  "species_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    allowedChannelId: uuid("allowed_channel_id")
      .notNull()
      .references(() => allowedChannels.id, { onDelete: "cascade" }),
    speciesId: text("species_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("species_access_channel_species_uq").on(t.allowedChannelId, t.speciesId)],
);

/** Sesiones del dashboard. Solo se guarda el hash del token de la cookie, nunca el token. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    streamerId: uuid("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_streamer_idx").on(t.streamerId), index("sessions_expires_idx").on(t.expiresAt)],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Pets que suben los canales. El PNG se guarda en la base de datos (el disco de Render gratis se borra
 * en cada reinicio). Solo las aprobadas llegan al catálogo y al overlay.
 */
export const customSpecies = pgTable(
  "custom_species",
  {
    /** Id de especie, p. ej. "u-3fa9c1d2". */
    id: text("id").primaryKey(),
    streamerId: uuid("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("pending"),
    rejectReason: text("reject_reason"),
    png: bytea("png").notNull(),
    createdAt: createdAt(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [index("custom_species_streamer_idx").on(t.streamerId), index("custom_species_status_idx").on(t.status)],
);
export type CustomSpeciesRow = typeof customSpecies.$inferSelect;

/** Especies que el administrador apagó (para todos los canales). Una fila = desactivada. */
export const speciesDisabled = pgTable("species_disabled", {
  speciesId: text("species_id").primaryKey(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }).notNull().defaultNow(),
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
export type AllowedChannelRow = typeof allowedChannels.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type ViewerRow = typeof viewers.$inferSelect;
export type PetRow = typeof pets.$inferSelect;
