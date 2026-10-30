/**
 * Parser del formato "Spritesheet (PNG + JSON)" que exporta PixelLab.
 *
 * Estructura que se espera (verificada con un export real):
 *  - spritesheet.cell_size: tamaño de cada celda (el personaje va centrado dentro).
 *  - spritesheet.rows[]: cada fila es o bien "rotations" (1 frame por dirección)
 *    o bien "animation" (N frames de una animación en una dirección).
 *  - El frame i de la fila r está en la columna i: x = i * cellW, y = r * cellH.
 */

export const DIRECTIONS = [
  "south",
  "south-east",
  "east",
  "north-east",
  "north",
  "north-west",
  "west",
  "south-west",
] as const;

export type Direction = (typeof DIRECTIONS)[number];

export interface FrameRect {
  /** Esquina superior izquierda de la celda dentro del PNG. */
  readonly x: number;
  readonly y: number;
}

export interface ParsedSheet {
  readonly cellW: number;
  readonly cellH: number;
  readonly sheetW: number;
  readonly sheetH: number;
  /** nombre de animación -> dirección -> frames en orden. */
  readonly animations: ReadonlyMap<string, ReadonlyMap<Direction, readonly FrameRect[]>>;
  /** Poses estáticas, una por dirección. */
  readonly rotations: ReadonlyMap<Direction, FrameRect>;
}

export class SheetParseError extends Error {
  constructor(message: string) {
    super(`PixelLab sheet: ${message}`);
    this.name = "SheetParseError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function posInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new SheetParseError(`${what} debe ser un entero positivo (recibido: ${String(v)})`);
  }
  return v;
}

function isDirection(v: unknown): v is Direction {
  return typeof v === "string" && (DIRECTIONS as readonly string[]).includes(v);
}

export function parsePixelLabSheet(json: unknown): ParsedSheet {
  if (!isRecord(json)) throw new SheetParseError("el JSON raíz no es un objeto");
  const sheet = json["spritesheet"];
  if (!isRecord(sheet)) throw new SheetParseError('falta el objeto "spritesheet"');

  const cell = sheet["cell_size"];
  const size = sheet["sheet_size"];
  if (!isRecord(cell)) throw new SheetParseError('falta "spritesheet.cell_size"');
  if (!isRecord(size)) throw new SheetParseError('falta "spritesheet.sheet_size"');
  const cellW = posInt(cell["width"], "cell_size.width");
  const cellH = posInt(cell["height"], "cell_size.height");
  const sheetW = posInt(size["width"], "sheet_size.width");
  const sheetH = posInt(size["height"], "sheet_size.height");

  const rows = sheet["rows"];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new SheetParseError('"spritesheet.rows" debe ser una lista no vacía');
  }

  const animations = new Map<string, Map<Direction, FrameRect[]>>();
  const rotations = new Map<Direction, FrameRect>();

  for (const raw of rows as unknown[]) {
    if (!isRecord(raw)) throw new SheetParseError("una fila no es un objeto");
    const rowIndex = raw["row"];
    if (typeof rowIndex !== "number" || !Number.isInteger(rowIndex) || rowIndex < 0) {
      throw new SheetParseError(`índice de fila inválido: ${String(rowIndex)}`);
    }
    const frameCount = posInt(raw["frame_count"], `fila ${rowIndex}: frame_count`);
    if (frameCount * cellW > sheetW || (rowIndex + 1) * cellH > sheetH) {
      throw new SheetParseError(`la fila ${rowIndex} se sale de la hoja (${sheetW}x${sheetH})`);
    }
    const y = rowIndex * cellH;

    if (raw["type"] === "rotations") {
      const dirs = raw["directions"];
      if (!Array.isArray(dirs) || dirs.length !== frameCount) {
        throw new SheetParseError(`fila ${rowIndex}: "directions" no coincide con frame_count`);
      }
      (dirs as unknown[]).forEach((d, i) => {
        if (!isDirection(d)) throw new SheetParseError(`fila ${rowIndex}: dirección desconocida "${String(d)}"`);
        rotations.set(d, { x: i * cellW, y });
      });
    } else if (raw["type"] === "animation") {
      const name = raw["animation"];
      const dir = raw["direction"];
      if (typeof name !== "string" || name.length === 0) {
        throw new SheetParseError(`fila ${rowIndex}: falta el nombre de la animación`);
      }
      if (!isDirection(dir)) throw new SheetParseError(`fila ${rowIndex}: dirección desconocida "${String(dir)}"`);
      const frames: FrameRect[] = [];
      for (let i = 0; i < frameCount; i++) frames.push({ x: i * cellW, y });
      let byDir = animations.get(name);
      if (!byDir) {
        byDir = new Map();
        animations.set(name, byDir);
      }
      byDir.set(dir, frames);
    } else {
      throw new SheetParseError(`fila ${rowIndex}: tipo desconocido "${String(raw["type"])}"`);
    }
  }

  return { cellW, cellH, sheetW, sheetH, animations, rotations };
}
