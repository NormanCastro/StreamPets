export { PetEngine } from "./engine.js";
export type { EngineOptions, AddPetInit, EngineStats } from "./engine.js";

export { Pet, MAX_DT } from "./pet/pet.js";
export type { PetInit } from "./pet/pet.js";
export { STATE_DEFS, DEFAULT_BEHAVIOR, mergeBehavior } from "./pet/state.js";
export type { PetState, Facing, StateDef, BehaviorConfig, TimedState } from "./pet/state.js";

export { Animator } from "./anim/animator.js";

export { parsePixelLabSheet, SheetParseError, DIRECTIONS } from "./assets/pixellab.js";
export type { ParsedSheet, FrameRect, Direction } from "./assets/pixellab.js";
export { loadSpecies, resolveClips, SpeciesError, CLIP_NAMES, VIEWS, REQUIRED_VIEWS } from "./assets/species.js";
export type { SpeciesDef, LoadedSpecies, ClipName, ClipDef, View, ResolvedClip } from "./assets/species.js";

export { Stage, DEFAULT_STAGE } from "./world/stage.js";
export type { StageConfig } from "./world/stage.js";
export { findNearbyPairs } from "./world/proximity.js";
export type { Positioned } from "./world/proximity.js";

export { createRng, mathRng, range, pickWeighted } from "./core/rng.js";
export type { Rng } from "./core/rng.js";

export type { DebugFlags } from "./render/renderer.js";
