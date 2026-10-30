import { describe, expect, it } from "vitest";
import { createRng } from "../src/core/rng.js";
import { Pet } from "../src/pet/pet.js";
import type { PetInit } from "../src/pet/pet.js";
import { DEFAULT_BEHAVIOR, STATE_DEFS } from "../src/pet/state.js";
import type { PetState } from "../src/pet/state.js";
import { findNearbyPairs } from "../src/world/proximity.js";
import { Stage } from "../src/world/stage.js";
import { loadShibaFixture } from "./helpers.js";

const species = loadShibaFixture();

function makePet(stage: Stage, seed: number, over: Partial<PetInit> = {}): Pet {
  return new Pet({ id: `p${seed}`, name: `pet${seed}`, species, x: 300, lane: 3, ...over }, stage, createRng(seed));
}

/** Duraciones largas: así el estado no termina solo en mitad de una medición. */
const LONG_STATES = {
  durations: {
    IDLE: [60, 60],
    WALK: [60, 60],
    RUN: [60, 60],
    SLEEP: [60, 60],
    SIT: [60, 60],
  },
} satisfies Partial<PetInit["behavior"] & object>;

/** Simula `seconds` con pasos de `dt` fijos. */
function run(pet: Pet, seconds: number, dt: number): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) pet.update(dt);
}

describe("tabla de comportamiento", () => {
  it("las transiciones autónomas solo apuntan a estados implementados", () => {
    for (const [from, targets] of Object.entries(DEFAULT_BEHAVIOR.weights)) {
      for (const to of Object.keys(targets ?? {}) as PetState[]) {
        expect(STATE_DEFS[to].implemented, `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it("PLAY e INTERACT están declarados pero sin implementar", () => {
    expect(STATE_DEFS.PLAY.implemented).toBe(false);
    expect(STATE_DEFS.INTERACT.implemented).toBe(false);
  });
});

describe("peticiones externas (comandos)", () => {
  const stage = new Stage({ width: 640, height: 360 });

  it("rechaza estados sin implementar", () => {
    const pet = makePet(stage, 1);
    expect(pet.requestState("PLAY")).toBe(false);
    expect(pet.requestState("INTERACT")).toBe(false);
    expect(pet.state).toBe("IDLE");
  });

  it("un comando interrumpe estados interrumpibles (dormir -> caminar)", () => {
    const pet = makePet(stage, 2);
    expect(pet.requestState("SLEEP")).toBe(true);
    expect(pet.view).toBe("south");
    expect(pet.requestState("WALK")).toBe(true);
    expect(pet.state).toBe("WALK");
  });

  it("el salto no se puede interrumpir con prioridad igual o menor, y termina solo", () => {
    const pet = makePet(stage, 3);
    expect(pet.requestState("JUMP")).toBe(true);
    expect(pet.requestState("SLEEP")).toBe(false);
    expect(pet.requestState("RUN")).toBe(false);
    expect(pet.state).toBe("JUMP");
    run(pet, DEFAULT_BEHAVIOR.jump.duration + 0.1, 1 / 60);
    expect(pet.state).not.toBe("JUMP");
    expect(pet.z).toBe(0);
    expect(pet.requestState("SLEEP")).toBe(true);
  });

  it("el salto describe un arco que no supera la altura configurada y vuelve a 0", () => {
    const pet = makePet(stage, 4);
    pet.requestState("JUMP");
    let peak = 0;
    for (let i = 0; i < 200 && pet.state === "JUMP"; i++) {
      pet.update(1 / 120);
      peak = Math.max(peak, pet.z);
      expect(pet.z).toBeGreaterThanOrEqual(0);
    }
    expect(peak).toBeGreaterThan(DEFAULT_BEHAVIOR.jump.height * 0.9);
    expect(peak).toBeLessThanOrEqual(DEFAULT_BEHAVIOR.jump.height + 1e-6);
  });

  it("notifica los cambios de estado", () => {
    const pet = makePet(stage, 5);
    const seen: string[] = [];
    pet.onStateChange = (_p, from, to) => seen.push(`${from}>${to}`);
    pet.requestState("RUN");
    pet.requestState("SIT");
    expect(seen).toEqual(["IDLE>RUN", "RUN>SIT"]);
  });
});

describe("movimiento", () => {
  it("caminar y correr mueven al pie de la letra la velocidad configurada", () => {
    const stage = new Stage({ width: 2000, height: 360 });
    for (const [state, speed] of [
      ["WALK", DEFAULT_BEHAVIOR.walkSpeed],
      ["RUN", DEFAULT_BEHAVIOR.runSpeed],
    ] as const) {
      const pet = makePet(stage, 6, { x: 1000, behavior: LONG_STATES });
      pet.requestState(state);
      const x0 = pet.x;
      run(pet, 1, 1 / 60);
      expect(Math.abs(pet.x - x0)).toBeCloseTo(speed, 0);
    }
  });

  it("la vista (east/west) siempre coincide con la dirección en la que camina", () => {
    const stage = new Stage({ width: 300, height: 360 });
    const pet = makePet(stage, 7, { x: 150 });
    pet.requestState("WALK");
    for (let i = 0; i < 2000; i++) {
      pet.update(1 / 60);
      if (pet.state === "WALK" || pet.state === "RUN") {
        expect(pet.view).toBe(pet.dir === 1 ? "east" : "west");
        expect(pet.facing).toBe(pet.view);
      }
    }
  });

  it("la distancia recorrida no depende de los FPS (30 vs 144 vs 240)", () => {
    const stage = new Stage({ width: 2000, height: 360 });
    const distances = [30, 144, 240].map((fps) => {
      const pet = makePet(stage, 8, { x: 1000, behavior: LONG_STATES });
      pet.requestState("RUN");
      const x0 = pet.x;
      run(pet, 2, 1 / fps);
      return Math.abs(pet.x - x0);
    });
    for (const d of distances) expect(d).toBeCloseTo(DEFAULT_BEHAVIOR.runSpeed * 2, 0);
  });

  it("rebota en los bordes: gira en vez de salirse del escenario", () => {
    const stage = new Stage({ width: 200, height: 360, margin: 20 });
    const pet = makePet(stage, 9, { x: 30, facing: "west" });
    pet.requestState("RUN");
    expect(pet.dir).toBe(1); // cerca del borde izquierdo debe elegir ir a la derecha
    let sawTurn = false;
    let prev = pet.dir;
    for (let i = 0; i < 600; i++) {
      pet.update(1 / 60);
      if (pet.state !== "RUN") pet.requestState("RUN");
      expect(pet.x).toBeGreaterThanOrEqual(stage.minX);
      expect(pet.x).toBeLessThanOrEqual(stage.maxX);
      if (pet.dir !== prev) sawTurn = true;
      prev = pet.dir;
    }
    expect(sawTurn).toBe(true);
  });

  it("si el escenario se achica, la mascota queda dentro de los nuevos límites", () => {
    const stage = new Stage({ width: 800, height: 360 });
    const pet = makePet(stage, 10, { x: 700 });
    stage.setSize(300, 360);
    pet.update(1 / 60);
    expect(pet.x).toBeLessThanOrEqual(stage.maxX);
  });
});

describe("comportamiento autónomo (simulación larga con semilla)", () => {
  it("20 mascotas durante 10 minutos: siempre dentro de límites, sin estados prohibidos, y pasan por todos los estados", () => {
    const stage = new Stage({ width: 640, height: 360 });
    const visited = new Set<PetState>();
    const pets = Array.from({ length: 20 }, (_, i) =>
      makePet(stage, 100 + i, { x: 40 + i * 28, lane: i % 10 }),
    );
    const dtRng = createRng(999);
    const laneBefore = pets.map((p) => p.lane);
    let outOfBounds = 0;
    let negativeZ = 0;
    let notFinite = 0;
    let forbidden = 0;

    for (let t = 0; t < 600; ) {
      const dt = 1 / 240 + dtRng.next() * (1 / 20 - 1 / 240); // FPS irregulares entre 20 y 240
      for (const pet of pets) {
        pet.update(dt);
        visited.add(pet.state);
        if (!STATE_DEFS[pet.state].implemented) forbidden++;
        if (pet.x < stage.minX - 1e-9 || pet.x > stage.maxX + 1e-9) outOfBounds++;
        if (pet.z < 0) negativeZ++;
        if (!Number.isFinite(pet.x)) notFinite++;
      }
      t += dt;
    }

    expect({ outOfBounds, negativeZ, notFinite, forbidden }).toEqual({ outOfBounds: 0, negativeZ: 0, notFinite: 0, forbidden: 0 });
    expect([...visited].sort()).toEqual(["IDLE", "JUMP", "RUN", "SIT", "SLEEP", "WALK"]);
    expect(pets.map((p) => p.lane)).toEqual(laneBefore);
  });

  it("mismas semillas -> mismo recorrido (determinista)", () => {
    const stage = new Stage({ width: 640, height: 360 });
    const trace = (): number[] => {
      const pet = makePet(stage, 42);
      const out: number[] = [];
      for (let i = 0; i < 3000; i++) {
        pet.update(1 / 60);
        if (i % 300 === 0) out.push(Math.round(pet.x * 1000));
      }
      return out;
    };
    expect(trace()).toEqual(trace());
  });

  it("currentFrame devuelve siempre un frame válido de la hoja", () => {
    const stage = new Stage({ width: 640, height: 360 });
    const pet = makePet(stage, 11);
    for (let i = 0; i < 3000; i++) {
      pet.update(1 / 60);
      const f = pet.currentFrame();
      expect(f.x % 48).toBe(0);
      expect(f.y % 48).toBe(0);
      expect(f.x + 48).toBeLessThanOrEqual(species.sheet.sheetW);
      expect(f.y + 48).toBeLessThanOrEqual(species.sheet.sheetH);
    }
  });
});

describe("escenario y proximidad", () => {
  it("groundY coloca más al fondo las lanes altas y respeta la franja", () => {
    const stage = new Stage({ width: 640, height: 360, groundPad: 4, laneBand: 10 });
    expect(stage.groundY(0)).toBe(356);
    expect(stage.groundY(10)).toBe(346);
    expect(stage.groundY(999)).toBe(346);
    expect(stage.groundY(-5)).toBe(356);
  });

  it("escenarios diminutos no invierten los límites", () => {
    const stage = new Stage({ width: 30, height: 100, margin: 20 });
    expect(stage.minX).toBeLessThanOrEqual(stage.maxX);
  });

  it("findNearbyPairs detecta solo pares dentro del radio y considera la profundidad", () => {
    const a = { id: "a", x: 100, lane: 0 };
    const b = { id: "b", x: 110, lane: 0 };
    const c = { id: "c", x: 200, lane: 0 };
    const d = { id: "d", x: 100, lane: 10 };
    const ids = (radius: number): string[] =>
      findNearbyPairs([a, b, c, d], radius)
        .map(([p, q]) => `${p.id}${q.id}`)
        .sort();
    // b-d está a sqrt(10² + 10²) ≈ 14.14: entra con radio 15 pero no con radio 12.
    expect(ids(15)).toEqual(["ab", "ad", "bd"]);
    expect(ids(12)).toEqual(["ab", "ad"]);
    expect(ids(5)).toEqual([]);
    expect(findNearbyPairs([a, b], 0)).toEqual([]);
  });
});
