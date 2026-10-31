import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
/** Raíz del monorepo (apps/server/src -> ../../..). */
const repoRoot = resolve(here, "../../..");

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Postgres. Si falta se usa PGlite (Postgres embebido) en PGLITE_DIR: cómodo para desarrollar. */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default(resolve(repoRoot, "apps/server/data/pglite")),
  /** Clave del panel de administración (provisional hasta tener login con Twitch). */
  ADMIN_TOKEN: z.string().optional(),
  STREAMER_LOGIN: z.string().default("streamer"),
  STREAMER_DISPLAY_NAME: z.string().default("Streamer"),
  /** Lectura del chat real de Twitch. Apagada por defecto. */
  TWITCH_CHAT_ENABLED: bool.optional(),
  /** Canal a leer. Si falta se usa STREAMER_LOGIN. */
  TWITCH_CHANNEL: z.string().optional(),
  /** Opcional (vía oficial): cuenta y token de usuario con permiso chat:read. Sin ellos se lee como anónimo. */
  TWITCH_BOT_LOGIN: z.string().optional(),
  TWITCH_OAUTH_TOKEN: z.string().optional(),
  /** Solo para pruebas con un servidor IRC falso. */
  TWITCH_IRC_URL: z.string().optional(),
  /** Login con Twitch (OpenID Connect). Los tres van juntos; sin ellos solo se entra con la clave de administración. */
  TWITCH_CLIENT_ID: z.string().optional(),
  TWITCH_CLIENT_SECRET: z.string().optional(),
  /** Dirección pública del servicio, p. ej. https://streampets.live (sin barra final). */
  PUBLIC_URL: z.string().optional(),
  /** Solo para pruebas con un Twitch falso. */
  TWITCH_ID_URL: z.string().optional(),
  /** Duración de la sesión del dashboard. */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  /** Orígenes permitidos para CORS (dashboard en otro dominio), separados por coma. */
  ALLOWED_ORIGINS: z.string().default(""),
  ENABLE_DEV_CHAT: bool.optional(),
  /** Detrás de un proxy (Render): usar X-Forwarded-For para la IP real. */
  TRUST_PROXY: bool.optional(),
  ASSETS_DIR: z.string().default(resolve(repoRoot, "shared-public/assets")),
  OVERLAY_DIST: z.string().default(resolve(repoRoot, "apps/overlay/dist")),
  DASHBOARD_DIST: z.string().default(resolve(repoRoot, "apps/dashboard/dist")),
  MIGRATIONS_DIR: z.string().default(resolve(repoRoot, "apps/server/drizzle")),
});

export interface Config {
  nodeEnv: "development" | "production" | "test";
  port: number;
  host: string;
  logLevel: string;
  databaseUrl: string | undefined;
  pgliteDir: string;
  adminToken: string;
  /** true si el token se generó automáticamente (solo en desarrollo). */
  adminTokenGenerated: boolean;
  streamerLogin: string;
  twitchChatEnabled: boolean;
  twitchChannel: string;
  twitchIrcUrl: string | undefined;
  /** Si es undefined se lee el chat como anónimo. */
  twitchAuth: { login: string; token: string } | undefined;
  streamerDisplayName: string;
  /** undefined = el login con Twitch no está configurado. */
  twitchLogin: TwitchLoginConfig | undefined;
  /** Origen público (https://dominio) si está configurado; se usa para validar de dónde vienen las peticiones con sesión. */
  publicOrigin: string | undefined;
  cookieSecure: boolean;
  sessionTtlMs: number;
  allowedOrigins: string[];
  enableDevChat: boolean;
  trustProxy: boolean;
  assetsDir: string;
  overlayDist: string;
  dashboardDist: string;
  migrationsDir: string;
}

export interface TwitchLoginConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  idBaseUrl: string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Configuración inválida: ${message}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";

  let adminToken = e.ADMIN_TOKEN;
  let adminTokenGenerated = false;
  if (production) {
    if (!adminToken || adminToken.length < 24) {
      throw new ConfigError("en producción ADMIN_TOKEN es obligatorio y debe tener al menos 24 caracteres");
    }
    if (!e.DATABASE_URL) throw new ConfigError("en producción DATABASE_URL es obligatorio");
  } else if (!adminToken) {
    adminToken = `dev-${randomBytes(18).toString("base64url")}`;
    adminTokenGenerated = true;
  }

  // Acepta "@Nombre", "#nombre" o con espacios: se deja el login limpio y en minúsculas.
  const cleanLogin = (s: string): string => s.trim().replace(/^[@#]+/, "").toLowerCase();
  const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
  const twitchChatEnabled = e.TWITCH_CHAT_ENABLED ?? false;
  const streamerLogin = cleanLogin(e.STREAMER_LOGIN);
  const twitchChannel = cleanLogin(e.TWITCH_CHANNEL ?? e.STREAMER_LOGIN);
  let twitchAuth: { login: string; token: string } | undefined;
  if (twitchChatEnabled) {
    if (e.TWITCH_CHANNEL === undefined && env["STREAMER_LOGIN"] === undefined) {
      throw new ConfigError("con TWITCH_CHAT_ENABLED hay que definir TWITCH_CHANNEL o STREAMER_LOGIN (el usuario de Twitch del canal)");
    }
    if (!LOGIN_RE.test(twitchChannel)) {
      throw new ConfigError(`el canal de Twitch "${twitchChannel}" no es válido (1 a 25 letras, números o guion bajo)`);
    }
    if ((e.TWITCH_BOT_LOGIN === undefined) !== (e.TWITCH_OAUTH_TOKEN === undefined)) {
      throw new ConfigError("TWITCH_BOT_LOGIN y TWITCH_OAUTH_TOKEN van juntos: define los dos o ninguno");
    }
    if (e.TWITCH_BOT_LOGIN !== undefined && e.TWITCH_OAUTH_TOKEN !== undefined) {
      const login = cleanLogin(e.TWITCH_BOT_LOGIN);
      const token = e.TWITCH_OAUTH_TOKEN.trim().replace(/^oauth:/i, "");
      if (!LOGIN_RE.test(login)) throw new ConfigError("TWITCH_BOT_LOGIN no es un usuario de Twitch válido");
      if (!/^[A-Za-z0-9]{10,100}$/.test(token)) throw new ConfigError("TWITCH_OAUTH_TOKEN no tiene el formato de un token de Twitch");
      twitchAuth = { login, token };
    }
  }

  // Login con Twitch: client id, secret y dirección pública, todo o nada.
  const loginVars = [e.TWITCH_CLIENT_ID, e.TWITCH_CLIENT_SECRET, e.PUBLIC_URL];
  const loginSet = loginVars.filter((v) => v !== undefined && v.trim() !== "").length;
  let twitchLogin: TwitchLoginConfig | undefined;
  let publicOrigin: string | undefined;
  if (loginSet !== 0 && loginSet !== 3) {
    throw new ConfigError("TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET y PUBLIC_URL van juntos: define los tres o ninguno");
  }
  if (loginSet === 3) {
    let url: URL;
    try {
      url = new URL((e.PUBLIC_URL as string).trim());
    } catch {
      throw new ConfigError("PUBLIC_URL no es una dirección válida (ej: https://streampets.live)");
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new ConfigError("PUBLIC_URL debe empezar con https:// (http:// solo vale para localhost)");
    }
    if (production && local) throw new ConfigError("en producción PUBLIC_URL no puede ser localhost");
    publicOrigin = url.origin;
    twitchLogin = {
      clientId: (e.TWITCH_CLIENT_ID as string).trim(),
      clientSecret: (e.TWITCH_CLIENT_SECRET as string).trim(),
      redirectUri: `${url.origin}/auth/twitch/callback`,
      idBaseUrl: e.TWITCH_ID_URL,
    };
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    pgliteDir: e.PGLITE_DIR,
    adminToken: adminToken as string,
    adminTokenGenerated,
    streamerLogin,
    twitchChatEnabled,
    twitchChannel,
    twitchIrcUrl: e.TWITCH_IRC_URL,
    twitchAuth,
    streamerDisplayName: e.STREAMER_DISPLAY_NAME,
    twitchLogin,
    publicOrigin,
    cookieSecure: publicOrigin?.startsWith("https:") ?? production,
    sessionTtlMs: e.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    allowedOrigins: e.ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // El chat simulado nunca está activo por defecto en producción.
    enableDevChat: e.ENABLE_DEV_CHAT ?? !production,
    trustProxy: e.TRUST_PROXY ?? production,
    assetsDir: e.ASSETS_DIR,
    overlayDist: e.OVERLAY_DIST,
    dashboardDist: e.DASHBOARD_DIST,
    migrationsDir: e.MIGRATIONS_DIR,
  };
}
