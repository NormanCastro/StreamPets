import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { LIMITS, SpeciesIdSchema, TwitchLoginSchema } from "@streampets/shared";
import type { Db } from "../db/client.js";
import * as repo from "../db/repo.js";
import type { OverlayRow, SettingsRow } from "../db/schema.js";
import type { ChatService } from "../domain/chat-service.js";
import type { SpeciesCatalog } from "../domain/species.js";
import { generateOverlayToken, safeEqual } from "../lib/tokens.js";
import type { OverlayHub } from "./hub.js";

export interface AdminDeps {
  db: Db;
  service: ChatService;
  hub: OverlayHub;
  species: SpeciesCatalog;
  adminToken: string;
  /** Streamer al que da acceso el ADMIN_TOKEN (provisional hasta tener login con Twitch). */
  streamerId: string;
  enableDevChat: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    streamerId?: string;
  }
}

const IdParam = z.object({ id: z.string().uuid() });

const ListQuery = z.object({
  q: z.string().max(60).optional(),
  role: z.enum(["all", "subs", "viewers"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const PetBody = z
  .object({ speciesId: SpeciesIdSchema.optional(), enabled: z.boolean().optional() })
  .strict()
  .refine((b) => b.speciesId !== undefined || b.enabled !== undefined, "nada que cambiar");

const SettingsBody = z
  .object({
    ignoredLogins: z.array(TwitchLoginSchema).max(LIMITS.ignoredLoginsMax).optional(),
    ignoreStreamer: z.boolean().optional(),
    defaultSpeciesId: SpeciesIdSchema.nullable().optional(),
    subsOnly: z.boolean().optional(),
    maxPets: z.number().int().min(1).max(LIMITS.maxPetsCap).optional(),
    idleTimeoutSec: z.number().int().min(LIMITS.idleTimeoutMin).max(LIMITS.idleTimeoutMax).optional(),
  })
  .strict();

const OverlayBody = z.object({ name: z.string().trim().min(1).max(60) }).strict();

const DevChatBody = z
  .object({
    login: TwitchLoginSchema,
    displayName: z.string().max(60).optional(),
    twitchUserId: z.string().min(1).max(40).optional(),
    isSubscriber: z.boolean().optional(),
  })
  .strict();

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return undefined;
  return h.slice(7).trim();
}

function fail(reply: FastifyReply, status: number, error: string, details?: unknown): FastifyReply {
  return reply.code(status).send({ error, ...(details === undefined ? {} : { details }) });
}

function parse<T>(schema: z.ZodType<T>, data: unknown, reply: FastifyReply): T | undefined {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  fail(reply, 400, "invalid_request", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return undefined;
}

function publicSettings(s: SettingsRow) {
  return {
    ignoredLogins: s.ignoredLogins,
    ignoreStreamer: s.ignoreStreamer,
    defaultSpeciesId: s.defaultSpeciesId,
    subsOnly: s.subsOnly,
    maxPets: s.maxPets,
    idleTimeoutSec: s.idleTimeoutSec,
  };
}

function publicOverlay(o: OverlayRow) {
  return { id: o.id, name: o.name, tokenPrefix: o.tokenPrefix, createdAt: o.createdAt };
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, service, hub, species } = deps;

  app.register(
    async (admin) => {
      admin.addHook("onRequest", async (req, reply) => {
        const token = bearer(req);
        if (!token || !safeEqual(token, deps.adminToken)) {
          reply.header("WWW-Authenticate", "Bearer");
          return fail(reply, 401, "unauthorized");
        }
        req.streamerId = deps.streamerId;
        return undefined;
      });
      // Nada de lo administrativo debe guardarse en cachés.
      admin.addHook("onSend", async (_req, reply, payload) => {
        reply.header("Cache-Control", "no-store");
        return payload;
      });

      const sid = (req: FastifyRequest): string => req.streamerId as string;

      admin.get("/me", async (req) => {
        const streamer = await repo.getStreamer(db, sid(req));
        return { streamer: streamer ? { login: streamer.login, displayName: streamer.displayName } : null };
      });

      // ── Mascotas de los espectadores ──
      admin.get("/viewers", async (req, reply) => {
        const q = parse(ListQuery, req.query, reply);
        if (!q) return reply;
        const { items, total } = await repo.listViewersWithPets(db, sid(req), {
          query: q.q,
          subscriber: q.role === "all" ? undefined : q.role === "subs",
          limit: q.limit,
          offset: q.offset,
        });
        const online = new Set((await service.snapshot(sid(req))).pets.map((p) => p.viewerId));
        const totals = await repo.getViewerCounts(db, sid(req));
        return {
          total,
          counts: { all: totals.total, subs: totals.subs, viewers: totals.total - totals.subs, online: online.size },
          items: items.map(({ viewer, pet }) => ({
            id: viewer.id,
            login: viewer.login,
            displayName: viewer.displayName,
            isSubscriber: viewer.isSubscriber,
            messageCount: viewer.messageCount,
            lastSeenAt: viewer.lastSeenAt,
            online: online.has(viewer.id),
            pet: pet ? { speciesId: pet.speciesId, enabled: pet.enabled } : null,
          })),
        };
      });

      admin.patch("/viewers/:id/pet", async (req, reply) => {
        const params = parse(IdParam, req.params, reply);
        if (!params) return reply;
        const body = parse(PetBody, req.body, reply);
        if (!body) return reply;
        if (body.speciesId !== undefined && !species.has(body.speciesId)) {
          return fail(reply, 400, "unknown_species");
        }
        const patch: repo.PetPatch = {};
        if (body.speciesId !== undefined) patch.speciesId = body.speciesId;
        if (body.enabled !== undefined) patch.enabled = body.enabled;
        const updated = await repo.updatePet(db, sid(req), params.id, patch);
        if (!updated) return fail(reply, 404, "not_found");
        await service.applyPetChange(sid(req), params.id);
        return { pet: { speciesId: updated.speciesId, enabled: updated.enabled } };
      });

      // ── Ajustes ──
      admin.get("/settings", async (req) => publicSettings(await repo.getSettings(db, sid(req))));

      admin.patch("/settings", async (req, reply) => {
        const body = parse(SettingsBody, req.body, reply);
        if (!body) return reply;
        if (body.defaultSpeciesId && !species.has(body.defaultSpeciesId)) {
          return fail(reply, 400, "unknown_species");
        }
        const patch: repo.SettingsPatch = {};
        if (body.ignoredLogins !== undefined) patch.ignoredLogins = [...new Set(body.ignoredLogins)];
        if (body.ignoreStreamer !== undefined) patch.ignoreStreamer = body.ignoreStreamer;
        if (body.defaultSpeciesId !== undefined) patch.defaultSpeciesId = body.defaultSpeciesId;
        if (body.subsOnly !== undefined) patch.subsOnly = body.subsOnly;
        if (body.maxPets !== undefined) patch.maxPets = body.maxPets;
        if (body.idleTimeoutSec !== undefined) patch.idleTimeoutSec = body.idleTimeoutSec;
        const row = await repo.updateSettings(db, sid(req), patch);
        await service.refreshSettings(sid(req));
        return publicSettings(row);
      });

      // ── Overlays (enlaces para OBS) ──
      admin.get("/overlays", async (req) => ({
        items: (await repo.listOverlays(db, sid(req))).map(publicOverlay),
      }));

      admin.post("/overlays", async (req, reply) => {
        const body = parse(OverlayBody, req.body, reply);
        if (!body) return reply;
        const t = generateOverlayToken();
        const row = await repo.createOverlay(db, sid(req), { name: body.name, tokenHash: t.hash, tokenPrefix: t.prefix });
        // El token solo se muestra ahora: en la base queda únicamente su hash.
        return reply.code(201).send({ ...publicOverlay(row), token: t.token, path: `/overlay/pets/${t.token}` });
      });

      admin.post("/overlays/:id/rotate", async (req, reply) => {
        const params = parse(IdParam, req.params, reply);
        if (!params) return reply;
        const t = generateOverlayToken();
        const row = await repo.replaceOverlayToken(db, sid(req), params.id, { tokenHash: t.hash, tokenPrefix: t.prefix });
        if (!row) return fail(reply, 404, "not_found");
        hub.closeOverlay(row.id);
        return { ...publicOverlay(row), token: t.token, path: `/overlay/pets/${t.token}` };
      });

      admin.delete("/overlays/:id", async (req, reply) => {
        const params = parse(IdParam, req.params, reply);
        if (!params) return reply;
        const row = await repo.revokeOverlay(db, sid(req), params.id);
        if (!row) return fail(reply, 404, "not_found");
        hub.closeOverlay(row.id);
        return reply.code(204).send();
      });

      // ── Chat simulado (solo desarrollo) ──
      if (deps.enableDevChat) {
        admin.post("/dev/chat", async (req, reply) => {
          const body = parse(DevChatBody, req.body, reply);
          if (!body) return reply;
          const result = await service.handleMessage({
            streamerId: sid(req),
            twitchUserId: body.twitchUserId ?? `dev-${body.login}`,
            login: body.login,
            displayName: body.displayName ?? body.login,
            isSubscriber: body.isSubscriber ?? false,
          });
          return result;
        });
      }
    },
    { prefix: "/api/admin" },
  );
}
