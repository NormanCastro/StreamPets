import type { ClipName } from "../assets/species.js";

/** Todos los estados previstos. PLAY e INTERACT quedan declarados pero sin implementar (ver `implemented`). */
export type PetState = "IDLE" | "WALK" | "RUN" | "SLEEP" | "JUMP" | "SIT" | "PLAY" | "INTERACT";

export type Facing = "east" | "west";

export interface StateDef {
  /** Prioridad para peticiones externas (comandos de chat, eventos). */
  readonly priority: number;
  /** Si es false, solo se puede interrumpir con un estado de prioridad estrictamente mayor. */
  readonly interruptible: boolean;
  readonly clip: ClipName;
  /** "side": mira hacia donde va (east/west). "front": mira al espectador (south). */
  readonly view: "side" | "front";
  readonly implemented: boolean;
}

export const STATE_DEFS: Readonly<Record<PetState, StateDef>> = {
  IDLE: { priority: 1, interruptible: true, clip: "idle", view: "side", implemented: true },
  SIT: { priority: 1, interruptible: true, clip: "idle", view: "front", implemented: true },
  SLEEP: { priority: 1, interruptible: true, clip: "idle", view: "front", implemented: true },
  WALK: { priority: 2, interruptible: true, clip: "walk", view: "side", implemented: true },
  RUN: { priority: 2, interruptible: true, clip: "run", view: "side", implemented: true },
  JUMP: { priority: 3, interruptible: false, clip: "idle", view: "side", implemented: true },
  PLAY: { priority: 3, interruptible: false, clip: "idle", view: "side", implemented: false },
  INTERACT: { priority: 4, interruptible: false, clip: "idle", view: "side", implemented: false },
};

export type TimedState = "IDLE" | "WALK" | "RUN" | "SLEEP" | "SIT";

export interface BehaviorConfig {
  /** Velocidades en píxeles de mundo por segundo. */
  walkSpeed: number;
  runSpeed: number;
  /** [mín, máx] en segundos que dura cada estado. */
  durations: Record<TimedState, [number, number]>;
  jump: { duration: number; height: number; forwardSpeed: number };
  /** Respiración (solo en IDLE/SIT/SLEEP): segundos por ciclo completo. */
  breathPeriod: number;
  sleepBreathPeriod: number;
  /** Pesos de transición autónoma: desde qué estado, hacia cuál. */
  weights: Partial<Record<PetState, Partial<Record<PetState, number>>>>;
}

export const DEFAULT_BEHAVIOR: BehaviorConfig = {
  walkSpeed: 20,
  runSpeed: 48,
  durations: {
    IDLE: [1.5, 4],
    WALK: [2.5, 6],
    RUN: [1, 2.5],
    SLEEP: [8, 20],
    SIT: [3, 8],
  },
  jump: { duration: 0.55, height: 10, forwardSpeed: 14 },
  breathPeriod: 1.4,
  sleepBreathPeriod: 2.6,
  weights: {
    IDLE: { WALK: 40, RUN: 8, SIT: 14, SLEEP: 8, JUMP: 6, IDLE: 24 },
    WALK: { IDLE: 55, WALK: 20, RUN: 10, SIT: 5, JUMP: 10 },
    RUN: { IDLE: 60, WALK: 35, JUMP: 5 },
    SLEEP: { IDLE: 80, SIT: 20 },
    SIT: { IDLE: 60, WALK: 25, SLEEP: 15 },
    JUMP: { IDLE: 50, WALK: 40, RUN: 10 },
  },
};

export function mergeBehavior(base: BehaviorConfig, patch: Partial<BehaviorConfig> | undefined): BehaviorConfig {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    durations: { ...base.durations, ...(patch.durations ?? {}) },
    jump: { ...base.jump, ...(patch.jump ?? {}) },
    weights: { ...base.weights, ...(patch.weights ?? {}) },
  };
}
