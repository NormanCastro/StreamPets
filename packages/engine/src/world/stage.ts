/**
 * Escenario: todas las medidas están en "píxeles de mundo" (= píxeles de sprite).
 * El renderer los multiplica por una escala entera para que el pixel art quede nítido.
 */
export interface StageConfig {
  width: number;
  height: number;
  /** Distancia mínima entre el punto de apoyo de una mascota y los bordes laterales. */
  margin: number;
  /** Espacio entre el borde inferior y la línea de suelo más cercana (lane 0). */
  groundPad: number;
  /** Alto de la franja de profundidad: las mascotas se reparten entre lane 0 y laneBand. */
  laneBand: number;
}

export const DEFAULT_STAGE: StageConfig = {
  width: 640,
  height: 360,
  margin: 20,
  groundPad: 4,
  laneBand: 10,
};

export class Stage {
  width: number;
  height: number;
  margin: number;
  groundPad: number;
  laneBand: number;

  constructor(config: Partial<StageConfig> = {}) {
    const c = { ...DEFAULT_STAGE, ...config };
    this.width = c.width;
    this.height = c.height;
    this.margin = c.margin;
    this.groundPad = c.groundPad;
    this.laneBand = Math.max(0, c.laneBand);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
  }

  get minX(): number {
    return Math.min(this.margin, this.width / 2);
  }

  get maxX(): number {
    return Math.max(this.width - this.margin, this.width / 2);
  }

  /** Coordenada Y (en píxeles de mundo) donde apoyan los pies para una lane dada. */
  groundY(lane: number): number {
    const clamped = Math.min(Math.max(lane, 0), this.laneBand);
    return Math.round(this.height - this.groundPad - clamped);
  }
}
