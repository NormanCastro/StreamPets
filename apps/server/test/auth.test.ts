import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { buildApp } from "../src/app.js";
import type { BuiltApp } from "../src/app.js";
import { JwksCache, OidcError, peekKid, verifyIdToken } from "../src/auth/oidc.js";
import type { Jwk } from "../src/auth/oidc.js";
import { TwitchOAuth } from "../src/auth/twitch-oauth.js";
import type { DbHandle } from "../src/db/client.js";
import * as repo from "../src/db/repo.js";
import { parseCookies, serializeCookie } from "../src/http/auth.js";
import { ASSETS_DIR, FakeClock, makeCatalog, makeTestDb } from "./helpers.js";

// ───────────────────────────── Twitch falso ─────────────────────────────

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const ISS = "https://id.twitch.tv/oauth2";
const CLIENT_ID = "cliente123";
const NOW_SEC = 1_800_000_000;

function makeKey(kid: string): { priv: KeyObject; jwk: Jwk } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = publicKey.export({ format: "jwk" }) as { n: string; e: string; kty: string };
  return { priv: privateKey, jwk: { kty: pub.kty, n: pub.n, e: pub.e, kid, alg: "RS256", use: "sig" } };
}

function sign(priv: KeyObject, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = b64({ alg: "RS256", typ: "JWT", kid: "k1", ...header });
  const p = b64(claims);
  const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(priv).toString("base64url");
  return `${h}.${p}.${s}`;
}

const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: ISS,
  aud: CLIENT_ID,
  sub: "12345",
  exp: NOW_SEC + 600,
  nonce: "n0nce",
  preferred_username: "NazhiKa",
  ...over,
});

const k1 = makeKey("k1");
const k2 = makeKey("k2");
const verifyOpts = (over: Record<string, unknown> = {}) => ({
  keys: [k1.jwk],
  issuer: ISS,
  audience: CLIENT_ID,
  nonce: "n0nce",
  nowSec: NOW_SEC,
  ...over,
});

describe("verifyIdToken", () => {
  it("acepta un token bien firmado y normaliza el login a minúsculas", () => {
    const c = verifyIdToken(sign(k1.priv, goodClaims()), verifyOpts());
    expect(c).toEqual({ sub: "12345", preferredUsername: "nazhika" });
  });

  it("sin preferred_username devuelve undefined (se usará /validate)", () => {
    const { preferred_username: _omit, ...rest } = goodClaims();
    expect(verifyIdToken(sign(k1.priv, rest), verifyOpts()).preferredUsername).toBeUndefined();
  });

  it.each([
    ["audiencia ajena", { aud: "otra-app" }, /audiencia/],
    ["emisor ajeno", { iss: "https://evil.example/oauth2" }, /emisor/],
    ["nonce distinto", { nonce: "otro" }, /nonce/],
    ["vencido", { exp: NOW_SEC - 3600 }, /vencido/],
    ["sub no numérico", { sub: "abc" }, /sub/],
    ["sin exp", { exp: undefined }, /vencido/],
  ])("rechaza: %s", (_n, over, msg) => {
    expect(() => verifyIdToken(sign(k1.priv, goodClaims(over)), verifyOpts())).toThrow(msg);
  });

  it("acepta aud como lista que incluye el client id", () => {
    expect(verifyIdToken(sign(k1.priv, goodClaims({ aud: ["x", CLIENT_ID] })), verifyOpts()).sub).toBe("12345");
  });

  it("rechaza firma de otra clave, token manipulado y kid desconocido", () => {
    expect(() => verifyIdToken(sign(k2.priv, goodClaims()), verifyOpts())).toThrow(/firma/);
    const t = sign(k1.priv, goodClaims());
    const [h, , s] = t.split(".") as [string, string, string];
    expect(() => verifyIdToken(`${h}.${b64(goodClaims({ sub: "999" }))}.${s}`, verifyOpts())).toThrow(/firma/);
    expect(() => verifyIdToken(sign(k1.priv, goodClaims(), { kid: "zzz" }), verifyOpts())).toThrow(/desconocida/);
  });

  it("rechaza alg none, HS256 y basura", () => {
    const none = `${b64({ alg: "none", kid: "k1" })}.${b64(goodClaims())}.x`;
    expect(() => verifyIdToken(none, verifyOpts())).toThrow(/algoritmo/);
    const hs = `${b64({ alg: "HS256", kid: "k1" })}.${b64(goodClaims())}.x`;
    expect(() => verifyIdToken(hs, verifyOpts())).toThrow(/algoritmo/);
    expect(() => verifyIdToken("a.b", verifyOpts())).toThrow(OidcError);
    expect(() => verifyIdToken("..", verifyOpts())).toThrow(OidcError);
    expect(() => peekKid("x.y.z")).toThrow(OidcError);
  });

  it("ignora un preferred_username con formato raro", () => {
    expect(verifyIdToken(sign(k1.priv, goodClaims({ preferred_username: "a b<script>" })), verifyOpts()).preferredUsername).toBeUndefined();
  });
});

describe("JwksCache", () => {
  const mkFetch = (keys: Jwk[]) => {
    let calls = 0;
    const fn = (async () => {
      calls++;
      return new Response(JSON.stringify({ keys }), { status: 200 });
    }) as typeof fetch;
    return { fn, calls: () => calls };
  };

  it("guarda las claves y solo vuelve a pedirlas si vence o llega un kid nuevo (máx. 1 por minuto)", async () => {
    let t = 1_000_000;
    const f = mkFetch([k1.jwk]);
    const c = new JwksCache({ url: "http://x/keys", fetchFn: f.fn, now: () => t });
    await c.keysFor("k1");
    await c.keysFor("k1");
    expect(f.calls()).toBe(1);
    await c.keysFor("desconocido"); // muy pronto: no insiste
    expect(f.calls()).toBe(1);
    t += 61_000;
    await c.keysFor("desconocido");
    expect(f.calls()).toBe(2);
    t += 2 * 60 * 60_000;
    await c.keysFor("k1");
    expect(f.calls()).toBe(3);
  });

  it("si Twitch responde error, falla con OidcError", async () => {
    const c = new JwksCache({ url: "http://x/keys", fetchFn: (async () => new Response("no", { status: 500 })) as typeof fetch });
    await expect(c.keysFor("k1")).rejects.toThrow(OidcError);
  });
});

// Twitch de mentira: guarda qué código corresponde a qué persona.
interface Grant {
  sub: string;
  login: string | undefined;
  nonce: string;
  validate?: "ok" | "mismatch" | "error";
}
class FakeTwitch {
  readonly grants = new Map<string, Grant>();
  tokenCalls = 0;
  readonly fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/oauth2/keys")) return new Response(JSON.stringify({ keys: [k1.jwk] }), { status: 200 });
    if (url.endsWith("/oauth2/token")) {
      this.tokenCalls++;
      const body = new URLSearchParams(String(init?.body));
      const g = this.grants.get(body.get("code") ?? "");
      if (!g || body.get("client_secret") !== "secreto" || body.get("client_id") !== CLIENT_ID) {
        return new Response("{}", { status: 400 });
      }
      this.grants.delete(body.get("code") as string); // un código sirve una vez
      const claims = goodClaims({ sub: g.sub, nonce: g.nonce, exp: Math.floor(Date.now() / 1000) + 600 });
      if (g.login === undefined) delete (claims as Record<string, unknown>)["preferred_username"];
      else claims.preferred_username = g.login;
      return new Response(JSON.stringify({ id_token: sign(k1.priv, claims), access_token: `tok-${g.sub}` }), { status: 200 });
    }
    if (url.endsWith("/oauth2/validate")) {
      const sub = String((init?.headers as Record<string, string>)["authorization"]).replace("OAuth tok-", "");
      const g = [...this.lastGrants].find((x) => x.sub === sub);
      if (g?.validate === "error") return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ login: "validado", user_id: g?.validate === "mismatch" ? "1" : sub }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  private readonly lastGrants: Grant[] = [];
  grant(code: string, g: Grant): void {
    this.grants.set(code, g);
    this.lastGrants.push(g);
  }
}

function mkOauth(f: FakeTwitch) {
  return new TwitchOAuth({
    clientId: CLIENT_ID,
    clientSecret: "secreto",
    redirectUri: "https://streampets.live/auth/twitch/callback",
    fetchFn: f.fetchFn,
  });
}

describe("TwitchOAuth", () => {
  it("authorizeUrl lleva client_id, redirect, scope openid, state, nonce y el claim del login", () => {
    const u = new URL(mkOauth(new FakeTwitch()).authorizeUrl({ state: "s1", nonce: "n1" }));
    expect(u.origin + u.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: "https://streampets.live/auth/twitch/callback",
      response_type: "code",
      scope: "openid",
      state: "s1",
      nonce: "n1",
    });
    expect(JSON.parse(u.searchParams.get("claims") as string)).toEqual({ id_token: { preferred_username: null } });
  });

  it("identify devuelve id y login verificados", async () => {
    const f = new FakeTwitch();
    f.grant("c1", { sub: "42", login: "kiko", nonce: "nn" });
    expect(await mkOauth(f).identify("c1", "nn")).toEqual({ twitchUserId: "42", login: "kiko" });
  });

  it("rechaza nonce distinto, código malo o repetido", async () => {
    const f = new FakeTwitch();
    f.grant("c1", { sub: "42", login: "kiko", nonce: "nn" });
    await expect(mkOauth(f).identify("c1", "otro")).rejects.toThrow(/nonce/);
    await expect(mkOauth(f).identify("c1", "nn")).rejects.toThrow(OidcError); // ya se gastó
    await expect(mkOauth(f).identify("nada", "nn")).rejects.toThrow(OidcError);
  });

  it("sin login en el token usa /oauth2/validate, pero solo si el id coincide", async () => {
    const f = new FakeTwitch();
    f.grant("c1", { sub: "42", login: undefined, nonce: "nn" });
    expect(await mkOauth(f).identify("c1", "nn")).toEqual({ twitchUserId: "42", login: "validado" });
    f.grant("c2", { sub: "43", login: undefined, nonce: "nn", validate: "mismatch" });
    await expect(mkOauth(f).identify("c2", "nn")).rejects.toThrow(/no coincide/);
    f.grant("c3", { sub: "44", login: undefined, nonce: "nn", validate: "error" });
    await expect(mkOauth(f).identify("c3", "nn")).rejects.toThrow(OidcError);
  });
});

// ───────────────────────────── cookies ─────────────────────────────

describe("cookies", () => {
  it("serializa con HttpOnly y SameSite; Secure solo si se pide", () => {
    expect(serializeCookie("a", "b", { secure: false, maxAgeSec: 5 })).toBe("a=b; Path=/; Max-Age=5; HttpOnly; SameSite=Lax");
    expect(serializeCookie("__Host-a", "b", { secure: true, maxAgeSec: 5 })).toContain("; Secure");
  });
  it("parsea una cabecera Cookie y se queda con el primer valor repetido", () => {
    expect([...parseCookies("a=1; b=2; a=3; =x; solo")]).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(parseCookies(undefined).size).toBe(0);
  });
});

// ───────────────────────────── rutas de login y sesiones ─────────────────────────────

const ADMIN = "test-admin-token-1234567890abcd";
const ORIGIN = "https://streampets.live";
const AUTH = { cookieSecure: true, publicOrigin: ORIGIN, sessionTtlMs: 3_600_000 };
const SESSION = "__Host-sp_session";
const OAUTHC = "__Host-sp_oauth";

let handle: DbHandle;
let built: BuiltApp;
let twitch: FakeTwitch;
let now: Date;
let ownerId: string;
let ready: Array<[string, string]>;
let removed: string[];

beforeEach(async () => {
  handle = await makeTestDb();
  twitch = new FakeTwitch();
  now = new Date("2026-10-31T12:00:00Z");
  ready = [];
  removed = [];
  ownerId = (await repo.ensureStreamer(handle.db, { login: "nazhika", displayName: "Nazhika" })).id;
  await repo.addAllowedChannel(handle.db, "nazhika");
  built = await buildApp({
    db: handle.db,
    species: makeCatalog(),
    adminToken: ADMIN,
    streamerId: ownerId,
    ownerLogin: "nazhika",
    auth: AUTH,
    oauth: mkOauth(twitch),
    onStreamerReady: (id, login) => ready.push([id, login]),
    onChannelRemoved: (id) => removed.push(id),
    assetsDir: ASSETS_DIR,
    overlayDist: "/nonexistent",
    enableDevChat: false,
    logLevel: "silent",
    clock: new FakeClock(),
    now: () => now,
  });
  await built.app.ready();
});
afterEach(async () => {
  await built.app.close();
  await handle.close();
});

const HOST = { host: "streampets.live" };

function cookiesOf(res: { headers: Record<string, unknown> }): Map<string, string> {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  const out = new Map<string, string>();
  for (const c of list) {
    const [pair = ""] = c.split(";");
    const i = pair.indexOf("=");
    out.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return out;
}
const rawSetCookies = (res: { headers: Record<string, unknown> }): string[] => {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
};

/** Recorre el flujo completo contra el Twitch falso. Devuelve la respuesta del callback y la cookie de sesión. */
async function loginAs(who: { sub: string; login: string }, opts: { code?: string; tamperState?: boolean } = {}) {
  const start = await built.app.inject({ method: "GET", url: "/auth/twitch/login", headers: HOST });
  expect(start.statusCode).toBe(302);
  const loc = new URL(start.headers.location as string);
  const state = loc.searchParams.get("state") as string;
  const nonce = loc.searchParams.get("nonce") as string;
  const oauthCookie = cookiesOf(start).get(OAUTHC) as string;
  const code = opts.code ?? `code${who.sub}x${Math.random().toString(36).slice(2, 8)}`;
  twitch.grant(code, { sub: who.sub, login: who.login, nonce });
  const cb = await built.app.inject({
    method: "GET",
    url: `/auth/twitch/callback?code=${code}&state=${opts.tamperState ? "xxxx" : state}`,
    headers: { ...HOST, cookie: `${OAUTHC}=${oauthCookie}` },
  });
  const session = cookiesOf(cb).get(SESSION);
  return { cb, session, start };
}

const asSession = (session: string, extra: Record<string, string> = {}) => ({
  ...HOST,
  cookie: `${SESSION}=${session}`,
  ...extra,
});
const csrf = { "x-streampets-csrf": "1" };

describe("login con Twitch", () => {
  it("/auth/status dice si el login está configurado", async () => {
    const r = await built.app.inject({ method: "GET", url: "/auth/status" });
    expect(r.json()).toEqual({ twitch: true });
  });

  it("sin Twitch configurado el login no existe", async () => {
    const b = await buildApp({
      db: handle.db, species: makeCatalog(), adminToken: ADMIN, streamerId: ownerId, ownerLogin: "nazhika",
      auth: AUTH, assetsDir: ASSETS_DIR, overlayDist: "/nonexistent", logLevel: "silent", clock: new FakeClock(),
    });
    await b.app.ready();
    expect((await b.app.inject({ method: "GET", url: "/auth/status" })).json()).toEqual({ twitch: false });
    expect((await b.app.inject({ method: "GET", url: "/auth/twitch/login" })).statusCode).toBe(404);
    const cb = await b.app.inject({ method: "GET", url: "/auth/twitch/callback?code=a&state=b" });
    expect(cb.headers.location).toBe("/admin/?login_error=disabled");
    await b.app.close();
  });

  it("login redirige a Twitch con state y nonce, y guarda la cookie de estado (HttpOnly, Secure, Path=/)", async () => {
    const r = await built.app.inject({ method: "GET", url: "/auth/twitch/login", headers: HOST });
    expect(r.statusCode).toBe(302);
    const u = new URL(r.headers.location as string);
    expect(u.host).toBe("id.twitch.tv");
    expect(u.searchParams.get("state")).toMatch(/^[\w-]{20,}$/);
    expect(u.searchParams.get("nonce")).toMatch(/^[\w-]{20,}$/);
    const c = rawSetCookies(r).find((x) => x.startsWith(OAUTHC)) as string;
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("Path=/;"); // el prefijo __Host- exige Path=/
    expect(c).toContain("SameSite=Lax");
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("si entran por otra dirección (onrender.com), los manda a la oficial para que la cookie coincida", async () => {
    const r = await built.app.inject({ method: "GET", url: "/auth/twitch/login", headers: { host: "streampets-rndi.onrender.com" } });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`${ORIGIN}/auth/twitch/login`);
  });

  it("dueño autorizado: entra, recibe cookie de sesión segura y se empieza a leer su chat", async () => {
    const { cb, session } = await loginAs({ sub: "100", login: "nazhika" });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/admin/");
    expect(session).toMatch(/^[\w-]{43}$/);
    const c = rawSetCookies(cb).find((x) => x.startsWith(SESSION)) as string;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/Max-Age=3600/);
    // la cookie de estado se borra
    expect(rawSetCookies(cb).find((x) => x.startsWith(OAUTHC))).toContain("Max-Age=0");
    expect(ready).toEqual([[ownerId, "nazhika"]]);
    // se vinculó al id numérico y se reutilizó la fila del dueño
    expect((await repo.getStreamer(handle.db, ownerId))?.twitchUserId).toBe("100");
    const row = (await repo.listAllowedChannels(handle.db)).find((r) => r.login === "nazhika");
    expect(row?.twitchUserId).toBe("100");
    expect(row?.lastLoginAt).not.toBeNull();
  });

  it("en la base solo se guarda el hash de la sesión, nunca el token", async () => {
    const { session } = await loginAs({ sub: "100", login: "nazhika" });
    const { hashToken } = await import("../src/lib/tokens.js");
    expect(await repo.findSession(handle.db, hashToken(session as string), now)).toEqual({ streamerId: ownerId });
    expect(await repo.findSession(handle.db, session as string, now)).toBeUndefined();
  });

  it("alguien no autorizado no entra ni queda registrado", async () => {
    const { cb, session } = await loginAs({ sub: "555", login: "intruso" });
    expect(cb.headers.location).toBe("/admin/?login_error=not_allowed");
    expect(session).toBeUndefined();
    expect(ready).toEqual([]);
    expect((await repo.listActiveStreamerChannels(handle.db)).map((c) => c.login)).not.toContain("intruso");
  });

  it("amigo autorizado: se crea su propio streamer, con ajustes, y sesión propia", async () => {
    await repo.addAllowedChannel(handle.db, "amiga");
    const { cb, session } = await loginAs({ sub: "200", login: "amiga" });
    expect(cb.headers.location).toBe("/admin/");
    const me = (await built.app.inject({ method: "GET", url: "/api/admin/me", headers: asSession(session as string) })).json();
    expect(me.role).toBe("streamer");
    expect(me.streamer.login).toBe("amiga");
    expect(ready[0]?.[1]).toBe("amiga");
    const s = await built.app.inject({ method: "GET", url: "/api/admin/settings", headers: asSession(session as string) });
    expect(s.statusCode).toBe(200);
  });

  it("el login autorizado se matchea sin importar mayúsculas del lado de Twitch (viene en minúsculas)", async () => {
    await repo.addAllowedChannel(handle.db, "amiga");
    const { cb } = await loginAs({ sub: "200", login: "AMIGA".toLowerCase() });
    expect(cb.headers.location).toBe("/admin/");
  });

  it("state incorrecto, ausente o cookie faltante → error 'state' y sin sesión", async () => {
    const bad = await loginAs({ sub: "100", login: "nazhika" }, { tamperState: true });
    expect(bad.cb.headers.location).toBe("/admin/?login_error=state");
    expect(bad.session).toBeUndefined();
    const noCookie = await built.app.inject({ method: "GET", url: "/auth/twitch/callback?code=abc&state=zzz", headers: HOST });
    expect(noCookie.headers.location).toBe("/admin/?login_error=state");
    const garbage = await built.app.inject({ method: "GET", url: "/auth/twitch/callback?code=%3Cx%3E&state=zzz", headers: HOST });
    expect(garbage.headers.location).toBe("/admin/?login_error=state");
    expect(twitch.tokenCalls).toBe(0);
  });

  it("si la persona cancela en Twitch → 'denied'", async () => {
    const r = await built.app.inject({ method: "GET", url: "/auth/twitch/callback?error=access_denied&state=x", headers: HOST });
    expect(r.headers.location).toBe("/admin/?login_error=denied");
  });

  it("código que Twitch rechaza → 'twitch'", async () => {
    const start = await built.app.inject({ method: "GET", url: "/auth/twitch/login", headers: HOST });
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const cb = await built.app.inject({
      method: "GET",
      url: `/auth/twitch/callback?code=inventado&state=${state}`,
      headers: { ...HOST, cookie: `${OAUTHC}=${cookiesOf(start).get(OAUTHC)}` },
    });
    expect(cb.headers.location).toBe("/admin/?login_error=twitch");
  });

  it("el estado sirve una sola vez (repetir el callback no entra)", async () => {
    const start = await built.app.inject({ method: "GET", url: "/auth/twitch/login", headers: HOST });
    const loc = new URL(start.headers.location as string);
    const cookie = `${OAUTHC}=${cookiesOf(start).get(OAUTHC)}`;
    twitch.grant("uno", { sub: "100", login: "nazhika", nonce: loc.searchParams.get("nonce") as string });
    const url = `/auth/twitch/callback?code=uno&state=${loc.searchParams.get("state")}`;
    const first = await built.app.inject({ method: "GET", url, headers: { ...HOST, cookie } });
    expect(cookiesOf(first).get(SESSION)).toBeTruthy();
    const second = await built.app.inject({ method: "GET", url, headers: { ...HOST, cookie } });
    expect(cookiesOf(second).get(SESSION)).toBeUndefined();
    expect(second.headers.location).toBe("/admin/?login_error=twitch");
  });

  it("vinculado al id: otra persona con el mismo login más tarde NO hereda el acceso", async () => {
    await repo.addAllowedChannel(handle.db, "amiga");
    expect((await loginAs({ sub: "200", login: "amiga" })).session).toBeTruthy();
    // la amiga se cambia de nombre y un desconocido toma "amiga"
    const impostor = await loginAs({ sub: "999", login: "amiga" });
    expect(impostor.cb.headers.location).toBe("/admin/?login_error=not_allowed");
    expect(impostor.session).toBeUndefined();
  });

  it("si la amiga cambia de nombre en Twitch, sigue entrando con su id y se actualiza su login", async () => {
    await repo.addAllowedChannel(handle.db, "amiga");
    await loginAs({ sub: "200", login: "amiga" });
    const again = await loginAs({ sub: "200", login: "amiga_nueva" });
    expect(again.cb.headers.location).toBe("/admin/");
    const me = (await built.app.inject({ method: "GET", url: "/api/admin/me", headers: asSession(again.session as string) })).json();
    expect(me.streamer.login).toBe("amiga_nueva");
  });

  it("el dueño no puede ser suplantado: si su fila ya está vinculada, otro id con su login no entra", async () => {
    await loginAs({ sub: "100", login: "nazhika" });
    const fake = await loginAs({ sub: "666", login: "nazhika" });
    expect(fake.cb.headers.location).toBe("/admin/?login_error=not_allowed");
  });
});

describe("reglas del prefijo __Host- (el navegador descarta la cookie si no se cumplen)", () => {
  it("todas las cookies que ponemos llevan Secure, Path=/ y no llevan Domain", async () => {
    const { start, cb } = await loginAs({ sub: "100", login: "nazhika" });
    const out = await built.app.inject({ method: "POST", url: "/api/admin/logout", headers: asSession(cookiesOf(cb).get(SESSION) as string, csrf) });
    const all = [...rawSetCookies(start), ...rawSetCookies(cb), ...rawSetCookies(out)].filter((c) => c.startsWith("__Host-"));
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const c of all) {
      expect(c).toContain("; Secure");
      expect(c).toContain("; Path=/;");
      expect(c).not.toMatch(/Domain=/i);
    }
  });
});

describe("sesiones y CSRF", () => {
  it("sin cookie ni clave: 401; cookie inventada: 401", async () => {
    expect((await built.app.inject({ method: "GET", url: "/api/admin/me" })).statusCode).toBe(401);
    const r = await built.app.inject({ method: "GET", url: "/api/admin/me", headers: asSession("a".repeat(43)) });
    expect(r.statusCode).toBe(401);
    const bad = await built.app.inject({ method: "GET", url: "/api/admin/me", headers: asSession("corta") });
    expect(bad.statusCode).toBe(401);
  });

  it("los cambios con cookie exigen la cabecera CSRF; las lecturas no", async () => {
    const { session } = await loginAs({ sub: "100", login: "nazhika" });
    const get = await built.app.inject({ method: "GET", url: "/api/admin/settings", headers: asSession(session as string) });
    expect(get.statusCode).toBe(200);
    const noCsrf = await built.app.inject({
      method: "PATCH", url: "/api/admin/settings", headers: asSession(session as string), payload: { maxPets: 7 },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error).toBe("csrf");
    const ok = await built.app.inject({
      method: "PATCH", url: "/api/admin/settings", headers: asSession(session as string, csrf), payload: { maxPets: 7 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().maxPets).toBe(7);
  });

  it("con cookie, un Origin ajeno se rechaza aunque traiga la cabecera", async () => {
    const { session } = await loginAs({ sub: "100", login: "nazhika" });
    const evil = await built.app.inject({
      method: "PATCH", url: "/api/admin/settings",
      headers: asSession(session as string, { ...csrf, origin: "https://evil.example" }), payload: { maxPets: 7 },
    });
    expect(evil.statusCode).toBe(403);
    const good = await built.app.inject({
      method: "PATCH", url: "/api/admin/settings",
      headers: asSession(session as string, { ...csrf, origin: ORIGIN }), payload: { maxPets: 7 },
    });
    expect(good.statusCode).toBe(200);
  });

  it("la clave de administración sigue funcionando sin CSRF (no es una cookie)", async () => {
    const r = await built.app.inject({
      method: "PATCH", url: "/api/admin/settings", headers: { authorization: `Bearer ${ADMIN}` }, payload: { maxPets: 9 },
    });
    expect(r.statusCode).toBe(200);
    const me = (await built.app.inject({ method: "GET", url: "/api/admin/me", headers: { authorization: `Bearer ${ADMIN}` } })).json();
    expect(me.role).toBe("admin");
    expect(me.streamer.login).toBe("nazhika");
  });

  it("clave incorrecta con Bearer: 401, y una cookie válida no la rescata", async () => {
    const { session } = await loginAs({ sub: "100", login: "nazhika" });
    const r = await built.app.inject({
      method: "GET", url: "/api/admin/me", headers: { ...asSession(session as string), authorization: "Bearer mala" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("la sesión vence con el tiempo", async () => {
    const { session } = await loginAs({ sub: "100", login: "nazhika" });
    const h = asSession(session as string);
    expect((await built.app.inject({ method: "GET", url: "/api/admin/me", headers: h })).statusCode).toBe(200);
    now = new Date(now.getTime() + AUTH.sessionTtlMs + 1000);
    expect((await built.app.inject({ method: "GET", url: "/api/admin/me", headers: h })).statusCode).toBe(401);
  });

  it("logout cierra la sesión en el servidor y borra la cookie", async () => {
    const { session } = await loginAs({ sub: "100", login: "nazhika" });
    const out = await built.app.inject({ method: "POST", url: "/api/admin/logout", headers: asSession(session as string, csrf) });
    expect(out.statusCode).toBe(204);
    expect(rawSetCookies(out).find((c) => c.startsWith(SESSION))).toContain("Max-Age=0");
    expect((await built.app.inject({ method: "GET", url: "/api/admin/me", headers: asSession(session as string) })).statusCode).toBe(401);
  });

  it("logout sin la cabecera CSRF se rechaza", async () => {
    const { session } = await loginAs({ sub: "100", login: "nazhika" });
    const out = await built.app.inject({ method: "POST", url: "/api/admin/logout", headers: asSession(session as string) });
    expect(out.statusCode).toBe(403);
  });
});

describe("canales autorizados (solo administrador)", () => {
  const adm = { authorization: `Bearer ${ADMIN}` };

  it("el dueño está en la lista desde el inicio y no se puede quitar", async () => {
    const list = (await built.app.inject({ method: "GET", url: "/api/admin/channels", headers: adm })).json();
    expect(list.items).toEqual([expect.objectContaining({ login: "nazhika", owner: true, linked: false })]);
    const del = await built.app.inject({ method: "DELETE", url: "/api/admin/channels/nazhika", headers: adm });
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toBe("owner");
  });

  it("agregar es idempotente y valida el login", async () => {
    const a = await built.app.inject({ method: "POST", url: "/api/admin/channels", headers: adm, payload: { login: "amiga" } });
    expect(a.statusCode).toBe(201);
    const b = await built.app.inject({ method: "POST", url: "/api/admin/channels", headers: adm, payload: { login: "amiga" } });
    expect(b.statusCode).toBe(201);
    expect((await repo.listAllowedChannels(handle.db)).filter((r) => r.login === "amiga")).toHaveLength(1);
    for (const login of ["con espacio", "", "x".repeat(40), "a;b"]) {
      const bad = await built.app.inject({ method: "POST", url: "/api/admin/channels", headers: adm, payload: { login } });
      expect(bad.statusCode).toBe(400);
    }
    const extra = await built.app.inject({ method: "POST", url: "/api/admin/channels", headers: adm, payload: { login: "ok", x: 1 } });
    expect(extra.statusCode).toBe(400);
  });

  it("un streamer con sesión NO puede ver ni tocar la lista (403)", async () => {
    await repo.addAllowedChannel(handle.db, "amiga");
    const { session } = await loginAs({ sub: "200", login: "amiga" });
    const h = asSession(session as string, csrf);
    expect((await built.app.inject({ method: "GET", url: "/api/admin/channels", headers: h })).statusCode).toBe(403);
    expect((await built.app.inject({ method: "POST", url: "/api/admin/channels", headers: h, payload: { login: "otro" } })).statusCode).toBe(403);
    expect((await built.app.inject({ method: "DELETE", url: "/api/admin/channels/nazhika", headers: h })).statusCode).toBe(403);
    expect((await repo.listAllowedChannels(handle.db)).map((r) => r.login).sort()).toEqual(["amiga", "nazhika"]);
  });

  it("al quitar un canal: se cierran sus sesiones, deja de leerse su chat y no puede volver a entrar", async () => {
    await repo.addAllowedChannel(handle.db, "amiga");
    const { session } = await loginAs({ sub: "200", login: "amiga" });
    const amigaId = ready[0]?.[0] as string;
    const del = await built.app.inject({ method: "DELETE", url: "/api/admin/channels/amiga", headers: adm });
    expect(del.statusCode).toBe(204);
    expect(removed).toEqual([amigaId]);
    expect((await built.app.inject({ method: "GET", url: "/api/admin/me", headers: asSession(session as string) })).statusCode).toBe(401);
    expect((await loginAs({ sub: "200", login: "amiga" })).cb.headers.location).toBe("/admin/?login_error=not_allowed");
    expect((await repo.listActiveStreamerChannels(handle.db)).map((c) => c.login)).not.toContain("amiga");
  });

  it("quitar un canal que no existe → 404", async () => {
    const r = await built.app.inject({ method: "DELETE", url: "/api/admin/channels/fantasma", headers: adm });
    expect(r.statusCode).toBe(404);
  });

  it("la lista marca como vinculado a quien ya entró", async () => {
    await repo.addAllowedChannel(handle.db, "amiga");
    await loginAs({ sub: "200", login: "amiga" });
    const list = (await built.app.inject({ method: "GET", url: "/api/admin/channels", headers: adm })).json();
    expect(list.items.find((i: { login: string }) => i.login === "amiga")).toMatchObject({ linked: true, owner: false });
  });
});

describe("aislamiento entre streamers", () => {
  it("lo de una streamer no se ve ni se toca desde la sesión de otra", async () => {
    await repo.addAllowedChannel(handle.db, "amiga");
    const owner = await loginAs({ sub: "100", login: "nazhika" });
    const friend = await loginAs({ sub: "200", login: "amiga" });
    const hO = asSession(owner.session as string, csrf);
    const hF = asSession(friend.session as string, csrf);
    const friendId = ready[1]?.[0] as string;

    // la dueña tiene un espectador con mascota, un overlay y ajustes propios
    const viewer = await repo.createViewerWithPet(
      handle.db, ownerId, { twitchUserId: "v1", login: "luna", displayName: "Luna", isSubscriber: false }, "shiba",
    );
    const ov = (await built.app.inject({ method: "POST", url: "/api/admin/overlays", headers: hO, payload: { name: "mio" } })).json();
    await built.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: hO, payload: { maxPets: 3 } });

    // la amiga no ve nada de eso
    const viewers = (await built.app.inject({ method: "GET", url: "/api/admin/viewers", headers: hF })).json();
    expect(viewers.total).toBe(0);
    const ovs = (await built.app.inject({ method: "GET", url: "/api/admin/overlays", headers: hF })).json();
    expect(JSON.stringify(ovs)).not.toContain(ov.id);
    expect((await built.app.inject({ method: "GET", url: "/api/admin/settings", headers: hF })).json().maxPets).not.toBe(3);

    // ni puede modificar la mascota, revocar el overlay de la otra
    const viewerId = viewer.viewer.id;
    const patch = await built.app.inject({ method: "PATCH", url: `/api/admin/viewers/${viewerId}/pet`, headers: hF, payload: { speciesId: "cat" } });
    expect(patch.statusCode).toBe(404);
    const revoke = await built.app.inject({ method: "DELETE", url: `/api/admin/overlays/${ov.id}`, headers: hF });
    expect([403, 404]).toContain(revoke.statusCode);
    expect((await repo.listOverlays(handle.db, ownerId)).every((o) => o.revokedAt === null)).toBe(true);
    expect((await repo.getViewerWithPet(handle.db, ownerId, viewerId))?.pet?.speciesId).toBe("shiba");

    // y sus datos quedan en su propia cuenta
    expect(friendId).not.toBe(ownerId);
    const mine = (await built.app.inject({ method: "GET", url: "/api/admin/viewers", headers: hO })).json();
    expect(mine.total).toBe(1);
  });

  it("el estado de Twitch que ve una streamer es el resumido (sin canales ajenos)", async () => {
    const b = await buildApp({
      db: handle.db, species: makeCatalog(), adminToken: ADMIN, streamerId: ownerId, ownerLogin: "nazhika",
      auth: AUTH, oauth: mkOauth(twitch), assetsDir: ASSETS_DIR, overlayDist: "/nonexistent", logLevel: "silent",
      clock: new FakeClock(), now: () => now,
      twitchStatus: (_id, role) => (role === "admin" ? { full: true, channels: ["a", "b"] } : { reading: true }),
    });
    await b.app.ready();
    await repo.addAllowedChannel(handle.db, "amiga");
    // login contra la nueva instancia
    const start = await b.app.inject({ method: "GET", url: "/auth/twitch/login", headers: HOST });
    const loc = new URL(start.headers.location as string);
    twitch.grant("zz", { sub: "200", login: "amiga", nonce: loc.searchParams.get("nonce") as string });
    const cb = await b.app.inject({
      method: "GET", url: `/auth/twitch/callback?code=zz&state=${loc.searchParams.get("state")}`,
      headers: { ...HOST, cookie: `${OAUTHC}=${cookiesOf(start).get(OAUTHC)}` },
    });
    const session = cookiesOf(cb).get(SESSION) as string;
    const asF = (await b.app.inject({ method: "GET", url: "/api/admin/me", headers: asSession(session) })).json();
    expect(asF.twitch).toEqual({ reading: true });
    const asA = (await b.app.inject({ method: "GET", url: "/api/admin/me", headers: { authorization: `Bearer ${ADMIN}` } })).json();
    expect(asA.twitch).toEqual({ full: true, channels: ["a", "b"] });
    await b.app.close();
  });
});
