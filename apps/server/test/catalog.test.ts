import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { BuiltApp } from "../src/app.js";
import type { DbHandle } from "../src/db/client.js";
import * as repo from "../src/db/repo.js";
import { ASSETS_DIR, FakeClock, makeCatalog, makeTestDb } from "./helpers.js";

const ADMIN = "test-admin-token-1234567890abcd";
const adm = { authorization: `Bearer ${ADMIN}` };
const csrf = { "x-streampets-csrf": "1" };
const AUTH = { cookieSecure: true, publicOrigin: "https://streampets.live", sessionTtlMs: 3_600_000 };
const SESSION = "__Host-sp_session";
const IDS = ["shiba", "gato", "dragon", "zorro", "honguito"];
const extra = { dragon: { tier: "premium" as const }, zorro: { scope: "exclusive" as const } };

let handle: DbHandle;
let built: BuiltApp;
let ownerId: string;

const mk = () => makeCatalog(IDS, extra);
const boot = (catalog = mk()) =>
  buildApp({
    db: handle.db, species: catalog, adminToken: ADMIN, streamerId: ownerId, ownerLogin: "nazhika",
    auth: AUTH, assetsDir: ASSETS_DIR, overlayDist: "/nonexistent", logLevel: "silent", clock: new FakeClock(),
  });

beforeEach(async () => {
  handle = await makeTestDb();
  ownerId = (await repo.ensureStreamer(handle.db, { login: "nazhika", displayName: "Nazhika" })).id;
  for (const l of ["nazhika", "amiga", "otra"]) await repo.addAllowedChannel(handle.db, l);
  await repo.setChannelPlan(handle.db, "amiga", "premium");
  built = await boot();
  await built.app.ready();
});
afterEach(async () => {
  await built.app.close();
  await handle.close();
});

const inject = (method: "GET" | "POST" | "PATCH", url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  built.app.inject({ method, url, headers: { host: "streampets.live", ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function login(channel: string): Promise<Record<string, string>> {
  const k = (await inject("POST", `/api/admin/channels/${channel}/key`, adm)).json().key as string;
  const r = await inject("POST", "/auth/key", csrf, { key: k });
  const raw = r.headers["set-cookie"];
  const c = (Array.isArray(raw) ? (raw as string[]) : [String(raw)]).find((x) => x.startsWith(SESSION)) as string;
  return { cookie: c.split(";")[0] as string, ...csrf };
}
async function streamerOf(login: string): Promise<string> {
  return (await repo.ensureStreamer(handle.db, { login, displayName: login })).id;
}
/** Crea un espectador con esa especie en ese canal. */
async function addPet(streamerId: string, viewer: string, speciesId: string): Promise<string> {
  await built.service.handleMessage({ streamerId, twitchUserId: viewer, login: viewer, displayName: viewer, isSubscriber: false });
  const v = (await repo.listViewersWithPets(handle.db, streamerId, { query: viewer, limit: 5, offset: 0 })).items[0]!.viewer;
  await repo.updatePet(handle.db, streamerId, v.id, { speciesId });
  await built.service.applyPetChange(streamerId, v.id);
  return v.id;
}
const catalog = async () => (await inject("GET", "/api/admin/catalog", adm)).json().items as Array<Record<string, unknown>>;

describe("catálogo para el administrador", () => {
  it("solo lo ve el administrador (o el dueño); un streamer recibe 403", async () => {
    const amiga = await login("amiga");
    expect((await inject("GET", "/api/admin/catalog", amiga)).statusCode).toBe(403);
    expect((await inject("PATCH", "/api/admin/catalog/shiba", amiga, { disabled: true })).statusCode).toBe(403);
    expect((await inject("GET", "/api/admin/catalog")).statusCode).toBe(401);
    expect((await inject("GET", "/api/admin/catalog", adm)).statusCode).toBe(200);
  });

  it("lista TODAS las especies con su categoría, y cuenta canales y mascotas", async () => {
    await login("amiga");
    await login("otra");
    const amiga = await streamerOf("amiga");
    const otra = await streamerOf("otra");
    await addPet(amiga, "v1", "shiba");
    await addPet(amiga, "v2", "shiba");
    await addPet(otra, "v3", "shiba");
    await addPet(amiga, "v4", "gato");
    const items = await catalog();
    expect(items.map((i) => i.id).sort()).toEqual([...IDS].sort());
    const by = (id: string) => items.find((i) => i.id === id)!;
    expect(by("shiba")).toMatchObject({ category: "free", channels: 2, pets: 3, disabled: false, custom: false });
    expect(by("gato")).toMatchObject({ channels: 1, pets: 1 });
    expect(by("dragon")).toMatchObject({ category: "premium", premium: true, channels: 0, pets: 0 });
    expect(by("zorro")).toMatchObject({ category: "exclusive" });
    expect(by("honguito")).toMatchObject({ category: "free", channels: 0 });
  });

  it("va ordenado de la más usada a la menos usada", async () => {
    await login("amiga");
    await login("otra");
    const amiga = await streamerOf("amiga");
    const otra = await streamerOf("otra");
    await addPet(amiga, "v1", "gato");
    await addPet(otra, "v2", "gato");
    await addPet(amiga, "v3", "shiba");
    await addPet(amiga, "v4", "shiba");
    await addPet(amiga, "v5", "shiba");
    const ids = (await catalog()).map((i) => i.id);
    expect(ids.slice(0, 2)).toEqual(["gato", "shiba"]); // gato: 2 canales; shiba: 1 canal aunque tenga más mascotas
  });

  it("una pet propia aparece como exclusiva con el canal dueño", async () => {
    await login("amiga");
    // se crea directo en la base y se aprueba por la API
    const id = "u-0a0a0a0a";
    await repo.insertCustomPet(handle.db, { id, streamerId: await streamerOf("amiga"), name: "Pollito", png: Buffer.from("x") });
    await inject("POST", `/api/admin/moderation/pets/${id}/approve`, adm);
    expect((await catalog()).find((i) => i.id === id)).toMatchObject({ category: "exclusive", custom: true, ownerLogin: "amiga", name: "Pollito" });
  });
});

describe("apagar y encender una especie", () => {
  it("al apagarla, quienes la tenían pasan a otra y nadie nuevo la recibe", async () => {
    const amigaH = await login("amiga");
    const amiga = await streamerOf("amiga");
    const ids = [await addPet(amiga, "v1", "shiba"), await addPet(amiga, "v2", "shiba")];
    const r = await inject("PATCH", "/api/admin/catalog/shiba", adm, { disabled: true });
    expect([r.statusCode, r.json()]).toEqual([200, { id: "shiba", disabled: true }]);
    for (const id of ids) expect((await repo.getViewerWithPet(handle.db, amiga, id))?.pet?.speciesId).not.toBe("shiba");
    expect((await catalog()).find((i) => i.id === "shiba")).toMatchObject({ disabled: true, channels: 0 });

    for (let i = 0; i < 40; i++) await built.service.handleMessage({ streamerId: amiga, twitchUserId: `n${i}`, login: `n${i}`, displayName: `n${i}`, isSubscriber: false });
    const all = await repo.listViewersWithPets(handle.db, amiga, { limit: 100, offset: 0 });
    expect(all.items.length).toBeGreaterThan(30);
    expect(all.items.some((v) => v.pet?.speciesId === "shiba")).toBe(false);

    // el canal la ve bloqueada y no puede elegirla
    const sp = (await inject("GET", "/api/admin/species", amigaH)).json().species as Array<{ id: string; disabled: boolean; locked: boolean }>;
    expect(sp.find((s) => s.id === "shiba")).toMatchObject({ disabled: true, locked: true });
    expect((await inject("PATCH", "/api/admin/settings", amigaH, { defaultSpeciesId: "shiba" })).json().error).toBe("species_locked");
  });

  it("tampoco la puede usar el dueño de la instalación", async () => {
    await inject("PATCH", "/api/admin/catalog/gato", adm, { disabled: true });
    expect((await inject("PATCH", "/api/admin/settings", adm, { defaultSpeciesId: "gato" })).statusCode).toBe(403);
    expect((await inject("PATCH", "/api/admin/settings", adm, { defaultSpeciesId: "shiba" })).statusCode).toBe(200);
  });

  it("al encenderla de nuevo vuelve a poder usarse", async () => {
    const amigaH = await login("amiga");
    await inject("PATCH", "/api/admin/catalog/gato", adm, { disabled: true });
    expect((await inject("PATCH", "/api/admin/settings", amigaH, { defaultSpeciesId: "gato" })).statusCode).toBe(403);
    expect((await inject("PATCH", "/api/admin/catalog/gato", adm, { disabled: false })).json().disabled).toBe(false);
    expect((await inject("PATCH", "/api/admin/settings", amigaH, { defaultSpeciesId: "gato" })).statusCode).toBe(200);
  });

  it("también apaga una especie premium o exclusiva, y se mantiene al reiniciar el servidor", async () => {
    await inject("PATCH", "/api/admin/catalog/dragon", adm, { disabled: true });
    const c2 = mk();
    const again = await boot(c2);
    await again.app.ready();
    expect(c2.isDisabled("dragon")).toBe(true);
    expect(c2.isDisabled("shiba")).toBe(false);
    await again.app.close();
  });

  it("valida el cuerpo y el id", async () => {
    expect((await inject("PATCH", "/api/admin/catalog/fantasma", adm, { disabled: true })).statusCode).toBe(404);
    expect((await inject("PATCH", "/api/admin/catalog/shiba", adm, { disabled: "si" })).statusCode).toBe(400);
    expect((await inject("PATCH", "/api/admin/catalog/shiba", adm, { disabled: true, extra: 1 })).statusCode).toBe(400);
    expect((await inject("PATCH", "/api/admin/catalog/shiba", adm, {})).statusCode).toBe(400);
  });
});
