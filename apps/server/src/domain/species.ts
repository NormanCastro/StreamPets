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

  /**
   * Especie preferida si existe (y está permitida); si no, una al azar entre las permitidas.
   * `allowed` limita la elección a esas especies; si queda vacío se usa todo el catálogo.
   */
  pick(rng: Rng, preferredId?: string | null, allowed?: ReadonlySet<string>): string {
    const ok = (id: string) => this.byId.has(id) && (allowed === undefined || allowed.has(id));
    if (preferredId && ok(preferredId)) return preferredId;
    const pool = this.entries.filter((e) => ok(e.id));
    const list = pool.length > 0 ? pool : this.entries;
    const i = Math.min(Math.floor(rng.next() * list.length), list.length - 1);
    return (list[i] as SpeciesEntry).id;
  }

  /** Especie a mostrar cuando la guardada ya no existe en el catálogo. */
  fallbackId(): string {
    return (this.entries[0] as SpeciesEntry).id;
  }
}
