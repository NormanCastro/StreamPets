import { JwksCache, OidcError, peekKid, verifyIdToken } from "./oidc.js";

export interface TwitchOAuthOptions {
  clientId: string;
  clientSecret: string;
  /** URL exacta registrada en la consola de Twitch (https://tu-dominio/auth/twitch/callback). */
  redirectUri: string;
  /** Solo se cambia en pruebas. */
  idBaseUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export interface TwitchIdentity {
  /** Foto de perfil de Twitch, si la entregó. */
  avatarUrl?: string | undefined;
  twitchUserId: string;
  login: string;
}

const TIMEOUT_MS = 8_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Login con Twitch por OpenID Connect (flujo de código de autorización).
 * Pedimos solo el alcance `openid`: sirve para saber quién es la persona, sin acceso a su correo
 * ni a su cuenta. Los tokens de acceso se usan al instante y no se guardan.
 */
export class TwitchOAuth {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly jwks: JwksCache;

  constructor(private readonly opts: TwitchOAuthOptions) {
    this.base = (opts.idBaseUrl ?? "https://id.twitch.tv").replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.jwks = new JwksCache({ url: `${this.base}/oauth2/keys`, fetchFn: this.fetchFn, now: this.now });
  }

  /** Dirección de Twitch a la que se manda el navegador de la persona. */
  authorizeUrl(p: { state: string; nonce: string }): string {
    const q = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: "code",
      scope: "openid",
      state: p.state,
      nonce: p.nonce,
      claims: JSON.stringify({ id_token: { preferred_username: null, picture: null } }),
    });
    return `${this.base}/oauth2/authorize?${q.toString()}`;
  }

  /** Canjea el código por la identidad verificada de la persona. */
  async identify(code: string, nonce: string): Promise<TwitchIdentity> {
    const res = await this.fetchFn(`${this.base}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: this.opts.redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new OidcError(`Twitch rechazó el código (${res.status})`);
    const body: unknown = await res.json();
    if (!isRecord(body) || typeof body["id_token"] !== "string") throw new OidcError("la respuesta no trae id_token");
    const idToken = body["id_token"];

    const keys = await this.jwks.keysFor(peekKid(idToken));
    const claims = verifyIdToken(idToken, {
      keys,
      issuer: `${this.base}/oauth2`,
      audience: this.opts.clientId,
      nonce,
      nowSec: Math.floor(this.now() / 1000),
    });

    let login = claims.preferredUsername;
    if (login === undefined) {
      // Plan B documentado: /oauth2/validate devuelve login y user_id del token de acceso.
      const accessToken = body["access_token"];
      if (typeof accessToken !== "string") throw new OidcError("no se pudo determinar el usuario");
      const v = await this.fetchFn(`${this.base}/oauth2/validate`, {
        headers: { authorization: `OAuth ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!v.ok) throw new OidcError(`no se pudo validar el token (${v.status})`);
      const info: unknown = await v.json();
      if (!isRecord(info) || typeof info["login"] !== "string" || String(info["user_id"]) !== claims.sub) {
        throw new OidcError("la validación no coincide con el id_token");
      }
      login = info["login"].toLowerCase();
    }
    if (!/^[a-z0-9_]{1,25}$/.test(login)) throw new OidcError("login inválido");
    return { twitchUserId: claims.sub, login, ...(claims.picture ? { avatarUrl: claims.picture } : {}) };
  }
}
