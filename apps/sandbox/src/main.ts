import { PetEngine, loadSpecies } from "@streampets/engine";
import type { LoadedSpecies, Pet, PetState } from "@streampets/engine";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Falta el elemento #${id}`);
  return el as T;
};

const NAMES = ["luna", "kiko", "nazhi", "mochi", "tomi", "sol", "pepa", "rayo", "nube", "canela", "bruno", "mora"];

const logEl = $("log");
function log(line: string): void {
  const time = new Date().toLocaleTimeString("es-CL", { hour12: false });
  logEl.textContent = `${time} ${line}\n${logEl.textContent ?? ""}`.split("\n").slice(0, 40).join("\n");
}

function showError(message: string): void {
  const box = $("error");
  box.textContent = message;
  box.style.display = "block";
}

async function main(): Promise<void> {
  let species: LoadedSpecies;
  try {
    species = await loadSpecies("/assets/species/shiba/species.json");
  } catch (err) {
    showError(`No se pudo cargar la especie: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  const canvas = $<HTMLCanvasElement>("stage");
  // ?seed=7 hace el comportamiento reproducible (útil para depurar y para las pruebas).
  const seedParam = new URLSearchParams(location.search).get("seed");
  const engine = new PetEngine({
    canvas,
    renderScale: 3,
    maxFps: 30,
    proximityRadius: 26,
    maxPets: 20,
    ...(seedParam !== null && Number.isFinite(Number(seedParam)) ? { seed: Number(seedParam) } : {}),
  });
  // Gancho para pruebas automáticas (scripts/smoke.mjs).
  (window as unknown as { __sandbox: unknown }).__sandbox = { engine };

  let counter = 0;
  const speeds = { walk: 20, run: 48 };

  const refreshTargets = (): void => {
    const select = $<HTMLSelectElement>("target");
    const current = select.value;
    select.replaceChildren(new Option("Todas", "*"));
    for (const pet of engine.pets) select.add(new Option(pet.name, pet.id));
    select.value = [...select.options].some((o) => o.value === current) ? current : "*";
  };

  const addPet = (name?: string): Pet => {
    counter++;
    const label = (name?.trim() || `${NAMES[(counter - 1) % NAMES.length] ?? "pet"}${counter > NAMES.length ? counter : ""}`).slice(0, 18);
    const pet = engine.addPet({
      id: `pet-${counter}`,
      name: label,
      species,
      behavior: { walkSpeed: speeds.walk, runSpeed: speeds.run },
    });
    pet.onStateChange = (p, from, to) => log(`${p.name}: ${from} → ${to}`);
    refreshTargets();
    return pet;
  };

  for (let i = 0; i < 6; i++) addPet();
  engine.start();

  $("add").addEventListener("click", () => {
    const input = $<HTMLInputElement>("pet-name");
    addPet(input.value);
    input.value = "";
  });
  $<HTMLInputElement>("pet-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("add").click();
  });
  $("add5").addEventListener("click", () => {
    for (let i = 0; i < 5; i++) addPet();
  });
  $("remove-one").addEventListener("click", () => {
    const first = engine.pets[0];
    if (first) engine.removePet(first.id);
    refreshTargets();
  });
  $("clear").addEventListener("click", () => {
    engine.clear();
    refreshTargets();
  });

  document.querySelectorAll<HTMLButtonElement>("button[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cmd = btn.dataset["cmd"] as PetState;
      const target = $<HTMLSelectElement>("target").value;
      const pets = target === "*" ? [...engine.pets] : [engine.getPet(target)].filter((p): p is Pet => p !== undefined);
      let accepted = 0;
      for (const pet of pets) if (pet.requestState(cmd)) accepted++;
      log(`!${cmd.toLowerCase()} → ${accepted}/${pets.length} aceptaron`);
    });
  });

  const bindRange = (id: string, outId: string, apply: (v: number) => void): void => {
    const input = $<HTMLInputElement>(id);
    const out = $(outId);
    const update = (): void => {
      const v = Number(input.value);
      out.textContent = String(v);
      apply(v);
    };
    input.addEventListener("input", update);
    update();
  };
  bindRange("scale", "scale-out", (v) => engine.setScale(v));
  bindRange("walk", "walk-out", (v) => {
    speeds.walk = v;
    for (const p of engine.pets) p.behavior.walkSpeed = v;
  });
  bindRange("run", "run-out", (v) => {
    speeds.run = v;
    for (const p of engine.pets) p.behavior.runSpeed = v;
  });

  $<HTMLSelectElement>("fps").addEventListener("change", (e) => engine.setMaxFps(Number((e.target as HTMLSelectElement).value)));
  $<HTMLSelectElement>("bg").addEventListener("change", (e) => {
    $("stage-wrap").className = `bg-${(e.target as HTMLSelectElement).value}`;
  });

  const bindFlag = (id: string, apply: (on: boolean) => void): void => {
    const input = $<HTMLInputElement>(id);
    input.addEventListener("change", () => apply(input.checked));
    apply(input.checked);
  };
  bindFlag("dbg-names", (on) => (engine.showNames = on));
  bindFlag("dbg-bounds", (on) => (engine.debug.bounds = on));
  bindFlag("dbg-anchors", (on) => (engine.debug.anchors = on));
  bindFlag("dbg-prox", (on) => (engine.debug.proximity = on));

  const statsEl = $("stats");
  setInterval(() => {
    const s = engine.stats;
    statsEl.textContent =
      `${s.fps.toFixed(0)} fps · ${s.frameMs.toFixed(2)} ms/cuadro · ${engine.pets.length} mascotas · ` +
      `mundo ${engine.stage.width}×${engine.stage.height} @${engine.renderScale}×`;
  }, 500);

  window.addEventListener("beforeunload", () => engine.dispose());
  log("listo");
}

main().catch((err: unknown) => {
  console.error(err);
  showError(err instanceof Error ? err.message : String(err));
});
