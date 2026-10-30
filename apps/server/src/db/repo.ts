import { and, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  overlays,
  pets,
  streamerSettings,
  streamers,
  viewers,
} from "./schema.js";
import type { OverlayRow, PetRow, SettingsRow, StreamerRow, ViewerRow } from "./schema.js";

/** Bots habituales de Twitch. Se siembran en los ajustes para que la streamer los vea y los edite. */
export const DEFAULT_IGNORED_LOGINS: readonly string[] = [
  "nightbot",
  "streamelements",
  "streamlabs",
  "moobot",
  "fossabot",
  "wizebot",
];

function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`Se esperaba una fila: ${what}`);
  return row;
}

// ───────────────────────────── streamers y ajustes ─────────────────────────────

export async function ensureStreamer(
  db: Db,
  input: { login: string; displayName: string },
): Promise<StreamerRow> {
  const row = one(
    await db
      .insert(streamers)
      .values({ login: input.login, displayName: input.displayName })
      .onConflictDoUpdate({ target: streamers.login, set: { displayName: input.displayName } })
      .returning(),
    "ensureStreamer",
  );
  await db
    .insert(streamerSettings)
    .values({ streamerId: row.id, ignoredLogins: [...DEFAULT_IGNORED_LOGINS] })
    .onConflictDoNothing();
  return row;
}

export async function getStreamer(db: Db, streamerId: string): Promise<StreamerRow | undefined> {
  return (await db.select().from(streamers).where(eq(streamers.id, streamerId)))[0];
}

export async function getSettings(db: Db, streamerId: string): Promise<SettingsRow> {
  const existing = (await db.select().from(streamerSettings).where(eq(streamerSettings.streamerId, streamerId)))[0];
  if (existing) return existing;
  await db
    .insert(streamerSettings)
    .values({ streamerId, ignoredLogins: [...DEFAULT_IGNORED_LOGINS] })
    .onConflictDoNothing();
  return one(
    await db.select().from(streamerSettings).where(eq(streamerSettings.streamerId, streamerId)),
    "getSettings",
  );
}

export type SettingsPatch = Partial<Omit<SettingsRow, "streamerId">>;

export async function updateSettings(db: Db, streamerId: string, patch: SettingsPatch): Promise<SettingsRow> {
  await getSettings(db, streamerId); // garantiza que exista la fila
  if (Object.keys(patch).length === 0) return getSettings(db, streamerId);
  return one(
    await db.update(streamerSettings).set(patch).where(eq(streamerSettings.streamerId, streamerId)).returning(),
    "updateSettings",
  );
}

// ───────────────────────────── espectadores y mascotas ─────────────────────────────

export interface ViewerWithPet {
  viewer: ViewerRow;
  pet: PetRow | null;
}

export async function findViewerByTwitchId(
  db: Db,
  streamerId: string,
  twitchUserId: string,
): Promise<ViewerWithPet | undefined> {
  const rows = await db
    .select({ viewer: viewers, pet: pets })
    .from(viewers)
    .leftJoin(pets, eq(pets.viewerId, viewers.id))
    .where(and(eq(viewers.streamerId, streamerId), eq(viewers.twitchUserId, twitchUserId)));
  return rows[0];
}

export async function getViewerWithPet(
  db: Db,
  streamerId: string,
  viewerId: string,
): Promise<ViewerWithPet | undefined> {
  const rows = await db
    .select({ viewer: viewers, pet: pets })
    .from(viewers)
    .leftJoin(pets, eq(pets.viewerId, viewers.id))
    .where(and(eq(viewers.streamerId, streamerId), eq(viewers.id, viewerId)));
  return rows[0];
}

export interface NewViewer {
  twitchUserId: string;
  login: string;
  displayName: string;
  isSubscriber: boolean;
}

/**
 * Crea al espectador y su mascota en una sola transacción.
 * Si dos mensajes del mismo espectador llegan a la vez, solo uno inserta y ambos reciben la misma fila.
 */
export async function createViewerWithPet(
  db: Db,
  streamerId: string,
  data: NewViewer,
  speciesId: string,
): Promise<ViewerWithPet & { created: boolean }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(viewers)
      .values({ streamerId, ...data })
      .onConflictDoNothing()
      .returning();
    const created = inserted.length > 0;
    const viewer =
      inserted[0] ??
      one(
        await tx
          .select()
          .from(viewers)
          .where(and(eq(viewers.streamerId, streamerId), eq(viewers.twitchUserId, data.twitchUserId))),
        "viewer existente",
      );
    await tx
      .insert(pets)
      .values({ streamerId, viewerId: viewer.id, speciesId })
      .onConflictDoNothing({ target: pets.viewerId });
    const pet = one(await tx.select().from(pets).where(eq(pets.viewerId, viewer.id)), "pet del viewer");
    return { viewer, pet, created };
  });
}

export async function updateViewerIdentity(
  db: Db,
  viewerId: string,
  patch: { login?: string; displayName?: string; isSubscriber?: boolean },
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db.update(viewers).set(patch).where(eq(viewers.id, viewerId));
}

export interface ActivityFlush {
  viewerId: string;
  /** Mensajes acumulados desde el último volcado. */
  count: number;
  lastSeenAt: Date;
}

/** Vuelca contadores y "última vez visto" en lote, para no escribir en la base por cada mensaje. */
export async function flushViewerActivity(db: Db, entries: ActivityFlush[]): Promise<void> {
  if (entries.length === 0) return;
  await db.transaction(async (tx) => {
    for (const e of entries) {
      await tx
        .update(viewers)
        .set({ messageCount: sql`${viewers.messageCount} + ${e.count}`, lastSeenAt: e.lastSeenAt })
        .where(eq(viewers.id, e.viewerId));
    }
  });
}

export interface ListViewersOptions {
  query?: string | undefined;
  /** true: solo subs; false: solo no subs; undefined: todos. */
  subscriber?: boolean | undefined;
  limit: number;
  offset: number;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listViewersWithPets(
  db: Db,
  streamerId: string,
  opts: ListViewersOptions,
): Promise<{ items: ViewerWithPet[]; total: number }> {
  const q = opts.query?.trim();
  const search = q
    ? or(ilike(viewers.login, `%${escapeLike(q)}%`), ilike(viewers.displayName, `%${escapeLike(q)}%`))
    : undefined;
  const role = opts.subscriber === undefined ? undefined : eq(viewers.isSubscriber, opts.subscriber);
  const where = and(eq(viewers.streamerId, streamerId), search, role);

  const items = await db
    .select({ viewer: viewers, pet: pets })
    .from(viewers)
    .leftJoin(pets, eq(pets.viewerId, viewers.id))
    .where(where)
    .orderBy(desc(viewers.lastSeenAt), viewers.login)
    .limit(opts.limit)
    .offset(opts.offset);
  const total = one(await db.select({ n: count() }).from(viewers).where(where), "count viewers").n;
  return { items, total };
}

/** Totales del streamer (sin filtros) para los contadores del dashboard. */
export async function getViewerCounts(db: Db, streamerId: string): Promise<{ total: number; subs: number }> {
  const rows = await db
    .select({ subscriber: viewers.isSubscriber, n: count() })
    .from(viewers)
    .where(eq(viewers.streamerId, streamerId))
    .groupBy(viewers.isSubscriber);
  const subs = rows.find((r) => r.subscriber)?.n ?? 0;
  const others = rows.find((r) => !r.subscriber)?.n ?? 0;
  return { total: subs + others, subs };
}

export interface PetPatch {
  speciesId?: string;
  enabled?: boolean;
}

/** Actualiza la mascota de un espectador de ESTE streamer. Devuelve undefined si no existe. */
export async function updatePet(
  db: Db,
  streamerId: string,
  viewerId: string,
  patch: PetPatch,
): Promise<PetRow | undefined> {
  const rows = await db
    .update(pets)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(pets.viewerId, viewerId), eq(pets.streamerId, streamerId)))
    .returning();
  return rows[0];
}

// ───────────────────────────── overlays ─────────────────────────────

export async function createOverlay(
  db: Db,
  streamerId: string,
  input: { name: string; tokenHash: string; tokenPrefix: string },
): Promise<OverlayRow> {
  return one(
    await db
      .insert(overlays)
      .values({ streamerId, name: input.name, tokenHash: input.tokenHash, tokenPrefix: input.tokenPrefix })
      .returning(),
    "createOverlay",
  );
}

export async function listOverlays(db: Db, streamerId: string): Promise<OverlayRow[]> {
  return db
    .select()
    .from(overlays)
    .where(and(eq(overlays.streamerId, streamerId), isNull(overlays.revokedAt)))
    .orderBy(overlays.createdAt);
}

/** Cambia el token de un overlay activo: el anterior deja de funcionar al instante. */
export async function replaceOverlayToken(
  db: Db,
  streamerId: string,
  overlayId: string,
  input: { tokenHash: string; tokenPrefix: string },
): Promise<OverlayRow | undefined> {
  const rows = await db
    .update(overlays)
    .set({ tokenHash: input.tokenHash, tokenPrefix: input.tokenPrefix })
    .where(and(eq(overlays.id, overlayId), eq(overlays.streamerId, streamerId), isNull(overlays.revokedAt)))
    .returning();
  return rows[0];
}

export async function revokeOverlay(db: Db, streamerId: string, overlayId: string): Promise<OverlayRow | undefined> {
  const rows = await db
    .update(overlays)
    .set({ revokedAt: new Date() })
    .where(and(eq(overlays.id, overlayId), eq(overlays.streamerId, streamerId), isNull(overlays.revokedAt)))
    .returning();
  return rows[0];
}

export async function findActiveOverlayByHash(db: Db, tokenHash: string): Promise<OverlayRow | undefined> {
  const rows = await db
    .select()
    .from(overlays)
    .where(and(eq(overlays.tokenHash, tokenHash), isNull(overlays.revokedAt)));
  return rows[0];
}
