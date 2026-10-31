const KEY = "streampets.adminToken";

export interface Species {
  id: string;
  name: string;
  url: string;
}
export interface ViewerItem {
  id: string;
  login: string;
  displayName: string;
  isSubscriber: boolean;
  messageCount: number;
  lastSeenAt: string;
  online: boolean;
  pet: { speciesId: string; enabled: boolean } | null;
}
export type Role = "all" | "subs" | "viewers";
export interface ViewerCounts {
  all: number;
  subs: number;
  viewers: number;
  online: number;
}
export interface Settings {
  ignoredLogins: string[];
  ignoreStreamer: boolean;
  defaultSpeciesId: string | null;
  subsOnly: boolean;
  maxPets: number;
  idleTimeoutSec: number;
}
export interface OverlayItem {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
}
export interface OverlayWithToken extends OverlayItem {
  token: string;
  path: string;
}

export type UserRole = "admin" | "streamer";
export interface Me {
  streamer: { login: string; displayName: string } | null;
  role: UserRole;
}
export interface ChannelItem {
  login: string;
  linked: boolean;
  owner: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
  }
}

/** Mensaje comprensible para mostrar al usuario. */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return "No se pudo conectar con el servidor.";
  if (err.status === 401) return "Clave incorrecta.";
  if (err.status === 403) return err.code === "owner" ? "Ese es tu canal: no se puede quitar." : "No tienes permiso para hacer eso.";
  if (err.status === 404) return "No encontrado (puede que ya no exista).";
  if (err.status === 429) return "Demasiadas solicitudes, espera un momento.";
  if (err.status === 400 && err.code === "owner") return "Ese es tu canal: no se puede quitar.";
  if (err.code === "unknown_species") return "Esa especie no existe.";
  if (err.code === "invalid_request" && Array.isArray(err.details)) {
    return (err.details as Array<{ path: string; message: string }>)
      .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
      .join("; ");
  }
  return `Error del servidor (${err.status}).`;
}

export const session = {
  get(): string | null {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    try {
      sessionStorage.setItem(KEY, token);
    } catch {
      /* sin almacenamiento: la sesión dura hasta recargar */
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nada */
    }
  },
};

let memoryToken: string | null = null;
export function setToken(token: string | null): void {
  memoryToken = token;
  if (token) session.set(token);
  else session.clear();
}
export function currentToken(): string | null {
  return memoryToken ?? session.get();
}

let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  const token = currentToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  // Fastify rechaza un cuerpo JSON vacío: solo se declara el tipo si hay cuerpo.
  if (body !== undefined) headers["content-type"] = "application/json";
  // Con la sesión de Twitch (cookie), los cambios llevan esta cabecera: un sitio ajeno no puede enviarla.
  if (method !== "GET") headers["x-streampets-csrf"] = "1";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network");
  }
  if (res.status === 401 && path.startsWith("/api/admin")) onUnauthorized();
  if (!res.ok) {
    let code = "error";
    let details: unknown;
    try {
      const j = (await res.json()) as { error?: string; details?: unknown };
      code = j.error ?? code;
      details = j.details;
    } catch {
      /* sin cuerpo */
    }
    throw new ApiError(res.status, code, details);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  me: () => request<Me>("GET", "/api/admin/me"),
  authStatus: () => request<{ twitch: boolean }>("GET", "/auth/status"),
  logout: () => request<void>("POST", "/api/admin/logout"),
  channels: () => request<{ items: ChannelItem[] }>("GET", "/api/admin/channels"),
  addChannel: (login: string) => request<ChannelItem>("POST", "/api/admin/channels", { login }),
  removeChannel: (login: string) => request<void>("DELETE", `/api/admin/channels/${encodeURIComponent(login)}`),
  species: () => request<{ species: Species[] }>("GET", "/api/species"),
  viewers: (q: string, role: Role, limit: number, offset: number, signal?: AbortSignal) =>
    request<{ total: number; counts: ViewerCounts; items: ViewerItem[] }>(
      "GET",
      `/api/admin/viewers?${new URLSearchParams({ q, role, limit: String(limit), offset: String(offset) })}`,
      undefined,
      signal,
    ),
  patchPet: (id: string, body: { speciesId?: string; enabled?: boolean }) =>
    request<{ pet: { speciesId: string; enabled: boolean } }>("PATCH", `/api/admin/viewers/${id}/pet`, body),
  settings: () => request<Settings>("GET", "/api/admin/settings"),
  saveSettings: (body: Partial<Settings>) => request<Settings>("PATCH", "/api/admin/settings", body),
  overlays: () => request<{ items: OverlayItem[] }>("GET", "/api/admin/overlays"),
  createOverlay: (name: string) => request<OverlayWithToken>("POST", "/api/admin/overlays", { name }),
  rotateOverlay: (id: string) => request<OverlayWithToken>("POST", `/api/admin/overlays/${id}/rotate`),
  revokeOverlay: (id: string) => request<void>("DELETE", `/api/admin/overlays/${id}`),
};
