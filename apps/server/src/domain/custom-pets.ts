import { randomBytes } from "node:crypto";
import { CUSTOM_PET } from "@streampets/shared";
import type { Db } from "../db/client.js";
import * as repo from "../db/repo.js";
import type { SpeciesCatalog } from "./species.js";

/** Id nuevo para una pet personalizada: "u-" + 8 hex. */
export function newCustomPetId(): string {
  return `u-${randomBytes(4).toString("hex")}`;
}

export function customQuota(plan: "free" | "premium"): number {
  return CUSTOM_PET.quota[plan];
}

/** Vuelve a leer de la base las pets aprobadas y actualiza el catálogo en memoria. */
export async function reloadCustomSpecies(db: Db, catalog: SpeciesCatalog): Promise<void> {
  catalog.setCustom(await repo.listApprovedCustomPets(db));
}

/** Lee de la base qué especies están apagadas. */
export async function reloadDisabledSpecies(db: Db, catalog: SpeciesCatalog): Promise<void> {
  catalog.setDisabled(await repo.listDisabledSpecies(db));
}

/** species.json de una pet personalizada (las URLs son relativas a este mismo archivo). */
export function customSpeciesDef(id: string, name: string) {
  return {
    id,
    name,
    sheetImage: "sheet.png",
    sheetMeta: "sheet.json",
    anchor: { x: 20, y: 34 },
    shadow: { rx: 6, ry: 2.5 },
    labelOffsetY: 33,
    clips: {
      idle: { source: "Idle", fps: 6, loop: true },
      walk: { source: "Walk", fps: 12, loop: true },
      run: { source: "Walk", fps: 19, loop: true },
    },
  };
}

/** Descripción de la hoja en el formato que lee el motor. La plantilla fija: el artista solo dibuja. */
export function customSheetMeta(id: string) {
  const dirs = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];
  const row = (n: number, animation: string, frames: number, direction: string) => ({
    row: n,
    type: "animation",
    frame_count: frames,
    animation,
    animation_group_id: `${id}-${animation.toLowerCase()}`,
    direction,
  });
  return {
    character: { id, name: id, size: { width: 32, height: 32 }, directions: 8, view: "low top-down" },
    spritesheet: {
      path: "sheet.png",
      cell_size: { width: CUSTOM_PET.cellSize, height: CUSTOM_PET.cellSize },
      sheet_size: { width: CUSTOM_PET.sheetWidth, height: CUSTOM_PET.sheetHeight },
      columns: CUSTOM_PET.columns,
      pivot: "cell-center",
      rows: [
        { row: 0, type: "rotations", frame_count: 8, directions: dirs },
        row(1, "Idle", CUSTOM_PET.idleFrames, "south"),
        row(2, "Idle", CUSTOM_PET.idleFrames, "east"),
        row(3, "Idle", CUSTOM_PET.idleFrames, "west"),
        row(4, "Walk", CUSTOM_PET.walkFrames, "south"),
        row(5, "Walk", CUSTOM_PET.walkFrames, "east"),
        row(6, "Walk", CUSTOM_PET.walkFrames, "west"),
      ],
    },
  };
}
