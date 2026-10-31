import type { Db } from "../db/client.js";
import * as repo from "../db/repo.js";
import type { SpeciesCatalog, SpeciesEntry } from "./species.js";

export interface AccessInfo {
  plan: repo.ChannelPlan;
  /** Especies exclusivas que el canal tiene permitidas. */
  grants: ReadonlySet<string>;
  /** El dueño de la instalación puede usar todo. */
  unrestricted: boolean;
  /** Canal que consulta (para las pets personalizadas, que son de un solo canal). */
  streamerId?: string | undefined;
}

/**
 * Regla: una especie "exclusiva" solo la usan los canales listados para ella; una "premium" solo los
 * canales con plan premium. Si es exclusiva Y premium hacen falta las dos cosas.
 */
export function canUse(
  entry: Pick<SpeciesEntry, "id" | "scope" | "tier"> & { ownerStreamerId?: string | undefined },
  a: AccessInfo,
): boolean {
  // Una pet personalizada la usa solo el canal que la subió (ni siquiera el dueño de la instalación).
  if (entry.ownerStreamerId !== undefined) return entry.ownerStreamerId === a.streamerId;
  if (a.unrestricted) return true;
  if (entry.scope === "exclusive" && !a.grants.has(entry.id)) return false;
  if (entry.tier === "premium" && a.plan !== "premium") return false;
  return true;
}

export class SpeciesAccess {
  constructor(
    private readonly db: Db,
    private readonly species: SpeciesCatalog,
    /** Streamer del dueño de la instalación. */
    private readonly ownerStreamerId: string,
  ) {}

  async info(streamerId: string): Promise<AccessInfo> {
    if (streamerId === this.ownerStreamerId) return { plan: "premium", grants: new Set(), unrestricted: true, streamerId };
    const a = await repo.getAccessForStreamer(this.db, streamerId);
    return { plan: a.plan, grants: new Set(a.grants), unrestricted: false, streamerId };
  }

  /** Ids de las especies que este streamer puede usar. */
  async allowedIds(streamerId: string): Promise<Set<string>> {
    const a = await this.info(streamerId);
    return new Set(this.species.list().filter((e) => canUse(e, a)).map((e) => e.id));
  }

  async isAllowed(streamerId: string, speciesId: string): Promise<boolean> {
    return (await this.allowedIds(streamerId)).has(speciesId);
  }
}
