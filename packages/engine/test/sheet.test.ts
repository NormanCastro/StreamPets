import { describe, expect, it } from "vitest";
import { parsePixelLabSheet, SheetParseError } from "../src/assets/pixellab.js";
import { resolveClips, SpeciesError } from "../src/assets/species.js";
import type { SpeciesDef } from "../src/assets/species.js";
import { readJson } from "./helpers.js";

const realSheet = readJson("shiba.sheet.json");
const shibaDef = readJson("species.json") as SpeciesDef;

describe("parsePixelLabSheet (export real del perro)", () => {
  const sheet = parsePixelLabSheet(realSheet);

  it("lee tamaños de celda y de hoja", () => {
    expect(sheet.cellW).toBe(48);
    expect(sheet.cellH).toBe(48);
    expect(sheet.sheetW).toBe(384);
    expect(sheet.sheetH).toBe(432);
  });

  it("encuentra Walk e Idle con 8 frames en las 4 direcciones cardinales", () => {
    for (const anim of ["Walk", "Idle"]) {
      for (const dir of ["south", "east", "north", "west"] as const) {
        expect(sheet.animations.get(anim)?.get(dir)).toHaveLength(8);
      }
    }
  });

  it("calcula la posición de cada frame (columna = índice, fila = fila del JSON)", () => {
    // Walk east está en la fila 2 del JSON.
    expect(sheet.animations.get("Walk")?.get("east")?.[3]).toEqual({ x: 3 * 48, y: 2 * 48 });
    // Idle west está en la fila 8.
    expect(sheet.animations.get("Idle")?.get("west")?.[7]).toEqual({ x: 7 * 48, y: 8 * 48 });
  });

  it("lee las 8 poses estáticas de la fila de rotaciones", () => {
    expect(sheet.rotations.size).toBe(8);
    expect(sheet.rotations.get("east")).toEqual({ x: 2 * 48, y: 0 });
  });

  it("todos los frames caben dentro de la hoja", () => {
    for (const byDir of sheet.animations.values()) {
      for (const frames of byDir.values()) {
        for (const f of frames) {
          expect(f.x + sheet.cellW).toBeLessThanOrEqual(sheet.sheetW);
          expect(f.y + sheet.cellH).toBeLessThanOrEqual(sheet.sheetH);
        }
      }
    }
  });
});

describe("parsePixelLabSheet (entradas inválidas)", () => {
  const base = (rows: unknown) => ({
    spritesheet: {
      cell_size: { width: 48, height: 48 },
      sheet_size: { width: 384, height: 96 },
      rows,
    },
  });

  it("rechaza JSON que no es un objeto", () => {
    expect(() => parsePixelLabSheet(null)).toThrow(SheetParseError);
    expect(() => parsePixelLabSheet([])).toThrow(SheetParseError);
  });

  it("rechaza hojas sin filas", () => {
    expect(() => parsePixelLabSheet(base([]))).toThrow(/rows/);
  });

  it("rechaza direcciones desconocidas", () => {
    const rows = [{ row: 0, type: "animation", frame_count: 2, animation: "Walk", direction: "up" }];
    expect(() => parsePixelLabSheet(base(rows))).toThrow(/dirección desconocida/);
  });

  it("rechaza filas que se salen de la hoja", () => {
    const rows = [{ row: 5, type: "animation", frame_count: 2, animation: "Walk", direction: "east" }];
    expect(() => parsePixelLabSheet(base(rows))).toThrow(/se sale de la hoja/);
  });

  it("rechaza tipos de fila desconocidos", () => {
    const rows = [{ row: 0, type: "otra-cosa", frame_count: 2 }];
    expect(() => parsePixelLabSheet(base(rows))).toThrow(/tipo desconocido/);
  });
});

describe("resolveClips", () => {
  const sheet = parsePixelLabSheet(realSheet);

  it("resuelve idle, walk y run en east, west y south", () => {
    const clips = resolveClips(shibaDef, sheet);
    for (const clip of ["idle", "walk", "run"] as const) {
      for (const view of ["east", "west", "south"] as const) {
        expect(clips.get(clip)?.get(view)?.frames.length).toBeGreaterThan(0);
      }
    }
  });

  it("walk y run no necesitan la vista de frente, pero idle sí", () => {
    const withoutSouth = (anim: string) => ({
      ...sheet,
      animations: new Map(
        [...sheet.animations].map(([name, byDir]) => [
          name,
          name === anim ? new Map([...byDir].filter(([dir]) => dir !== "south")) : byDir,
        ]),
      ),
    });
    const noWalkSouth = resolveClips(shibaDef, withoutSouth("Walk"));
    expect(noWalkSouth.get("walk")?.get("east")?.frames.length).toBeGreaterThan(0);
    expect(noWalkSouth.get("walk")?.get("south")).toBeUndefined();
    expect(noWalkSouth.get("run")?.get("west")?.frames.length).toBeGreaterThan(0);
    expect(noWalkSouth.get("idle")?.get("south")?.frames.length).toBeGreaterThan(0);
    expect(() => resolveClips(shibaDef, withoutSouth("Idle"))).toThrow(/idle.*falta la dirección "south"/);
  });

  it("walk exige east y west", () => {
    const withoutWest = {
      ...sheet,
      animations: new Map(
        [...sheet.animations].map(([name, byDir]) => [
          name,
          name === "Walk" ? new Map([...byDir].filter(([dir]) => dir !== "west")) : byDir,
        ]),
      ),
    };
    expect(() => resolveClips(shibaDef, withoutWest)).toThrow(/walk.*falta la dirección "west"/);
  });

  it("falla con un mensaje útil si la animación no existe en la hoja", () => {
    const broken: SpeciesDef = {
      ...shibaDef,
      clips: { ...shibaDef.clips, walk: { source: "Caminar", fps: 10, loop: true } },
    };
    expect(() => resolveClips(broken, sheet)).toThrow(SpeciesError);
    expect(() => resolveClips(broken, sheet)).toThrow(/Caminar.*disponibles: .*Walk/);
  });

  it("falla si fps no es positivo", () => {
    const broken: SpeciesDef = {
      ...shibaDef,
      clips: { ...shibaDef.clips, idle: { source: "Idle", fps: 0, loop: true } },
    };
    expect(() => resolveClips(broken, sheet)).toThrow(/fps/);
  });
});
