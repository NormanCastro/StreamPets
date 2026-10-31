import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { BuiltApp } from "../src/app.js";
import type { DbHandle } from "../src/db/client.js";
import * as repo from "../src/db/repo.js";
import { SpeciesAccess, canUse } from "../src/domain/access.js";
import { seededRng } from "../src/domain/rng.js";
import { hashToken } from "../src/lib/tokens.js";
import { ASSETS_DIR, FakeClock, makeCatalog, makeTestDb } from "./helpers.js";

const ADMIN = "test-admin-token-1234567890abcd";
const adm = { authorization: `Bearer ${ADMIN}` };
const AUTH = { cookieSecure: false, publicOrigin: undefined, sessionTtlMs: 86_400_000 };
const csrf = { "x-streampets-csrf": "1" };

// shiba/gato: de todos · dragon: premium · zorro: exclusiva · tigre: exclusiva y premium
const catalog = () =>
  makeCatalog(["shiba", "gato", "dragon", "zorro", "tigre"], {
    dragon: { tier: "premium" },
    zorro: { scope: "exclusive" },
    tigre: { scope: "exclusive", tier: "premium" },
  });

describe("canUse", () => {
  const e = (scope: "general" | "exclusive", tier: "free" | "premium") => ({ id: "x", scope, tier });
  const a = (plan: "free" | "premium", grants: string[] = [], unrestricted = false) => ({ plan, grants: new Set(grants), unrestricted });

  it("general + free: todos", () => {
    expect(canUse(e("general", "free"), a("free"))).toBe(true);
  });
  it("general + premium: solo plan premium", () => {
    expect(canUse(e("general", "premium"), a("free"))).toBe(false);
    expect(canUse(e("general", "premium"), a("premium"))).toBe(true);
  });
  it("exclusiva + free: solo los canales listados, sea cual sea su plan", () => {
    expect(canUse(e("exclusive", "free"), a("free"))).toBe(false);
    expect(canUse(e("exclusive", "free"), a("premium"))).toBe(false);
    expect(canUse(e("exclusive", "free"), a("free", ["x"]))).toBe(true);
  });
  it("exclusiva + premium: hacen falta las dos cosas", () => {
    expect(canUse(e("exclusive", "premium"), a("premium"))).toBe(false);
    expect(canUse(e("exclusive", "premium"), a("free", ["x"]))).toBe(false);
    expect(canUse(e("exclusive", "premium"), a("premium", ["x"]))).toBe(true);
  });
  it("el dueño (sin restricciones) lo puede todo", () => {
    expect(canUse(e("exclusive", "premium"), a("free", [], true))).toBe(true);
  });
});

describe("SpeciesCatalog.pick con permitidas", () => {
  it("elige solo entre las permitidas y respeta la preferida si está permitida", () => {
    const c = catalog();
    const rng = seededRng(3);
    const allowed = new Set(["shiba", "gato"]);
    for (let i = 0; i < 100; i++) expect(allowed.has(c.pick(rng, null, allowed))).toBe(true);
    expect(c.pick(rng, "gato", allowed)).toBe("gato");
    expect(allowed.has(c.pick(rng, "dragon", allowed))).toBe(true); // preferida no permitida: se ignora
  });
});

let handle: DbHandle;
let built: BuiltApp;
let ownerId: string;
let friendId: string;
let session: string;
let bcast: Array<{ streamerId: string; type: string }>;

const asFriend = (extra: Record<string, string> = {}) => ({ cookie: `sp_session=${session}`, ...extra });

beforeEach(async () => {
  handle = await makeTestDb();
  ownerId = (await repo.ensureStreamer(handle.db, { login: "nazhika", displayName: "Nazhika" })).id;
  await repo.addAllowedChannel(handle.db, "nazhika");
  await repo.addAllowedChannel(handle.db, "amiga");
  const who = { twitchUserId: "200", login: "amiga" };
  const friend = await repo.upsertStreamerFromTwitch(handle.db, who);
  friendId = friend.id;
  await repo.bindAllowedChannel(handle.db, (await repo.findAllowedChannelFor(handle.db, who))!.id, who);
  session = "s".repeat(43);
  await repo.createSession(handle.db, { streamerId: friendId, tokenHash: hashToken(session), expiresAt: new Date(Date.now() + 3_600_000) });
  bcast = [];
  built = await buildApp({
    db: handle.db, species: catalog(), adminToken: ADMIN, streamerId: ownerId, ownerLogin: "nazhika",
    auth: AUTH, assetsDir: ASSETS_DIR, overlayDist: "/nonexistent", logLevel: "silent", clock: new FakeClock(), rng: seededRng(11),
  });
  await built.app.ready();
  const orig = built.hub.emit.bind(built.hub);
  built.hub.emit = (streamerId, message) => {
    bcast.push({ streamerId, type: message.type });
    orig(streamerId, message);
  };
});
afterEach(async () => {
  await built.app.close();
  await handle.close();
});

const inject = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
  built.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

const lockedOf = async (headers: Record<string, string>) =>
  Object.fromEntries(((await inject("GET", "/api/admin/species", headers)).json().species as Array<{ id: string; locked: boolean }>).map((s) => [s.id, s.locked]));

async function viewerFor(streamerId: string, login: string): Promise<string> {
  const r = await built.service.handleMessage({ streamerId, twitchUserId: `id-${login}`, login, displayName: login, isSubscriber: false });
  if (!("viewerId" in r) || !r.viewerId) throw new Error("sin viewer");
  return r.viewerId;
}

describe("catálogo por canal", () => {
  it("un canal gratis ve bloqueadas las premium y las exclusivas que no tiene", async () => {
    expect(await lockedOf(asFriend())).toEqual({ shiba: false, gato: false, dragon: true, zorro: true, tigre: true });
  });

  it("el dueño lo ve todo desbloqueado", async () => {
    expect(await lockedOf(adm)).toEqual({ shiba: false, gato: false, dragon: false, zorro: false, tigre: false });
  });

  it("/api/species (público, para el overlay) lista todo con su alcance y nivel", async () => {
    const list = (await inject("GET", "/api/species", {})).json().species as Array<{ id: string; scope: string; tier: string }>;
    expect(list.map((s) => s.id)).toEqual(["shiba", "gato", "dragon", "zorro", "tigre"]);
    expect(list.find((s) => s.id === "tigre")).toMatchObject({ scope: "exclusive", tier: "premium" });
  });

  it("el catálogo real sigue siendo todo general y gratis (nada cambia para nadie)", async () => {
    const { SpeciesCatalog } = await import("../src/domain/species.js");
    const real = SpeciesCatalog.fromAssetsDir(ASSETS_DIR);
    expect(real.list().every((s) => s.scope === "general" && s.tier === "free")).toBe(true);
  });
});

describe("elegir mascota", () => {
  it("un canal gratis no puede ponerle una especie premium o exclusiva a un espectador (403)", async () => {
    const v = await viewerFor(friendId, "luna");
    for (const speciesId of ["dragon", "zorro", "tigre"]) {
      const r = await inject("PATCH", `/api/admin/viewers/${v}/pet`, asFriend(csrf), { speciesId });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe("species_locked");
    }
    const ok = await inject("PATCH", `/api/admin/viewers/${v}/pet`, asFriend(csrf), { speciesId: "gato" });
    expect(ok.statusCode).toBe(200);
  });

  it("tampoco como especie por defecto", async () => {
    const r = await inject("PATCH", "/api/admin/settings", asFriend(csrf), { defaultSpeciesId: "dragon" });
    expect(r.statusCode).toBe(403);
    expect((await inject("PATCH", "/api/admin/settings", asFriend(csrf), { defaultSpeciesId: "shiba" })).statusCode).toBe(200);
  });

  it("una especie que no existe sigue siendo 400", async () => {
    const v = await viewerFor(friendId, "luna");
    expect((await inject("PATCH", `/api/admin/viewers/${v}/pet`, asFriend(csrf), { speciesId: "nada" })).statusCode).toBe(400);
  });

  it("el dueño sí puede usar cualquiera", async () => {
    const v = await viewerFor(ownerId, "kiko");
    for (const speciesId of ["dragon", "zorro", "tigre"]) {
      expect((await inject("PATCH", `/api/admin/viewers/${v}/pet`, adm, { speciesId })).statusCode).toBe(200);
    }
  });

  it("las mascotas nuevas de un canal gratis nunca salen premium ni exclusivas", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 80; i++) {
      const id = await viewerFor(friendId, `u${i}`);
      const row = await repo.getViewerWithPet(handle.db, friendId, id);
      seen.add(row!.pet!.speciesId);
    }
    expect([...seen].sort()).toEqual(["gato", "shiba"]);
  });

  it("con plan premium salen también las premium generales, pero no las exclusivas sin permiso", async () => {
    await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "premium" });
    const seen = new Set<string>();
    for (let i = 0; i < 150; i++) {
      const id = await viewerFor(friendId, `u${i}`);
      seen.add((await repo.getViewerWithPet(handle.db, friendId, id))!.pet!.speciesId);
    }
    expect([...seen].sort()).toEqual(["dragon", "gato", "shiba"]);
  });
});

describe("administrar plan y especies de un canal", () => {
  it("la lista de canales muestra plan y especies", async () => {
    await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "premium", species: ["zorro"] });
    const items = (await inject("GET", "/api/admin/channels", adm)).json().items as Array<{ login: string; plan: string; species: string[] }>;
    expect(items.find((i) => i.login === "amiga")).toMatchObject({ plan: "premium", species: ["zorro"] });
    expect(items.find((i) => i.login === "nazhika")).toMatchObject({ plan: "free", species: [] });
  });

  it("exclusiva + premium necesita las dos cosas", async () => {
    await inject("PATCH", "/api/admin/channels/amiga", adm, { species: ["tigre"] });
    expect((await lockedOf(asFriend())).tigre).toBe(true); // tiene el permiso pero no el plan
    await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "premium" });
    expect((await lockedOf(asFriend())).tigre).toBe(false);
    await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "free" });
    expect((await lockedOf(asFriend())).tigre).toBe(true);
  });

  it("una exclusiva solo se desbloquea para los canales listados", async () => {
    await inject("PATCH", "/api/admin/channels/amiga", adm, { species: ["zorro"] });
    expect((await lockedOf(asFriend())).zorro).toBe(false);
    await repo.addAllowedChannel(handle.db, "otro");
    await inject("PATCH", "/api/admin/channels/otro", adm, { plan: "premium" }); // premium no abre una exclusiva
    expect(await repo.getAccessForStreamer(handle.db, friendId)).toEqual({ plan: "free", grants: ["zorro"] });
  });

  it("validaciones: especie inexistente, no exclusiva, cuerpo vacío, plan raro, dueño, canal inexistente", async () => {
    expect((await inject("PATCH", "/api/admin/channels/amiga", adm, { species: ["nada"] })).json().error).toBe("unknown_species");
    expect((await inject("PATCH", "/api/admin/channels/amiga", adm, { species: ["shiba"] })).json().error).toBe("not_exclusive");
    expect((await inject("PATCH", "/api/admin/channels/amiga", adm, {})).statusCode).toBe(400);
    expect((await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "oro" })).statusCode).toBe(400);
    expect((await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "free", x: 1 })).statusCode).toBe(400);
    expect((await inject("PATCH", "/api/admin/channels/nazhika", adm, { plan: "premium" })).json().error).toBe("owner");
    expect((await inject("PATCH", "/api/admin/channels/fantasma", adm, { plan: "premium" })).statusCode).toBe(404);
  });

  it("un streamer con su sesión NO puede cambiarse el plan ni darse especies (403)", async () => {
    const r = await inject("PATCH", "/api/admin/channels/amiga", asFriend(csrf), { plan: "premium", species: ["zorro"] });
    expect(r.statusCode).toBe(403);
    expect(await repo.getAccessForStreamer(handle.db, friendId)).toEqual({ plan: "free", grants: [] });
  });

  it("el plan y las especies se pueden dejar listos antes del primer ingreso", async () => {
    await repo.addAllowedChannel(handle.db, "nueva");
    await inject("PATCH", "/api/admin/channels/nueva", adm, { plan: "premium", species: ["zorro"] });
    const who = { twitchUserId: "300", login: "nueva" };
    const s = await repo.upsertStreamerFromTwitch(handle.db, who);
    await repo.bindAllowedChannel(handle.db, (await repo.findAllowedChannelFor(handle.db, who))!.id, who);
    const info = await new SpeciesAccess(handle.db, catalog(), ownerId).info(s.id);
    expect(info.plan).toBe("premium");
    expect([...info.grants]).toEqual(["zorro"]);
  });

  it("quitar el canal borra sus permisos y deja al streamer como gratis", async () => {
    await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "premium", species: ["zorro"] });
    expect((await inject("DELETE", "/api/admin/channels/amiga", adm)).statusCode).toBe(204);
    expect(await repo.getAccessForStreamer(handle.db, friendId)).toEqual({ plan: "free", grants: [] });
    expect((await repo.listChannelGrants(handle.db)).size).toBe(0);
  });
});

describe("al perder acceso, las mascotas pasan a una permitida", () => {
  it("bajar a gratis reasigna las premium, avisa al overlay y limpia la especie por defecto", async () => {
    await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "premium", species: ["zorro"] });
    const a = await viewerFor(friendId, "luna");
    const b = await viewerFor(friendId, "kiko");
    await inject("PATCH", `/api/admin/viewers/${a}/pet`, asFriend(csrf), { speciesId: "dragon" });
    await inject("PATCH", `/api/admin/viewers/${b}/pet`, asFriend(csrf), { speciesId: "zorro" });
    await inject("PATCH", "/api/admin/settings", asFriend(csrf), { defaultSpeciesId: "dragon" });
    bcast.length = 0;

    const r = await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "free", species: [] });
    expect(r.statusCode).toBe(200);

    const sa = (await repo.getViewerWithPet(handle.db, friendId, a))!.pet!.speciesId;
    const sb = (await repo.getViewerWithPet(handle.db, friendId, b))!.pet!.speciesId;
    expect(["shiba", "gato"]).toContain(sa);
    expect(["shiba", "gato"]).toContain(sb);
    expect((await repo.getSettings(handle.db, friendId)).defaultSpeciesId).toBeNull();
    expect(bcast.filter((e) => e.streamerId === friendId && e.type === "pet.update").length).toBe(2);
  });

  it("no toca las mascotas que siguen siendo válidas ni las de otros canales", async () => {
    const mine = await viewerFor(friendId, "luna");
    await inject("PATCH", `/api/admin/viewers/${mine}/pet`, asFriend(csrf), { speciesId: "gato" });
    const owners = await viewerFor(ownerId, "kiko");
    await inject("PATCH", `/api/admin/viewers/${owners}/pet`, adm, { speciesId: "tigre" });
    await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "premium" });
    await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "free" });
    expect((await repo.getViewerWithPet(handle.db, friendId, mine))!.pet!.speciesId).toBe("gato");
    expect((await repo.getViewerWithPet(handle.db, ownerId, owners))!.pet!.speciesId).toBe("tigre");
  });
});

describe("/me", () => {
  it("informa el plan del canal", async () => {
    expect((await inject("GET", "/api/admin/me", asFriend())).json().plan).toBe("free");
    await inject("PATCH", "/api/admin/channels/amiga", adm, { plan: "premium" });
    expect((await inject("GET", "/api/admin/me", asFriend())).json().plan).toBe("premium");
  });
});
