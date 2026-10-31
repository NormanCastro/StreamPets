import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OVERLAY_TOKEN_PREFIX = "spo_";

/** Token de overlay: 256 bits aleatorios. Se muestra una sola vez; en la base solo va su hash. */
export function generateOverlayToken(): { token: string; hash: string; prefix: string } {
  const token = `${OVERLAY_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, OVERLAY_TOKEN_PREFIX.length + 4) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** ¿Tiene la forma de un token nuestro? Evita consultar la base con basura. */
export function looksLikeOverlayToken(token: string): boolean {
  return /^spo_[A-Za-z0-9_-]{43}$/.test(token);
}

/** Comparación en tiempo constante de dos secretos de cualquier longitud. */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

export const ACCESS_KEY_PREFIX = "spk_";

/** Clave personal de acceso: 256 bits aleatorios. Se muestra una sola vez; en la base solo va su hash. */
export function generateAccessKey(): { key: string; hash: string; prefix: string } {
  const key = `${ACCESS_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashToken(key), prefix: key.slice(0, ACCESS_KEY_PREFIX.length + 4) };
}

/** ¿Tiene la forma de una clave personal? Evita consultar la base con basura. */
export function looksLikeAccessKey(key: string): boolean {
  return /^spk_[A-Za-z0-9_-]{43}$/.test(key);
}
