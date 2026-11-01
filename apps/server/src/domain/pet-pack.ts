import { unzipSync } from "fflate";
import { PNG } from "pngjs";

/** Límites del paquete de imágenes sueltas (.zip). */
export const PACK = {
  maxZipBytes: 1_500_000,
  maxEntries: 200,
  maxFileBytes: 300_000,
  maxTotalBytes: 12_000_000,
  minFrame: 16,
  maxFrame: 256,
  maxFrames: 24,
  /** Alto/ancho máximo del sprite ya reducido (en píxeles de sprite, como las pets normales). */
  targetH: 48,
  targetW: 64,
  maxSheetBytes: 250_000,
  alphaMin: 8,
} as const;

/** Datos de una pet convertida desde un paquete; se guardan junto a la hoja y los lee el overlay. */
export interface PackInfo {
  cellW: number;
  cellH: number;
  idle: number;
  walk: number;
  /** 0 = sin animación de ataque. */
  attack: number;
  anchorX: number;
  anchorY: number;
  /** Factor de reducción aplicado (1 = tamaño original). */
  shrink: number;
}

export type PackError =
  | "bad_zip"
  | "zip_too_large"
  | "too_many_files"
  | "file_too_large"
  | "no_frames"
  | "missing_idle"
  | "missing_walk"
  | "walk_needs_two"
  | "too_many_frames"
  | "bad_png"
  | "bad_frame_size"
  | "mixed_sizes"
  | "empty_frames"
  | "sheet_too_large";

export interface PackResult {
  ok: true;
  png: Buffer;
  info: PackInfo;
  /** Archivos del zip que se usaron y los que se ignoraron (Hurt, Death…), para mostrar al artista. */
  used: { idle: number; walk: number; attack: number };
  ignored: string[];
}
export type PackOutcome = PackResult | { ok: false; error: PackError; detail?: string };

type Anim = "idle" | "walk" | "attack";
const NAME_RE = /^(idle|walk|attack)[ _-]?(\d+)$/i;

interface Img {
  w: number;
  h: number;
  data: Uint8Array;
}

const fail = (error: PackError, detail?: string): PackOutcome => ({ ok: false, error, ...(detail ? { detail } : {}) });

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Convierte un .zip con imágenes sueltas (Idle1.png, Walk1.png, Attack1.png…) en una hoja para el motor. */
export function convertPetPack(zip: Uint8Array, opts: { flip?: boolean } = {}): PackOutcome {
  if (zip.byteLength > PACK.maxZipBytes) return fail("zip_too_large");

  let files: Record<string, Uint8Array>;
  let count = 0;
  let declared = 0;
  try {
    files = unzipSync(zip, {
      filter: (f) => {
        count++;
        declared += f.originalSize;
        if (count > PACK.maxEntries) throw new Error("too_many_files");
        if (declared > PACK.maxTotalBytes) throw new Error("too_large_total");
        if (f.originalSize > PACK.maxFileBytes) throw new Error(`file_too_large:${f.name}`);
        return /\.png$/i.test(f.name) && !/(^|\/)(__MACOSX|\.)/.test(f.name);
      },
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m === "too_many_files") return fail("too_many_files");
    if (m.startsWith("file_too_large") || m === "too_large_total") return fail("file_too_large", m.split(":")[1]);
    return fail("bad_zip");
  }

  const groups: Record<Anim, Array<{ n: number; path: string; data: Uint8Array }>> = { idle: [], walk: [], attack: [] };
  const ignored: string[] = [];
  for (const path of Object.keys(files).sort()) {
    const base = baseName(path).replace(/\.png$/i, "");
    const m = NAME_RE.exec(base);
    const data = files[path];
    if (!m || !data) {
      ignored.push(baseName(path));
      continue;
    }
    const kind = (m[1] ?? "").toLowerCase() as Anim;
    const n = Number(m[2]);
    // Si el mismo número aparece en dos carpetas, nos quedamos con el primero.
    if (!groups[kind].some((g) => g.n === n)) groups[kind].push({ n, path, data });
    else ignored.push(baseName(path));
  }
  if (groups.idle.length + groups.walk.length + groups.attack.length === 0) return fail("no_frames");
  if (groups.idle.length === 0) return fail("missing_idle");
  if (groups.walk.length === 0) return fail("missing_walk");
  if (groups.walk.length < 2) return fail("walk_needs_two");
  for (const k of ["idle", "walk", "attack"] as const) {
    groups[k].sort((a, b) => a.n - b.n);
    if (groups[k].length > PACK.maxFrames) return fail("too_many_frames", k);
  }

  // Decodifica todo y comprueba que los cuadros midan lo mismo.
  const frames: Record<Anim, Img[]> = { idle: [], walk: [], attack: [] };
  let size: { w: number; h: number } | undefined;
  for (const k of ["idle", "walk", "attack"] as const) {
    for (const g of groups[k]) {
      let png: PNG;
      try {
        png = PNG.sync.read(Buffer.from(g.data));
      } catch {
        return fail("bad_png", baseName(g.path));
      }
      if (png.width < PACK.minFrame || png.height < PACK.minFrame || png.width > PACK.maxFrame || png.height > PACK.maxFrame) {
        return fail("bad_frame_size", `${baseName(g.path)} (${png.width}x${png.height})`);
      }
      size ??= { w: png.width, h: png.height };
      if (png.width !== size.w || png.height !== size.h) return fail("mixed_sizes", baseName(g.path));
      frames[k].push({ w: png.width, h: png.height, data: png.data });
    }
  }
  if (!size) return fail("no_frames");

  // Caja que contiene todo lo dibujado en todos los cuadros (así nada se corta y los pies no saltan).
  let minX = size.w;
  let minY = size.h;
  let maxX = -1;
  let maxY = -1;
  for (const k of ["idle", "walk", "attack"] as const) {
    for (const f of frames[k]) {
      for (let y = 0; y < f.h; y++) {
        for (let x = 0; x < f.w; x++) {
          if ((f.data[(y * f.w + x) * 4 + 3] ?? 0) > PACK.alphaMin) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
    }
  }
  if (maxX < 0) return fail("empty_frames");
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const shrink = Math.max(1, Math.ceil(bh / PACK.targetH), Math.ceil(bw / PACK.targetW));
  const sw = Math.ceil(bw / shrink);
  const sh = Math.ceil(bh / shrink);
  const pad = 2;
  const cellW = sw + pad * 2;
  const cellH = sh + pad * 2;

  /** Recorta la caja y reduce por bloques (promedio con alfa); el borde queda nítido, sin halo. */
  const shrinkFrame = (f: Img, flip: boolean): Uint8Array => {
    const out = new Uint8Array(cellW * cellH * 4);
    for (let oy = 0; oy < sh; oy++) {
      for (let ox = 0; ox < sw; ox++) {
        let a = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = 0; dy < shrink; dy++) {
          for (let dx = 0; dx < shrink; dx++) {
            const sx = minX + ox * shrink + dx;
            const sy = minY + oy * shrink + dy;
            n++;
            if (sx > maxX || sy > maxY) continue;
            const i = (sy * f.w + sx) * 4;
            const al = f.data[i + 3] ?? 0;
            a += al;
            r += (f.data[i] ?? 0) * al;
            g += (f.data[i + 1] ?? 0) * al;
            b += (f.data[i + 2] ?? 0) * al;
          }
        }
        const avg = a / n;
        if (avg < 96) continue;
        const tx = flip ? sw - 1 - ox : ox;
        const o = ((oy + pad) * cellW + tx + pad) * 4;
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = 255;
      }
    }
    return out;
  };

  // El paquete trae una sola dirección. `flip` indica que el original mira a la izquierda.
  const east = (list: Img[]) => list.map((f) => shrinkFrame(f, opts.flip === true));
  const west = (list: Img[]) => list.map((f) => shrinkFrame(f, opts.flip !== true));
  const rows: Uint8Array[][] = [];
  rows.push([east(frames.idle)[0] ?? new Uint8Array(cellW * cellH * 4)]); // 0: rotación (relleno)
  rows.push(east(frames.idle)); // 1 Idle south (usamos el de lado)
  rows.push(east(frames.idle)); // 2 Idle east
  rows.push(west(frames.idle)); // 3 Idle west
  rows.push(east(frames.walk)); // 4 Walk south (relleno)
  rows.push(east(frames.walk)); // 5 Walk east
  rows.push(west(frames.walk)); // 6 Walk west
  if (frames.attack.length > 0) {
    rows.push(east(frames.attack)); // 7 Attack east
    rows.push(west(frames.attack)); // 8 Attack west
  }

  const cols = Math.max(...rows.map((r) => r.length));
  const sheet = new PNG({ width: cols * cellW, height: rows.length * cellH });
  rows.forEach((row, ri) => {
    row.forEach((cell, ci) => {
      for (let y = 0; y < cellH; y++) {
        const from = y * cellW * 4;
        const to = ((ri * cellH + y) * sheet.width + ci * cellW) * 4;
        sheet.data.set(cell.subarray(from, from + cellW * 4), to);
      }
    });
  });
  const png = PNG.sync.write(sheet, { colorType: 6 });
  if (png.length > PACK.maxSheetBytes) return fail("sheet_too_large");

  return {
    ok: true,
    png,
    info: {
      cellW,
      cellH,
      idle: frames.idle.length,
      walk: frames.walk.length,
      attack: frames.attack.length,
      anchorX: Math.floor(cellW / 2),
      anchorY: cellH - pad,
      shrink,
    },
    used: { idle: frames.idle.length, walk: frames.walk.length, attack: frames.attack.length },
    ignored: ignored.slice(0, 40),
  };
}

/** species.json de una pet convertida desde un paquete. */
export function packSpeciesDef(id: string, name: string, p: PackInfo) {
  const clips: Record<string, { source: string; fps: number; loop: boolean }> = {
    idle: { source: "Idle", fps: p.idle >= 6 ? 6 : Math.max(2, p.idle + 1), loop: true },
    walk: { source: "Walk", fps: p.walk >= 8 ? 12 : 8, loop: true },
    run: { source: "Walk", fps: p.walk >= 8 ? 19 : 14, loop: true },
  };
  if (p.attack > 0) clips["attack"] = { source: "Attack", fps: 12, loop: false };
  return {
    id,
    name,
    sheetImage: "sheet.png",
    sheetMeta: "sheet.json",
    anchor: { x: p.anchorX, y: p.anchorY },
    shadow: { rx: Math.max(5, Math.round(p.cellW * 0.28)), ry: Math.max(2, Math.round(p.cellW * 0.08)) },
    labelOffsetY: p.cellH - 2,
    clips,
  };
}

/** Descripción de la hoja convertida en el formato que lee el motor. */
export function packSheetMeta(id: string, p: PackInfo) {
  const cols = Math.max(p.idle, p.walk, p.attack, 1);
  const anim = (row: number, animation: string, frames: number, direction: string) => ({
    row,
    type: "animation",
    frame_count: frames,
    animation,
    animation_group_id: `${id}-${animation.toLowerCase()}`,
    direction,
  });
  const rows: unknown[] = [
    { row: 0, type: "rotations", frame_count: 1, directions: ["south"] },
    anim(1, "Idle", p.idle, "south"),
    anim(2, "Idle", p.idle, "east"),
    anim(3, "Idle", p.idle, "west"),
    anim(4, "Walk", p.walk, "south"),
    anim(5, "Walk", p.walk, "east"),
    anim(6, "Walk", p.walk, "west"),
  ];
  if (p.attack > 0) rows.push(anim(7, "Attack", p.attack, "east"), anim(8, "Attack", p.attack, "west"));
  return {
    character: { id, name: id, size: { width: p.cellW, height: p.cellH }, directions: 8, view: "low top-down" },
    spritesheet: {
      path: "sheet.png",
      cell_size: { width: p.cellW, height: p.cellH },
      sheet_size: { width: cols * p.cellW, height: rows.length * p.cellH },
      columns: cols,
      pivot: "cell-center",
      rows,
    },
  };
}
