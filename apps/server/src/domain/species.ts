import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SpeciesIndexSchema } from "@streampets/shared";
import type { SpeciesIndex } from "@streampets/shared";
import type { Rng } from "./rng.js";

export type SpeciesEntry = SpeciesIndex["species"][number] & {
  /** Solo en pets personalizadas: el único canal que puede usarla. */
  ownerStreamerId?: string | undefined;
};

/** Catálogo de especies disponibles (se lee de assets/species/index.json). */
export class SpeciesCatalog {
  private readonly byId = new Map<string, SpeciesEntry>();
  private custom: SpeciesEntry[] = [];
  private disabled = new Set<string>();

  constructor(readonly entries: readonly SpeciesEntry[]) {
    if (entries.length === 0) throw new Error("El catálogo de especies está vacío");
    for (const e of entries) {
      if (this.byId.has(e.id)) throw new Error(`Especie duplicada en el catálogo: ${e.id}`);
      this.byId.set(e.id, e);
    }
  }

  /** Reemplaza las pets personalizadas aprobadas (se agregan después de las del catálogo base). */
  setCustom(list: ReadonlyArray<{ id: string; name: string; streamerId: string }>): void {
    for (const c of this.custom) this.byId.delete(c.id);
    this.custom = list
      .filter((c) => !this.entries.some((e) => e.id === c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        url: `/api/custom-species/${c.id}/species.json`,
        scope: "exclusive" as const,
        tier: "free" as const,
        ownerStreamerId: c.streamerId,
      }));
    for (const c of this.custom) this.byId.set(c.id, c);
  }

  static fromAssetsDir(assetsDir: string): SpeciesCatalog {
    const file = resolve(assetsDir, "species/index.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return new SpeciesCatalog(SpeciesIndexSchema.parse(raw).species);
  }

  /** Especies apagadas por el administrador: nadie puede usarlas ni recibirlas. */
  setDisabled(ids: Iterable<string>): void {
    this.disabled = new Set(ids);
  }

  isDisabled(id: string): boolean {
    return this.disabled.has(id);
  }

  list(): readonly SpeciesEntry[] {
    return this.custom.length === 0 ? this.entries : [...this.entries, ...this.custom];
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /**
   * Especie preferida si existe (y está permitida); si no, una al azar entre las permitidas.
   * `allowed` limita la elección a esas especies; si queda vacío se usa todo el catálogo.
   */
  pick(rng: Rng, preferredId?: string | null, allowed?: ReadonlySet<string>): string {
    const ok = (id: string) => this.byId.has(id) && !this.disabled.has(id) && (allowed === undefined || allowed.has(id));
    if (preferredId && ok(preferredId)) return preferredId;
    const pool = this.list().filter((e) => ok(e.id));
    const list = pool.length > 0 ? pool : this.entries;
    const i = Math.min(Math.floor(rng.next() * list.length), list.length - 1);
    return (list[i] as SpeciesEntry).id;
  }

  /** Especie a mostrar cuando la guardada ya no existe en el catálogo. */
  fallbackId(): string {
    return (this.entries[0] as SpeciesEntry).id;
  }
}
