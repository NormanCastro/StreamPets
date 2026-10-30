// Prueba de punta a punta del dashboard: servidor real + dashboard + overlay en Chromium.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");

const PORT = 3112;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "e2e-admin-token-abcdefghijklmnop";
const shot = process.argv[2] ?? "/tmp/dashboard-e2e.png";

const server = spawn("pnpm", ["--filter", "@streampets/server", "exec", "tsx", "src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: ADMIN, LOG_LEVEL: "warn", PGLITE_DIR: mkdtempSync(join(tmpdir(), "sp-")), HOST: "127.0.0.1" },
  stdio: ["ignore", "inherit", "inherit"],
});
let browser;
const fail = async (m) => { console.error("FALLO:", m); await browser?.close().catch(() => {}); server.kill(); process.exit(1); };
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  return r.status === 204 ? null : r.json();
};
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
  if (i > 100) await fail("el servidor no arrancó");
  await new Promise((r) => setTimeout(r, 200));
}
const until = async (cond, label, ms = 6000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) await fail("timeout: " + label); await new Promise((r) => setTimeout(r, 50)); } };

for (const login of ["luna", "kiko", "nazhi", "mochi"]) await api("POST", "/api/admin/dev/chat", { login, isSubscriber: login === "luna" || login === "nazhi" });

browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/status of (401|400)/.test(m.text())) errors.push(m.text()); });

// 1) /admin redirige y pide clave; una clave mala se rechaza
await page.goto(`${BASE}/admin`);
await page.getByLabel("Clave de administración").fill("clave-mala");
await page.getByRole("button", { name: "Entrar" }).click();
await page.getByText("Clave incorrecta.").waitFor();
console.log("OK clave incorrecta rechazada");

// 2) clave buena
await page.getByLabel("Clave de administración").fill(ADMIN);
await page.getByRole("button", { name: "Entrar" }).click();
await page.getByText("4 espectadores").waitFor();
console.log("OK entra y lista 4 espectadores");

// 3) búsqueda
await page.getByLabel("Buscar espectador").fill("lun");
await page.getByText("1 espectador", { exact: true }).waitFor();
await page.getByLabel("Buscar espectador").fill("");
await page.getByText("4 espectadores").waitFor();
console.log("OK búsqueda");

// 3b) separar subs de viewers (se espera el resultado real, no un texto que ya podría estar en pantalla)
const subPills = () => page.getByText("SUB", { exact: true }).count();
await page.getByRole("button", { name: /^Subs/ }).click();
await until(async () => (await subPills()) === 2, "2 etiquetas SUB en el filtro Subs");
await page.getByRole("button", { name: /^Viewers/ }).click();
await until(async () => (await subPills()) === 0 && (await page.getByText("mochi").count()) > 0, "Viewers sin SUB");
await page.getByRole("button", { name: /^Todos/ }).click();
await page.getByText("4 espectadores").waitFor();
console.log("OK filtros Todos / Subs / Viewers");

// 4) crear overlay y abrirlo en otra pestaña
await page.getByRole("tab", { name: "Overlay para OBS" }).click();
await page.getByLabel("Nombre del nuevo overlay").fill("OBS");
await page.getByRole("button", { name: "Crear enlace" }).click();
const url = await page.getByLabel("Enlace del overlay").inputValue();
if (!/\/overlay\/pets\/spo_/.test(url)) await fail("enlace inesperado: " + url);
console.log("OK overlay creado");
const ov = await ctx.newPage();
await ov.goto(url);
await ov.waitForFunction(() => window.__overlay);
const count = () => ov.evaluate(() => window.__overlay.engine.pets.length);
await until(async () => (await count()) === 4, "4 mascotas en el overlay");

// 5) desactivar desde el dashboard retira la mascota del overlay
await page.getByRole("tab", { name: "Mascotas" }).click();
await page.getByLabel("Mascota activa de luna").uncheck();
await until(async () => (await count()) === 3, "luna retirada del overlay");
console.log("OK desactivar desde el panel la quita del overlay");
await page.getByLabel("Mascota activa de luna").check();
await page.getByLabel("Mascota activa de luna").waitFor();
await api("POST", "/api/admin/dev/chat", { login: "luna" });
await until(async () => (await count()) === 4, "luna vuelve");
console.log("OK reactivar");

// 6) ajustes: solo subs + guardar; el chat de un no-sub ya no recibe mascota
await page.getByRole("tab", { name: "Ajustes" }).click();
await page.getByLabel(/Solo suscriptores/).check();
await page.getByRole("button", { name: "Guardar cambios" }).click();
await page.getByText(/Guardado/).waitFor();
const r = await api("POST", "/api/admin/dev/chat", { login: "novato" });
if (r.outcome !== "ignored") await fail("subs-only no se aplicó: " + JSON.stringify(r));
console.log("OK ajustes aplicados al instante");
await page.getByLabel(/Cuentas ignoradas/).fill("bot_ok\nmal$login");
await page.getByRole("button", { name: "Guardar cambios" }).click();
await page.getByText(/login de Twitch inválido/).waitFor();
console.log("OK error de validación mostrado");

// 7) salir y volver a pedir clave
await page.getByRole("button", { name: "Salir" }).click();
await page.getByLabel("Clave de administración").waitFor();
await page.screenshot({ path: shot.replace(".png", "-login.png") });
await page.getByLabel("Clave de administración").fill(ADMIN);
await page.getByRole("button", { name: "Entrar" }).click();
await page.getByRole("tab", { name: "Mascotas" }).click();
await page.getByText("4 espectadores").waitFor();
await page.screenshot({ path: shot });
console.log("OK salir y volver a entrar");

if (errors.length) await fail("errores de consola: " + errors.join(" | "));
await browser.close();
server.kill();
console.log("E2E DASHBOARD COMPLETO");
process.exit(0);
