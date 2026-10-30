// Prueba de punta a punta: servidor real + overlay compilado + chat simulado en Chromium.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "e2e-admin-token-abcdefghijklmnop";
const out = process.argv[2] ?? "/tmp/overlay-e2e.png";

const server = spawn("pnpm", ["--filter", "@streampets/server", "exec", "tsx", "src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: ADMIN, LOG_LEVEL: "warn", PGLITE_DIR: mkdtempSync(join(tmpdir(), "sp-")), HOST: "127.0.0.1" },
  stdio: ["ignore", "inherit", "inherit"],
});
const fail = (m) => { console.error("FALLO:", m); server.kill(); process.exit(1); };
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, json: r.status === 204 ? null : await r.json() };
};
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
  if (i > 100) fail("el servidor no arrancó");
  await new Promise((r) => setTimeout(r, 200));
}

const { json: overlay } = await api("POST", "/api/admin/overlays", { name: "e2e" });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 360 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (process.env.DEBUG_E2E) console.log("[page]", m.type(), m.text()); if (m.type() === "error") errors.push(m.text()); });
await page.goto(BASE + overlay.path);
await page.waitForFunction(() => window.__overlay);
const count = () => page.evaluate(() => window.__overlay.engine.pets.length);
const names = () => page.evaluate(() => window.__overlay.engine.pets.map((p) => p.name).sort());
const until = async (cond, label, ms = 5000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) fail("timeout: " + label); await new Promise((r) => setTimeout(r, 50)); } };

// 1) Gente nueva escribe -> aparecen
const people = ["luna", "kiko", "nazhi", "mochi"];
for (const login of people) await api("POST", "/api/admin/dev/chat", { login });
await until(async () => (await count()) === 4, "4 mascotas");
console.log("OK aparecen:", await names());

// 2) Repetir mensajes no duplica
for (const login of people) await api("POST", "/api/admin/dev/chat", { login });
await new Promise((r) => setTimeout(r, 400));
if ((await count()) !== 4) fail("se duplicaron mascotas");
console.log("OK sin duplicados");

// 3) Un bot no aparece
await api("POST", "/api/admin/dev/chat", { login: "nightbot" });
await new Promise((r) => setTimeout(r, 300));
if ((await count()) !== 4) fail("apareció un bot");
console.log("OK bot ignorado");

// 4) Mover para ver caminar y captura
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: out });

// 5) Cambiar especie / desactivar desde el "dashboard"
const { json: list } = await api("GET", "/api/admin/viewers?q=luna");
const luna = list.items[0];
const r1 = await api("PATCH", `/api/admin/viewers/${luna.id}/pet`, { enabled: false });
if (r1.status !== 200) fail("PATCH enabled");
await until(async () => (await count()) === 3, "luna retirada");
console.log("OK desactivar la retira");
await api("PATCH", `/api/admin/viewers/${luna.id}/pet`, { enabled: true });
await api("POST", "/api/admin/dev/chat", { login: "luna" });
await until(async () => (await count()) === 4, "luna vuelve");
console.log("OK reactivar y volver");

// 6) Revocar el token vacía la pantalla
console.log("DELETE ->", (await api("DELETE", `/api/admin/overlays/${overlay.id}`)).status, "overlay.id=", overlay.id);
await until(async () => (await count()) === 0, "pantalla vacía tras revocar");
console.log("OK revocar limpia el overlay");

// 7) Reconexión: nuevo token, servidor sigue con las mascotas
const { json: o2 } = await api("POST", "/api/admin/overlays", { name: "e2e2" });
const page2 = await browser.newPage({ viewport: { width: 1280, height: 360 } });
await page2.goto(BASE + o2.path);
await page2.waitForFunction(() => window.__overlay);
await until(async () => (await page2.evaluate(() => window.__overlay.engine.pets.length)) === 4, "snapshot inicial en overlay nuevo");
console.log("OK un overlay nuevo recibe el estado actual");

const real = errors.filter((e) => !/4001|token inválido|revocado|WebSocket connection/.test(e));
if (real.length) fail("errores de consola: " + real.join(" | "));
await browser.close();
server.kill();
console.log("E2E COMPLETO. Captura:", out);
process.exit(0);
