export interface Positioned {
  readonly id: string;
  readonly x: number;
  readonly lane: number;
}

/**
 * Pares de mascotas a distancia <= radius (en píxeles de mundo, contando la profundidad).
 * O(n^2): suficiente para el máximo previsto de mascotas en pantalla.
 */
export function findNearbyPairs<T extends Positioned>(pets: readonly T[], radius: number): Array<[T, T]> {
  const out: Array<[T, T]> = [];
  if (!(radius > 0)) return out;
  const r2 = radius * radius;
  for (let i = 0; i < pets.length; i++) {
    const a = pets[i];
    if (!a) continue;
    for (let j = i + 1; j < pets.length; j++) {
      const b = pets[j];
      if (!b) continue;
      const dx = a.x - b.x;
      const dy = a.lane - b.lane;
      if (dx * dx + dy * dy <= r2) out.push([a, b]);
    }
  }
  return out;
}
