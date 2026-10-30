/** Generador de números aleatorios inyectable: permite simulaciones deterministas en tests. */
export interface Rng {
  /** Devuelve un número en [0, 1). */
  next(): number;
}

/** mulberry32: PRNG pequeño y rápido con semilla de 32 bits. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export const mathRng: Rng = { next: () => Math.random() };

/** Número real uniforme en [min, max). */
export function range(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng.next();
}

/** Elige una clave según pesos no negativos. Devuelve undefined si todos los pesos son 0. */
export function pickWeighted<K extends string>(
  rng: Rng,
  weights: Partial<Record<K, number>>,
): K | undefined {
  let total = 0;
  const entries: Array<[K, number]> = [];
  for (const key of Object.keys(weights) as K[]) {
    const w = weights[key] ?? 0;
    if (w > 0) {
      entries.push([key, w]);
      total += w;
    }
  }
  if (total <= 0) return undefined;
  let roll = rng.next() * total;
  for (const [key, w] of entries) {
    roll -= w;
    if (roll < 0) return key;
  }
  return entries[entries.length - 1]?.[0];
}
