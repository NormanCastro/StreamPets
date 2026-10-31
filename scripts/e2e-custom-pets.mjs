// Pets propias de punta a punta: una streamer premium sube una, el administrador la aprueba, se ve en el overlay,
// y al rechazarla vuelve a otra especie.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
const { chromium } = createRequire(import.meta.url)("playwright");

const PORT = 3114;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "e2e-admin-token-abcdefghijklmnop";
const shot = process.argv[2] ?? "/tmp/custom-pets-e2e.png";

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

// PNG de 520x280 con un cuadrado de color en cada cuadro (se nota la animación).
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function sheet(w = 520, h = 280) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cx = x % 40, cy = y % 40, col = Math.floor(x / 40), row = Math.floor(y / 40);
    if (cx >= 12 && cx < 28 && cy >= 14 && cy < 35) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = (col * 19) % 256; raw[o + 1] = 90 + row * 20; raw[o + 2] = 200; raw[o + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

await adminApi("POST", "/api/admin/channels", { login: "amiga" });
await adminApi("POST", "/api/admin/channels", { login: "otra" });
await adminApi("PATCH", "/api/admin/channels/amiga", { plan: "premium" });
const KEY = (await adminApi("POST", "/api/admin/channels/amiga/key")).key;
const KEY2 = (await adminApi("POST", "/api/admin/channels/otra/key")).key;

browser = await chromium.launch();
const errors = [];
const watch = (p) => { p.on("pageerror", (e) => errors.push(String(e))); p.on("console", (m) => { if (m.type() === "error" && !/status of (401|400|404)/.test(m.text())) errors.push(m.text()); }); };
async function enter(ctx, key) {
  const p = await ctx.newPage(); watch(p);
  await p.goto(`${BASE}/admin`);
  await p.getByRole("button", { name: "Entrar con clave" }).click();
  await p.getByLabel("Clave de acceso").fill(key);
  await p.getByRole("button", { name: "Entrar", exact: true }).click();
  return p;
}

// 1) un canal gratis ve que es premium y no puede subir
const freeCtx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
const free = await enter(freeCtx, KEY2);
await free.getByRole("tab", { name: "Mis pets" }).click();
await free.getByText("Las mascotas propias son parte del plan premium.").waitFor();
console.log("OK plan gratis: no puede subir");

// 2) streamer premium sube una pet
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const amiga = await enter(ctx, KEY);
await amiga.getByRole("tab", { name: "Mis pets" }).click();
await amiga.getByText("Cómo preparar tu mascota").waitFor();
await amiga.getByLabel(/Hoja de sprites/).setInputFiles({ name: "mala.png", mimeType: "image/png", buffer: sheet(100, 100) });
await amiga.getByText(/Mide 100×100/).waitFor();
console.log("OK medidas malas rechazadas antes de subir");
await amiga.getByLabel("Nombre de la mascota").fill("Pollito");
await amiga.getByLabel(/Hoja de sprites/).setInputFiles({ name: "pollito.png", mimeType: "image/png", buffer: sheet() });
await amiga.getByRole("button", { name: "Enviar a revisión" }).click();
await amiga.getByText("En revisión", { exact: true }).waitFor();
console.log("OK subida: queda en revisión");

// 3) mientras está pendiente no sirve el archivo ni está en el catálogo
const list = await adminApi("GET", "/api/admin/moderation/pets?status=pending");
const petId = list.items[0].id;
if ((await fetch(`${BASE}/api/custom-species/${petId}/sheet.png`)).status !== 404) await fail("la pendiente se sirve");
console.log("OK pendiente no es pública");

// 4) el administrador la ve y la aprueba
const adminCtx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const adm = await enter(adminCtx, ADMIN);
await adm.getByRole("tab", { name: "Moderación" }).click();
await adm.getByText("de @amiga").waitFor();
await adm.getByRole("img", { name: "Hoja completa de la mascota" }).waitFor();
await adm.screenshot({ path: shot.replace(".png", "-mod.png") });
await adm.getByRole("button", { name: "Aprobar" }).click();
await adm.getByText("No hay mascotas en esta lista.").waitFor();
console.log("OK el administrador la aprueba");
if ((await fetch(`${BASE}/api/custom-species/${petId}/sheet.png`)).status !== 200) await fail("la aprobada no se sirve");

// 5) la streamer la elige para un espectador y se ve en el overlay; otro canal no la tiene
const KEYAPI = async (method, path, body) => {
  const c = (await ctx.cookies()).map((x) => `${x.name}=${x.value}`).join("; ");
  const r = await fetch(BASE + path, { method, headers: { cookie: c, "x-streampets-csrf": "1", ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  return r.status === 204 ? null : r.json();
};
await KEYAPI("POST", "/api/admin/dev/chat", { login: "luna" });
const ov0 = await KEYAPI("POST", "/api/admin/overlays", { name: "OBS" });
await amiga.reload();
await amiga.getByRole("tab", { name: "Mascotas" }).click();
await amiga.getByLabel("Especie de luna").selectOption(petId);
const ov = await ctx.newPage(); watch(ov);
const loaded = [];
ov.on("response", (r) => { if (r.url().includes(`/api/custom-species/${petId}/`)) loaded.push(r.status()); });
await ov.goto(BASE + ov0.path);
await ov.waitForFunction(() => window.__overlay);
await until(async () => loaded.includes(200), "el overlay pide la hoja de la pet propia");
await ov.waitForTimeout(600);
await ov.screenshot({ path: shot });
console.log("OK el overlay carga la pet propia");
const otherSpecies = await (async () => {
  const c = (await freeCtx.cookies()).map((x) => `${x.name}=${x.value}`).join("; ");
  return (await (await fetch(BASE + "/api/admin/species", { headers: { cookie: c } })).json()).species.some((s) => s.id === petId);
})();
if (otherSpecies) await fail("otro canal ve la pet de amiga");
console.log("OK otro canal no la ve");

// 6) el administrador la rechaza: la espectadora pasa a otra especie y el archivo deja de servirse
await adm.getByRole("button", { name: "Aprobadas" }).click();
await adm.getByText("de @amiga").waitFor();
await adm.getByLabel(/Motivo para rechazar/).fill("no cumple");
await adm.getByRole("button", { name: "Rechazar" }).click();
await adm.getByText("No hay mascotas en esta lista.").waitFor();
await until(async () => (await fetch(`${BASE}/api/custom-species/${petId}/sheet.png`)).status === 404, "deja de servirse");
const viewers = await KEYAPI("GET", "/api/admin/viewers");
if (viewers.items[0].pet.speciesId === petId) await fail("el espectador sigue con la pet rechazada");
await amiga.getByRole("tab", { name: "Mis pets" }).click();
await amiga.getByText("Motivo: no cumple").waitFor();
console.log("OK rechazar: reubica al espectador y muestra el motivo");

if (errors.length) await fail("errores en el navegador: " + errors.join(" | "));
await browser.close();
server.kill();
console.log("E2E PETS PROPIAS COMPLETO");
