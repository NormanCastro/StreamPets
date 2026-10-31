import { createPublicKey, verify } from "node:crypto";

/**
 * Verificación del id_token que entrega Twitch (OpenID Connect).
 * Según la documentación de Twitch: firma RS256 con las claves de /oauth2/keys,
 * `iss` = https://id.twitch.tv/oauth2, `aud` = el client id de la app y `nonce` si se envió.
 */

export class OidcError extends Error {
  constructor(message: string) {
    super(`OIDC: ${message}`);
    this.name = "OidcError";
  }
}

export interface Jwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  [k: string]: unknown;
}

export interface IdTokenClaims {
  /** ID numérico del usuario de Twitch. */
  sub: string;
  /** Login de Twitch, si el token lo trae (se pide con el parámetro `claims`). */
  preferredUsername: string | undefined;
  /** Foto de perfil (solo si viene del CDN de Twitch por https). */
  picture: string | undefined;
}

/** La foto solo se acepta del CDN de imágenes de Twitch: así nadie puede meter una dirección cualquiera en la página. */
const AVATAR_RE = /^https:\/\/static-cdn\.jtvnw\.net\/[A-Za-z0-9_./%-]{1,300}$/;

export interface VerifyOptions {
  keys: readonly Jwk[];
  issuer: string;
  audience: string;
  nonce: string;
  /** Segundos desde 1970. */
  nowSec: number;
  /** Tolerancia al desfase de relojes, en segundos. */
  leewaySec?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function b64urlJson(part: string, what: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (!isRecord(parsed)) throw new Error("no es un objeto");
    return parsed;
  } catch {
    throw new OidcError(`${what} ilegible`);
  }
}

/** Devuelve el kid del encabezado sin verificar nada todavía (solo para elegir la clave). */
export function peekKid(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new OidcError("el token no tiene tres partes");
  const header = b64urlJson(parts[0] as string, "encabezado");
  if (typeof header["kid"] !== "string") throw new OidcError("el encabezado no trae kid");
  return header["kid"];
}

export function verifyIdToken(token: string, opts: VerifyOptions): IdTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new OidcError("el token no tiene tres partes");
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h, "encabezado");
  // Solo RS256: rechaza "none" y cualquier algoritmo simétrico (ataque de confusión de algoritmo).
  if (header["alg"] !== "RS256") throw new OidcError("algoritmo no permitido");
  const kid = header["kid"];
  if (typeof kid !== "string") throw new OidcError("el encabezado no trae kid");
  const jwk = opts.keys.find((k) => k.kid === kid && k.kty === "RSA");
  if (!jwk) throw new OidcError("clave de firma desconocida");

  let valid = false;
  try {
    const key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
    valid = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) throw new OidcError("firma inválida");

  const claims = b64urlJson(p, "contenido");
  if (claims["iss"] !== opts.issuer) throw new OidcError("emisor inesperado");
  const aud = claims["aud"];
  if (!(aud === opts.audience || (Array.isArray(aud) && aud.includes(opts.audience)))) {
    throw new OidcError("audiencia inesperada");
  }
  const exp = claims["exp"];
  if (typeof exp !== "number" || !(exp + (opts.leewaySec ?? 30) > opts.nowSec)) throw new OidcError("token vencido");
  if (claims["nonce"] !== opts.nonce) throw new OidcError("nonce no coincide");
  const sub = claims["sub"];
  if (typeof sub !== "string" || !/^\d{1,20}$/.test(sub)) throw new OidcError("sub inválido");
  const pu = claims["preferred_username"];
  const preferredUsername = typeof pu === "string" && /^[A-Za-z0-9_]{1,25}$/.test(pu) ? pu.toLowerCase() : undefined;
  const pic = claims["picture"];
  const picture = typeof pic === "string" && AVATAR_RE.test(pic) ? pic : undefined;
  return { sub, preferredUsername, picture };
}

export interface JwksCacheOptions {
  url: string;
  fetchFn?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}

/** Claves públicas de Twitch en memoria; si llega un kid nuevo se vuelve a pedir (como mucho una vez por minuto). */
export class JwksCache {
  private keys: Jwk[] = [];
  private fetchedAt = 0;
  private readonly fetchFn: typeof fetch;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: JwksCacheOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.ttlMs = opts.ttlMs ?? 60 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async keysFor(kid: string): Promise<readonly Jwk[]> {
    const age = this.now() - this.fetchedAt;
    const known = this.keys.some((k) => k.kid === kid);
    if (this.keys.length === 0 || age > this.ttlMs || (!known && age > 60_000)) await this.refresh();
    return this.keys;
  }

  private async refresh(): Promise<void> {
    const res = await this.fetchFn(this.opts.url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new OidcError(`no se pudieron obtener las claves de Twitch (${res.status})`);
    const body: unknown = await res.json();
    const list = isRecord(body) && Array.isArray(body["keys"]) ? (body["keys"] as unknown[]) : [];
    this.keys = list.filter(
      (k): k is Jwk => isRecord(k) && typeof k["kid"] === "string" && typeof k["n"] === "string" && typeof k["e"] === "string" && typeof k["kty"] === "string",
    );
    this.fetchedAt = this.now();
  }
}
