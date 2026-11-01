import type { Direction, FrameRect, ParsedSheet } from "./pixellab.js";
import { parsePixelLabSheet } from "./pixellab.js";

/** Nombres de clips que entiende el motor. Cada especie los mapea a animaciones de su hoja. */
export type ClipName = "idle" | "walk" | "run" | "attack";
/** Clips obligatorios: toda especie debe traerlos. */
export const CLIP_NAMES: readonly ClipName[] = ["idle", "walk", "run"];
/** Clips opcionales (p. ej. el ataque para un futuro PvP): si faltan, la especie simplemente no los tiene. */
export const OPTIONAL_CLIP_NAMES: readonly ClipName[] = ["attack"];

/** Vistas que el motor usa: de lado (east/west) o de frente (south). */
export type View = "east" | "west" | "south";
export const VIEWS: readonly View[] = ["east", "west", "south"];

/**
 * Vistas que cada clip necesita de verdad. Caminar y correr siempre se ven de lado;
 * la vista de frente solo la usan sentarse y dormir, que animan con "idle".
 */
export const REQUIRED_VIEWS: Readonly<Record<ClipName, readonly View[]>> = {
  idle: ["east", "west", "south"],
  walk: ["east", "west"],
  run: ["east", "west"],
  attack: ["east", "west"],
};

export interface ClipDef {
  /** Nombre de la animación dentro del JSON de la hoja (p. ej. "Walk"). */
  readonly source: string;
  readonly fps: number;
  readonly loop: boolean;
}

/** Definición de una especie, serializable a JSON. Las URLs son relativas al propio JSON. */
export interface SpeciesDef {
  readonly id: string;
  readonly name: string;
  readonly sheetImage: string;
  readonly sheetMeta: string;
  /** Punto de apoyo (pies) dentro de la celda, en píxeles de sprite. */
  readonly anchor: { readonly x: number; readonly y: number };
  /** Elipse de sombra en píxeles de sprite. */
  readonly shadow: { readonly rx: number; readonly ry: number };
  /** Distancia desde los pies hasta donde se dibuja el nombre. */
  readonly labelOffsetY: number;
  /** Fila (en la celda) donde se parte el sprite para el efecto de respiración. Opcional. */
  readonly breathSplitY?: number;
  /** idle, walk y run son obligatorios; attack es opcional. */
  readonly clips: Readonly<Partial<Record<ClipName, ClipDef>> & Record<"idle" | "walk" | "run", ClipDef>>;
}

export interface ResolvedClip {
  readonly def: ClipDef;
  readonly frames: readonly FrameRect[];
}

export interface LoadedSpecies {
  readonly def: SpeciesDef;
  readonly sheet: ParsedSheet;
  readonly image: CanvasImageSource;
  /** clip -> vista -> frames ya resueltos. */
  readonly clips: ReadonlyMap<ClipName, ReadonlyMap<View, ResolvedClip>>;
}

export class SpeciesError extends Error {
  constructor(message: string) {
    super(`Species: ${message}`);
    this.name = "SpeciesError";
  }
}

/**
 * Valida que la especie tenga todos los clips en todas las vistas que usa el motor
 * y devuelve el índice resuelto. Es puro (sin DOM), así que se puede testear en Node.
 */
export function resolveClips(
  def: SpeciesDef,
  sheet: ParsedSheet,
): ReadonlyMap<ClipName, ReadonlyMap<View, ResolvedClip>> {
  const out = new Map<ClipName, Map<View, ResolvedClip>>();
  for (const clip of [...CLIP_NAMES, ...OPTIONAL_CLIP_NAMES]) {
    const clipDef = def.clips[clip];
    if (!clipDef && OPTIONAL_CLIP_NAMES.includes(clip)) continue;
    if (!clipDef) throw new SpeciesError(`"${def.id}" no define el clip "${clip}"`);
    if (!(clipDef.fps > 0)) throw new SpeciesError(`"${def.id}".${clip}: fps debe ser > 0`);
    const byDir = sheet.animations.get(clipDef.source);
    if (!byDir) {
      throw new SpeciesError(
        `"${def.id}".${clip}: la hoja no tiene la animación "${clipDef.source}" ` +
          `(disponibles: ${[...sheet.animations.keys()].join(", ") || "ninguna"})`,
      );
    }
    const views = new Map<View, ResolvedClip>();
    for (const view of VIEWS) {
      const frames = byDir.get(view as Direction);
      if (!frames || frames.length === 0) {
        if (REQUIRED_VIEWS[clip].includes(view)) {
          throw new SpeciesError(`"${def.id}".${clip}: falta la dirección "${view}" en "${clipDef.source}"`);
        }
        continue; // vista opcional: el motor nunca la pide para este clip
      }
      views.set(view, { def: clipDef, frames });
    }
    out.set(clip, views);
  }
  return out;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new SpeciesError(`no se pudo cargar la imagen ${url}`));
    img.src = url;
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new SpeciesError(`${url} respondió ${res.status}`);
  return (await res.json()) as unknown;
}

const cache = new Map<string, Promise<LoadedSpecies>>();

/**
 * Carga (y cachea) una especie a partir de la URL de su species.json.
 * El mismo PNG se reutiliza para todas las mascotas de esa especie.
 */
export function loadSpecies(speciesUrl: string): Promise<LoadedSpecies> {
  const cached = cache.get(speciesUrl);
  if (cached) return cached;
  const promise = (async (): Promise<LoadedSpecies> => {
    const base = new URL(speciesUrl, globalThis.location?.href ?? "http://localhost/");
    const def = (await fetchJson(base.href)) as SpeciesDef;
    const metaUrl = new URL(def.sheetMeta, base).href;
    const imageUrl = new URL(def.sheetImage, base).href;
    const [meta, image] = await Promise.all([fetchJson(metaUrl), loadImage(imageUrl)]);
    const sheet = parsePixelLabSheet(meta);
    if (image.naturalWidth !== sheet.sheetW || image.naturalHeight !== sheet.sheetH) {
      throw new SpeciesError(
        `"${def.id}": el PNG mide ${image.naturalWidth}x${image.naturalHeight} ` +
          `pero el JSON dice ${sheet.sheetW}x${sheet.sheetH}`,
      );
    }
    return { def, sheet, image, clips: resolveClips(def, sheet) };
  })();
  // Si falla, no dejamos el error cacheado para poder reintentar.
  promise.catch(() => cache.delete(speciesUrl));
  cache.set(speciesUrl, promise);
  return promise;
}
