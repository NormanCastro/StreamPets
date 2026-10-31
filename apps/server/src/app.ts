import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastify from "fastify";
import type { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { Db } from "./db/client.js";
import { ChatService } from "./domain/chat-service.js";
import { mathRng, systemClock } from "./domain/rng.js";
import type { Clock, Rng } from "./domain/rng.js";
import type { SpeciesCatalog } from "./domain/species.js";
import type { TwitchOAuth } from "./auth/twitch-oauth.js";
import { registerAdminRoutes } from "./http/admin.js";
import { registerAuthRoutes } from "./http/auth.js";
import type { AuthSettings, Role } from "./http/auth.js";
import { OverlayHub } from "./http/hub.js";
import { looksLikeOverlayToken } from "./lib/tokens.js";

export interface AppOptions {
  db: Db;
  species: SpeciesCatalog;
  adminToken: string;
  streamerId: string;
  /** Login del dueño de la instalación (su canal siempre está autorizado). */
  ownerLogin: string;
  /** Sesiones del dashboard y cookies. */
  auth: AuthSettings;
  /** Login con Twitch; undefined si no está configurado (solo se entra con la clave). */
  oauth?: TwitchOAuth | undefined;
  /** Alguien autorizado entró: hay que empezar a leer el chat de su canal. */
  onStreamerReady?: (streamerId: string, login: string) => void;
  /** Se le quitó el permiso a un canal: hay que dejar de leer su chat. */
  onChannelRemoved?: (streamerId: string) => void;
  assetsDir: string;
  overlayDist: string;
  /** Panel de administración compilado (se sirve en /admin/). Opcional. */
  dashboardDist?: string;
  /** Estado del lector de chat de Twitch (para /api/admin/me): completo para el administrador, resumido para un streamer. */
  twitchStatus?: (streamerId: string, role: Role) => unknown;
  allowedOrigins?: string[];
  enableDevChat?: boolean;
  trustProxy?: boolean;
  logLevel?: string;
  clock?: Clock;
  rng?: Rng;
  /** Para probar sesiones que vencen. */
  now?: () => Date;
}

export interface BuiltApp {
  app: FastifyInstance;
  service: ChatService;
  hub: OverlayHub;
}

/** Los tokens del overlay viajan en la URL: nunca deben acabar en los logs. */
export function redactUrl(url: string): string {
  return url
    .replace(/(\/overlay\/pets\/)[^/?#]+/, "$1[redacted]")
    .replace(/([?&]token=)[^&#]*/, "$1[redacted]");
}

export async function buildApp(opts: AppOptions): Promise<BuiltApp> {
  const app = fastify({
    logger: {
      level: opts.logLevel ?? "info",
      serializers: {
        req(req) {
          return { method: req.method ?? "", url: redactUrl(req.url ?? ""), remoteAddress: req.ip };
        },
      },
    },
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 16 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 1024 } });

  // CORS solo para los orígenes configurados (dashboard alojado aparte).
  const allowed = new Set(opts.allowedOrigins ?? []);
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin) || !req.url.startsWith("/api/")) return;
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
    if (req.method === "OPTIONS") {
      reply
        .header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
        .header("Access-Control-Allow-Headers", "Authorization,Content-Type,X-StreamPets-CSRF")
        .header("Access-Control-Max-Age", "600")
        .code(204)
        .send();
    }
  });

  // ── Servicio de chat y hub de overlays ──
  let service!: ChatService;
  const hub = new OverlayHub(opts.db, async (streamerId) => {
    const s = await service.snapshot(streamerId);
    return { type: "snapshot", pets: s.pets, maxPets: s.maxPets };
  });
  service = new ChatService({
    db: opts.db,
    broadcaster: hub,
    species: opts.species,
    clock: opts.clock ?? systemClock,
    rng: opts.rng ?? mathRng,
    log: app.log,
  });
  hub.start();
  app.addHook("onClose", async () => {
    hub.stop();
  });

  // ── Rutas públicas ──
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/species", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=60");
    return { species: opts.species.list() };
  });

  app.get("/ws/overlay", { websocket: true }, async (socket, req) => {
    const token = (req.query as { token?: unknown }).token;
    await hub.connect(socket, typeof token === "string" ? token : undefined);
  });

  registerAuthRoutes(app, {
    db: opts.db,
    oauth: opts.oauth,
    auth: opts.auth,
    onStreamerReady: opts.onStreamerReady ?? (() => undefined),
    log: app.log,
    ...(opts.now ? { now: opts.now } : {}),
  });

  registerAdminRoutes(app, {
    db: opts.db,
    service,
    hub,
    species: opts.species,
    adminToken: opts.adminToken,
    streamerId: opts.streamerId,
    ownerLogin: opts.ownerLogin,
    auth: opts.auth,
    enableDevChat: opts.enableDevChat ?? false,
    twitchStatus: opts.twitchStatus ?? (() => null),
    ...(opts.onChannelRemoved ? { onChannelRemoved: opts.onChannelRemoved } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  // ── Archivos estáticos: sprites y overlay compilado ──
  await app.register(fastifyStatic, {
    root: resolve(opts.assetsDir),
    prefix: "/assets/",
    maxAge: "5m",
    decorateReply: true,
  });

  if (existsSync(resolve(opts.overlayDist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: resolve(opts.overlayDist),
      prefix: "/overlay/",
      index: false,
      decorateReply: false,
      maxAge: "1h",
    });
    app.get("/overlay/pets/:token", async (req, reply) => {
      const { token } = req.params as { token: string };
      if (!looksLikeOverlayToken(token)) return reply.code(404).send({ error: "not_found" });
      // La página lleva el token en su URL: sin caché y sin enviarlo como referrer.
      reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer").type("text/html");
      return reply.sendFile("index.html", resolve(opts.overlayDist), { cacheControl: false });
    });
  }

  if (opts.dashboardDist && existsSync(resolve(opts.dashboardDist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: resolve(opts.dashboardDist),
      prefix: "/admin/",
      decorateReply: false,
      maxAge: "1h",
      // index.html sin caché: apunta a archivos con hash que cambian en cada compilación.
      setHeaders: (res, path) => {
        if (path.endsWith("index.html")) res.header("Cache-Control", "no-cache");
      },
    });
    app.get("/admin", async (_req, reply) => reply.redirect("/admin/"));
  }

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));
  return { app, service, hub };
}
