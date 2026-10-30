/** Fuente de azar inyectable (para tests deterministas). */
export interface Rng {
  /** Número en [0, 1). */
  next(): number;
}

export const mathRng: Rng = { next: () => Math.random() };

/** mulberry32 con semilla. */
export function seededRng(seed: number): Rng {
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

export interface Clock {
  /** Milisegundos (época). */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
