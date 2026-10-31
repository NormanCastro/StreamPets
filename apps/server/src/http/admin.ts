import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { LIMITS, PlanSchema, SpeciesIdSchema, TwitchLoginSchema } from "@streampets/shared";
import type { Db } from "../db/client.js";
import * as repo from "../db/repo.js";
import type { AllowedChannelRow, OverlayRow, SettingsRow } from "../db/schema.js";
import type { ChatService } from "../domain/chat-service.js";
import type { SpeciesAccess } from "../domain/access.js";
import type { SpeciesCatalog } from "../domain/species.js";
import { generateAccessKey, generateOverlayToken } from "../lib/tokens.js";
import { authenticate, cookieName, serializeCookie } from "./auth.js";
import type { AuthSettings, Role } from "./auth.js";
import type { OverlayHub } from "./hub.js";

export interface AdminDeps {
  db: Db;
  service: ChatService;
  hub: OverlayHub;
  species: SpeciesCatalog;
  access: SpeciesAccess;
  adminToken: string;
  /** Streamer al que da acceso el ADMIN_TOKEN (el dueño de la instalación). */
  streamerId: string;
  /** Login del dueño: su canal siempre está autorizado y no se puede quitar. */
  ownerLogin: string;
  auth: AuthSettings;
  enableDevChat: boolean;
  /** Estado del lector de chat: completo para el administrador, resumido para un streamer. */
  twitchStatus: (streamerId: string, role: Role) => unknown;
  /** Se llama al quitarle el permiso a un canal (para dejar de leer su chat). */
  onChannelRemoved?: (streamerId: string) => void;
  now?: () => Date;
}

declare module "fastify" {
  interface FastifyRequest {
    streamerId?: string;
    role?: Role;
    sessionHash?: string;
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
  const { db, service, hub, species, access } = deps;

  app.register(
    async (admin) => {
      admin.addHook("onRequest", async (req, reply) => {
        const r = await authenticate(req, {
          db,
          adminToken: deps.adminToken,
          ownerStreamerId: deps.streamerId,
          auth: deps.auth,
          ...(deps.now ? { now: deps.now } : {}),
        });
        if (!r.ok) {
          if (r.status === 401) reply.header("WWW-Authenticate", "Bearer");
          return fail(reply, r.status, r.error);
        }
        req.streamerId = r.principal.streamerId;
        req.role = r.principal.role;
        if (r.principal.sessionHash !== undefined) req.sessionHash = r.principal.sessionHash;
        return undefined;
      });
      // Nada de lo administrativo debe guardarse en cachés.
      admin.addHook("onSend", async (_req, reply, payload) => {
        reply.header("Cache-Control", "no-store");
        return payload;
      });

      const sid = (req: FastifyRequest): string => req.streamerId as string;

      const role = (req: FastifyRequest): Role => req.role as Role;
      const onlyAdmin = (req: FastifyRequest, reply: FastifyReply): boolean => {
        if (role(req) === "admin") return true;
        fail(reply, 403, "forbidden");
        return false;
      };

      admin.get("/me", async (req) => {
        const streamer = await repo.getStreamer(db, sid(req));
        return {
          streamer: streamer ? { login: streamer.login, displayName: streamer.displayName } : null,
          role: role(req),
          plan: (await access.info(sid(req))).plan,
          twitch: deps.twitchStatus(sid(req), role(req)),
        };
      });

      // Catálogo con lo que este canal puede y no puede usar (lo bloqueado se muestra, pero no se puede elegir).
      admin.get("/species", async (req) => {
        const allowed = await access.allowedIds(sid(req));
        return {
          species: species.list().map((e) => ({
            id: e.id,
            name: e.name,
            url: e.url,
            scope: e.scope,
            tier: e.tier,
            locked: !allowed.has(e.id),
          })),
        };
      });

      // Cerrar sesión: borra la sesión del servidor y la cookie. Con la clave de administración no hay nada que cerrar.
      admin.post("/logout", async (req, reply) => {
        if (req.sessionHash !== undefined) await repo.deleteSession(db, req.sessionHash);
        reply.header(
          "Set-Cookie",
          serializeCookie(cookieName("sp_session", deps.auth.cookieSecure), "", { secure: deps.auth.cookieSecure, maxAgeSec: 0 }),
        );
        return reply.code(204).send();
      });

      // ── Canales autorizados (solo el administrador) ──
      const channelItem = (r: AllowedChannelRow, grants: string[]) => ({
        login: r.login,
        linked: r.twitchUserId !== null,
        owner: r.login === deps.ownerLogin,
        plan: repo.asPlan(r.plan),
        hasKey: r.keyHash !== null,
        keyPrefix: r.keyPrefix,
        keyCreatedAt: r.keyCreatedAt,
        species: grants,
        createdAt: r.createdAt,
        lastLoginAt: r.lastLoginAt,
      });

      admin.get("/channels", async (req, reply) => {
        if (!onlyAdmin(req, reply)) return reply;
        const rows = await repo.listAllowedChannels(db);
        const grants = await repo.listChannelGrants(db);
        return { items: rows.map((r) => channelItem(r, grants.get(r.id) ?? [])) };
      });

      admin.post("/channels", async (req, reply) => {
        if (!onlyAdmin(req, reply)) return reply;
        const body = parse(z.object({ login: TwitchLoginSchema }).strict(), req.body, reply);
        if (!body) return reply;
        const row = await repo.addAllowedChannel(db, body.login);
        const grants = await repo.listChannelGrants(db);
        return reply.code(201).send(channelItem(row, grants.get(row.id) ?? []));
      });

      // Clave personal de respaldo de un canal: se muestra una sola vez al generarla.
      admin.post("/channels/:login/key", async (req, reply) => {
        if (!onlyAdmin(req, reply)) return reply;
        const params = parse(z.object({ login: TwitchLoginSchema }), req.params, reply);
        if (!params) return reply;
        if (params.login === deps.ownerLogin) return fail(reply, 400, "owner");
        const k = generateAccessKey();
        const row = await repo.setChannelKey(db, params.login, { hash: k.hash, prefix: k.prefix });
        if (!row) return fail(reply, 404, "not_found");
        // Si la clave anterior se filtró, lo que se abrió con ella tiene que cerrarse.
        const streamer = await repo.findStreamerForAllowed(db, row);
        if (streamer) await repo.deleteSessionsForStreamer(db, streamer.id);
        return reply.code(201).send({ key: k.key, prefix: k.prefix });
      });

      admin.delete("/channels/:login/key", async (req, reply) => {
        if (!onlyAdmin(req, reply)) return reply;
        const params = parse(z.object({ login: TwitchLoginSchema }), req.params, reply);
        if (!params) return reply;
        const row = await repo.clearChannelKey(db, params.login);
        if (!row) return fail(reply, 404, "not_found");
        const streamer = await repo.findStreamerForAllowed(db, row);
        if (streamer) await repo.deleteSessionsForStreamer(db, streamer.id);
        return reply.code(204).send();
      });

      // Plan y especies exclusivas de un canal.
      admin.patch("/channels/:login", async (req, reply) => {
        if (!onlyAdmin(req, reply)) return reply;
        const params = parse(z.object({ login: TwitchLoginSchema }), req.params, reply);
        if (!params) return reply;
        const body = parse(
          z
            .object({ plan: PlanSchema.optional(), species: z.array(SpeciesIdSchema).max(100).optional() })
            .strict()
            .refine((b) => b.plan !== undefined || b.species !== undefined, "nada que cambiar"),
          req.body,
          reply,
        );
        if (!body) return reply;
        if (params.login === deps.ownerLogin) return fail(reply, 400, "owner");
        const list = body.species !== undefined ? [...new Set(body.species)] : undefined;
        if (list) {
          for (const id of list) {
            const e = species.list().find((x) => x.id === id);
            if (!e) return fail(reply, 400, "unknown_species");
            if (e.scope !== "exclusive") return fail(reply, 400, "not_exclusive");
          }
        }
        const found = (await repo.listAllowedChannels(db)).find((r) => r.login === params.login);
        if (!found) return fail(reply, 404, "not_found");
        if (body.plan !== undefined) await repo.setChannelPlan(db, params.login, body.plan);
        if (list) await repo.setChannelSpecies(db, params.login, list);
        // Quien pierde una especie pasa a una permitida, y el overlay se entera al instante.
        const streamer = await repo.findStreamerForAllowed(db, found);
        if (streamer) await service.refreshAccess(streamer.id);
        const row = (await repo.listAllowedChannels(db)).find((r) => r.login === params.login) as AllowedChannelRow;
        const grants = await repo.listChannelGrants(db);
        return channelItem(row, grants.get(row.id) ?? []);
      });

      admin.delete("/channels/:login", async (req, reply) => {
        if (!onlyAdmin(req, reply)) return reply;
        const params = parse(z.object({ login: TwitchLoginSchema }), req.params, reply);
        if (!params) return reply;
        if (params.login === deps.ownerLogin) return fail(reply, 400, "owner");
        const row = await repo.removeAllowedChannel(db, params.login);
        if (!row) return fail(reply, 404, "not_found");
        // Se le corta el acceso ya: sus sesiones se cierran y deja de leerse su chat.
        const streamer = await repo.findStreamerForAllowed(db, row);
        if (streamer) {
          await repo.deleteSessionsForStreamer(db, streamer.id);
          deps.onChannelRemoved?.(streamer.id);
        }
        return reply.code(204).send();
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
        if (body.speciesId !== undefined && !(await access.isAllowed(sid(req), body.speciesId))) {
          return fail(reply, 403, "species_locked");
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
        if (body.defaultSpeciesId && !(await access.isAllowed(sid(req), body.defaultSpeciesId))) {
          return fail(reply, 403, "species_locked");
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
