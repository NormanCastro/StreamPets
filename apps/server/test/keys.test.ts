import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { BuiltApp } from "../src/app.js";
import type { DbHandle } from "../src/db/client.js";
import * as repo from "../src/db/repo.js";
import { generateAccessKey, hashToken, looksLikeAccessKey } from "../src/lib/tokens.js";
import { ASSETS_DIR, FakeClock, makeCatalog, makeTestDb } from "./helpers.js";

const ADMIN = "test-admin-token-1234567890abcd";
const adm = { authorization: `Bearer ${ADMIN}` };
const csrf = { "x-streampets-csrf": "1" };
const ORIGIN = "https://streampets.live";
const AUTH = { cookieSecure: true, publicOrigin: ORIGIN, sessionTtlMs: 3_600_000 };
const SESSION = "__Host-sp_session";

let handle: DbHandle;
let built: BuiltApp;
let ownerId: string;
let now: Date;
let ready: Array<[string, string]>;

beforeEach(async () => {
  handle = await makeTestDb();
  now = new Date("2026-10-31T12:00:00Z");
  ready = [];
  ownerId = (await repo.ensureStreamer(handle.db, { login: "nazhika", displayName: "Nazhika" })).id;
  await repo.addAllowedChannel(handle.db, "nazhika");
  await repo.addAllowedChannel(handle.db, "amiga");
  await repo.addAllowedChannel(handle.db, "otra");
  built = await buildApp({
    db: handle.db, species: makeCatalog(), adminToken: ADMIN, streamerId: ownerId, ownerLogin: "nazhika",
    auth: AUTH, assetsDir: ASSETS_DIR, overlayDist: "/nonexistent", logLevel: "silent", clock: new FakeClock(),
    onStreamerReady: (id, login) => ready.push([id, login]), now: () => now,
  });
  await built.app.ready();
});
afterEach(async () => {
  await built.app.close();
  await handle.close();
});

const inject = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  built.app.inject({ method, url, headers: { host: "streampets.live", ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function genKey(login: string): Promise<string> {
  const r = await inject("POST", `/api/admin/channels/${login}/key`, adm);
  expect(r.statusCode).toBe(201);
  return r.json().key as string;
}
const enter = (key: unknown, headers: Record<string, string> = csrf) => inject("POST", "/auth/key", headers, { key });
function sessionOf(res: { headers: Record<string, unknown> }): string | undefined {
  const raw = res.headers["set-cookie"];
  const c = (Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : []).find((x) => x.startsWith(SESSION));
  return c?.split(";")[0]?.slice(SESSION.length + 1);
}
const withSession = (s: string, extra: Record<string, string> = {}) => ({ cookie: `${SESSION}=${s}`, ...extra });

describe("formato de la clave", () => {
  it("generateAccessKey: prefijo spk_, 256 bits, hash distinto de la clave, y se reconoce", () => {
    const a = generateAccessKey();
    const b = generateAccessKey();
    expect(a.key).toMatch(/^spk_[\w-]{43}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.hash).toBe(hashToken(a.key));
    expect(a.hash).not.toContain(a.key);
    expect(a.prefix).toBe(a.key.slice(0, 8));
    expect(looksLikeAccessKey(a.key)).toBe(true);
    for (const bad of ["", "spk_", "spk_corta", `spo_${"a".repeat(43)}`, `${a.key}x`, ` ${a.key}`]) expect(looksLikeAccessKey(bad)).toBe(false);
  });
});

describe("generar y revocar (solo administrador)", () => {
  it("se muestra una sola vez; en la base solo está el hash; la lista solo muestra el prefijo", async () => {
    const key = await genKey("amiga");
    const row = (await repo.listAllowedChannels(handle.db)).find((r) => r.login === "amiga")!;
    expect(row.keyHash).toBe(hashToken(key));
    expect(JSON.stringify(row)).not.toContain(key);
    const list = (await inject("GET", "/api/admin/channels", adm)).json();
    expect(JSON.stringify(list)).not.toContain(key);
    expect(list.items.find((i: { login: string }) => i.login === "amiga")).toMatchObject({ hasKey: true, keyPrefix: key.slice(0, 8) });
    expect(list.items.find((i: { login: string }) => i.login === "otra")).toMatchObject({ hasKey: false, keyPrefix: null });
  });

  it("el dueño no tiene clave personal (400), un canal que no existe da 404", async () => {
    expect((await inject("POST", "/api/admin/channels/nazhika/key", adm)).json().error).toBe("owner");
    expect((await inject("POST", "/api/admin/channels/fantasma/key", adm)).statusCode).toBe(404);
    expect((await inject("DELETE", "/api/admin/channels/fantasma/key", adm)).statusCode).toBe(404);
  });

  it("una streamer con su sesión no puede generar, ver ni revocar claves (403)", async () => {
    const key = await genKey("amiga");
    const s = sessionOf(await enter(key))!;
    const h = withSession(s, csrf);
    expect((await inject("POST", "/api/admin/channels/otra/key", h)).statusCode).toBe(403);
    expect((await inject("DELETE", "/api/admin/channels/amiga/key", h)).statusCode).toBe(403);
    expect((await inject("GET", "/api/admin/channels", h)).statusCode).toBe(403);
    expect((await repo.listAllowedChannels(handle.db)).find((r) => r.login === "otra")!.keyHash).toBeNull();
  });
});

describe("entrar con la clave", () => {
  it("la clave correcta abre una sesión del canal (cookie segura) y empieza a leerse su chat", async () => {
    const key = await genKey("amiga");
    const r = await enter(key);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    const cookie = (r.headers["set-cookie"] as string);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Path=\/;/);
    const s = sessionOf(r)!;
    const me = (await inject("GET", "/api/admin/me", withSession(s))).json();
    expect(me.role).toBe("streamer");
    expect(me.streamer.login).toBe("amiga");
    expect(ready.map((x) => x[1])).toEqual(["amiga"]);
  });

  it("la sesión es solo de su canal: no ve lo de otros ni puede administrar", async () => {
    const ka = await genKey("amiga");
    const ko = await genKey("otra");
    const sa = sessionOf(await enter(ka))!;
    const so = sessionOf(await enter(ko))!;
    await repo.createViewerWithPet(
      handle.db, (await repo.getStreamer(handle.db, ownerId))!.id,
      { twitchUserId: "v1", login: "luna", displayName: "Luna", isSubscriber: false }, "shiba",
    );
    expect((await inject("GET", "/api/admin/viewers", withSession(sa))).json().total).toBe(0);
    const meA = (await inject("GET", "/api/admin/me", withSession(sa))).json();
    const meO = (await inject("GET", "/api/admin/me", withSession(so))).json();
    expect([meA.streamer.login, meO.streamer.login]).toEqual(["amiga", "otra"]);
    expect((await inject("GET", "/api/admin/channels", withSession(sa))).statusCode).toBe(403);
  });

  it("clave incorrecta, mal formada, vacía o de otro tipo → 401 sin cookie", async () => {
    const good = await genKey("amiga");
    const wrong = generateAccessKey().key;
    for (const k of [wrong, "spk_corta", "", good.slice(0, -1) + "x", `spo_${"a".repeat(43)}`, ADMIN, 123, null]) {
      const r = await enter(k);
      expect(r.statusCode).toBe(401);
      expect(r.json().error).toBe("invalid_key");
      expect(sessionOf(r)).toBeUndefined();
    }
    expect((await inject("POST", "/auth/key", csrf, { key: good, extra: 1 })).statusCode).toBe(401);
    expect((await inject("POST", "/auth/key", csrf, {})).statusCode).toBe(401);
  });

  it("exige la cabecera propia y un origen válido (como los demás cambios con cookie)", async () => {
    const key = await genKey("amiga");
    expect((await enter(key, {})).statusCode).toBe(403);
    expect((await enter(key, { ...csrf, origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await enter(key, { ...csrf, origin: ORIGIN })).statusCode).toBe(200);
  });

  it("se frena a quien prueba claves a lo loco (límite por minuto)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await enter(generateAccessKey().key)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes).toContain(429);
  });

  it("la sesión vence con el tiempo, igual que con Twitch", async () => {
    const s = sessionOf(await enter(await genKey("amiga")))!;
    expect((await inject("GET", "/api/admin/me", withSession(s))).statusCode).toBe(200);
    now = new Date(now.getTime() + AUTH.sessionTtlMs + 1000);
    expect((await inject("GET", "/api/admin/me", withSession(s))).statusCode).toBe(401);
  });

  it("si después entra con Twitch, es la misma cuenta (no se duplica)", async () => {
    const s = sessionOf(await enter(await genKey("amiga")))!;
    const first = (await inject("GET", "/api/admin/me", withSession(s))).json();
    expect(first.streamer.login).toBe("amiga");
    const who = { twitchUserId: "200", login: "amiga" };
    const viaTwitch = await repo.upsertStreamerFromTwitch(handle.db, who);
    expect(viaTwitch.login).toBe("amiga");
    expect((await repo.findStreamerForAllowed(handle.db, (await repo.findAllowedChannelFor(handle.db, who))!))!.id).toBe(viaTwitch.id);
    expect(ready[0]?.[0]).toBe(viaTwitch.id);
  });
});

describe("regenerar, revocar y quitar", () => {
  it("regenerar invalida la clave anterior y cierra las sesiones abiertas", async () => {
    const old = await genKey("amiga");
    const s = sessionOf(await enter(old))!;
    const fresh = await genKey("amiga");
    expect(fresh).not.toBe(old);
    expect((await enter(old)).statusCode).toBe(401);
    expect((await inject("GET", "/api/admin/me", withSession(s))).statusCode).toBe(401);
    expect((await enter(fresh)).statusCode).toBe(200);
  });

  it("revocar quita la clave y cierra las sesiones", async () => {
    const key = await genKey("amiga");
    const s = sessionOf(await enter(key))!;
    expect((await inject("DELETE", "/api/admin/channels/amiga/key", adm)).statusCode).toBe(204);
    expect((await enter(key)).statusCode).toBe(401);
    expect((await inject("GET", "/api/admin/me", withSession(s))).statusCode).toBe(401);
    const item = (await inject("GET", "/api/admin/channels", adm)).json().items.find((i: { login: string }) => i.login === "amiga");
    expect(item).toMatchObject({ hasKey: false, keyPrefix: null });
  });

  it("quitar el canal de la lista también anula su clave", async () => {
    const key = await genKey("amiga");
    const s = sessionOf(await enter(key))!;
    expect((await inject("DELETE", "/api/admin/channels/amiga", adm)).statusCode).toBe(204);
    expect((await enter(key)).statusCode).toBe(401);
    expect((await inject("GET", "/api/admin/me", withSession(s))).statusCode).toBe(401);
  });

  it("regenerar la clave de un canal no toca las sesiones de otros", async () => {
    const sa = sessionOf(await enter(await genKey("amiga")))!;
    const so = sessionOf(await enter(await genKey("otra")))!;
    await genKey("amiga");
    expect((await inject("GET", "/api/admin/me", withSession(sa))).statusCode).toBe(401);
    expect((await inject("GET", "/api/admin/me", withSession(so))).statusCode).toBe(200);
  });
});
