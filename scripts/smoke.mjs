// Prueba de humo en un navegador real (Chromium + Playwright).
// Uso: arrancar el sandbox (pnpm dev o vite preview) y luego:
//   node scripts/smoke.mjs [url] [carpeta-de-capturas]
// Requiere tener `playwright` disponible (npm i -D playwright, o el preinstalado del entorno).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

// createRequire respeta NODE_PATH, así que sirve tanto con playwright local como global.
const { chromium } = createRequire(import.meta.url)("playwright");

const url = process.argv[2] ?? "http://localhost:4173/";
const outDir = process.argv[3] ?? "./smoke-out";
mkdirSync(outDir, { recursive: true });

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${msg}`);
  if (!ok) failures.push(msg);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__sandbox?.engine?.pets?.length > 0, null, { timeout: 10000 });

const snap = () =>
  page.evaluate(() => {
    const { engine } = window.__sandbox;
    return {
      world: [engine.stage.width, engine.stage.height],
      scale: engine.renderScale,
      pets: engine.pets.map((p) => ({ id: p.id, x: p.x, z: p.z, state: p.state, view: p.view, frame: p.animator.frameIndex })),
    };
  });

// Cuenta píxeles no transparentes del canvas (¿se dibujó algo?) y su caja.
const canvasInk = () =>
  page.evaluate(() => {
    const c = document.getElementById("stage");
    const ctx = c.getContext("2d");
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let ink = 0, minX = width, maxX = 0, minY = height, maxY = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) { ink++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    return { ink, width, height, box: [minX, minY, maxX, maxY], clientW: c.clientWidth, clientH: c.clientHeight };
  });

await page.waitForTimeout(1500);
const a = await snap();
const inkA = await canvasInk();
check(a.pets.length === 6, `arranca con 6 mascotas (hay ${a.pets.length})`);
check(inkA.ink > 2000, `el canvas tiene píxeles dibujados (${inkA.ink})`);
check(inkA.width === inkA.clientW && inkA.height === inkA.clientH, `búfer = tamaño CSS (${inkA.width}x${inkA.height})`);
check(inkA.box[3] <= inkA.height && inkA.box[3] > inkA.height * 0.8, `las mascotas están en la franja inferior (y máx ${inkA.box[3]} de ${inkA.height})`);
await page.screenshot({ path: `${outDir}/01-inicio.png` });

// Con el tiempo deben moverse: sumamos el recorrido muestreando cada 250 ms durante 10 s.
const travelled = new Map();
let prev = a.pets;
let b = a;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(250);
  b = await snap();
  for (const p of b.pets) {
    const before = prev.find((q) => q.id === p.id);
    if (before) travelled.set(p.id, (travelled.get(p.id) ?? 0) + Math.abs(p.x - before.x));
  }
  prev = b.pets;
}
const moved = [...travelled.values()].filter((d) => d > 5).length;
const states = new Set(b.pets.map((p) => p.state));
check(moved >= 3, `al menos 3 de 6 mascotas recorrieron más de 5 px en 10 s (${moved}; recorridos: ${[...travelled.values()].map((d) => d.toFixed(0)).join(", ")})`);
check(b.pets.every((p) => p.x >= 0 && p.x <= b.world[0]), "ninguna mascota está fuera del escenario");
console.log("     estados actuales:", [...states].join(", "));
await page.screenshot({ path: `${outDir}/02-caminando.png` });

// Comandos: !jump a todas -> deben estar en JUMP con z > 0 poco después.
await page.click('button[data-cmd="WALK"]');
await page.waitForTimeout(100);
await page.click('button[data-cmd="JUMP"]');
await page.waitForTimeout(220);
const j = await snap();
check(j.pets.every((p) => p.state === "JUMP"), "!jump pone a todas en JUMP");
check(j.pets.some((p) => p.z > 2), `en pleno salto hay altura (z máx ${Math.max(...j.pets.map((p) => p.z)).toFixed(1)})`);
await page.screenshot({ path: `${outDir}/03-salto.png` });

await page.waitForTimeout(900);
await page.click('button[data-cmd="SLEEP"]');
await page.waitForTimeout(400);
const s = await snap();
check(s.pets.every((p) => p.state === "SLEEP" && p.view === "south"), "!sleep duerme a todas, mirando de frente");
await page.screenshot({ path: `${outDir}/04-dormidas.png` });

await page.click('button[data-cmd="RUN"]');
await page.waitForTimeout(300);
await page.check("#dbg-bounds");
await page.check("#dbg-anchors");
await page.check("#dbg-prox");
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/05-correr-debug.png` });

// Añadir / quitar mascotas y límite de 20.
await page.fill("#pet-name", "NazhiTest");
await page.click("#add");
for (let i = 0; i < 5; i++) await page.click("#add5");
await page.waitForTimeout(300);
const many = await snap();
check(many.pets.length === 20, `el límite de 20 mascotas se respeta (hay ${many.pets.length})`);
await page.click("#clear");
// Las guías de depuración (límites, apoyos) también dibujan píxeles: se apagan para medir "vacío".
await page.uncheck("#dbg-bounds");
await page.uncheck("#dbg-anchors");
await page.uncheck("#dbg-prox");
await page.waitForTimeout(300);
check((await snap()).pets.length === 0, "vaciar elimina todas");
const inkEmpty = await canvasInk();
check(inkEmpty.ink === 0, `canvas vacío sin mascotas (${inkEmpty.ink} px)`);

// Rendimiento: 20 mascotas, tope libre, medir ms por cuadro.
await page.selectOption("#fps", "0");
await page.click("#add5"); await page.click("#add5"); await page.click("#add5"); await page.click("#add5");
await page.waitForTimeout(3500);
const perf = await page.evaluate(() => ({ ...window.__sandbox.engine.stats }));
console.log(`     rendimiento (headless, 20 mascotas, sin tope): ${perf.fps.toFixed(0)} fps, ${perf.frameMs.toFixed(3)} ms/cuadro`);
check(perf.frameMs < 4, `coste por cuadro < 4 ms (${perf.frameMs.toFixed(3)})`);

// Redimensionar la ventana: el escenario debe seguir al canvas.
await page.setViewportSize({ width: 900, height: 500 });
await page.waitForTimeout(400);
const r = await snap();
const inkR = await canvasInk();
check(inkR.width === inkR.clientW, `tras redimensionar, búfer = CSS (${inkR.width})`);
check(r.pets.every((p) => p.x <= r.world[0]), "tras redimensionar nadie queda fuera");

check(consoleErrors.length === 0, `sin errores de consola${consoleErrors.length ? ": " + consoleErrors.join(" | ") : ""}`);

await browser.close();
console.log(failures.length ? `\n${failures.length} comprobación(es) fallaron` : "\nTodo OK");
process.exit(failures.length ? 1 : 0);
