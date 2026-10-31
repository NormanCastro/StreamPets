// Colores del panel: elegir, que se aplique de verdad, que quede guardado y que no rompa nada (incluida la CSP).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");

const PORT = 3115;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "e2e-admin-token-abcdefghijklmnop";
const out = process.argv[2] ?? "/tmp/themes";
const server = spawn("pnpm", ["--filter", "@streampets/server", "exec", "tsx", "src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: ADMIN, LOG_LEVEL: "warn", HOST: "127.0.0.1", PGLITE_DIR: mkdtempSync(join(tmpdir(), "sp-")) },
  stdio: ["ignore", "inherit", "inherit"],
});
let browser;
const cleanup = async () => { await browser?.close().catch(() => {}); server.kill(); };
const fail = async (m) => { console.error("FALLO:", m); await cleanup(); process.exit(1); };
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
  if (i > 150) await fail("el servidor no arrancó");
  await new Promise((r) => setTimeout(r, 200));
}

browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 520 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/status of (401|403|400)/.test(m.text())) errors.push(m.text()); });

const css = (v) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), v);
const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
const WANT = { morado: "#a855f7", verde: "#22c55e", azul: "#3b82f6", rojo: "#ef4444", dorado: "#f5b301", rosado: "#ec4899" };

await page.goto(`${BASE}/admin`);
await page.getByLabel("Clave de administración").waitFor();
if ((await theme()) !== "morado") await fail("el tema por defecto debería ser morado: " + (await theme()));
console.log("OK por defecto: morado");

// el selector también está en la pantalla de entrada
await page.getByRole("button", { name: "Cambiar color del panel" }).click();
await page.getByRole("button", { name: "Color verde" }).click();
if ((await theme()) !== "verde") await fail("no cambió a verde en la pantalla de entrada");
console.log("OK se puede elegir color desde la pantalla de entrada");

await page.getByLabel("Clave de administración").fill(ADMIN);
await page.getByRole("button", { name: "Entrar", exact: true }).click();
await page.getByRole("tab", { name: "Mascotas" }).waitFor();
if ((await theme()) !== "verde") await fail("el color no se mantuvo al entrar");

for (const [id, hex] of Object.entries(WANT)) {
  await page.getByRole("button", { name: "Cambiar color del panel" }).click();
  await page.getByRole("button", { name: `Color ${id}` }).click();
  if ((await theme()) !== id) await fail(`no se aplicó ${id}`);
  if ((await page.getByRole("button", { name: `Color ${id}` }).count()) !== 0) await fail("el menú de colores debería cerrarse al elegir");
  await page.getByRole("button", { name: "Cambiar color del panel" }).click();
  if ((await css("--accent")) !== hex) await fail(`${id}: --accent = ${await css("--accent")}`);
  const pressed = await page.getByRole("button", { name: `Color ${id}` }).getAttribute("aria-pressed");
  if (pressed !== "true") await fail(`${id}: no quedó marcado`);
  // el color realmente llega a la pantalla: pestaña activa con el degradado del acento
  const bg = await page.getByRole("tab", { name: "Mascotas" }).evaluate((el) => getComputedStyle(el).backgroundImage);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (!bg.includes(`${r}, ${g}, ${b}`)) await fail(`${id}: la pestaña activa no usa el color (${bg.slice(0, 90)})`);
  if (id === "dorado") await page.screenshot({ path: `${out}-menu.png` });
  await page.keyboard.press("Escape");
  if ((await page.getByRole("button", { name: `Color ${id}` }).count()) !== 0) await fail("Escape debería cerrar el menú");
  await page.screenshot({ path: `${out}-${id}.png` });
  console.log(`OK ${id}`);
}

// el encabezado no se desborda: «Salir» queda en la misma fila que las pestañas
const rowY = async (n, role) => (await page.getByRole(role, { name: n, exact: true }).first().boundingBox()).y;
const dy = Math.abs((await rowY("Salir", "button")) - (await rowY("Mascotas", "tab")));
if (dy > 40) await fail("«Salir» se cayó a otra fila (diferencia " + dy + "px)");
console.log("OK el encabezado cabe en una fila");

// guardado: recargar conserva el último elegido (rosado) y se aplica antes de pintar
await page.reload();
await page.getByRole("tab", { name: "Mascotas" }).waitFor();
if ((await theme()) !== "rosado") await fail("no recordó el color tras recargar: " + (await theme()));
console.log("OK el color queda guardado al recargar");

// salir y volver: sigue igual
await page.getByRole("button", { name: "Salir" }).click();
await page.getByLabel("Clave de administración").waitFor();
if ((await theme()) !== "rosado") await fail("el color se perdió al salir");
console.log("OK el color sobrevive a salir y entrar");

// un valor raro guardado no rompe nada
await page.evaluate(() => localStorage.setItem("streampets.theme", "<script>"));
await page.reload();
await page.getByLabel("Clave de administración").waitFor();
if ((await theme()) !== "morado") await fail("un valor inválido debería volver a morado: " + (await theme()));
console.log("OK un valor guardado inválido vuelve a morado");

if (errors.length) await fail("errores de consola: " + errors.join(" | "));
await cleanup();
console.log("E2E COLORES COMPLETO");
process.exit(0);
