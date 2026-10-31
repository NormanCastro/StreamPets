import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OidcError } from "../auth/oidc.js";
import type { TwitchOAuth } from "../auth/twitch-oauth.js";
import type { Db } from "../db/client.js";
import * as repo from "../db/repo.js";
import { hashToken, looksLikeAccessKey, safeEqual } from "../lib/tokens.js";

export type Role = "admin" | "streamer";

export interface AuthSettings {
  cookieSecure: boolean;
  /** https://dominio. Si existe, las peticiones con sesión deben venir de este origen. */
  publicOrigin: string | undefined;
  sessionTtlMs: number;
}

export interface Principal {
  streamerId: string;
  role: Role;
  via: "token" | "session";
  /** Hash de la sesión actual (para cerrarla). */
  sessionHash?: string;
}

export const CSRF_HEADER = "x-streampets-csrf";

// ───────────────────────────── cookies ─────────────────────────────

/** Con HTTPS se usa el prefijo __Host-: el navegador solo la acepta con Secure, Path=/ y sin Domain. */
export function cookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (name === "") continue;
    const value = part.slice(i + 1).trim();
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  o: { secure: boolean; maxAgeSec: number; path?: string },
): string {
  return [
    `${name}=${value}`,
    `Path=${o.path ?? "/"}`,
    `Max-Age=${o.maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(o.secure ? ["Secure"] : []),
  ].join("; ");
}

// ───────────────────────────── identificar a quien pide ─────────────────────────────

export interface AuthenticateDeps {
  db: Db;
  adminToken: string;
  /** Streamer al que da acceso la clave de administración. */
  ownerStreamerId: string;
  auth: AuthSettings;
  now?: () => Date;
}

export type AuthOutcome = { ok: true; principal: Principal } | { ok: false; status: 401 | 403; error: string };

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return undefined;
  return h.slice(7).trim();
}

/**
 * Quién hace la petición: la clave de administración (super-admin del dueño) o una sesión de Twitch.
 * Las peticiones que cambian algo y vienen con cookie exigen además una cabecera propia (CSRF):
 * un sitio ajeno no puede enviarla sin permiso de CORS, y nosotros no lo damos.
 */
export async function authenticate(req: FastifyRequest, d: AuthenticateDeps): Promise<AuthOutcome> {
  const token = bearer(req);
  if (token !== undefined) {
    if (safeEqual(token, d.adminToken)) {
      return { ok: true, principal: { streamerId: d.ownerStreamerId, role: "admin", via: "token" } };
    }
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies.get(cookieName("sp_session", d.auth.cookieSecure));
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return { ok: false, status: 401, error: "unauthorized" };
  const hash = hashToken(raw);
  const session = await repo.findSession(d.db, hash, (d.now ?? (() => new Date()))());
  if (!session) return { ok: false, status: 401, error: "unauthorized" };

  const safe = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  if (!safe) {
    if (req.headers[CSRF_HEADER] !== "1") return { ok: false, status: 403, error: "csrf" };
    const origin = req.headers.origin;
    if (origin !== undefined && d.auth.publicOrigin !== undefined && origin !== d.auth.publicOrigin) {
      return { ok: false, status: 403, error: "csrf" };
    }
  }
  return { ok: true, principal: { streamerId: session.streamerId, role: "streamer", via: "session", sessionHash: hash } };
}

// ───────────────────────────── rutas /auth ─────────────────────────────

export interface AuthRoutesDeps {
  db: Db;
  /** undefined = login con Twitch no configurado. */
  oauth: TwitchOAuth | undefined;
  auth: AuthSettings;
  /** Se llama cuando alguien entra bien: aquí se empieza a leer su chat. */
  onStreamerReady: (streamerId: string, login: string) => void;
  log: { warn(obj: unknown, msg?: string): void };
  now?: () => Date;
}

const CallbackQuery = z.object({
  code: z.string().regex(/^[A-Za-z0-9]{1,200}$/).optional(),
  state: z.string().max(200).optional(),
  error: z.string().max(200).optional(),
});

function backToPanel(reply: FastifyReply, reason?: string): FastifyReply {
  return reply.header("Cache-Control", "no-store").redirect(reason ? `/admin/?login_error=${reason}` : "/admin/");
}

export function registerAuthRoutes(app: FastifyInstance, d: AuthRoutesDeps): void {
  const oauthCookie = cookieName("sp_oauth", d.auth.cookieSecure);
  const sessionCookie = cookieName("sp_session", d.auth.cookieSecure);
  const now = d.now ?? (() => new Date());
  const publicHost = d.auth.publicOrigin ? new URL(d.auth.publicOrigin).host : undefined;

  app.get("/auth/status", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { twitch: d.oauth !== undefined };
  });

  // Entrada con la clave personal del canal (respaldo para cuando Twitch no funciona).
  app.post("/auth/key", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    // Crea una sesión, así que exige lo mismo que los cambios con cookie: cabecera propia y origen válido.
    const origin = req.headers.origin;
    if (
      req.headers[CSRF_HEADER] !== "1" ||
      (origin !== undefined && d.auth.publicOrigin !== undefined && origin !== d.auth.publicOrigin)
    ) {
      return reply.code(403).send({ error: "csrf" });
    }
    const body = z.object({ key: z.string().max(100) }).strict().safeParse(req.body);
    const key = body.success ? body.data.key.trim() : "";
    if (!looksLikeAccessKey(key)) return reply.code(401).send({ error: "invalid_key" });
    const row = await repo.findAllowedChannelByKeyHash(d.db, hashToken(key));
    if (!row) return reply.code(401).send({ error: "invalid_key" });

    // Quien nunca entró con Twitch todavía no tiene cuenta: se crea aquí (y Twitch la vinculará después).
    const streamer =
      (await repo.findStreamerForAllowed(d.db, row)) ??
      (await repo.ensureStreamer(d.db, { login: row.login, displayName: row.login }));
    await repo.deleteExpiredSessions(d.db, now());
    const token = randomBytes(32).toString("base64url");
    await repo.createSession(d.db, {
      streamerId: streamer.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(now().getTime() + d.auth.sessionTtlMs),
    });
    reply.header(
      "Set-Cookie",
      serializeCookie(sessionCookie, token, { secure: d.auth.cookieSecure, maxAgeSec: Math.floor(d.auth.sessionTtlMs / 1000) }),
    );
    d.onStreamerReady(streamer.id, streamer.login);
    return { ok: true };
  });

  app.get("/auth/twitch/login", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!d.oauth) return reply.code(404).send({ error: "twitch_login_disabled" });
    // El navegador tiene que iniciar y terminar el login en la misma dirección (la de la cookie).
    if (publicHost !== undefined && req.headers.host !== publicHost) {
      return reply.redirect(`${d.auth.publicOrigin as string}/auth/twitch/login`);
    }
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    reply.header(
      "Set-Cookie",
      serializeCookie(oauthCookie, `${state}.${nonce}`, { secure: d.auth.cookieSecure, maxAgeSec: 600 }),
    );
    return reply.header("Cache-Control", "no-store").redirect(d.oauth.authorizeUrl({ state, nonce }));
  });

  app.get("/auth/twitch/callback", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    // La cookie de estado sirve una sola vez, pase lo que pase.
    const cookies = [serializeCookie(oauthCookie, "", { secure: d.auth.cookieSecure, maxAgeSec: 0 })];
    const finish = (reason?: string): FastifyReply => {
      reply.header("Set-Cookie", cookies);
      return backToPanel(reply, reason);
    };
    if (!d.oauth) return finish("disabled");

    const q = CallbackQuery.safeParse(req.query);
    if (!q.success) return finish("state");
    if (q.data.error !== undefined) return finish("denied");

    const saved = parseCookies(req.headers.cookie).get(oauthCookie) ?? "";
    const [state = "", nonce = ""] = saved.split(".");
    if (!state || !nonce || !q.data.state || !safeEqual(q.data.state, state) || !q.data.code) {
      return finish("state");
    }

    let who;
    try {
      who = await d.oauth.identify(q.data.code, nonce);
    } catch (err) {
      d.log.warn({ reason: err instanceof OidcError ? err.message : "fallo al hablar con Twitch" }, "login con Twitch rechazado");
      return finish("twitch");
    }

    const allowed = await repo.findAllowedChannelFor(d.db, who);
    if (!allowed) return finish("not_allowed");

    let streamer;
    try {
      streamer = await repo.upsertStreamerFromTwitch(d.db, who);
    } catch (err) {
      if (err instanceof repo.StreamerConflictError) return finish("conflict");
      throw err;
    }
    await repo.bindAllowedChannel(d.db, allowed.id, who);
    if (who.avatarUrl !== undefined && who.avatarUrl !== streamer.avatarUrl) {
      await repo.setStreamerAvatar(d.db, streamer.id, who.avatarUrl);
    }

    await repo.deleteExpiredSessions(d.db, now());
    const token = randomBytes(32).toString("base64url");
    await repo.createSession(d.db, {
      streamerId: streamer.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(now().getTime() + d.auth.sessionTtlMs),
    });
    cookies.push(
      serializeCookie(sessionCookie, token, { secure: d.auth.cookieSecure, maxAgeSec: Math.floor(d.auth.sessionTtlMs / 1000) }),
    );
    d.onStreamerReady(streamer.id, streamer.login);
    return finish();
  });
}
