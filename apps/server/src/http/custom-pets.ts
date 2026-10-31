import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CUSTOM_PET } from "@streampets/shared";
import type { Db } from "../db/client.js";
import * as repo from "../db/repo.js";
import type { ChatService } from "../domain/chat-service.js";
import type { SpeciesAccess } from "../domain/access.js";
import { customQuota, customSheetMeta, customSpeciesDef, newCustomPetId, reloadCustomSpecies } from "../domain/custom-pets.js";
import type { SpeciesCatalog } from "../domain/species.js";
import { sanitizePng } from "../lib/png.js";

const ID_RE = /^u-[0-9a-f]{8}$/;

function fail(reply: FastifyReply, status: number, error: string, details?: unknown): FastifyReply {
  return reply.code(status).send({ error, ...(details === undefined ? {} : { details }) });
}

const bytesOf = (b: Uint8Array): Buffer => Buffer.from(b);
const dataUrl = (b: Uint8Array): string => `data:image/png;base64,${bytesOf(b).toString("base64")}`;

/** Archivos de las pets APROBADAS: los lee el overlay sin iniciar sesión. */
export function registerCustomPetPublicRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const approved = async (id: string, reply: FastifyReply) => {
    if (!ID_RE.test(id)) {
      fail(reply, 404, "not_found");
      return undefined;
    }
    const row = await repo.getCustomPet(deps.db, id);
    if (!row || row.status !== "approved") {
      fail(reply, 404, "not_found");
      return undefined;
    }
    return row;
  };
  app.get("/api/custom-species/:id/species.json", async (req, reply) => {
    const row = await approved((req.params as { id: string }).id, reply);
    if (!row) return reply;
    reply.header("Cache-Control", "public, max-age=60");
    return customSpeciesDef(row.id, row.name);
  });
  app.get("/api/custom-species/:id/sheet.json", async (req, reply) => {
    const row = await approved((req.params as { id: string }).id, reply);
    if (!row) return reply;
    reply.header("Cache-Control", "public, max-age=60");
    return customSheetMeta(row.id);
  });
  app.get("/api/custom-species/:id/sheet.png", async (req, reply) => {
    const row = await approved((req.params as { id: string }).id, reply);
    if (!row) return reply;
    return reply.header("Cache-Control", "public, max-age=60").type("image/png").send(bytesOf(row.png));
  });
}

export interface CustomPetAdminDeps {
  db: Db;
  service: ChatService;
  species: SpeciesCatalog;
  access: SpeciesAccess;
  /** Streamer del dueño de la instalación: también puede moderar. */
  ownerStreamerId: string;
  now?: (() => Date) | undefined;
}

const UploadBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(CUSTOM_PET.nameMax)
      .regex(/^[\p{L}\p{N} _.'-]+$/u, "solo letras, números y espacios"),
    /** PNG en base64 (sin el prefijo data:). */
    png: z.string().max(Math.ceil((CUSTOM_PET.maxBytes * 4) / 3) + 16).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();

const ReviewBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();

/** Rutas de subida y moderación; se registran dentro del plugin autenticado de /api/admin. */
export function registerCustomPetAdminRoutes(
  admin: FastifyInstance,
  deps: CustomPetAdminDeps,
  who: { sid: (req: FastifyRequest) => string; isModerator: (req: FastifyRequest) => boolean },
): void {
  const { db, service, species, access } = deps;
  const now = () => (deps.now ? deps.now() : new Date());

  /** Se llama cuando cambia lo aprobado: actualiza el catálogo y reubica a quien usaba una pet que ya no está. */
  const resync = async (ownerStreamerId: string): Promise<void> => {
    await reloadCustomSpecies(db, species);
    await service.refreshAccess(ownerStreamerId);
  };

  const view = async (r: repo.CustomPetMeta) => {
    const full = await repo.getCustomPet(db, r.id);
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      rejectReason: r.rejectReason,
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
      png: full ? dataUrl(full.png) : null,
    };
  };

  // ── Del canal ──
  admin.get("/custom-pets", async (req) => {
    const sid = who.sid(req);
    const plan = (await access.info(sid)).plan;
    const items = await repo.listCustomPetsOf(db, sid);
    return {
      items: await Promise.all(items.slice(0, 20).map(view)),
      quota: { used: await repo.countActiveCustomPets(db, sid), max: customQuota(plan) },
    };
  });

  admin.post(
    "/custom-pets",
    { bodyLimit: 220 * 1024, config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const sid = who.sid(req);
      const parsed = UploadBody.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, "invalid_request");
      const max = customQuota((await access.info(sid)).plan);
      if (max === 0) return fail(reply, 403, "plan_required");
      if ((await repo.countActiveCustomPets(db, sid)) >= max) return fail(reply, 403, "quota_reached");

      const check = sanitizePng(Buffer.from(parsed.data.png, "base64"), CUSTOM_PET.sheetWidth, CUSTOM_PET.sheetHeight, CUSTOM_PET.maxBytes);
      if (!check.ok) return fail(reply, 400, check.error);

      const id = newCustomPetId();
      await repo.insertCustomPet(db, { id, streamerId: sid, name: parsed.data.name, png: check.png });
      return reply.code(201).send({ id, status: "pending" });
    },
  );

  admin.delete("/custom-pets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID_RE.test(id)) return fail(reply, 404, "not_found");
    const row = await repo.getCustomPet(db, id);
    if (!row || (row.streamerId !== who.sid(req) && !who.isModerator(req))) return fail(reply, 404, "not_found");
    await repo.deleteCustomPet(db, id);
    if (row.status === "approved") await resync(row.streamerId);
    return reply.code(204).send();
  });

  // ── Moderación ──
  admin.get("/moderation/pets", async (req, reply) => {
    if (!who.isModerator(req)) return fail(reply, 403, "forbidden");
    const q = z.object({ status: z.enum(["pending", "approved", "rejected", "all"]).default("pending") }).safeParse(req.query);
    if (!q.success) return fail(reply, 400, "invalid_request");
    const rows = (await repo.listCustomPetsForReview(db, q.data.status === "all" ? undefined : q.data.status)).slice(0, 100);
    return { items: await Promise.all(rows.map(async (r) => ({ ...(await view(r)), login: r.login }))) };
  });

  admin.post("/moderation/pets/:id/approve", async (req, reply) => {
    if (!who.isModerator(req)) return fail(reply, 403, "forbidden");
    const { id } = req.params as { id: string };
    const row = ID_RE.test(id) ? await repo.getCustomPet(db, id) : undefined;
    if (!row) return fail(reply, 404, "not_found");
    await repo.reviewCustomPet(db, id, "approved", null, now());
    await resync(row.streamerId);
    return { id, status: "approved" };
  });

  admin.post("/moderation/pets/:id/reject", async (req, reply) => {
    if (!who.isModerator(req)) return fail(reply, 403, "forbidden");
    const { id } = req.params as { id: string };
    const body = ReviewBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, "invalid_request");
    const row = ID_RE.test(id) ? await repo.getCustomPet(db, id) : undefined;
    if (!row) return fail(reply, 404, "not_found");
    await repo.reviewCustomPet(db, id, "rejected", body.data.reason || null, now());
    await resync(row.streamerId);
    return { id, status: "rejected" };
  });
}
