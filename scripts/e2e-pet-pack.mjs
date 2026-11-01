// Paquete de imágenes sueltas (.zip) de punta a punta: se sube, se previsualiza ANTES de enviar,
// se envía, se aprueba, se ve en el overlay y el ataque (gancho para PvP) funciona.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const req = createRequire(import.meta.url);
const { chromium } = req("playwright");
const serverReq = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { zipSync } = serverReq("fflate");
const { PNG } = serverReq("pngjs");

const PORT = 3115;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "e2e-admin-token-abcdefghijklmnop";
const shot = process.argv[2] ?? "/tmp/pet-pack-e2e.png";
const MEDUSA = process.env.PACK_DIR ?? "/tmp/medusa-x/medusa";

const server = spawn("pnpm", ["--filter", "@streampets/server", "exec", "tsx", "src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: ADMIN, LOG_LEVEL: "warn", PGLITE_DIR: mkdtempSync(join(tmpdir(), "sp-")), HOST: "127.0.0.1" },
  stdio: ["ignore", "inherit", "inherit"],
});
let browser;
const fail = async (m) => { console.error("FALLO:", m); await browser?.close().catch(() => {}); server.kill(); process.exit(1); };
const adminApi = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  return r.status === 204 ? null : r.json();
};
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
  if (i > 100) await fail("el servidor no arrancó");
  await new Promise((r) => setTimeout(r, 200));
}
const until = async (cond, label, ms = 8000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) await fail("timeout: " + label); await new Promise((r) => setTimeout(r, 50)); } };

// Paquete: el real si existe; si no, uno sintético de 128x128.
function buildZip() {
  const files = {};
  if (existsSync(MEDUSA)) {
    for (const f of readdirSync(MEDUSA)) files[f] = readFileSync(join(MEDUSA, f));
    return { zip: Buffer.from(zipSync(files)), real: true };
  }
  const frame = (shift) => {
    const png = new PNG({ width: 128, height: 128 });
    for (let y = 40; y < 110; y++) for (let x = 30 + shift; x < 90 + shift; x++) { const i = (y * 128 + x) * 4; png.data[i] = 60; png.data[i + 1] = 180; png.data[i + 2] = 90; png.data[i + 3] = 255; }
    return PNG.sync.write(png);
  };
  for (let i = 1; i <= 3; i++) files[`Idle${i}.png`] = frame(i);
  for (let i = 1; i <= 4; i++) files[`Walk${i}.png`] = frame(i * 3);
  for (let i = 1; i <= 6; i++) files[`Attack${i}.png`] = frame(i * 4);
  files["Hurt1.png"] = frame(0);
  return { zip: Buffer.from(zipSync(files)), real: false };
}
const { zip, real } = buildZip();
console.log(`paquete: ${real ? "medusa real" : "sintético"} (${zip.length} bytes)`);

await adminApi("POST", "/api/admin/channels", { login: "amiga" });
const KEY = (await adminApi("POST", "/api/admin/channels/amiga/key")).key;

browser = await chromium.launch();
const errors = [];
const watch = (p) => { p.on("pageerror", (e) => errors.push(String(e))); p.on("console", (m) => { if (m.type() === "error" && !/status of (401|400|404)/.test(m.text())) errors.push(m.text()); }); };
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const amiga = await ctx.newPage(); watch(amiga);
await amiga.goto(`${BASE}/admin`);
await amiga.getByRole("button", { name: "Entrar con clave" }).click();
await amiga.getByLabel("Clave de acceso").fill(KEY);
await amiga.getByRole("button", { name: "Entrar", exact: true }).click();
await amiga.getByRole("tab", { name: "Mis pets" }).click();
await amiga.getByText("Cupos usados:").waitFor();

// 1) un archivo que no es zip se rechaza al instante
await amiga.getByLabel(/Archivo \.zip/).setInputFiles({ name: "x.zip", mimeType: "application/zip", buffer: Buffer.from("esto no es un zip") });
await amiga.getByText(/no es un \.zip/).waitFor();
console.log("OK un archivo que no es zip se rechaza");

// 2) un zip sin Walk explica qué falta
const bad = Buffer.from(zipSync({ "Idle1.png": new Uint8Array(0) }));
await amiga.getByLabel(/Archivo \.zip/).setInputFiles({ name: "malo.zip", mimeType: "application/zip", buffer: bad });
await amiga.getByRole("alert").filter({ hasText: /./ }).first().waitFor();
if ((await amiga.getByRole("button", { name: "Enviar a revisión" }).isEnabled())) await fail("no debería dejar enviar un zip malo");
console.log("OK un zip malo muestra error y no deja enviar");

// 3) zip bueno: aparece la vista previa y TODAVÍA no se envió nada
await amiga.getByLabel(/Archivo \.zip/).setInputFiles({ name: "medusa.zip", mimeType: "application/zip", buffer: zip });
await amiga.getByText("Así se verá en tu stream").waitFor();
const canvas = amiga.locator("canvas.packplayer");
await canvas.waitFor();
const px = async () => canvas.evaluate((c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 3]) | 0; return h; });
const h1 = await px();
await until(async () => (await px()) !== h1, "la vista previa se anima");
console.log("OK vista previa animada antes de enviar");
if ((await adminApi("GET", "/api/admin/moderation/pets?status=all")).items.length !== 0) await fail("se envió algo antes de confirmar");
if ((await amiga.getByLabel("Nombre de la mascota").inputValue()) === "") await fail("el nombre no se rellenó con el del archivo");
await amiga.getByRole("button", { name: "Ataque" }).click();
await amiga.getByRole("button", { name: "Ataque" }).waitFor();
await amiga.waitForTimeout(300);
const hAtk = await px();
await amiga.getByRole("button", { name: "Quieta" }).click();
await amiga.waitForTimeout(300);
if ((await px()) === hAtk && real) console.log("(aviso) mismo cuadro en Quieta y Ataque");
await amiga.getByLabel(/mira hacia la izquierda/).check();
await amiga.getByText("Así se verá en tu stream").waitFor();
await amiga.getByLabel(/mira hacia la izquierda/).uncheck();
await amiga.getByRole("button", { name: "Ataque" }).click();
await amiga.screenshot({ path: shot.replace(".png", "-preview.png") });
console.log("OK botones de animación y de dirección");

// 4) enviar
await amiga.getByLabel("Nombre de la mascota").fill("Medusa");
await amiga.getByRole("button", { name: "Enviar a revisión" }).click();
await amiga.getByText("En revisión", { exact: true }).waitFor();
console.log("OK enviada: queda en revisión");

// 5) moderación: el administrador ve la pet con su vista previa y la aprueba
const adminCtx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const adm = await adminCtx.newPage(); watch(adm);
await adm.goto(`${BASE}/admin`);
await adm.getByRole("button", { name: "Entrar con clave" }).click();
await adm.getByLabel("Clave de acceso").fill(ADMIN);
await adm.getByRole("button", { name: "Entrar", exact: true }).click();
await adm.getByRole("tab", { name: "Moderación" }).click();
await adm.getByText("de @amiga").waitFor();
await adm.locator("canvas.packplayer").first().waitFor();
await adm.screenshot({ path: shot.replace(".png", "-mod.png") });
await adm.getByRole("button", { name: "Aprobar" }).click();
await adm.getByText("No hay mascotas en esta lista.").waitFor();
const petId = (await adminApi("GET", "/api/admin/moderation/pets?status=approved")).items[0].id;
console.log("OK aprobada por el administrador");

// 6) overlay: aparece con sus medidas y el ataque funciona
const cookie = async () => (await ctx.cookies()).map((x) => `${x.name}=${x.value}`).join("; ");
const KEYAPI = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { cookie: await cookie(), "x-streampets-csrf": "1", ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  return r.status === 204 ? null : r.json();
};
await KEYAPI("POST", "/api/admin/dev/chat", { login: "luna" });
const ov0 = await KEYAPI("POST", "/api/admin/overlays", { name: "OBS" });
await amiga.reload();
await amiga.getByRole("tab", { name: "Mascotas" }).click();
await amiga.getByLabel("Especie de luna").selectOption(petId);
const ov = await ctx.newPage(); watch(ov);
await ov.goto(BASE + ov0.path);
await ov.waitForFunction(() => window.__overlay);
await until(() => ov.evaluate((id) => window.__overlay.engine.pets.some((p) => p.species.def.id === id), petId), "la pet de paquete aparece en el overlay");
const info = await ov.evaluate((id) => {
  const p = window.__overlay.engine.pets.find((x) => x.species.def.id === id);
  return { canAttack: p.canAttack, cellW: p.species.sheet.cellW, cellH: p.species.sheet.cellH };
}, petId);
if (!info.canAttack) await fail("la pet debería poder atacar");
console.log("OK overlay carga la pet de paquete:", JSON.stringify(info));
const attacked = await ov.evaluate(async (id) => {
  const e = window.__overlay.engine;
  const p = e.pets.find((x) => x.species.def.id === id);
  p.state !== "ATTACK" && (p.requestState("IDLE"));
  const ok = e.attack(p.id, "east");
  const during = p.state + "/" + p.clip + "/" + p.view;
  await new Promise((r) => setTimeout(r, 1000));
  return { ok, during, after: p.state };
}, petId);
if (!attacked.ok || attacked.during !== "ATTACK/attack/east" || attacked.after === "ATTACK") await fail("el ataque no funcionó: " + JSON.stringify(attacked));
console.log("OK ataque desde el motor:", JSON.stringify(attacked));
const west = await ov.evaluate((id) => { const e = window.__overlay.engine; const p = e.pets.find((x) => x.species.def.id === id); if (!p) return { gone: true, pets: e.pets.map((x) => x.species.def.id) }; return { ok: e.attack(p.id, "west"), view: p.view }; }, petId);
console.log("ataque hacia la izquierda:", JSON.stringify(west));
await ov.waitForTimeout(200);
await ov.screenshot({ path: shot });

// 7) las pets normales no se ven afectadas: el ataque se rechaza sin romper nada
const normal = await ov.evaluate(() => { const e = window.__overlay.engine; const p = e.pets.find((x) => !x.species.def.id.startsWith("u-")); return p ? { has: p.canAttack, ok: e.attack(p.id) } : null; });
if (normal && (normal.has || normal.ok)) await fail("una especie base no debería atacar");
console.log("OK especies base sin ataque no se rompen");

if (errors.length) await fail("errores en consola: " + errors.slice(0, 3).join(" | "));
console.log("OK sin errores de consola");
await browser.close();
server.kill();
process.exit(0);
