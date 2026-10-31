import { deflateSync, crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { BuiltApp } from "../src/app.js";
import type { DbHandle } from "../src/db/client.js";
import * as repo from "../src/db/repo.js";
import { customSheetMeta, customSpeciesDef } from "../src/domain/custom-pets.js";
import { sanitizePng } from "../src/lib/png.js";
import { parsePixelLabSheet } from "../../../packages/engine/src/assets/pixellab.js";
import { ASSETS_DIR, FakeClock, makeCatalog, makeTestDb } from "./helpers.js";

const W = 520;
const H = 280;
const ADMIN = "test-admin-token-1234567890abcd";
const adm = { authorization: `Bearer ${ADMIN}` };
const csrf = { "x-streampets-csrf": "1" };
const AUTH = { cookieSecure: true, publicOrigin: "https://streampets.live", sessionTtlMs: 3_600_000 };
const SESSION = "__Host-sp_session";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** PNG RGBA válido de w×h (todo transparente salvo un píxel), con bloques opcionales. */
function makePng(o: { w?: number; h?: number; interlace?: number; extra?: Buffer[]; badCrc?: boolean } = {}): Buffer {
  const w = o.w ?? W;
  const h = o.h ?? H;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[12] = o.interlace ?? 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  const idat = chunk("IDAT", deflateSync(raw));
  if (o.badCrc) idat[idat.length - 1] = (idat[idat.length - 1]! + 1) & 0xff;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(o.extra ?? []),
    idat,
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("sanitizePng", () => {
  it("acepta el tamaño exacto y descarta bloques de texto/metadatos", () => {
    const withText = makePng({ extra: [chunk("tEXt", Buffer.from("Author\0yo")), chunk("eXIf", Buffer.from("secreto"))] });
    const r = sanitizePng(withText, W, H, 120_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.png.includes(Buffer.from("tEXt"))).toBe(false);
      expect(r.png.includes(Buffer.from("secreto"))).toBe(false);
      expect(sanitizePng(r.png, W, H, 120_000).ok).toBe(true);
    }
  });
  it("rechaza medidas distintas, no-PNG, CRC malo, entrelazado y archivos grandes", () => {
    const err = (b: Buffer, max = 120_000) => {
      const r = sanitizePng(b, W, H, max);
      return r.ok ? "ok" : r.error;
    };
    expect(err(makePng({ w: 256, h: 256 }))).toBe("bad_size");
    expect(err(makePng({ w: W, h: H + 1 }))).toBe("bad_size");
    expect(err(Buffer.from("GIF89a....................................."))).toBe("not_png");
    expect(err(Buffer.alloc(10))).toBe("not_png");
    expect(err(makePng({ badCrc: true }))).toBe("corrupt");
    expect(err(makePng({ interlace: 1 }))).toBe("interlaced");
    expect(err(makePng(), 50)).toBe("too_large");
    expect(err(Buffer.concat([makePng(), Buffer.from("basura")]))).toBe("corrupt");
    expect(err(makePng().subarray(0, 60))).toBe("corrupt");
  });
});

describe("hoja de una pet personalizada", () => {
  it("la descripción generada la entiende el motor y trae todos los clips y direcciones", () => {
    const sheet = parsePixelLabSheet(customSheetMeta("u-12345678"));
    expect([sheet.sheetW, sheet.sheetH, sheet.cellW]).toEqual([W, H, 40]);
    const def = customSpeciesDef("u-12345678", "Mi pet");
    // Cada clip apunta a una animación que existe, con las direcciones y la cantidad de cuadros de la plantilla.
    for (const clip of Object.values(def.clips)) expect(sheet.animations.has(clip.source)).toBe(true);
    expect(sheet.animations.get("Walk")?.get("east")).toHaveLength(13);
    expect(sheet.animations.get("Walk")?.get("west")).toHaveLength(13);
    expect(sheet.animations.get("Idle")?.get("south")).toHaveLength(8);
    expect(sheet.animations.get("Idle")?.get("east")).toHaveLength(8);
    expect(sheet.animations.get("Idle")?.get("west")).toHaveLength(8);
    expect(sheet.rotations.size).toBe(8);
  });
});

let handle: DbHandle;
let built: BuiltApp;
let ownerId: string;

beforeEach(async () => {
  handle = await makeTestDb();
  ownerId = (await repo.ensureStreamer(handle.db, { login: "nazhika", displayName: "Nazhika" })).id;
  for (const l of ["nazhika", "amiga", "otra"]) await repo.addAllowedChannel(handle.db, l);
  await repo.setChannelPlan(handle.db, "amiga", "premium");
  built = await buildApp({
    db: handle.db, species: makeCatalog(), adminToken: ADMIN, streamerId: ownerId, ownerLogin: "nazhika",
    auth: AUTH, assetsDir: ASSETS_DIR, overlayDist: "/nonexistent", logLevel: "silent", clock: new FakeClock(),
  });
  await built.app.ready();
});
afterEach(async () => {
  await built.app.close();
  await handle.close();
});

const inject = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  built.app.inject({ method, url, headers: { host: "streampets.live", ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function login(channel: string): Promise<Record<string, string>> {
  const k = (await inject("POST", `/api/admin/channels/${channel}/key`, adm)).json().key as string;
  const r = await inject("POST", "/auth/key", csrf, { key: k });
  const raw = r.headers["set-cookie"];
  const c = (Array.isArray(raw) ? (raw as string[]) : [String(raw)]).find((x) => x.startsWith(SESSION)) as string;
  return { cookie: c.split(";")[0] as string, ...csrf };
}
const upload = (h: Record<string, string>, name = "Mi pet", png: Buffer = makePng()) =>
  inject("POST", "/api/admin/custom-pets", h, { name, png: png.toString("base64") });

describe("subir (cupos por plan)", () => {
  it("plan gratis no puede subir (403 plan_required)", async () => {
    const otra = await login("otra");
    const r = await upload(otra);
    expect([r.statusCode, r.json().error]).toEqual([403, "plan_required"]);
  });

  it("premium sube hasta 3 (pendientes) y luego recibe quota_reached; rechazadas no cuentan", async () => {
    const amiga = await login("amiga");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await upload(amiga, `Pet ${i}`);
      expect([r.statusCode, r.json().status]).toEqual([201, "pending"]);
      ids.push(r.json().id as string);
    }
    expect((await upload(amiga)).json().error).toBe("quota_reached");
    const list = (await inject("GET", "/api/admin/custom-pets", amiga)).json();
    expect(list.quota).toEqual({ used: 3, max: 3 });
    expect(list.items).toHaveLength(3);
    expect(list.items[0].png).toMatch(/^data:image\/png;base64,/);

    await inject("POST", `/api/admin/moderation/pets/${ids[0]}/reject`, adm, { reason: "no va" });
    expect((await inject("GET", "/api/admin/custom-pets", amiga)).json().quota.used).toBe(2);
    expect((await upload(amiga, "Otra")).statusCode).toBe(201);
  });

  it("valida nombre, medidas, formato y que el cuerpo sea exacto", async () => {
    const amiga = await login("amiga");
    expect((await upload(amiga, "")).statusCode).toBe(400);
    expect((await upload(amiga, "x".repeat(31))).statusCode).toBe(400);
    expect((await upload(amiga, "<script>")).statusCode).toBe(400);
    expect((await upload(amiga, "ok", makePng({ w: 100, h: 100 }))).json().error).toBe("bad_size");
    expect((await upload(amiga, "ok", Buffer.from("hola mundo, esto no es un png de verdad..."))).json().error).toBe("not_png");
    expect((await inject("POST", "/api/admin/custom-pets", amiga, { name: "a", png: "!!!" })).statusCode).toBe(400);
    expect((await inject("POST", "/api/admin/custom-pets", amiga, { name: "a", png: "AAAA", extra: 1 })).statusCode).toBe(400);
    expect((await repo.listCustomPetsOf(handle.db, (await repo.ensureStreamer(handle.db, { login: "amiga", displayName: "A" })).id))).toHaveLength(0);
  });

  it("exige el encabezado CSRF con la cookie y sesión para todo", async () => {
    const amiga = await login("amiga");
    const { cookie } = amiga;
    expect((await inject("POST", "/api/admin/custom-pets", { cookie: cookie as string }, { name: "a", png: "AAAA" })).statusCode).toBe(403);
    expect((await inject("GET", "/api/admin/custom-pets")).statusCode).toBe(401);
    expect((await inject("GET", "/api/custom-species/u-00000000/sheet.png")).statusCode).toBe(404);
  });
});

describe("moderación", () => {
  it("solo el administrador (o el dueño) la ve; un streamer recibe 403", async () => {
    const amiga = await login("amiga");
    await upload(amiga);
    expect((await inject("GET", "/api/admin/moderation/pets", amiga)).statusCode).toBe(403);
    const r = await inject("GET", "/api/admin/moderation/pets", adm);
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toHaveLength(1);
    expect(r.json().items[0]).toMatchObject({ login: "amiga", status: "pending", name: "Mi pet" });
    expect((await inject("GET", "/api/admin/me", adm)).json().moderator).toBe(true);
    expect((await inject("GET", "/api/admin/me", amiga)).json().moderator).toBe(false);
    const id = r.json().items[0].id as string;
    expect((await inject("POST", `/api/admin/moderation/pets/${id}/approve`, amiga)).statusCode).toBe(403);
    expect((await inject("POST", `/api/admin/moderation/pets/${id}/reject`, amiga, {})).statusCode).toBe(403);
    expect((await inject("POST", "/api/admin/moderation/pets/u-ffffffff/approve", adm)).statusCode).toBe(404);
  });

  it("una pet pendiente o rechazada no se sirve ni está en el catálogo; aprobada sí", async () => {
    const amiga = await login("amiga");
    const id = (await upload(amiga)).json().id as string;
    for (const f of ["species.json", "sheet.json", "sheet.png"]) {
      expect((await inject("GET", `/api/custom-species/${id}/${f}`)).statusCode).toBe(404);
    }
    expect(((await inject("GET", "/api/species")).json().species as Array<{ id: string }>).some((s) => s.id === id)).toBe(false);

    expect((await inject("POST", `/api/admin/moderation/pets/${id}/approve`, adm)).json().status).toBe("approved");
    const def = (await inject("GET", `/api/custom-species/${id}/species.json`)).json();
    expect(def).toMatchObject({ id, name: "Mi pet", sheetImage: "sheet.png", sheetMeta: "sheet.json" });
    const meta = (await inject("GET", `/api/custom-species/${id}/sheet.json`)).json();
    expect(meta.spritesheet.sheet_size).toEqual({ width: W, height: H });
    const png = await inject("GET", `/api/custom-species/${id}/sheet.png`);
    expect([png.statusCode, png.headers["content-type"]]).toEqual([200, "image/png"]);
    expect(sanitizePng(png.rawPayload, W, H, 120_000).ok).toBe(true);

    const pub = ((await inject("GET", "/api/species")).json().species as Array<Record<string, unknown>>).find((s) => s.id === id);
    expect(pub).toEqual({ id, name: "Mi pet", url: `/api/custom-species/${id}/species.json`, scope: "exclusive", tier: "free" });

    await inject("POST", `/api/admin/moderation/pets/${id}/reject`, adm, { reason: "no" });
    expect((await inject("GET", `/api/custom-species/${id}/sheet.png`)).statusCode).toBe(404);
    expect(((await inject("GET", "/api/species")).json().species as Array<{ id: string }>).some((s) => s.id === id)).toBe(false);
  });

  it("el motivo del rechazo lo ve quien subió la pet", async () => {
    const amiga = await login("amiga");
    const id = (await upload(amiga)).json().id as string;
    await inject("POST", `/api/admin/moderation/pets/${id}/reject`, adm, { reason: "forma inapropiada" });
    const it = (await inject("GET", "/api/admin/custom-pets", amiga)).json().items[0];
    expect(it).toMatchObject({ status: "rejected", rejectReason: "forma inapropiada" });
    expect((await inject("POST", `/api/admin/moderation/pets/${id}/reject`, adm, { reason: "x".repeat(201) })).statusCode).toBe(400);
  });
});

describe("quién puede usar la pet", () => {
  async function approved(): Promise<{ id: string; amiga: Record<string, string>; amigaId: string }> {
    const amiga = await login("amiga");
    const id = (await upload(amiga)).json().id as string;
    await inject("POST", `/api/admin/moderation/pets/${id}/approve`, adm);
    const amigaId = (await repo.ensureStreamer(handle.db, { login: "amiga", displayName: "Amiga" })).id;
    return { id, amiga, amigaId };
  }
  const listFor = async (h: Record<string, string>) =>
    (await inject("GET", "/api/admin/species", h)).json().species as Array<{ id: string; locked: boolean; custom: boolean }>;

  it("solo su canal la ve y la puede elegir; otros canales y el administrador no", async () => {
    const { id, amiga } = await approved();
    expect(await listFor(amiga)).toContainEqual(expect.objectContaining({ id, locked: false, custom: true }));
    expect((await listFor(adm)).some((s) => s.id === id)).toBe(false);
    const otra = await login("otra");
    expect((await listFor(otra)).some((s) => s.id === id)).toBe(false);
    // El dueño de la instalación tampoco puede usarla (solo el canal que la subió).
    expect((await inject("PATCH", "/api/admin/settings", adm, { defaultSpeciesId: id })).statusCode).toBe(403);
    expect((await inject("PATCH", "/api/admin/settings", amiga, { defaultSpeciesId: id })).statusCode).toBe(200);
  });

  it("no se puede dar como especie exclusiva a otro canal", async () => {
    const { id } = await approved();
    const r = await inject("PATCH", `/api/admin/channels/otra`, adm, { species: [id] });
    expect([r.statusCode, r.json().error]).toEqual([400, "not_exclusive"]);
  });

  it("al eliminarla, el catálogo la pierde y sus espectadores pasan a otra especie", async () => {
    const { id, amiga, amigaId } = await approved();
    await built.service.handleMessage({ streamerId: amigaId, twitchUserId: "v1", login: "v1", displayName: "V1", isSubscriber: false });
    const viewer = (await repo.listViewersWithPets(handle.db, amigaId, { limit: 10, offset: 0 })).items[0]!.viewer;
    await repo.updatePet(handle.db, amigaId, viewer.id, { speciesId: id });
    await built.service.applyPetChange(amigaId, viewer.id);
    expect((await inject("DELETE", `/api/admin/custom-pets/${id}`, adm)).statusCode).toBe(204);
    expect(((await inject("GET", "/api/species")).json().species as Array<{ id: string }>).some((s) => s.id === id)).toBe(false);
    expect((await inject("GET", `/api/custom-species/${id}/sheet.png`)).statusCode).toBe(404);
    expect((await inject("DELETE", `/api/admin/custom-pets/${id}`, adm)).statusCode).toBe(404);
    const after = await repo.getViewerWithPet(handle.db, amigaId, viewer.id);
    expect(after?.pet?.speciesId).not.toBe(id);
    expect(["shiba", "cat", "bunny"]).toContain(after?.pet?.speciesId);
    expect((await inject("PATCH", "/api/admin/settings", amiga, { defaultSpeciesId: id })).statusCode).toBe(400);
  });

  it("un canal solo puede borrar las suyas", async () => {
    const amiga = await login("amiga");
    const id = (await upload(amiga)).json().id as string;
    const otra = await login("otra");
    expect((await inject("DELETE", `/api/admin/custom-pets/${id}`, otra)).statusCode).toBe(404);
    expect((await inject("DELETE", `/api/admin/custom-pets/${id}`, amiga)).statusCode).toBe(204);
  });

  it("al reiniciar el servidor, las aprobadas vuelven al catálogo", async () => {
    const { id } = await approved();
    const catalog = makeCatalog();
    const again = await buildApp({
      db: handle.db, species: catalog, adminToken: ADMIN, streamerId: ownerId, ownerLogin: "nazhika",
      auth: AUTH, assetsDir: ASSETS_DIR, overlayDist: "/nonexistent", logLevel: "silent", clock: new FakeClock(),
    });
    await again.app.ready();
    expect(catalog.has(id)).toBe(true);
    await again.app.close();
  });
});
