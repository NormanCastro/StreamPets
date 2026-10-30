import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { parsePixelLabSheet } from "../src/assets/pixellab.js";
import { resolveClips } from "../src/assets/species.js";
import type { LoadedSpecies, SpeciesDef } from "../src/assets/species.js";

const here = dirname(fileURLToPath(import.meta.url));
export const SHIBA_DIR = resolve(here, "../../../shared-public/assets/species/shiba");

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(resolve(SHIBA_DIR, file), "utf8")) as unknown;
}

/** Especie real (JSON del perro) sin imagen: el motor lógico no toca el PNG. */
export function loadShibaFixture(): LoadedSpecies {
  const def = readJson("species.json") as SpeciesDef;
  const sheet = parsePixelLabSheet(readJson(def.sheetMeta));
  return { def, sheet, image: {} as CanvasImageSource, clips: resolveClips(def, sheet) };
}
