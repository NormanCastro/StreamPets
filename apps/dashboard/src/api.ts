const KEY = "streampets.adminToken";

export type SpeciesScope = "general" | "exclusive" | "event";
export type SpeciesTier = "free" | "premium";
export type Plan = "free" | "premium";
export interface Species {
  id: string;
  name: string;
  url: string;
  scope: SpeciesScope;
  tier: SpeciesTier;
  /** true = este canal no puede usarla (se muestra, pero no se puede elegir). */
  locked: boolean;
  /** Pet subida por el propio canal. */
  custom?: boolean;
  /** Apagada por el administrador: nadie puede usarla. */
  disabled?: boolean;
}

/** Por qué una especie está bloqueada, para mostrarlo en los selectores. */
export function lockReason(s: Pick<Species, "scope" | "tier">): string {
  if (s.scope === "exclusive") return s.tier === "premium" ? "Exclusiva premium" : "Exclusiva";
  return "Premium";
}
/** Texto de una especie en un selector. */
export function speciesLabel(s: Species): string {
  if (s.disabled) return `🔒 ${s.name} · No disponible`;
  if (s.locked) return `🔒 ${s.name} · ${lockReason(s)}`;
  if (s.scope === "event") return `${s.name} · Evento`;
  return s.tier === "premium" ? `${s.name} ★` : s.name;
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
  streamer: { login: string; displayName: string; avatarUrl?: string | null } | null;
  role: UserRole;
  plan: Plan;
  /** Puede revisar las pets que suben los canales. */
  moderator?: boolean;
}
export interface CatalogItem {
  id: string;
  name: string;
  url: string;
  category: "general" | "event" | "exclusive";
  custom: boolean;
  ownerLogin: string | null;
  disabled: boolean;
  /** En cuántos canales hay al menos una mascota de esta especie. */
  channels: number;
  /** Mascotas en total. */
  pets: number;
}
export type CustomPetStatus = "pending" | "approved" | "rejected";
/** Medidas de una pet convertida desde un paquete .zip (null = plantilla fija de 520×280). */
export interface PackInfo {
  cellW: number;
  cellH: number;
  idle: number;
  walk: number;
  /** 0 = sin animación de ataque. */
  attack: number;
  anchorX: number;
  anchorY: number;
  shrink: number;
}
export interface PackPreviewResult {
  png: string;
  pack: PackInfo;
  used: { idle: number; walk: number; attack: number };
  ignored: string[];
}
export interface CustomPet {
  id: string;
  name: string;
  status: CustomPetStatus;
  rejectReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  /** La hoja completa como data URL. */
  png: string | null;
  pack: PackInfo | null;
}
export interface ReviewPet extends CustomPet {
  login: string;
}
export interface ChannelItem {
  login: string;
  linked: boolean;
  owner: boolean;
  plan: Plan;
  /** Tiene una clave personal de respaldo (solo se ve su comienzo). */
  hasKey: boolean;
  keyPrefix: string | null;
  /** Especies exclusivas que tiene permitidas. */
  species: string[];
  /** Cupos de mascotas propias del canal. */
  customSlots: number;
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
  if (err.status === 403 && err.code === "species_locked") return "Esa especie no está incluida en tu plan.";
  if (err.status === 403) return err.code === "owner" ? "Ese es tu canal: no se puede quitar." : "No tienes permiso para hacer eso.";
  if (err.status === 404) return "No encontrado (puede que ya no exista).";
  if (err.status === 429) return "Demasiados intentos, espera un minuto.";
  if (err.status === 400 && err.code === "owner") return "Ese es tu canal: no se puede quitar.";
  if (err.code === "unknown_species") return "Esa especie no existe.";
  if (err.code === "custom_species") return "Las mascotas propias siempre son exclusivas de su canal.";
  if (err.code === "plan_required") return "Tu plan no incluye subir mascotas propias.";
  if (err.code === "quota_reached") return "Ya usaste todos los cupos de tu plan. Elimina una para subir otra.";
  if (err.code === "bad_size") return "El PNG debe medir exactamente 520×280 píxeles.";
  if (err.code === "not_png") return "El archivo no es un PNG.";
  if (err.code === "interlaced") return "Guarda el PNG sin entrelazado (interlaced).";
  if (err.code === "corrupt") return "El PNG está dañado. Vuelve a exportarlo.";
  if (err.code === "too_large") return "El PNG pesa demasiado (máximo 120 KB).";
  const d = typeof err.details === "string" ? ` (${err.details})` : "";
  if (err.code === "bad_zip") return "No se pudo abrir el .zip. Comprímelo de nuevo (zip normal, sin contraseña).";
  if (err.code === "zip_too_large") return "El .zip pesa demasiado (máximo 1,5 MB).";
  if (err.code === "too_many_files") return "El .zip trae demasiados archivos (máximo 200).";
  if (err.code === "file_too_large") return `Una imagen del .zip pesa demasiado${d}.`;
  if (err.code === "no_frames") return "No encontré imágenes con nombres como Idle1.png y Walk1.png dentro del .zip.";
  if (err.code === "missing_idle") return "Falta la animación Idle (Idle1.png, Idle2.png…).";
  if (err.code === "missing_walk") return "Falta la animación Walk (Walk1.png, Walk2.png…).";
  if (err.code === "walk_needs_two") return "Walk necesita al menos 2 imágenes para verse caminar.";
  if (err.code === "too_many_frames") return `Una animación tiene más de 24 imágenes${d}.`;
  if (err.code === "bad_png") return `Una imagen no es un PNG válido${d}.`;
  if (err.code === "bad_frame_size") return `Cada imagen debe medir entre 16 y 256 píxeles por lado${d}.`;
  if (err.code === "mixed_sizes") return `Todas las imágenes deben medir lo mismo${d}.`;
  if (err.code === "empty_frames") return "Las imágenes están vacías (todo transparente).";
  if (err.code === "sheet_too_large") return "El resultado pesa demasiado. Usa menos imágenes por animación.";
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
  catalog: () => request<{ items: CatalogItem[] }>("GET", "/api/admin/catalog"),
  setSpeciesDisabled: (id: string, disabled: boolean) =>
    request<{ id: string; disabled: boolean }>("PATCH", `/api/admin/catalog/${encodeURIComponent(id)}`, { disabled }),
  setSpeciesCategory: (id: string, category: CatalogItem["category"]) =>
    request<{ id: string; category: CatalogItem["category"] }>("PATCH", `/api/admin/catalog/${encodeURIComponent(id)}`, { category }),
  customPets: () =>
    request<{ items: CustomPet[]; quota: { used: number; max: number } }>("GET", "/api/admin/custom-pets"),
  uploadCustomPet: (name: string, png: string) =>
    request<{ id: string; status: string }>("POST", "/api/admin/custom-pets", { name, png }),
  previewPetPack: (zip: string, flip: boolean) =>
    request<PackPreviewResult>("POST", "/api/admin/custom-pets/preview", { zip, flip }),
  uploadPetPack: (name: string, zip: string, flip: boolean) =>
    request<{ id: string; status: string }>("POST", "/api/admin/custom-pets", { name, zip, flip }),
  deleteCustomPet: (id: string) => request<void>("DELETE", `/api/admin/custom-pets/${id}`),
  reviewPets: (status: CustomPetStatus | "all") =>
    request<{ items: ReviewPet[] }>("GET", `/api/admin/moderation/pets?status=${status}`),
  approvePet: (id: string) => request<unknown>("POST", `/api/admin/moderation/pets/${id}/approve`),
  rejectPet: (id: string, reason: string) =>
    request<unknown>("POST", `/api/admin/moderation/pets/${id}/reject`, reason ? { reason } : {}),
  authStatus: () => request<{ twitch: boolean }>("GET", "/auth/status"),
  logout: () => request<void>("POST", "/api/admin/logout"),
  channels: () => request<{ items: ChannelItem[] }>("GET", "/api/admin/channels"),
  addChannel: (login: string) => request<ChannelItem>("POST", "/api/admin/channels", { login }),
  enterWithKey: (key: string) => request<{ ok: boolean }>("POST", "/auth/key", { key }),
  createChannelKey: (login: string) =>
    request<{ key: string; prefix: string }>("POST", `/api/admin/channels/${encodeURIComponent(login)}/key`),
  revokeChannelKey: (login: string) => request<void>("DELETE", `/api/admin/channels/${encodeURIComponent(login)}/key`),
  patchChannel: (login: string, body: { plan?: Plan; species?: string[]; customSlots?: number }) =>
    request<ChannelItem>("PATCH", `/api/admin/channels/${encodeURIComponent(login)}`, body),
  removeChannel: (login: string) => request<void>("DELETE", `/api/admin/channels/${encodeURIComponent(login)}`),
  species: () => request<{ species: Species[] }>("GET", "/api/admin/species"),
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
