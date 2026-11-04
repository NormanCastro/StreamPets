import { zipSync } from "fflate";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { BuiltApp } from "../src/app.js";
import type { DbHandle } from "../src/db/client.js";
import * as repo from "../src/db/repo.js";
import { customSheetMeta, customSpeciesDef, parsePack } from "../src/domain/custom-pets.js";
import { PACK, convertPetPack, packSheetMeta, packSpeciesDef } from "../src/domain/pet-pack.js";
import { parsePixelLabSheet } from "../../../packages/engine/src/assets/pixellab.js";
import { ASSETS_DIR, FakeClock, makeCatalog, makeTestDb } from "./helpers.js";

const ADMIN = "test-admin-token-1234567890abcd";
const adm = { authorization: `Bearer ${ADMIN}` };
const csrf = { "x-streampets-csrf": "1" };
const AUTH = { cookieSecure: true, publicOrigin: "https://streampets.live", sessionTtlMs: 3_600_000 };
const SESSION = "__Host-sp_session";

/** Cuadro w×h con un rectángulo "cuerpo" opaco; `shift` lo mueve para que cada cuadro sea distinto. */
function frame(w: number, h: number, o: { shift?: number; box?: [number, number, number, number]; color?: [number, number, number] } = {}): Buffer {
  const png = new PNG({ width: w, height: h });
  const [x0, y0, bw, bh] = o.box ?? [Math.floor(w / 4), Math.floor(h / 4), Math.floor(w / 2), Math.floor(h / 2)];
  const c = o.color ?? [200, 40, 40];
  for (let y = y0; y < y0 + bh; y++) {
    for (let x = x0 + (o.shift ?? 0); x < x0 + (o.shift ?? 0) + bw && x < w; x++) {
      const i = (y * w + x) * 4;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

type Files = Record<string, Uint8Array>;
/** Paquete estilo "medusa": Idle#/Walk#/Attack# más animaciones que se ignoran, cuadros de 128×128. */
function pack(o: { idle?: number; walk?: number; attack?: number; size?: number; extra?: Files } = {}): Files {
  const size = o.size ?? 128;
  const f: Files = {};
  for (let i = 1; i <= (o.idle ?? 3); i++) f[`Idle${i}.png`] = frame(size, size, { shift: i });
  for (let i = 1; i <= (o.walk ?? 4); i++) f[`Walk${i}.png`] = frame(size, size, { shift: i * 2 });
  for (let i = 1; i <= (o.attack ?? 6); i++) f[`Attack${i}.png`] = frame(size, size, { shift: i * 3 });
  for (let i = 1; i <= 2; i++) f[`Hurt${i}.png`] = frame(size, size);
  for (let i = 1; i <= 6; i++) f[`Death${i}.png`] = frame(size, size);
  return { ...f, ...(o.extra ?? {}) };
}
const zip = (files: Files): Uint8Array => zipSync(files, { level: 0 });

describe("convertPetPack", () => {
  it("convierte un paquete tipo medusa: usa Idle/Walk/Attack e ignora Hurt/Death", () => {
    const r = convertPetPack(zip(pack()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.used).toEqual({ idle: 3, walk: 4, attack: 6 });
    expect(r.ignored).toEqual(expect.arrayContaining(["Hurt1.png", "Death6.png"]));
    // 128 px con un cuerpo de 64×64 → se reduce a la altura de una pet normal (≤48).
    expect(r.info.shrink).toBe(2);
    expect(r.info.cellH).toBeLessThanOrEqual(PACK.targetH + 4);
    const png = PNG.sync.read(r.png);
    expect(png.width).toBe(6 * r.info.cellW);
    expect(png.height).toBe(9 * r.info.cellH);
    expect(r.png.length).toBeLessThan(PACK.maxSheetBytes);
  });

  /** Igual que el motor: cada clip apunta a una animación de la hoja con las vistas que necesita. */
  const clipFrames = (def: ReturnType<typeof packSpeciesDef>, sheet: ReturnType<typeof parsePixelLabSheet>, clip: string, view: string) => {
    const src = (def.clips as Record<string, { source: string } | undefined>)[clip]?.source;
    return src ? sheet.animations.get(src)?.get(view as never)?.length : undefined;
  };

  it("la hoja y los clips generados los entiende el motor (ataque incluido y de una sola vez)", () => {
    const r = convertPetPack(zip(pack()));
    if (!r.ok) throw new Error("debía convertir");
    const sheet = parsePixelLabSheet(packSheetMeta("u-12345678", r.info));
    const def = packSpeciesDef("u-12345678", "Medusa", r.info);
    expect(clipFrames(def, sheet, "idle", "south")).toBe(3);
    expect(clipFrames(def, sheet, "idle", "west")).toBe(3);
    expect(clipFrames(def, sheet, "walk", "west")).toBe(4);
    expect(clipFrames(def, sheet, "run", "east")).toBe(4);
    expect(clipFrames(def, sheet, "attack", "east")).toBe(6);
    expect(clipFrames(def, sheet, "attack", "west")).toBe(6);
    expect(def.clips.attack?.loop).toBe(false);
    expect(sheet.sheetW).toBe(PNG.sync.read(r.png).width);
    expect(sheet.sheetH).toBe(PNG.sync.read(r.png).height);
  });

  it("sin Attack también sirve (es opcional) y la hoja no trae esas filas", () => {
    const r = convertPetPack(zip(pack({ attack: 0 })));
    if (!r.ok) throw new Error("debía convertir");
    expect(r.info.attack).toBe(0);
    const def = packSpeciesDef("u-12345678", "X", r.info);
    expect(def.clips.attack).toBeUndefined();
    const sheet = parsePixelLabSheet(packSheetMeta("u-12345678", r.info));
    expect(sheet.animations.has("Attack")).toBe(false);
    expect(PNG.sync.read(r.png).height).toBe(7 * r.info.cellH);
  });

  it("ordena por número (Walk10 después de Walk2), acepta carpetas y rutas con espacios, ignora __MACOSX", () => {
    const files: Files = {};
    for (const n of [1, 2, 10, 3]) files[`medusa/Walk ${n}.PNG`] = frame(64, 64, { shift: n });
    files["medusa/Idle_1.png"] = frame(64, 64);
    files["__MACOSX/medusa/Idle1.png"] = Buffer.from("basura");
    files["medusa/notas.txt"] = Buffer.from("hola");
    const r = convertPetPack(zip(files));
    expect(r.ok && r.used).toEqual({ idle: 1, walk: 4, attack: 0 });
  });

  it("flip refleja el dibujo (el original mira a la izquierda)", () => {
    const files = pack({ attack: 0, size: 64 });
    const a = convertPetPack(zip(files));
    const b = convertPetPack(zip(files), { flip: true });
    if (!a.ok || !b.ok) throw new Error("debían convertir");
    const pa = PNG.sync.read(a.png);
    const pb = PNG.sync.read(b.png);
    const { cellW, cellH } = a.info;
    // Fila 2 (Idle east) sin flip == fila 3 (Idle west) con flip, y están reflejadas entre sí.
    const cell = (p: PNG, row: number, x: number, y: number) => p.data[((row * cellH + y) * p.width + x) * 4 + 3];
    let same = 0;
    let mirrored = 0;
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        if (cell(pa, 2, x, y) === cell(pb, 3, x, y)) same++;
        if (cell(pa, 2, x, y) === cell(pa, 3, cellW - 1 - x, y)) mirrored++;
      }
    }
    expect(same).toBe(cellW * cellH);
    expect(mirrored).toBe(cellW * cellH);
  });

  it("los pies quedan abajo y el punto de apoyo no se sale de la celda", () => {
    const r = convertPetPack(zip(pack({ attack: 0 })));
    if (!r.ok) throw new Error("debía convertir");
    expect(r.info.anchorY).toBeLessThan(r.info.cellH);
    expect(r.info.anchorX).toBe(Math.floor(r.info.cellW / 2));
  });

  it.each([
    ["no es un zip", () => Buffer.from("esto no es un zip, solo texto"), "bad_zip"],
    ["sin imágenes con esos nombres", () => zip({ "a.png": frame(64, 64), "b.png": frame(64, 64) }), "no_frames"],
    ["falta Idle", () => zip(pack({ idle: 0 })), "missing_idle"],
    ["falta Walk", () => zip(pack({ walk: 0 })), "missing_walk"],
    ["Walk con un solo cuadro", () => zip(pack({ walk: 1 })), "walk_needs_two"],
    ["demasiados cuadros", () => zip(pack({ walk: PACK.maxFrames + 1, size: 16 })), "too_many_frames"],
    ["cuadro diminuto", () => zip(pack({ size: 8 })), "bad_frame_size"],
    ["cuadro enorme", () => zip(pack({ size: 300 })), "bad_frame_size"],
    ["tamaños distintos", () => zip(pack({ attack: 0, extra: { "Idle2.png": frame(64, 64) } })), "mixed_sizes"],
    ["PNG dañado", () => zip(pack({ extra: { "Idle1.png": Buffer.from("no soy png") } })), "bad_png"],
    ["cuadros vacíos", () => zip({ "Idle1.png": frame(32, 32, { box: [0, 0, 0, 0] }), "Walk1.png": frame(32, 32, { box: [0, 0, 0, 0] }), "Walk2.png": frame(32, 32, { box: [0, 0, 0, 0] }) }), "empty_frames"],
  ])("rechaza: %s", (_n, make, code) => {
    const r = convertPetPack(make());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(code);
  });

  it("rechaza zips grandes, con demasiados archivos o con un archivo gigante", () => {
    expect(convertPetPack(new Uint8Array(PACK.maxZipBytes + 1)).ok).toBe(false);
    const many: Files = {};
    for (let i = 0; i < PACK.maxEntries + 1; i++) many[`f${i}.txt`] = Buffer.from("x");
    const r1 = convertPetPack(zip(many));
    expect(!r1.ok && r1.error).toBe("too_many_files");
    const big = convertPetPack(zip({ "Idle1.png": new Uint8Array(PACK.maxFileBytes + 1) }));
    expect(!big.ok && big.error).toBe("file_too_large");
  });

  it("un PNG que declara medidas gigantes se rechaza por el encabezado, sin decodificarlo (no gasta memoria)", () => {
    const small = frame(32, 32);
    const huge = Buffer.from(small);
    huge.writeUInt32BE(60_000, 16); // ancho
    huge.writeUInt32BE(60_000, 20); // alto
    const before = process.memoryUsage().rss;
    const r = convertPetPack(zip({ "Idle1.png": huge, "Walk1.png": small, "Walk2.png": small }));
    expect(!r.ok && r.error).toBe("bad_frame_size");
    expect(process.memoryUsage().rss - before).toBeLessThan(100_000_000);
  });

  it("es determinista: el mismo zip da la misma hoja", () => {
    const a = convertPetPack(zip(pack()));
    const b = convertPetPack(zip(pack()));
    expect(a.ok && b.ok && Buffer.compare(a.png, b.png)).toBe(0);
  });
});

describe("parsePack y compatibilidad con la plantilla fija", () => {
  it("parsePack acepta lo válido y descarta basura (→ plantilla fija)", () => {
    expect(parsePack(null)).toBeNull();
    expect(parsePack("no json")).toBeNull();
    expect(parsePack('{"cellW":-1}')).toBeNull();
    const r = convertPetPack(zip(pack()));
    if (!r.ok) throw new Error("x");
    expect(parsePack(JSON.stringify(r.info))).toEqual(r.info);
  });
  it("sin pack se mantiene la plantilla de 520×280", () => {
    expect(customSheetMeta("u-12345678").spritesheet.sheet_size).toEqual({ width: 520, height: 280 });
    expect(customSpeciesDef("u-12345678", "x").clips).not.toHaveProperty("attack");
  });
});

describe("rutas: vista previa y envío del .zip", () => {
  let handle: DbHandle;
  let built: BuiltApp;
  beforeEach(async () => {
    handle = await makeTestDb();
    const ownerId = (await repo.ensureStreamer(handle.db, { login: "nazhika", displayName: "Nazhika" })).id;
    await repo.addAllowedChannel(handle.db, "nazhika");
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
  const call = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
    built.app.inject({ method, url, headers: { host: "streampets.live", ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const b64 = (f: Files) => Buffer.from(zip(f)).toString("base64");

  it("la vista previa convierte sin guardar nada y avisa qué se usó e ignoró", async () => {
    const r = await call("POST", "/api/admin/custom-pets/preview", adm, { zip: b64(pack()) });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.png).toMatch(/^data:image\/png;base64,/);
    expect(j.used).toEqual({ idle: 3, walk: 4, attack: 6 });
    expect(j.pack).toMatchObject({ idle: 3, walk: 4, attack: 6 });
    expect(j.ignored).toContain("Hurt1.png");
    expect((await call("GET", "/api/admin/custom-pets", adm)).json().items).toHaveLength(0);
  });

  it("la vista previa explica el error del paquete", async () => {
    const r = await call("POST", "/api/admin/custom-pets/preview", adm, { zip: b64(pack({ walk: 0 })) });
    expect([r.statusCode, r.json().error]).toEqual([400, "missing_walk"]);
    expect((await call("POST", "/api/admin/custom-pets/preview", adm, { zip: "!!" })).statusCode).toBe(400);
    expect((await call("POST", "/api/admin/custom-pets/preview", adm, { zip: "AAAA", extra: 1 })).statusCode).toBe(400);
  });

  it("enviar el zip lo deja pendiente; al aprobarlo se sirve con sus medidas y el ataque", async () => {
    const up = await call("POST", "/api/admin/custom-pets", adm, { name: "Medusa", zip: b64(pack()) });
    expect([up.statusCode, up.json().status]).toEqual([201, "pending"]);
    const id = up.json().id as string;
    const list = (await call("GET", "/api/admin/custom-pets", adm)).json();
    expect(list.items[0].pack).toMatchObject({ idle: 3, walk: 4, attack: 6 });
    expect((await call("GET", `/api/custom-species/${id}/sheet.png`, {})).statusCode).toBe(404);

    await call("POST", `/api/admin/moderation/pets/${id}/approve`, adm);
    const def = (await call("GET", `/api/custom-species/${id}/species.json`, {})).json();
    expect(def.clips.attack).toEqual({ source: "Attack", fps: 12, loop: false });
    const meta = (await call("GET", `/api/custom-species/${id}/sheet.json`, {})).json();
    const png = await call("GET", `/api/custom-species/${id}/sheet.png`, {});
    const real = PNG.sync.read(png.rawPayload);
    expect(meta.spritesheet.sheet_size).toEqual({ width: real.width, height: real.height });
    const sheet = parsePixelLabSheet(meta);
    expect(sheet.animations.get(def.clips.attack.source)?.get("west")).toHaveLength(6);
  });

  it("exige png o zip (no ambos ni ninguno) y respeta el cupo", async () => {
    expect((await call("POST", "/api/admin/custom-pets", adm, { name: "a" })).statusCode).toBe(400);
    expect((await call("POST", "/api/admin/custom-pets", adm, { name: "a", png: "AAAA", zip: "AAAA" })).statusCode).toBe(400);
    for (let i = 0; i < 3; i++) expect((await call("POST", "/api/admin/custom-pets", adm, { name: `P${i}`, zip: b64(pack({ attack: 0 })) })).statusCode).toBe(201);
    expect((await call("POST", "/api/admin/custom-pets", adm, { name: "P4", zip: b64(pack()) })).json().error).toBe("quota_reached");
  });

  it("un zip malo no consume cupo", async () => {
    const r = await call("POST", "/api/admin/custom-pets", adm, { name: "Mala", zip: b64(pack({ idle: 0 })) });
    expect(r.json().error).toBe("missing_idle");
    expect((await call("GET", "/api/admin/custom-pets", adm)).json().quota.used).toBe(0);
  });
});

void csrf;
void SESSION;
