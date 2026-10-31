import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { ServerMessage } from "@streampets/shared";
import { buildApp, redactUrl } from "../src/app.js";
import type { BuiltApp } from "../src/app.js";
import * as repo from "../src/db/repo.js";
import { ASSETS_DIR, FakeClock, makeCatalog, makeTestDb } from "./helpers.js";
import type { DbHandle } from "../src/db/client.js";

const ADMIN = "test-admin-token-1234567890abcd";
const auth = { authorization: `Bearer ${ADMIN}` };
const AUTH = { cookieSecure: false, publicOrigin: undefined, sessionTtlMs: 86_400_000 };

let handle: DbHandle;
let built: BuiltApp;
let streamerId: string;
let otherStreamerId: string;
let clock: FakeClock;

beforeEach(async () => {
  handle = await makeTestDb();
  clock = new FakeClock();
  streamerId = (await repo.ensureStreamer(handle.db, { login: "streamer", displayName: "Streamer" })).id;
  otherStreamerId = (await repo.ensureStreamer(handle.db, { login: "otra", displayName: "Otra" })).id;
  built = await buildApp({
    db: handle.db,
    species: makeCatalog(),
    adminToken: ADMIN,
    streamerId,
    ownerLogin: "streamer",
    auth: AUTH,
    assetsDir: ASSETS_DIR,
    overlayDist: "/nonexistent",
    enableDevChat: true,
    logLevel: "silent",
    clock,
  });
  await built.app.ready();
});
afterEach(async () => {
  await built.app.close();
  await handle.close();
});

async function api(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, headers = auth) {
  return built.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
}

async function say(login: string, extra: object = {}) {
  const res = await api("POST", "/api/admin/dev/chat", { login, ...extra });
  expect(res.statusCode).toBe(200);
  return res.json() as { outcome: string; viewerId?: string };
}

describe("rutas públicas", () => {
  it("healthz y catálogo de especies no requieren clave", async () => {
    expect((await api("GET", "/healthz", undefined, {} as never)).json()).toEqual({ ok: true });
    const sp = (await api("GET", "/api/species", undefined, {} as never)).json() as { species: unknown[] };
    expect(sp.species).toHaveLength(3);
  });

  it("sirve los sprites en /assets", async () => {
    const res = await api("GET", "/assets/species/index.json", undefined, {} as never);
    expect(res.statusCode).toBe(200);
  });

  it("rutas desconocidas dan 404 JSON", async () => {
    const res = await api("GET", "/nope", undefined, {} as never);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});

describe("autenticación del admin", () => {
  it.each([
    ["sin cabecera", {}],
    ["clave incorrecta", { authorization: "Bearer mala" }],
    ["esquema incorrecto", { authorization: `Basic ${ADMIN}` }],
    ["clave vacía", { authorization: "Bearer " }],
  ])("rechaza %s", async (_n, headers) => {
    for (const [m, u] of [
      ["GET", "/api/admin/viewers"],
      ["GET", "/api/admin/settings"],
      ["GET", "/api/admin/overlays"],
      ["POST", "/api/admin/dev/chat"],
    ] as const) {
      const res = await api(m, u, undefined, headers as never);
      expect(res.statusCode, `${m} ${u}`).toBe(401);
    }
  });

  it("las respuestas administrativas no se cachean", async () => {
    expect((await api("GET", "/api/admin/settings")).headers["cache-control"]).toBe("no-store");
  });
});

describe("dev chat y listado de espectadores", () => {
  it("el chat crea espectadores que aparecen en el listado, en línea y con mascota", async () => {
    await say("luna");
    await say("kiko");
    const list = (await api("GET", "/api/admin/viewers")).json() as {
      total: number;
      items: Array<{ login: string; online: boolean; pet: { speciesId: string; enabled: boolean } | null }>;
    };
    expect(list.total).toBe(2);
    expect(list.items.map((i) => i.login).sort()).toEqual(["kiko", "luna"]);
    for (const i of list.items) {
      expect(i.online).toBe(true);
      expect(i.pet?.enabled).toBe(true);
    }
  });

  it("busca por nombre sin que % o _ actúen como comodines", async () => {
    await say("luna_azul");
    await say("lunaXazul");
    await say("kiko");
    const q = async (s: string) =>
      ((await api("GET", `/api/admin/viewers?q=${encodeURIComponent(s)}`)).json() as { items: unknown[] }).items.length;
    expect(await q("luna")).toBe(2);
    expect(await q("na_a")).toBe(1);
    expect(await q("%")).toBe(0);
  });

  it("separa subs de viewers y devuelve contadores", async () => {
    await say("sub1", { isSubscriber: true });
    await say("sub2", { isSubscriber: true });
    await say("normal1");
    const get = async (role: string) =>
      (await api("GET", `/api/admin/viewers?role=${role}`)).json() as {
        total: number;
        counts: { all: number; subs: number; viewers: number; online: number };
        items: Array<{ login: string; isSubscriber: boolean }>;
      };
    const subs = await get("subs");
    expect(subs.items.map((i) => i.login).sort()).toEqual(["sub1", "sub2"]);
    expect(subs.items.every((i) => i.isSubscriber)).toBe(true);
    expect(subs.total).toBe(2);
    const viewers = await get("viewers");
    expect(viewers.items.map((i) => i.login)).toEqual(["normal1"]);
    expect(viewers.items[0]?.isSubscriber).toBe(false);
    const all = await get("all");
    expect(all.total).toBe(3);
    // Los contadores no dependen del filtro activo.
    expect(subs.counts).toEqual({ all: 3, subs: 2, viewers: 1, online: 3 });
    expect(all.counts).toEqual(subs.counts);
    expect((await api("GET", "/api/admin/viewers?role=otro")).statusCode).toBe(400);
  });

  it("si alguien se suscribe, pasa a la lista de subs", async () => {
    await say("luna");
    await say("luna", { isSubscriber: true });
    const subs = (await api("GET", "/api/admin/viewers?role=subs")).json() as { items: Array<{ login: string }> };
    expect(subs.items.map((i) => i.login)).toEqual(["luna"]);
  });

  it("pagina", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) await say(n);
    const page = (await api("GET", "/api/admin/viewers?limit=2&offset=4")).json() as { total: number; items: unknown[] };
    expect(page).toMatchObject({ total: 5 });
    expect(page.items).toHaveLength(1);
  });

  it("valida los parámetros", async () => {
    expect((await api("GET", "/api/admin/viewers?limit=0")).statusCode).toBe(400);
    expect((await api("GET", "/api/admin/viewers?limit=1000")).statusCode).toBe(400);
    expect((await api("POST", "/api/admin/dev/chat", { login: "con espacios" })).statusCode).toBe(400);
    expect((await api("POST", "/api/admin/dev/chat", { login: "ok", extra: 1 })).statusCode).toBe(400);
  });
});

describe("cambiar mascotas desde el dashboard", () => {
  it("cambia la especie y la guarda", async () => {
    const { viewerId } = await say("luna");
    const res = await api("PATCH", `/api/admin/viewers/${viewerId}/pet`, { speciesId: "bunny" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pet: { speciesId: "bunny", enabled: true } });
    const row = await repo.getViewerWithPet(handle.db, streamerId, viewerId as string);
    expect(row?.pet?.speciesId).toBe("bunny");
  });

  it("desactiva y reactiva", async () => {
    const { viewerId } = await say("luna");
    expect((await api("PATCH", `/api/admin/viewers/${viewerId}/pet`, { enabled: false })).json()).toEqual({
      pet: { speciesId: expect.any(String), enabled: false },
    });
    expect((await say("luna")).outcome).toBe("disabled");
    await api("PATCH", `/api/admin/viewers/${viewerId}/pet`, { enabled: true });
    await say("luna");
    expect(await built.service.activeCount(streamerId)).toBe(1);
  });

  it("rechaza especies inexistentes, cuerpos vacíos e ids mal formados", async () => {
    const { viewerId } = await say("luna");
    expect((await api("PATCH", `/api/admin/viewers/${viewerId}/pet`, { speciesId: "dragon" })).statusCode).toBe(400);
    expect((await api("PATCH", `/api/admin/viewers/${viewerId}/pet`, {})).statusCode).toBe(400);
    expect((await api("PATCH", `/api/admin/viewers/${viewerId}/pet`, { speciesId: "../x" })).statusCode).toBe(400);
    expect((await api("PATCH", `/api/admin/viewers/no-es-uuid/pet`, { enabled: true })).statusCode).toBe(400);
  });

  it("404 si el espectador no existe o es de otro streamer", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await api("PATCH", `/api/admin/viewers/${missing}/pet`, { enabled: false })).statusCode).toBe(404);

    const foreign = await repo.createViewerWithPet(
      handle.db,
      otherStreamerId,
      { twitchUserId: "9", login: "ajeno", displayName: "Ajeno", isSubscriber: false },
      "cat",
    );
    const res = await api("PATCH", `/api/admin/viewers/${foreign.viewer.id}/pet`, { speciesId: "bunny" });
    expect(res.statusCode).toBe(404);
    expect((await repo.getViewerWithPet(handle.db, otherStreamerId, foreign.viewer.id))?.pet?.speciesId).toBe("cat");
    // y el listado de este streamer no lo muestra
    expect(((await api("GET", "/api/admin/viewers")).json() as { total: number }).total).toBe(0);
  });
});

describe("ajustes", () => {
  it("devuelve valores por defecto con los bots ignorados", async () => {
    const s = (await api("GET", "/api/admin/settings")).json() as Record<string, unknown>;
    expect(s["subsOnly"]).toBe(false);
    expect(s["maxPets"]).toBe(20);
    expect(s["ignoredLogins"]).toContain("nightbot");
  });

  it("aplica cambios al instante (subs-only, lista de ignorados, tope)", async () => {
    const res = await api("PATCH", "/api/admin/settings", {
      subsOnly: true,
      ignoredLogins: ["Troll", "troll", "otro"],
      maxPets: 5,
      defaultSpeciesId: "cat",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ subsOnly: true, ignoredLogins: ["troll", "otro"], maxPets: 5, defaultSpeciesId: "cat" });
    expect((await say("normal")).outcome).toBe("ignored");
    expect((await say("troll", { isSubscriber: true })).outcome).toBe("ignored");
    expect((await say("suscriptor", { isSubscriber: true })).outcome).toBe("spawned");
  });

  it.each([
    [{ maxPets: 0 }],
    [{ maxPets: 51 }],
    [{ idleTimeoutSec: 5 }],
    [{ defaultSpeciesId: "dragon" }],
    [{ ignoredLogins: ["con espacio"] }],
    [{ desconocido: true }],
  ])("rechaza %j", async (body) => {
    expect((await api("PATCH", "/api/admin/settings", body)).statusCode).toBe(400);
  });

  it("defaultSpeciesId null limpia la preferencia", async () => {
    await api("PATCH", "/api/admin/settings", { defaultSpeciesId: "cat" });
    const res = await api("PATCH", "/api/admin/settings", { defaultSpeciesId: null });
    expect(res.json()).toMatchObject({ defaultSpeciesId: null });
  });
});

describe("overlays", () => {
  it("crea, lista sin exponer el token, rota y revoca", async () => {
    const created = (await api("POST", "/api/admin/overlays", { name: "OBS principal" })).json() as {
      id: string;
      token: string;
      path: string;
      tokenPrefix: string;
    };
    expect(created.token).toMatch(/^spo_[A-Za-z0-9_-]{43}$/);
    expect(created.path).toBe(`/overlay/pets/${created.token}`);

    const listRes = await api("GET", "/api/admin/overlays");
    expect(listRes.body).not.toContain(created.token);
    expect((listRes.json() as { items: Array<{ tokenPrefix: string }> }).items[0]?.tokenPrefix).toBe(created.tokenPrefix);

    const rotated = (await api("POST", `/api/admin/overlays/${created.id}/rotate`)).json() as { token: string };
    expect(rotated.token).not.toBe(created.token);
    expect(await repo.findActiveOverlayByHash(handle.db, (await import("../src/lib/tokens.js")).hashToken(created.token))).toBeUndefined();

    expect((await api("DELETE", `/api/admin/overlays/${created.id}`)).statusCode).toBe(204);
    expect((await api("DELETE", `/api/admin/overlays/${created.id}`)).statusCode).toBe(404);
    expect((await api("POST", `/api/admin/overlays/${created.id}/rotate`)).statusCode).toBe(404);
    expect(((await api("GET", "/api/admin/overlays")).json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("exige nombre", async () => {
    expect((await api("POST", "/api/admin/overlays", { name: "  " })).statusCode).toBe(400);
    expect((await api("POST", "/api/admin/overlays", {})).statusCode).toBe(400);
  });
});

describe("página del overlay", () => {
  it("se sirve sin caché y sin referrer, y solo con un token bien formado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title>");
    const local = await buildApp({
      db: handle.db,
      species: makeCatalog(),
      adminToken: ADMIN,
      streamerId,
      ownerLogin: "streamer",
      auth: AUTH,
      assetsDir: ASSETS_DIR,
      overlayDist: dir,
      logLevel: "silent",
    });
    try {
      const ok = await local.app.inject({ method: "GET", url: `/overlay/pets/spo_${"A".repeat(43)}` });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers["cache-control"]).toBe("no-store");
      expect(ok.headers["referrer-policy"]).toBe("no-referrer");
      expect((await local.app.inject({ method: "GET", url: "/overlay/pets/basura" })).statusCode).toBe(404);
    } finally {
      await local.app.close();
    }
  });
});

describe("dashboard en /admin", () => {
  it("se sirve si existe la carpeta compilada y /admin redirige a /admin/", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>panel</title>");
    const local = await buildApp({
      db: handle.db,
      species: makeCatalog(),
      adminToken: ADMIN,
      streamerId,
      ownerLogin: "streamer",
      auth: AUTH,
      assetsDir: ASSETS_DIR,
      overlayDist: "/nonexistent",
      dashboardDist: dir,
      logLevel: "silent",
    });
    try {
      expect((await local.app.inject({ method: "GET", url: "/admin" })).headers["location"]).toBe("/admin/");
      const page = await local.app.inject({ method: "GET", url: "/admin/" });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("panel");
      expect(page.headers["cache-control"]).toBe("no-cache");
    } finally {
      await local.app.close();
    }
  });

  it("sin carpeta compilada no hay /admin", async () => {
    expect((await api("GET", "/admin/", undefined, {} as never)).statusCode).toBe(404);
  });
});

describe("redactUrl", () => {
  it("oculta el token en la ruta y en el query", () => {
    expect(redactUrl("/overlay/pets/spo_secreto?scale=2")).toBe("/overlay/pets/[redacted]?scale=2");
    expect(redactUrl("/ws/overlay?token=spo_secreto&x=1")).toBe("/ws/overlay?token=[redacted]&x=1");
  });
});

// ───────────────────────────── WebSocket real ─────────────────────────────

describe("WebSocket del overlay", () => {
  let base: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    await built.app.listen({ port: 0, host: "127.0.0.1" });
    base = `ws://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    for (const s of sockets.splice(0)) s.terminate();
  });

  async function newToken(): Promise<{ id: string; token: string }> {
    return (await api("POST", "/api/admin/overlays", { name: "t" })).json() as { id: string; token: string };
  }

  function open(token: string): { ws: WebSocket; messages: ServerMessage[]; closed: Promise<number> } {
    const ws = new WebSocket(`${base}/ws/overlay?token=${token}`);
    sockets.push(ws);
    const messages: ServerMessage[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    const closed = new Promise<number>((res) => ws.on("close", (code) => res(code)));
    ws.on("error", () => undefined);
    return { ws, messages, closed };
  }

  const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("timeout esperando condición");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("envía el estado actual al conectar y luego los eventos en vivo", async () => {
    await say("antes");
    const { token } = await newToken();
    const c = open(token);
    await waitFor(() => c.messages.length >= 1);
    expect(c.messages[0]).toMatchObject({ type: "snapshot", maxPets: 20 });
    expect((c.messages[0] as { pets: Array<{ name: string }> }).pets.map((p) => p.name)).toEqual(["antes"]);

    const { viewerId } = await say("despues");
    await waitFor(() => c.messages.some((m) => m.type === "pet.appear"));
    const appear = c.messages.find((m) => m.type === "pet.appear");
    expect(appear).toMatchObject({ pet: { viewerId, name: "despues" } });

    await api("PATCH", `/api/admin/viewers/${viewerId}/pet`, { speciesId: "bunny" });
    await waitFor(() => c.messages.some((m) => m.type === "pet.update"));
    await api("PATCH", `/api/admin/viewers/${viewerId}/pet`, { enabled: false });
    await waitFor(() => c.messages.some((m) => m.type === "pet.leave"));
  });

  it("rechaza tokens inválidos o desconocidos con 4001", async () => {
    expect(await open("spo_" + "A".repeat(43)).closed).toBe(4001);
    expect(await open("basura").closed).toBe(4001);
    const noToken = new WebSocket(`${base}/ws/overlay`);
    sockets.push(noToken);
    expect(await new Promise<number>((res) => noToken.on("close", (c) => res(c)))).toBe(4001);
  });

  it("al revocar o rotar el token se corta la conexión", async () => {
    const a = await newToken();
    const ca = open(a.token);
    await waitFor(() => ca.messages.length >= 1);
    await api("DELETE", `/api/admin/overlays/${a.id}`);
    expect(await ca.closed).toBe(4001);

    const b = await newToken();
    const cb = open(b.token);
    await waitFor(() => cb.messages.length >= 1);
    await api("POST", `/api/admin/overlays/${b.id}/rotate`);
    expect(await cb.closed).toBe(4001);
    // el token viejo ya no entra
    expect(await open(b.token).closed).toBe(4001);
  });

  it("limita las conexiones simultáneas por overlay", async () => {
    const { token } = await newToken();
    const first = Array.from({ length: 5 }, () => open(token));
    await waitFor(() => first.every((c) => c.messages.length >= 1));
    expect(await open(token).closed).toBe(4002);
  });

  it("un overlay no recibe eventos de otro streamer", async () => {
    const mine = await newToken();
    const foreign = await repo.createOverlay(handle.db, otherStreamerId, {
      name: "ajeno",
      ...(() => {
        const t = foreignToken();
        return { tokenHash: t.hash, tokenPrefix: t.prefix };
      })(),
    });
    expect(foreign.streamerId).toBe(otherStreamerId);
    const c = open(mine.token);
    await waitFor(() => c.messages.length >= 1);
    built.hub.emit(otherStreamerId, { type: "pet.leave", viewerId: "00000000-0000-4000-8000-000000000000" });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.messages).toHaveLength(1);
  });

  it("ignora lo que envíe el cliente (solo lectura)", async () => {
    const { token } = await newToken();
    const c = open(token);
    await waitFor(() => c.messages.length >= 1);
    c.ws.send(JSON.stringify({ type: "pet.appear", pet: { viewerId: "x" } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(c.messages).toHaveLength(1);
    expect(await built.service.activeCount(streamerId)).toBe(0);
  });
});

import { generateOverlayToken } from "../src/lib/tokens.js";
function foreignToken() {
  return generateOverlayToken();
}
