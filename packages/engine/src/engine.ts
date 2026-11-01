import type { LoadedSpecies } from "./assets/species.js";
import type { Rng } from "./core/rng.js";
import { createRng, mathRng, range } from "./core/rng.js";
import { Pet, MAX_DT } from "./pet/pet.js";
import type { PetInit } from "./pet/pet.js";
import { CanvasRenderer } from "./render/renderer.js";
import type { DebugFlags } from "./render/renderer.js";
import type { Positioned } from "./world/proximity.js";
import { findNearbyPairs } from "./world/proximity.js";
import type { StageConfig } from "./world/stage.js";
import { Stage } from "./world/stage.js";

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Píxeles de pantalla por píxel de sprite (entero). Por defecto 3 (32 px -> 96 px en 1080p). */
  renderScale?: number;
  /** Tope de cuadros por segundo. 0 = al ritmo del monitor. */
  maxFps?: number;
  /** Semilla para comportamiento reproducible. Sin semilla usa Math.random. */
  seed?: number;
  stage?: Partial<StageConfig>;
  /** Distancia (px de mundo) bajo la cual dos mascotas se consideran cercanas. 0 = desactivado. */
  proximityRadius?: number;
  /** Máximo de mascotas simultáneas; al superarlo se retira la más antigua. */
  maxPets?: number;
  showNames?: boolean;
}

export type AddPetInit = Omit<PetInit, "x" | "lane" | "species"> & {
  species: LoadedSpecies;
  x?: number;
  lane?: number;
};

export interface EngineStats {
  fps: number;
  /** Milisegundos medios de actualizar + dibujar un cuadro. */
  frameMs: number;
  pets: number;
}

/** Tope de tiempo simulado por cuadro; evita avanzar minutos de golpe si la pestaña estuvo oculta. */
const MAX_FRAME_SECONDS = 0.5;

export class PetEngine {
  readonly stage: Stage;
  readonly debug: DebugFlags = { proximity: false, bounds: false, anchors: false };
  showNames: boolean;
  proximityRadius: number;
  maxPets: number;
  readonly stats: EngineStats = { fps: 0, frameMs: 0, pets: 0 };

  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: CanvasRenderer;
  private readonly rng: Rng;
  private readonly byId = new Map<string, Pet>();
  private list: Pet[] = [];
  private pairs: Array<[Positioned, Positioned]> = [];
  private scale: number;
  private minFrameTime = 0;
  private raf = 0;
  private lastTime = 0;
  private running = false;
  private resizeObserver: ResizeObserver | undefined;
  private statFrames = 0;
  private statTime = 0;
  private statWork = 0;

  constructor(opts: EngineOptions) {
    this.canvas = opts.canvas;
    this.renderer = new CanvasRenderer(opts.canvas);
    this.stage = new Stage(opts.stage);
    this.rng = opts.seed === undefined ? mathRng : createRng(opts.seed);
    this.scale = Math.max(1, Math.floor(opts.renderScale ?? 3));
    this.showNames = opts.showNames ?? true;
    this.proximityRadius = opts.proximityRadius ?? 0;
    this.maxPets = Math.max(1, Math.floor(opts.maxPets ?? 20));
    this.setMaxFps(opts.maxFps ?? 0);
    this.resize();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(opts.canvas);
    }
  }

  get pets(): readonly Pet[] {
    return this.list;
  }

  get renderScale(): number {
    return this.scale;
  }

  getPet(id: string): Pet | undefined {
    return this.byId.get(id);
  }

  /**
   * Hace atacar a una mascota (gancho para el futuro PvP). `towards` la gira hacia ese lado.
   * Devuelve false si no existe, su especie no tiene animación de ataque o está ocupada.
   */
  attack(id: string, towards?: "east" | "west"): boolean {
    return this.byId.get(id)?.playAttack(towards) ?? false;
  }

  addPet(init: AddPetInit): Pet {
    if (this.byId.has(init.id)) throw new Error(`Ya existe una mascota con id "${init.id}"`);
    while (this.list.length >= this.maxPets) {
      const oldest = this.list[0];
      if (!oldest) break;
      this.removePet(oldest.id);
    }
    const { x, lane, ...rest } = init;
    const pet = new Pet(
      {
        ...rest,
        x: x ?? range(this.rng, this.stage.minX, this.stage.maxX),
        lane: lane ?? range(this.rng, 0, this.stage.laneBand),
      },
      this.stage,
      this.rng,
    );
    this.byId.set(pet.id, pet);
    this.list.push(pet);
    return pet;
  }

  removePet(id: string): boolean {
    const pet = this.byId.get(id);
    if (!pet) return false;
    this.byId.delete(id);
    this.list = this.list.filter((p) => p !== pet);
    return true;
  }

  clear(): void {
    this.byId.clear();
    this.list = [];
    this.pairs = [];
  }

  setScale(scale: number): void {
    this.scale = Math.max(1, Math.floor(scale));
    this.resize();
  }

  setMaxFps(maxFps: number): void {
    this.minFrameTime = maxFps > 0 ? 1 / maxFps : 0;
  }

  /** Recalcula el tamaño del búfer y del escenario a partir del tamaño CSS del canvas. */
  resize(): void {
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    this.renderer.setBackingSize(w, h);
    this.stage.setSize(w / this.scale, h / this.scale);
  }

  /** Avanza la simulación `dt` segundos, en pasos que nunca superan MAX_DT. */
  step(dt: number): void {
    let remaining = Math.min(Math.max(dt, 0), MAX_FRAME_SECONDS);
    while (remaining > 1e-9) {
      const d = Math.min(remaining, MAX_DT);
      for (const pet of this.list) pet.update(d);
      remaining -= d;
    }
    this.pairs = this.proximityRadius > 0 ? findNearbyPairs(this.list, this.proximityRadius) : [];
  }

  render(): void {
    this.renderer.render(this.list, this.stage, {
      scale: this.scale,
      showNames: this.showNames,
      debug: this.debug,
      proximityPairs: this.pairs,
    });
  }

  /** Pares de mascotas cercanas calculados en el último `step`. */
  get nearbyPairs(): ReadonlyArray<readonly [Positioned, Positioned]> {
    return this.pairs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Libera el bucle y los observadores. Llamar al desmontar el overlay. */
  dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.clear();
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    if (this.lastTime === 0) {
      this.lastTime = now;
      return;
    }
    const elapsed = (now - this.lastTime) / 1000;
    // Con tope de FPS dejamos que el tiempo se acumule hasta el siguiente cuadro útil.
    if (this.minFrameTime > 0 && elapsed < this.minFrameTime - 0.002) return;
    this.lastTime = now;

    const t0 = performance.now();
    this.step(elapsed);
    this.render();
    this.statWork += performance.now() - t0;
    this.statFrames++;
    this.statTime += elapsed;
    if (this.statTime >= 1) {
      this.stats.fps = this.statFrames / this.statTime;
      this.stats.frameMs = this.statWork / this.statFrames;
      this.stats.pets = this.list.length;
      this.statFrames = 0;
      this.statTime = 0;
      this.statWork = 0;
    }
  };
}
