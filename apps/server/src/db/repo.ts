import { and, count, desc, eq, gt, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  allowedChannels,
  customSpecies,
  overlays,
  pets,
  sessions,
  speciesAccess,
  speciesDisabled,
  speciesOverrides,
  streamerSettings,
  streamers,
  viewers,
} from "./schema.js";
import type { AllowedChannelRow, CustomSpeciesRow, OverlayRow, PetRow, SettingsRow, StreamerRow, ViewerRow } from "./schema.js";

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


// ───────────────────────────── canales autorizados ─────────────────────────────

export async function listAllowedChannels(db: Db): Promise<AllowedChannelRow[]> {
  return db.select().from(allowedChannels).orderBy(allowedChannels.createdAt);
}

/** Agrega un canal a la lista. Si ya estaba, devuelve la fila existente. */
export async function addAllowedChannel(db: Db, login: string): Promise<AllowedChannelRow> {
  await db.insert(allowedChannels).values({ login }).onConflictDoNothing();
  return one(await db.select().from(allowedChannels).where(eq(allowedChannels.login, login)), "addAllowedChannel");
}

export async function removeAllowedChannel(db: Db, login: string): Promise<AllowedChannelRow | undefined> {
  return (await db.delete(allowedChannels).where(eq(allowedChannels.login, login)).returning())[0];
}

/**
 * Busca la autorización de quien intenta entrar. Si el canal ya está vinculado a un id de Twitch,
 * solo vale ese id (alguien que herede el mismo login más tarde no entra). Si aún no está vinculado,
 * vale el login.
 */
export async function findAllowedChannelFor(
  db: Db,
  who: { twitchUserId: string; login: string },
): Promise<AllowedChannelRow | undefined> {
  return (
    await db
      .select()
      .from(allowedChannels)
      .where(
        or(
          eq(allowedChannels.twitchUserId, who.twitchUserId),
          and(isNull(allowedChannels.twitchUserId), eq(allowedChannels.login, who.login)),
        ),
      )
  )[0];
}

export async function bindAllowedChannel(
  db: Db,
  rowId: string,
  who: { twitchUserId: string; login: string },
): Promise<void> {
  await db
    .update(allowedChannels)
    .set({ twitchUserId: who.twitchUserId, login: who.login, lastLoginAt: new Date() })
    .where(eq(allowedChannels.id, rowId));
}

export class StreamerConflictError extends Error {
  constructor(login: string) {
    super(`El login "${login}" ya pertenece a otra cuenta de Twitch`);
    this.name = "StreamerConflictError";
  }
}

/**
 * Streamer de una cuenta de Twitch: por id si ya entró antes; si no, el que ya exista con ese login
 * y aún no tenga cuenta vinculada (el streamer original); si no, uno nuevo. Sigue los cambios de nombre.
 */
export async function upsertStreamerFromTwitch(
  db: Db,
  who: { twitchUserId: string; login: string },
): Promise<StreamerRow> {
  const byId = (await db.select().from(streamers).where(eq(streamers.twitchUserId, who.twitchUserId)))[0];
  if (byId) {
    if (byId.login === who.login) return byId;
    try {
      return one(
        await db
          .update(streamers)
          .set({ login: who.login, displayName: who.login })
          .where(eq(streamers.id, byId.id))
          .returning(),
        "upsertStreamerFromTwitch/rename",
      );
    } catch {
      throw new StreamerConflictError(who.login);
    }
  }
  const byLogin = (await db.select().from(streamers).where(eq(streamers.login, who.login)))[0];
  if (byLogin) {
    if (byLogin.twitchUserId !== null) throw new StreamerConflictError(who.login);
    return one(
      await db.update(streamers).set({ twitchUserId: who.twitchUserId }).where(eq(streamers.id, byLogin.id)).returning(),
      "upsertStreamerFromTwitch/bind",
    );
  }
  const row = one(
    await db.insert(streamers).values({ login: who.login, displayName: who.login, twitchUserId: who.twitchUserId }).returning(),
    "upsertStreamerFromTwitch/create",
  );
  await db
    .insert(streamerSettings)
    .values({ streamerId: row.id, ignoredLogins: [...DEFAULT_IGNORED_LOGINS] })
    .onConflictDoNothing();
  return row;
}

/** Streamers con permiso vigente: son los canales cuyo chat hay que leer. */
export async function listActiveStreamerChannels(db: Db): Promise<Array<{ streamerId: string; login: string }>> {
  const rows = await db
    .select({ streamerId: streamers.id, login: streamers.login })
    .from(streamers)
    .innerJoin(
      allowedChannels,
      or(
        eq(allowedChannels.twitchUserId, streamers.twitchUserId),
        and(isNull(allowedChannels.twitchUserId), eq(allowedChannels.login, streamers.login)),
      ),
    );
  return rows;
}

/** Streamer que corresponde a una autorización (para cortarle el acceso al quitarla). */
export async function findStreamerForAllowed(db: Db, row: AllowedChannelRow): Promise<StreamerRow | undefined> {
  if (row.twitchUserId) {
    const byId = (await db.select().from(streamers).where(eq(streamers.twitchUserId, row.twitchUserId)))[0];
    if (byId) return byId;
  }
  return (await db.select().from(streamers).where(eq(streamers.login, row.login)))[0];
}

// ───────────────────────────── clave personal de respaldo ─────────────────────────────

/** Guarda (reemplaza) la clave personal del canal. Devuelve undefined si el canal no existe. */
export async function setChannelKey(
  db: Db,
  login: string,
  key: { hash: string; prefix: string },
): Promise<AllowedChannelRow | undefined> {
  return (
    await db
      .update(allowedChannels)
      .set({ keyHash: key.hash, keyPrefix: key.prefix, keyCreatedAt: new Date() })
      .where(eq(allowedChannels.login, login))
      .returning()
  )[0];
}

export async function clearChannelKey(db: Db, login: string): Promise<AllowedChannelRow | undefined> {
  return (
    await db
      .update(allowedChannels)
      .set({ keyHash: null, keyPrefix: null, keyCreatedAt: null })
      .where(eq(allowedChannels.login, login))
      .returning()
  )[0];
}

export async function findAllowedChannelByKeyHash(db: Db, keyHash: string): Promise<AllowedChannelRow | undefined> {
  return (await db.select().from(allowedChannels).where(eq(allowedChannels.keyHash, keyHash)))[0];
}

// ───────────────────────────── planes y especies por canal ─────────────────────────────

export type ChannelPlan = "free" | "premium";

export function asPlan(v: string): ChannelPlan {
  return v === "premium" ? "premium" : "free";
}

/** Plan y especies exclusivas permitidas del canal al que pertenece este streamer (gratis y sin extras si no tiene permiso vigente). */
export async function getAccessForStreamer(
  db: Db,
  streamerId: string,
): Promise<{ plan: ChannelPlan; grants: string[]; customSlots: number }> {
  const row = (
    await db
      .select({ id: allowedChannels.id, plan: allowedChannels.plan, customSlots: allowedChannels.customSlots })
      .from(streamers)
      .innerJoin(
        allowedChannels,
        or(
          eq(allowedChannels.twitchUserId, streamers.twitchUserId),
          and(isNull(allowedChannels.twitchUserId), eq(allowedChannels.login, streamers.login)),
        ),
      )
      .where(eq(streamers.id, streamerId))
  )[0];
  if (!row) return { plan: "free", grants: [], customSlots: 0 };
  const grants = await db.select({ speciesId: speciesAccess.speciesId }).from(speciesAccess).where(eq(speciesAccess.allowedChannelId, row.id));
  return { plan: asPlan(row.plan), grants: grants.map((g) => g.speciesId), customSlots: row.customSlots };
}

/** Especies exclusivas por canal, indexadas por id de la fila de canal autorizado. */
export async function listChannelGrants(db: Db): Promise<Map<string, string[]>> {
  const rows = await db.select().from(speciesAccess).orderBy(speciesAccess.speciesId);
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.allowedChannelId, [...(out.get(r.allowedChannelId) ?? []), r.speciesId]);
  return out;
}

export async function setChannelPlan(db: Db, login: string, plan: ChannelPlan): Promise<AllowedChannelRow | undefined> {
  return (await db.update(allowedChannels).set({ plan }).where(eq(allowedChannels.login, login)).returning())[0];
}

/** Cupos de mascotas propias del canal. */
export async function setChannelCustomSlots(db: Db, login: string, customSlots: number): Promise<AllowedChannelRow | undefined> {
  return (await db.update(allowedChannels).set({ customSlots }).where(eq(allowedChannels.login, login)).returning())[0];
}

/** Reemplaza la lista de especies exclusivas del canal. */
export async function setChannelSpecies(
  db: Db,
  login: string,
  speciesIds: string[],
): Promise<AllowedChannelRow | undefined> {
  return db.transaction(async (tx) => {
    const row = (await tx.select().from(allowedChannels).where(eq(allowedChannels.login, login)))[0];
    if (!row) return undefined;
    await tx.delete(speciesAccess).where(eq(speciesAccess.allowedChannelId, row.id));
    if (speciesIds.length > 0) {
      await tx.insert(speciesAccess).values(speciesIds.map((speciesId) => ({ allowedChannelId: row.id, speciesId })));
    }
    return row;
  });
}

/** Mascotas de este streamer cuya especie ya no le corresponde. */
export async function listPetsOutside(
  db: Db,
  streamerId: string,
  allowedSpeciesIds: readonly string[],
): Promise<Array<{ viewerId: string; speciesId: string }>> {
  const rows = await db
    .select({ viewerId: pets.viewerId, speciesId: pets.speciesId })
    .from(pets)
    .where(eq(pets.streamerId, streamerId));
  const ok = new Set(allowedSpeciesIds);
  return rows.filter((r) => !ok.has(r.speciesId));
}

// ───────────────────────────── sesiones ─────────────────────────────

export async function createSession(
  db: Db,
  input: { streamerId: string; tokenHash: string; expiresAt: Date },
): Promise<void> {
  await db.insert(sessions).values(input);
}

/** Sesión vigente por hash del token, o undefined si no existe o ya venció. */
export async function findSession(
  db: Db,
  tokenHash: string,
  now: Date,
): Promise<{ streamerId: string } | undefined> {
  const row = (
    await db
      .select({ streamerId: sessions.streamerId })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
  )[0];
  return row;
}

export async function deleteSession(db: Db, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

export async function deleteSessionsForStreamer(db: Db, streamerId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.streamerId, streamerId));
}

export async function deleteExpiredSessions(db: Db, now: Date): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}

// ───────────────────────────── pets personalizadas ─────────────────────────────

export type CustomPetMeta = Omit<CustomSpeciesRow, "png">;

const customMetaCols = {
  id: customSpecies.id,
  streamerId: customSpecies.streamerId,
  name: customSpecies.name,
  status: customSpecies.status,
  rejectReason: customSpecies.rejectReason,
  pack: customSpecies.pack,
  createdAt: customSpecies.createdAt,
  reviewedAt: customSpecies.reviewedAt,
};

export async function insertCustomPet(
  db: Db,
  input: { id: string; streamerId: string; name: string; png: Buffer; pack?: string | null },
): Promise<void> {
  await db.insert(customSpecies).values(input);
}

export async function getCustomPet(db: Db, id: string): Promise<CustomSpeciesRow | undefined> {
  const rows = await db.select().from(customSpecies).where(eq(customSpecies.id, id)).limit(1);
  return rows[0];
}

/** Pets de un canal (sin la imagen), las más nuevas primero. */
export async function listCustomPetsOf(db: Db, streamerId: string): Promise<CustomPetMeta[]> {
  return db
    .select(customMetaCols)
    .from(customSpecies)
    .where(eq(customSpecies.streamerId, streamerId))
    .orderBy(desc(customSpecies.createdAt));
}

/** Todas las pets con el login de su canal, para moderar. */
export async function listCustomPetsForReview(
  db: Db,
  status?: string,
): Promise<Array<CustomPetMeta & { login: string }>> {
  const q = db
    .select({ ...customMetaCols, login: streamers.login })
    .from(customSpecies)
    .innerJoin(streamers, eq(streamers.id, customSpecies.streamerId));
  const rows = status ? await q.where(eq(customSpecies.status, status)).orderBy(customSpecies.createdAt) : await q.orderBy(customSpecies.createdAt);
  return rows;
}

/** Cuántas pets cuentan contra el cupo del canal (pendientes y aprobadas). */
export async function countActiveCustomPets(db: Db, streamerId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(customSpecies)
    .where(and(eq(customSpecies.streamerId, streamerId), or(eq(customSpecies.status, "pending"), eq(customSpecies.status, "approved"))));
  return Number(row?.n ?? 0);
}

export async function listApprovedCustomPets(db: Db): Promise<Array<{ id: string; name: string; streamerId: string }>> {
  return db
    .select({ id: customSpecies.id, name: customSpecies.name, streamerId: customSpecies.streamerId })
    .from(customSpecies)
    .where(eq(customSpecies.status, "approved"));
}

export async function reviewCustomPet(
  db: Db,
  id: string,
  status: "approved" | "rejected",
  reason: string | null,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(customSpecies)
    .set({ status, rejectReason: status === "rejected" ? reason : null, reviewedAt: at })
    .where(eq(customSpecies.id, id))
    .returning({ id: customSpecies.id });
  return rows.length > 0;
}

export async function deleteCustomPet(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(customSpecies).where(eq(customSpecies.id, id)).returning({ id: customSpecies.id });
  return rows.length > 0;
}

/** Guarda (o borra) la foto de perfil de Twitch de un streamer. */
export async function setStreamerAvatar(db: Db, streamerId: string, url: string | null): Promise<void> {
  await db.update(streamers).set({ avatarUrl: url }).where(eq(streamers.id, streamerId));
}

// ───────────────────────────── catálogo (vista del administrador) ─────────────────────────────

export async function listDisabledSpecies(db: Db): Promise<string[]> {
  return (await db.select({ id: speciesDisabled.speciesId }).from(speciesDisabled)).map((r) => r.id);
}

export async function setSpeciesDisabled(db: Db, speciesId: string, disabled: boolean): Promise<void> {
  if (disabled) await db.insert(speciesDisabled).values({ speciesId }).onConflictDoNothing();
  else await db.delete(speciesDisabled).where(eq(speciesDisabled.speciesId, speciesId));
}

/** Por especie: en cuántos canales hay al menos una mascota y cuántas mascotas hay en total. */
export async function listSpeciesUsage(db: Db): Promise<Map<string, { channels: number; pets: number }>> {
  const rows = await db
    .select({
      speciesId: pets.speciesId,
      channels: sql<number>`count(distinct ${pets.streamerId})`,
      total: sql<number>`count(*)`,
    })
    .from(pets)
    .groupBy(pets.speciesId);
  return new Map(rows.map((r) => [r.speciesId, { channels: Number(r.channels), pets: Number(r.total) }]));
}

export async function listStreamersUsingSpecies(db: Db, speciesId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ id: pets.streamerId }).from(pets).where(eq(pets.speciesId, speciesId));
  return rows.map((r) => r.id);
}

export async function listSpeciesOverrides(
  db: Db,
): Promise<Array<{ id: string; scope: "general" | "exclusive" | "event"; tier: "free" | "premium" }>> {
  const rows = await db.select().from(speciesOverrides);
  return rows.map((r) => ({
    id: r.speciesId,
    scope: r.scope === "exclusive" ? "exclusive" : r.scope === "event" ? "event" : "general",
    tier: r.tier === "premium" ? "premium" : "free",
  }));
}

/** Guarda el tipo elegido por el administrador; con null vuelve a valer lo de index.json. */
export async function setSpeciesOverride(
  db: Db,
  speciesId: string,
  value: { scope: "general" | "exclusive" | "event"; tier: "free" | "premium" } | null,
): Promise<void> {
  if (value === null) {
    await db.delete(speciesOverrides).where(eq(speciesOverrides.speciesId, speciesId));
    return;
  }
  await db
    .insert(speciesOverrides)
    .values({ speciesId, ...value })
    .onConflictDoUpdate({ target: speciesOverrides.speciesId, set: { ...value, updatedAt: new Date() } });
}
