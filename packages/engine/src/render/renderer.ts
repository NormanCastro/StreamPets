import type { Pet } from "../pet/pet.js";
import type { Positioned } from "../world/proximity.js";
import type { Stage } from "../world/stage.js";

export interface DebugFlags {
  /** Líneas entre mascotas cercanas. */
  proximity: boolean;
  /** Límites del escenario y franja de profundidad. */
  bounds: boolean;
  /** Punto de apoyo de cada mascota. */
  anchors: boolean;
}

export interface RenderOptions {
  /** Píxeles de pantalla por píxel de mundo. Siempre entero para que el pixel art quede nítido. */
  scale: number;
  showNames: boolean;
  debug: DebugFlags;
  proximityPairs: ReadonlyArray<readonly [Positioned, Positioned]>;
}

/**
 * Renderer Canvas 2D. No contiene lógica de comportamiento: solo dibuja el estado de las mascotas.
 * Todo se alinea a píxeles de mundo enteros multiplicados por una escala entera.
 */
export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("No se pudo crear el contexto 2D del canvas");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
  }

  /** Ajusta el tamaño del búfer. Cambiar width/height reinicia el estado del contexto. */
  setBackingSize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.ctx.imageSmoothingEnabled = false;
  }

  render(pets: readonly Pet[], stage: Stage, opts: RenderOptions): void {
    const { ctx } = this;
    const s = opts.scale;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (opts.debug.bounds) this.drawBounds(stage, s);

    // groundY crece hacia abajo: la menor Y es la mascota más al fondo y se dibuja primero.
    const ordered = [...pets].sort((a, b) => stage.groundY(a.lane) - stage.groundY(b.lane) || a.x - b.x);

    for (const pet of ordered) this.drawPet(pet, stage, opts);

    if (opts.debug.proximity) this.drawProximity(opts.proximityPairs, stage, s);
  }

  private drawPet(pet: Pet, stage: Stage, opts: RenderOptions): void {
    const { ctx } = this;
    const s = opts.scale;
    const def = pet.species.def;
    const feetX = Math.round(pet.x);
    const feetY = stage.groundY(pet.lane);
    const z = Math.round(pet.z);

    // Sombra: se encoge un poco cuando la mascota salta.
    const lift = Math.min(z / 20, 0.5);
    ctx.fillStyle = `rgba(0,0,0,${0.28 * (1 - lift)})`;
    ctx.beginPath();
    ctx.ellipse(feetX * s, feetY * s, def.shadow.rx * s * (1 - lift), def.shadow.ry * s * (1 - lift), 0, 0, Math.PI * 2);
    ctx.fill();

    // Sprite.
    const { cellW, cellH } = pet.species.sheet;
    const frame = pet.currentFrame();
    const dx = (feetX - def.anchor.x) * s;
    const dy = (feetY - z - def.anchor.y) * s;
    const split = def.breathSplitY;
    const breathing = pet.state === "IDLE" || pet.state === "SIT" || pet.state === "SLEEP";
    const period = pet.state === "SLEEP" ? pet.behavior.sleepBreathPeriod : pet.behavior.breathPeriod;
    const inhale = breathing && split !== undefined && Math.floor(pet.stateTime / (period / 2)) % 2 === 1;

    // Dormida: sprite de frente (el pack no trae animación de sueño), un poco apagado.
    const dim = pet.state === "SLEEP";
    if (dim) ctx.filter = "brightness(0.72) saturate(0.85)";

    if (inhale && split !== undefined) {
      // Estiramos 1 píxel de mundo: la mitad superior sube 1 px y la fila de corte se duplica,
      // así no queda ninguna rendija y se mantiene el pixel art entero.
      ctx.drawImage(pet.species.image, frame.x, frame.y + split, cellW, cellH - split, dx, dy + split * s, cellW * s, (cellH - split) * s);
      ctx.drawImage(pet.species.image, frame.x, frame.y, cellW, split + 1, dx, dy - s, cellW * s, (split + 1) * s);
    } else {
      ctx.drawImage(pet.species.image, frame.x, frame.y, cellW, cellH, dx, dy, cellW * s, cellH * s);
    }

    if (dim) ctx.filter = "none";

    if (pet.state === "SLEEP") this.drawZzz(pet, feetX, feetY, s);

    if (opts.showNames) {
      ctx.font = `bold ${Math.round(5 * s)}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(2, s);
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.fillStyle = "#ffffff";
      const ty = (feetY - def.labelOffsetY - 2) * s;
      ctx.strokeText(pet.name, feetX * s, ty);
      ctx.fillText(pet.name, feetX * s, ty);
    }

    if (opts.debug.anchors) {
      ctx.fillStyle = "#ff3b6b";
      ctx.fillRect(feetX * s - 1, feetY * s - 1, 3, 3);
    }
  }

  private drawZzz(pet: Pet, feetX: number, feetY: number, s: number): void {
    const { ctx } = this;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#cfe3ff";
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = Math.max(2, s);
    for (let i = 0; i < 3; i++) {
      const t = (pet.stateTime * 0.45 + i / 3) % 1;
      const px = (feetX + 9 + t * 7 + i * 1.5) * s;
      const py = (feetY - 24 - t * 16) * s;
      ctx.globalAlpha = Math.sin(Math.PI * t);
      ctx.font = `bold ${Math.round((3.5 + i) * s)}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.strokeText("z", px, py);
      ctx.fillText("z", px, py);
    }
    ctx.globalAlpha = 1;
  }

  private drawBounds(stage: Stage, s: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = "rgba(80,200,255,0.7)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(stage.minX * s, 0, (stage.maxX - stage.minX) * s, stage.height * s);
    ctx.strokeStyle = "rgba(255,200,80,0.7)";
    const front = stage.groundY(0) * s;
    const back = stage.groundY(stage.laneBand) * s;
    ctx.beginPath();
    ctx.moveTo(0, front);
    ctx.lineTo(stage.width * s, front);
    ctx.moveTo(0, back);
    ctx.lineTo(stage.width * s, back);
    ctx.stroke();
    ctx.restore();
  }

  private drawProximity(pairs: RenderOptions["proximityPairs"], stage: Stage, s: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = "rgba(255,90,140,0.9)";
    ctx.lineWidth = 2;
    for (const [a, b] of pairs) {
      ctx.beginPath();
      ctx.moveTo(Math.round(a.x) * s, (stage.groundY(a.lane) - 12) * s);
      ctx.lineTo(Math.round(b.x) * s, (stage.groundY(b.lane) - 12) * s);
      ctx.stroke();
    }
    ctx.restore();
  }
}
