import type { PetView, ServerMessage } from "@streampets/shared";
import type { Db } from "../db/client.js";
import * as repo from "../db/repo.js";
import type { SettingsRow } from "../db/schema.js";
import type { Clock, Rng } from "./rng.js";
import type { SpeciesCatalog } from "./species.js";

/** Cómo se avisa a los overlays conectados de un streamer. */
export interface Broadcaster {
  emit(streamerId: string, message: ServerMessage): void;
}

export interface Logger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Un mensaje de chat ya normalizado (venga del chat simulado o de Twitch). */
export interface ChatInput {
  streamerId: string;
  twitchUserId: string;
  login: string;
  displayName: string;
  isSubscriber: boolean;
}

export type ChatResult =
  | { outcome: "ignored"; reason: "ignored-list" | "streamer" | "subs-only" }
  | { outcome: "disabled"; viewerId: string }
  | { outcome: "spawned" | "seen"; viewerId: string };

interface CachedViewer {
  id: string;
  twitchUserId: string;
  login: string;
  displayName: string;
  isSubscriber: boolean;
  speciesId: string;
  enabled: boolean;
  /** Mensajes aún no volcados a la base. */
  pending: number;
  lastSeen: number;
}

interface StreamerRuntime {
  streamerId: string;
  streamerLogin: string;
  settings: SettingsRow;
  ignored: Set<string>;
  byTwitchId: Map<string, CachedViewer>;
  byId: Map<string, CachedViewer>;
  /** viewerId -> último mensaje (ms). Quien está aquí tiene su mascota en pantalla. */
  active: Map<string, number>;
}

export interface ChatServiceDeps {
  db: Db;
  broadcaster: Broadcaster;
  species: SpeciesCatalog;
  clock: Clock;
  rng: Rng;
  log: Logger;
}

const MAX_NAME_LENGTH = 40;

/** Nombre apto para mostrar: sin caracteres de control ni de formato invisibles, recortado por caracteres reales. */
export function sanitizeName(displayName: string, login: string): string {
  // \p{Cc} = control, \p{Cf} = formato (ancho cero, marcas bidireccionales), \p{Zl}/\p{Zp} = separadores de línea/párrafo.
  const clean = displayName.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim();
  const chars = Array.from(clean.length > 0 ? clean : login);
  return chars.slice(0, MAX_NAME_LENGTH).join("");
}

/**
 * Corazón de la lógica de chat: cuando alguien escribe, registra al espectador si es nuevo,
 * le asigna una mascota, la mantiene en pantalla mientras hable y la retira cuando se calla.
 *
 * Mantiene estado en memoria (caché + espectadores activos), así que asume UN solo proceso de servidor.
 * Para escalar a varios procesos haría falta un bus (Redis, LISTEN/NOTIFY) para difundir los eventos.
 */
export class ChatService {
  private readonly runtimes = new Map<string, Promise<StreamerRuntime>>();
  private readonly creating = new Map<string, Promise<{ viewer: CachedViewer; created: boolean }>>();

  constructor(private readonly deps: ChatServiceDeps) {}

  async handleMessage(input: ChatInput): Promise<ChatResult> {
    const rt = await this.runtime(input.streamerId);
    const login = input.login.toLowerCase();

    if (rt.ignored.has(login)) return { outcome: "ignored", reason: "ignored-list" };
    if (rt.settings.ignoreStreamer && login === rt.streamerLogin) return { outcome: "ignored", reason: "streamer" };
    if (rt.settings.subsOnly && !input.isSubscriber) return { outcome: "ignored", reason: "subs-only" };

    const now = this.deps.clock.now();
    const { viewer, created } = await this.resolveViewer(rt, input);
    await this.syncIdentity(rt, viewer, input);

    viewer.pending += 1;
    viewer.lastSeen = now;
    if (!viewer.enabled) return { outcome: "disabled", viewerId: viewer.id };

    const wasActive = rt.active.has(viewer.id);
    rt.active.set(viewer.id, now);
    if (!wasActive) {
      this.emit(rt, { type: "pet.appear", pet: this.view(viewer) });
      this.enforceCap(rt, viewer.id);
    }
    return { outcome: created ? "spawned" : "seen", viewerId: viewer.id };
  }

  /** Mascotas que deben verse ahora mismo (para un overlay que acaba de conectarse). */
  async snapshot(streamerId: string): Promise<{ pets: PetView[]; maxPets: number }> {
    const rt = await this.runtime(streamerId);
    const pets = [...rt.active.entries()]
      .sort((a, b) => a[1] - b[1])
      .flatMap(([id]) => {
        const v = rt.byId.get(id);
        return v && v.enabled ? [this.view(v)] : [];
      });
    return { pets, maxPets: rt.settings.maxPets };
  }

  /** Retira a quienes llevan demasiado sin escribir. Se llama periódicamente. */
  async sweep(): Promise<number> {
    const now = this.deps.clock.now();
    let removed = 0;
    for (const promise of this.runtimes.values()) {
      const rt = await promise;
      const idleMs = rt.settings.idleTimeoutSec * 1000;
      for (const [viewerId, last] of [...rt.active.entries()]) {
        if (now - last > idleMs) {
          rt.active.delete(viewerId);
          this.emit(rt, { type: "pet.leave", viewerId });
          removed++;
        }
      }
    }
    return removed;
  }

  /** Vuelca a la base los contadores acumulados. Se llama periódicamente y al apagar. */
  async flush(): Promise<void> {
    for (const promise of this.runtimes.values()) {
      const rt = await promise;
      const batch = [...rt.byId.values()].filter((v) => v.pending > 0);
      if (batch.length === 0) continue;
      const entries = batch.map((v) => ({ viewerId: v.id, count: v.pending, lastSeenAt: new Date(v.lastSeen) }));
      for (const v of batch) v.pending = 0;
      try {
        await repo.flushViewerActivity(this.deps.db, entries);
      } catch (err) {
        // No perdemos los conteos: los devolvemos para el siguiente intento.
        for (const e of entries) {
          const v = rt.byId.get(e.viewerId);
          if (v) v.pending += e.count;
        }
        this.deps.log.error({ err }, "no se pudo volcar la actividad de los espectadores");
      }
    }
  }

  /** Vuelve a leer los ajustes (tras un cambio desde el dashboard) y aplica sus consecuencias. */
  async refreshSettings(streamerId: string): Promise<void> {
    const rt = await this.runtime(streamerId);
    rt.settings = await repo.getSettings(this.deps.db, streamerId);
    rt.ignored = new Set(rt.settings.ignoredLogins.map((l) => l.toLowerCase()));

    // Quien pasó a estar en la lista de ignorados, o ya no cumple "solo subs", se retira de pantalla.
    for (const viewerId of [...rt.active.keys()]) {
      const v = rt.byId.get(viewerId);
      if (!v) continue;
      const blocked =
        rt.ignored.has(v.login) ||
        (rt.settings.ignoreStreamer && v.login === rt.streamerLogin) ||
        (rt.settings.subsOnly && !v.isSubscriber);
      if (blocked) {
        rt.active.delete(viewerId);
        this.emit(rt, { type: "pet.leave", viewerId });
      }
    }
    this.enforceCap(rt, undefined);
  }

  /** Recarga la mascota de un espectador tras un cambio desde el dashboard y avisa al overlay. */
  async applyPetChange(streamerId: string, viewerId: string): Promise<void> {
    const rt = await this.runtime(streamerId);
    const row = await repo.getViewerWithPet(this.deps.db, streamerId, viewerId);
    if (!row?.pet) return;
    const cached = rt.byId.get(viewerId);
    if (!cached) return; // no está en caché: se leerá de la base cuando vuelva a escribir
    cached.speciesId = row.pet.speciesId;
    const wasEnabled = cached.enabled;
    cached.enabled = row.pet.enabled;

    if (!cached.enabled) {
      if (rt.active.delete(viewerId)) this.emit(rt, { type: "pet.leave", viewerId });
    } else if (rt.active.has(viewerId)) {
      this.emit(rt, { type: wasEnabled ? "pet.update" : "pet.appear", pet: this.view(cached) });
    }
  }

  /** Para tests y diagnóstico. */
  async activeCount(streamerId: string): Promise<number> {
    return (await this.runtime(streamerId)).active.size;
  }

  // ───────────────────────────── internos ─────────────────────────────

  private runtime(streamerId: string): Promise<StreamerRuntime> {
    let p = this.runtimes.get(streamerId);
    if (!p) {
      p = this.loadRuntime(streamerId);
      this.runtimes.set(streamerId, p);
      p.catch(() => this.runtimes.delete(streamerId)); // si falla, se reintenta en la próxima llamada
    }
    return p;
  }

  private async loadRuntime(streamerId: string): Promise<StreamerRuntime> {
    const streamer = await repo.getStreamer(this.deps.db, streamerId);
    if (!streamer) throw new Error(`Streamer inexistente: ${streamerId}`);
    const settings = await repo.getSettings(this.deps.db, streamerId);
    return {
      streamerId,
      streamerLogin: streamer.login.toLowerCase(),
      settings,
      ignored: new Set(settings.ignoredLogins.map((l) => l.toLowerCase())),
      byTwitchId: new Map(),
      byId: new Map(),
      active: new Map(),
    };
  }

  private resolveViewer(
    rt: StreamerRuntime,
    input: ChatInput,
  ): Promise<{ viewer: CachedViewer; created: boolean }> {
    const cached = rt.byTwitchId.get(input.twitchUserId);
    if (cached) return Promise.resolve({ viewer: cached, created: false });

    // Si llegan varios mensajes seguidos de alguien nuevo, solo se crea una vez.
    const key = `${rt.streamerId}:${input.twitchUserId}`;
    let p = this.creating.get(key);
    if (!p) {
      p = this.loadOrCreateViewer(rt, input).finally(() => this.creating.delete(key));
      this.creating.set(key, p);
    }
    return p;
  }

  private async loadOrCreateViewer(
    rt: StreamerRuntime,
    input: ChatInput,
  ): Promise<{ viewer: CachedViewer; created: boolean }> {
    const found = await repo.findViewerByTwitchId(this.deps.db, rt.streamerId, input.twitchUserId);
    let row: repo.ViewerWithPet;
    let created = false;
    if (found?.pet) {
      row = found as repo.ViewerWithPet;
    } else {
      const speciesId = this.deps.species.pick(this.deps.rng, rt.settings.defaultSpeciesId);
      const res = await repo.createViewerWithPet(
        this.deps.db,
        rt.streamerId,
        {
          twitchUserId: input.twitchUserId,
          login: input.login.toLowerCase(),
          displayName: sanitizeName(input.displayName, input.login),
          isSubscriber: input.isSubscriber,
        },
        speciesId,
      );
      row = res;
      created = res.created;
    }
    const pet = row.pet;
    if (!pet) throw new Error("el espectador no tiene mascota tras crearla");
    const viewer: CachedViewer = {
      id: row.viewer.id,
      twitchUserId: row.viewer.twitchUserId,
      login: row.viewer.login,
      displayName: row.viewer.displayName,
      isSubscriber: row.viewer.isSubscriber,
      speciesId: pet.speciesId,
      enabled: pet.enabled,
      pending: 0,
      lastSeen: this.deps.clock.now(),
    };
    rt.byTwitchId.set(viewer.twitchUserId, viewer);
    rt.byId.set(viewer.id, viewer);
    return { viewer, created };
  }

  /** Si cambió el nombre, el login o la suscripción, lo guardamos y avisamos al overlay. */
  private async syncIdentity(rt: StreamerRuntime, viewer: CachedViewer, input: ChatInput): Promise<void> {
    const login = input.login.toLowerCase();
    const displayName = sanitizeName(input.displayName, input.login);
    const patch: { login?: string; displayName?: string; isSubscriber?: boolean } = {};
    if (viewer.login !== login) patch.login = login;
    if (viewer.displayName !== displayName) patch.displayName = displayName;
    if (viewer.isSubscriber !== input.isSubscriber) patch.isSubscriber = input.isSubscriber;
    if (Object.keys(patch).length === 0) return;

    Object.assign(viewer, patch);
    try {
      await repo.updateViewerIdentity(this.deps.db, viewer.id, patch);
    } catch (err) {
      this.deps.log.warn({ err }, "no se pudo guardar el cambio de identidad del espectador");
    }
    if (patch.displayName !== undefined && viewer.enabled && rt.active.has(viewer.id)) {
      this.emit(rt, { type: "pet.update", pet: this.view(viewer) });
    }
  }

  /** Si hay más mascotas en pantalla que el máximo, retira a las que llevan más tiempo sin hablar. */
  private enforceCap(rt: StreamerRuntime, keepId: string | undefined): void {
    while (rt.active.size > rt.settings.maxPets) {
      let oldestId: string | undefined;
      let oldest = Infinity;
      for (const [id, last] of rt.active) {
        if (id !== keepId && last < oldest) {
          oldest = last;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      rt.active.delete(oldestId);
      this.emit(rt, { type: "pet.leave", viewerId: oldestId });
    }
  }

  private view(v: CachedViewer): PetView {
    return {
      viewerId: v.id,
      name: v.displayName,
      speciesId: this.deps.species.has(v.speciesId) ? v.speciesId : this.deps.species.fallbackId(),
    };
  }

  private emit(rt: StreamerRuntime, message: ServerMessage): void {
    try {
      this.deps.broadcaster.emit(rt.streamerId, message);
    } catch (err) {
      this.deps.log.error({ err }, "falló la difusión a los overlays");
    }
  }
}
