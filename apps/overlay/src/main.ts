import { PetEngine, loadSpecies } from "@streampets/engine";
import type { LoadedSpecies } from "@streampets/engine";
import { LIMITS, ServerMessageSchema, SpeciesIndexSchema } from "@streampets/shared";
import type { PetView } from "@streampets/shared";

/** Sin mensajes durante este tiempo (el servidor manda latido cada 15 s) = conexión muerta. */
const STALE_MS = 45_000;
const BACKOFF_MIN = 1_000;
const BACKOFF_MAX = 30_000;
/** Código con el que el servidor cierra cuando el token es inválido o fue revocado. */
const CLOSE_BAD_TOKEN = 4001;

const params = new URLSearchParams(location.search);

/** El token va en la ruta (/overlay/pets/:token); ?token= solo se admite para pruebas en desarrollo. */
function readToken(): string | undefined {
  const m = /\/pets\/([^/?#]+)/.exec(location.pathname);
  return m?.[1] ?? params.get("token") ?? undefined;
}

function autoScale(): number {
  const forced = Number(params.get("scale"));
  if (Number.isInteger(forced) && forced >= 1 && forced <= 8) return forced;
  // La escena mide ~360 px de alto lógicos: 1080p -> x3, 1440p -> x4, 720p -> x2.
  return Math.min(6, Math.max(1, Math.round(window.innerHeight / 360)));
}

function numParam(name: string, fallback: number, min: number, max: number): number {
  const v = Number(params.get(name));
  return params.has(name) && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

async function main(): Promise<void> {
  const token = readToken();
  if (!token) {
    console.error("[streampets] falta el token en la URL del overlay");
    return;
  }

  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  const engine = new PetEngine({
    canvas,
    renderScale: autoScale(),
    maxFps: numParam("fps", 30, 5, 60),
    proximityRadius: 26,
    // El tope real lo aplica el servidor (ajuste del dashboard); aquí solo un límite de seguridad.
    maxPets: LIMITS.maxPetsCap,
    showNames: params.get("names") !== "0",
  });
  window.addEventListener("resize", () => engine.setScale(autoScale()));
  engine.start();
  (window as unknown as { __overlay: unknown }).__overlay = { engine };

  // ── Catálogo de especies ──
  let catalog = new Map<string, string>();
  async function refreshCatalog(): Promise<void> {
    const res = await fetch("/api/species", { cache: "no-store" });
    if (!res.ok) throw new Error(`catálogo: HTTP ${res.status}`);
    const index = SpeciesIndexSchema.parse(await res.json());
    catalog = new Map(index.species.map((s) => [s.id, s.url]));
  }

  async function speciesFor(id: string): Promise<LoadedSpecies | undefined> {
    if (!catalog.has(id)) await refreshCatalog().catch(() => undefined);
    const url = catalog.get(id);
    if (!url) return undefined;
    try {
      return await loadSpecies(url);
    } catch (err) {
      console.warn(`[streampets] no se pudo cargar la especie ${id}`, err);
      return undefined;
    }
  }

  // ── Estado deseado vs. estado en pantalla ──
  // Los eventos llegan en orden, pero cargar una especie es asíncrono: se guarda lo que DEBE
  // haber en pantalla y se reconcilia, así un "leave" nunca queda anulado por un "appear" lento.
  const desired = new Map<string, PetView>();
  const shown = new Map<string, { speciesId: string; name: string }>();

  async function reconcile(viewerId: string): Promise<void> {
    const want = desired.get(viewerId);
    if (!want) {
      if (shown.delete(viewerId)) engine.removePet(viewerId);
      return;
    }
    const have = shown.get(viewerId);
    if (have && have.speciesId === want.speciesId && have.name === want.name) return;

    const species = await speciesFor(want.speciesId);
    const now = desired.get(viewerId);
    if (!now) return; // se fue mientras cargaba
    if (!species) return;
    if (now.speciesId !== want.speciesId || now.name !== want.name) return reconcile(viewerId); // cambió otra vez

    // Si ya estaba en pantalla se conserva su posición, carril y dirección.
    const old = engine.getPet(viewerId);
    const keep = old ? { x: old.x, lane: old.lane, facing: old.facing } : {};
    if (old) engine.removePet(viewerId);
    engine.addPet({ id: viewerId, name: want.name, species, ...keep });
    shown.set(viewerId, { speciesId: want.speciesId, name: want.name });
  }

  // ── Conexión WebSocket ──
  let backoff = BACKOFF_MIN;
  let stopped = false;

  function connect(): void {
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/overlay?token=${encodeURIComponent(token as string)}`);
    let stale: number | undefined;
    const armStale = (): void => {
      window.clearTimeout(stale);
      stale = window.setTimeout(() => ws.close(), STALE_MS);
    };

    ws.addEventListener("open", () => {
      backoff = BACKOFF_MIN;
      armStale();
    });
    ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
      armStale();
      let json: unknown;
      try {
        json = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const parsed = ServerMessageSchema.safeParse(json);
      if (!parsed.success) return;
      const msg = parsed.data;
      switch (msg.type) {
        case "snapshot": {
          desired.clear();
          for (const p of msg.pets) desired.set(p.viewerId, p);
          for (const id of [...shown.keys()]) void reconcile(id);
          for (const p of msg.pets) void reconcile(p.viewerId);
          break;
        }
        case "pet.appear":
        case "pet.update":
          desired.set(msg.pet.viewerId, msg.pet);
          void reconcile(msg.pet.viewerId);
          break;
        case "pet.leave":
          desired.delete(msg.viewerId);
          void reconcile(msg.viewerId);
          break;
        case "hb":
          break;
      }
    });
    ws.addEventListener("close", (ev) => {
      window.clearTimeout(stale);
      if (ev.code === CLOSE_BAD_TOKEN) {
        // Token inválido o revocado: reintentar no sirve. Se limpia la pantalla y se deja de insistir.
        console.error("[streampets] token inválido o revocado: genera un enlace nuevo en el dashboard");
        stopped = true;
        desired.clear();
        for (const id of [...shown.keys()]) void reconcile(id);
        return;
      }
      // Con la conexión caída no se sabe quién sigue activo: se mantienen las mascotas actuales
      // y el snapshot al reconectar corrige la diferencia.
      const wait = backoff + Math.random() * 500;
      backoff = Math.min(BACKOFF_MAX, backoff * 2);
      window.setTimeout(connect, wait);
    });
    ws.addEventListener("error", () => undefined); // el evento close que sigue gestiona el reintento
  }

  await refreshCatalog().catch((err: unknown) => console.warn("[streampets] catálogo no disponible aún", err));
  connect();
}

void main();
