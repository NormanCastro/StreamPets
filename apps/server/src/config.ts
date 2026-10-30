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
  streamerDisplayName: string;
  allowedOrigins: string[];
  enableDevChat: boolean;
  trustProxy: boolean;
  assetsDir: string;
  overlayDist: string;
  dashboardDist: string;
  migrationsDir: string;
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

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    pgliteDir: e.PGLITE_DIR,
    adminToken: adminToken as string,
    adminTokenGenerated,
    streamerLogin: e.STREAMER_LOGIN.toLowerCase(),
    streamerDisplayName: e.STREAMER_DISPLAY_NAME,
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
