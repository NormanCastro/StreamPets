import { Animator } from "../anim/animator.js";
import type { ClipName, LoadedSpecies, View } from "../assets/species.js";
import type { FrameRect } from "../assets/pixellab.js";
import type { Rng } from "../core/rng.js";
import { pickWeighted, range } from "../core/rng.js";
import type { Stage } from "../world/stage.js";
import type { BehaviorConfig, Facing, PetState, TimedState } from "./state.js";
import { DEFAULT_BEHAVIOR, STATE_DEFS, mergeBehavior } from "./state.js";

export interface PetInit {
  id: string;
  name: string;
  species: LoadedSpecies;
  /** Espectador dueño de la mascota (para la Fase 4 / Twitch). */
  ownerId?: string;
  x: number;
  lane: number;
  facing?: Facing;
  behavior?: Partial<BehaviorConfig>;
}

/** dt máximo que procesamos de una vez (evita saltos enormes tras una pestaña en segundo plano). */
export const MAX_DT = 0.1;

export class Pet {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string | undefined;
  readonly species: LoadedSpecies;
  readonly animator = new Animator();
  readonly behavior: BehaviorConfig;

  /** Posición horizontal del punto de apoyo, en píxeles de mundo. */
  x: number;
  /** Profundidad dentro de la franja del escenario (0 = más cerca del borde inferior). */
  lane: number;
  /** Altura sobre el suelo (saltos). */
  z = 0;
  facing: Facing;
  /** -1 = izquierda (west), 1 = derecha (east). */
  dir: -1 | 1;

  state: PetState = "IDLE";
  stateTime = 0;
  stateDuration = 1;
  clip: ClipName = "idle";
  view: View = "east";

  /** Se llama en cada cambio de estado. */
  onStateChange: ((pet: Pet, from: PetState, to: PetState) => void) | undefined;

  private readonly stage: Stage;
  private readonly rng: Rng;

  constructor(init: PetInit, stage: Stage, rng: Rng) {
    this.id = init.id;
    this.name = init.name;
    this.ownerId = init.ownerId;
    this.species = init.species;
    this.stage = stage;
    this.rng = rng;
    this.behavior = mergeBehavior(DEFAULT_BEHAVIOR, init.behavior);
    this.x = init.x;
    this.lane = init.lane;
    this.facing = init.facing ?? (rng.next() < 0.5 ? "east" : "west");
    this.dir = this.facing === "east" ? 1 : -1;
    this.enter("IDLE", false);
  }

  /** Frame actual (celda dentro del PNG) para dibujar. */
  currentFrame(): FrameRect {
    const resolved = this.species.clips.get(this.clip)?.get(this.view);
    const frame = resolved?.frames[this.animator.frameIndex];
    if (!resolved || !frame) throw new Error(`Pet ${this.id}: sin frames para ${this.clip}/${this.view}`);
    return frame;
  }

  /**
   * Petición externa de cambio de estado (comando de chat, evento...).
   * Se acepta si el estado actual es interrumpible o el nuevo tiene prioridad mayor.
   * Devuelve false si se rechaza (no se encola).
   */
  requestState(next: PetState): boolean {
    const nextDef = STATE_DEFS[next];
    if (!nextDef.implemented) return false;
    const curDef = STATE_DEFS[this.state];
    if (!curDef.interruptible && nextDef.priority <= curDef.priority) return false;
    this.enter(next, true);
    return true;
  }

  update(rawDt: number): void {
    if (!(rawDt > 0)) return;
    const dt = Math.min(rawDt, MAX_DT);
    this.stateTime += dt;
    this.animator.update(dt);

    switch (this.state) {
      case "WALK":
        this.move(dt, this.behavior.walkSpeed);
        break;
      case "RUN":
        this.move(dt, this.behavior.runSpeed);
        break;
      case "JUMP": {
        const t = Math.min(this.stateTime / this.behavior.jump.duration, 1);
        this.z = 4 * this.behavior.jump.height * t * (1 - t);
        this.move(dt, this.behavior.jump.forwardSpeed);
        break;
      }
      default:
        break;
    }

    // Si el escenario cambió de tamaño, no dejamos a nadie fuera.
    this.x = Math.min(Math.max(this.x, this.stage.minX), this.stage.maxX);

    if (this.stateTime >= this.stateDuration) this.nextAutonomous();
  }

  private move(dt: number, speed: number): void {
    this.x += this.dir * speed * dt;
    if (this.x >= this.stage.maxX) {
      this.x = this.stage.maxX;
      this.turn(-1);
    } else if (this.x <= this.stage.minX) {
      this.x = this.stage.minX;
      this.turn(1);
    }
  }

  private turn(dir: -1 | 1): void {
    this.dir = dir;
    this.facing = dir === 1 ? "east" : "west";
    if (STATE_DEFS[this.state].view === "side") this.view = this.facing;
  }

  private nextAutonomous(): void {
    const weights = this.behavior.weights[this.state] ?? {};
    const candidates: Partial<Record<PetState, number>> = {};
    for (const key of Object.keys(weights) as PetState[]) {
      if (STATE_DEFS[key].implemented) candidates[key] = weights[key] ?? 0;
    }
    this.enter(pickWeighted(this.rng, candidates) ?? "IDLE", false);
  }

  private enter(next: PetState, external: boolean): void {
    const from = this.state;
    const def = STATE_DEFS[next];
    this.state = next;
    this.stateTime = 0;
    this.z = 0;

    if (next === "WALK" || next === "RUN") {
      this.dir = this.pickDirection();
      this.facing = this.dir === 1 ? "east" : "west";
    } else if (next === "JUMP") {
      this.dir = this.facing === "east" ? 1 : -1;
    }

    this.view = def.view === "front" ? "south" : this.facing;
    this.clip = def.clip;

    const resolved = this.species.clips.get(this.clip)?.get(this.view);
    if (!resolved) throw new Error(`Pet ${this.id}: la especie no tiene ${this.clip}/${this.view}`);
    // Desfasamos el inicio para que mascotas que entran a la vez no animen sincronizadas.
    const startAt = external ? 0 : range(this.rng, 0, resolved.frames.length / resolved.def.fps);
    this.animator.play(resolved.frames.length, resolved.def.fps, resolved.def.loop, startAt);

    this.stateDuration =
      next === "JUMP"
        ? this.behavior.jump.duration
        : (() => {
            const [min, max] = this.behavior.durations[next as TimedState];
            return range(this.rng, min, max);
          })();

    if (from !== next || external) this.onStateChange?.(this, from, next);
  }

  /** Elige hacia dónde caminar: prefiere el lado con más espacio, con algo de azar. */
  private pickDirection(): -1 | 1 {
    const left = this.x - this.stage.minX;
    const right = this.stage.maxX - this.x;
    if (left < 12) return 1;
    if (right < 12) return -1;
    return this.rng.next() < right / (left + right) ? 1 : -1;
  }
}
