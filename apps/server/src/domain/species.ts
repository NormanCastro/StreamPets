import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SpeciesIndexSchema } from "@streampets/shared";
import type { SpeciesIndex } from "@streampets/shared";
import type { Rng } from "./rng.js";

export type SpeciesEntry = SpeciesIndex["species"][number];

/** Catálogo de especies disponibles (se lee de assets/species/index.json). */
export class SpeciesCatalog {
  private readonly byId = new Map<string, SpeciesEntry>();

  constructor(readonly entries: readonly SpeciesEntry[]) {
    if (entries.length === 0) throw new Error("El catálogo de especies está vacío");
    for (const e of entries) {
      if (this.byId.has(e.id)) throw new Error(`Especie duplicada en el catálogo: ${e.id}`);
      this.byId.set(e.id, e);
    }
  }

  static fromAssetsDir(assetsDir: string): SpeciesCatalog {
    const file = resolve(assetsDir, "species/index.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return new SpeciesCatalog(SpeciesIndexSchema.parse(raw).species);
  }

  list(): readonly SpeciesEntry[] {
    return this.entries;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Especie preferida si existe; si no, una al azar. */
  pick(rng: Rng, preferredId?: string | null): string {
    if (preferredId && this.byId.has(preferredId)) return preferredId;
    const i = Math.min(Math.floor(rng.next() * this.entries.length), this.entries.length - 1);
    return (this.entries[i] as SpeciesEntry).id;
  }

  /** Especie a mostrar cuando la guardada ya no existe en el catálogo. */
  fallbackId(): string {
    return (this.entries[0] as SpeciesEntry).id;
  }
}
