// Login con Twitch de punta a punta: servidor real + dashboard en Chromium + un Twitch de mentira local.
// (No habla con el Twitch verdadero: eso solo se puede probar con las credenciales reales.)
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createSign, generateKeyPairSync } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");

const PORT = 3113;
const TW_PORT = 3114;
const BASE = `http://localhost:${PORT}`;
const ADMIN = "e2e-admin-token-abcdefghijklmnop";
const CLIENT_ID = "e2eclient";
const shot = process.argv[2] ?? "/tmp/login-e2e.png";

// ── Twitch falso ──
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const codes = new Map(); // code -> {sub, login, nonce}
let nextUser = { sub: "100", login: "nazhika" }; // quién "inicia sesión" en Twitch ahora
const twitch = createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${TW_PORT}`);
  if (u.pathname === "/oauth2/authorize") {
    const code = "c" + Math.random().toString(36).slice(2, 12);
    codes.set(code, { ...nextUser, nonce: u.searchParams.get("nonce") });
    const back = new URL(u.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", u.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() }).end();
  } else if (u.pathname === "/oauth2/keys") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  } else if (u.pathname === "/oauth2/token" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      const g = codes.get(p.get("code"));
      if (!g || p.get("client_secret") !== "e2esecret") return res.writeHead(400).end("{}");
      codes.delete(p.get("code"));
      const h = b64({ alg: "RS256", typ: "JWT", kid: "k1" });
      const c = b64({
        iss: `http://localhost:${TW_PORT}/oauth2`, aud: CLIENT_ID, sub: g.sub, nonce: g.nonce,
        exp: Math.floor(Date.now() / 1000) + 600, preferred_username: g.login,
        picture: `https://static-cdn.jtvnw.net/jtv_user_pictures/e2e-${g.login}.png`,
      });
      const sig = createSign("RSA-SHA256").update(`${h}.${c}`).sign(privateKey).toString("base64url");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: `${h}.${c}.${sig}`, access_token: "x" }));
    });
  } else res.writeHead(404).end();
});
await new Promise((r) => twitch.listen(TW_PORT, "127.0.0.1", r));

// Catálogo de prueba: dragón = premium, zorro = exclusiva, resto general y gratis.
const assets = mkdtempSync(join(tmpdir(), "sp-assets-"));
cpSync(new URL("../shared-public/assets", import.meta.url).pathname, assets, { recursive: true });
const idx = JSON.parse(readFileSync(join(assets, "species/index.json"), "utf8"));
for (const sp of idx.species) {
  if (sp.id === "dragon") sp.tier = "premium";
  if (sp.id === "zorro") sp.scope = "exclusive";
}
writeFileSync(join(assets, "species/index.json"), JSON.stringify(idx));

const server = spawn("pnpm", ["--filter", "@streampets/server", "exec", "tsx", "src/index.ts"], {
  env: {
    ...process.env, PORT: String(PORT), ADMIN_TOKEN: ADMIN, LOG_LEVEL: "warn", HOST: "127.0.0.1",
    PGLITE_DIR: mkdtempSync(join(tmpdir(), "sp-")), STREAMER_LOGIN: "nazhika", ASSETS_DIR: assets, ENABLE_DEV_CHAT: "true",
    TWITCH_CLIENT_ID: CLIENT_ID, TWITCH_CLIENT_SECRET: "e2esecret", PUBLIC_URL: BASE, TWITCH_ID_URL: `http://localhost:${TW_PORT}`,
  },
  stdio: ["ignore", "inherit", "inherit"],
});
let browser;
const cleanup = async () => { await browser?.close().catch(() => {}); server.kill(); twitch.close(); };
const fail = async (m) => { console.error("FALLO:", m); await cleanup(); process.exit(1); };
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
  if (i > 150) await fail("el servidor no arrancó");
  await new Promise((r) => setTimeout(r, 200));
}

browser = await chromium.launch();
const errors = [];
const newCtx = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  // (la foto de Twitch no carga en el sandbox sin internet: esos errores se ignoran)
  page.on("console", (m) => { if (m.type() === "error" && !/status of (401|403|400)/.test(m.text()) && !/ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text()); });
  return { ctx, page };
};

const themeOf = (page) => page.evaluate(() => document.documentElement.dataset.theme);
// El nombre, el plan, el color y «Salir» viven en el menú de usuario (botón sándwich).
const openMenu = async (page) => {
  if ((await page.locator(".menu-pop").count()) === 0) await page.getByRole("button", { name: "Menú de usuario" }).click();
  return page.locator(".menu-pop");
};
const who = async (page) => (await openMenu(page)).locator(".menu-name strong");
const picker = (page) => page.getByRole("group", { name: "Color del panel" });

// 1) la pantalla de entrada muestra el botón de Twitch
const owner = await newCtx();
await owner.page.goto(`${BASE}/admin`);
await owner.page.getByRole("link", { name: "Entrar con Twitch" }).waitFor();
if ((await picker(owner.page).count()) !== 0) await fail("la pantalla de entrada no debería tener selector de color");
if ((await themeOf(owner.page)) !== "morado") await fail("la entrada debe ser morada");
await owner.page.screenshot({ path: shot.replace(".png", "-login.png") });
console.log("OK botón «Entrar con Twitch» visible");

// 2) la dueña entra con Twitch → ve su panel y la pestaña de admin NO aparece (no entró con la clave)
nextUser = { sub: "100", login: "nazhika" };
await owner.page.getByRole("link", { name: "Entrar con Twitch" }).click();
await (await who(owner.page)).filter({ hasText: "Nazhika" }).waitFor();
const whoText = (await (await who(owner.page)).textContent()) ?? "";
if (whoText.includes("@") || !whoText.startsWith("Nazhika")) await fail("el nombre debe verse «Nazhika» sin @: " + whoText);
if (!whoText.includes("⭐")) await fail("el dueño (todo incluido) debería llevar ⭐: " + whoText);
await owner.page.getByRole("tab", { name: "Mascotas" }).waitFor();
// los contadores (Total / Subs / En pantalla) van centrados
const aligns = await owner.page.locator(".stat").evaluateAll((els) => els.map((e) => getComputedStyle(e).textAlign));
if (aligns.length !== 3 || aligns.some((a) => a !== "center")) await fail("los contadores deberían ir centrados: " + aligns);
console.log("OK nombre sin @ con mayúscula, ⭐ y contadores centrados");

// la foto de perfil de Twitch llega al menú (y la dirección viaja solo si es del CDN de Twitch)
const me0 = await owner.page.evaluate(async () => (await fetch("/api/admin/me")).json());
if (me0.streamer.avatarUrl !== "https://static-cdn.jtvnw.net/jtv_user_pictures/e2e-nazhika.png") await fail("la foto de Twitch no llegó: " + me0.streamer.avatarUrl);
await owner.page.locator(".menu-pop .avatar").waitFor();
console.log("OK el menú muestra la foto de perfil de Twitch");

// el streamer sí puede elegir color, y se guarda
await openMenu(owner.page);
await owner.page.getByRole("button", { name: "Color rosado" }).click();
if ((await themeOf(owner.page)) !== "rosado") await fail("el streamer no pudo cambiar a rosado");
await owner.page.screenshot({ path: shot.replace(".png", "-streamer-rosado.png") });
console.log("OK un streamer elige su color");
if ((await owner.page.getByRole("tab", { name: "Canales" }).count()) !== 0) await fail("un streamer con sesión ve la pestaña Canales");
console.log("OK entra con Twitch como streamer (sin pestaña Canales)");

// 3) la sesión sobrevive a recargar
await owner.page.reload();
await (await who(owner.page)).filter({ hasText: "Nazhika" }).waitFor();
if ((await themeOf(owner.page)) !== "rosado") await fail("el color del streamer no se guardó");
console.log("OK la sesión y el color sobreviven al recargar");

// 4) alguien no autorizado es rechazado con mensaje claro
const intruder = await newCtx();
nextUser = { sub: "555", login: "intruso" };
await intruder.page.goto(`${BASE}/admin`);
await intruder.page.getByRole("link", { name: "Entrar con Twitch" }).click();
await intruder.page.getByText(/todavía no está autorizado/).waitFor();
if (intruder.page.url().includes("login_error")) await fail("el error quedó en la dirección");
console.log("OK un canal no autorizado se rechaza con mensaje");

// 5) el admin (clave) autoriza a la amiga desde «Canales»
const adm = await newCtx();
await adm.page.goto(`${BASE}/admin`);
await adm.page.evaluate(() => localStorage.setItem("streampets.theme", "rojo")); // aunque haya un color guardado
await adm.page.reload();
await adm.page.getByRole("button", { name: "Entrar con clave" }).click();
await adm.page.getByLabel("Clave de acceso").fill(ADMIN);
await adm.page.getByRole("button", { name: "Entrar", exact: true }).click();
await adm.page.getByRole("tab", { name: "Canales" }).click();
if ((await themeOf(adm.page)) !== "morado") await fail("el panel de administración debe ser morado: " + (await themeOf(adm.page)));
if ((await picker(adm.page).count()) !== 0) await fail("el panel de administración no debería tener selector de color");
await adm.page.getByRole("button", { name: "Menú de usuario" }).click();
if ((await picker(adm.page).count()) !== 0) await fail("el menú del administrador no debería tener selector de color");
const admText = ((await (await who(adm.page)).textContent()) ?? "").trim();
if (admText !== "Admin") await fail("con la clave el encabezado debe decir «Admin»: " + admText);
console.log("OK login y panel de administración siempre morados, sin selector, y dice «Admin»");
await adm.page.getByLabel("Usuario de Twitch a autorizar").fill("@Amiga");
await adm.page.getByRole("button", { name: "Autorizar canal" }).click();
await adm.page.getByText("@amiga").waitFor();
console.log("OK el admin autoriza un canal");

// 6) la amiga entra y ve SU panel vacío (sin las mascotas de la dueña)
const friend = await newCtx();
nextUser = { sub: "200", login: "amiga" };
await friend.page.goto(`${BASE}/admin`);
await friend.page.getByRole("link", { name: "Entrar con Twitch" }).click();
await (await who(friend.page)).filter({ hasText: "Amiga" }).waitFor();
if (((await (await who(friend.page)).textContent()) ?? "").includes("⭐")) await fail("un canal gratis no debería llevar ⭐");
await friend.page.getByRole("tab", { name: "Overlay para OBS" }).click();
await friend.page.getByLabel("Nombre del nuevo overlay").fill("OBS amiga");
await friend.page.getByRole("button", { name: "Crear enlace" }).click();
const url = await friend.page.getByLabel("Enlace del overlay").inputValue();
if (!/\/overlay\/pets\/spo_/.test(url)) await fail("enlace inesperado: " + url);
console.log("OK la amiga entra y crea su propio enlace de OBS");

// el overlay de la amiga funciona y es independiente
const ov = await friend.ctx.newPage();
await ov.goto(url);
await ov.waitForFunction(() => window.__overlay, null, { timeout: 8000 });
console.log("OK el overlay de la amiga carga");

// 6b) con plan gratis, en su panel el dragón (premium) y el zorro (exclusiva) salen bloqueados
await friend.page.getByRole("tab", { name: "Ajustes" }).click();
const opts = friend.page.getByLabel("Especie para los nuevos").locator("option");
const text = async (name) => (await opts.filter({ hasText: name }).first().textContent()) ?? "";
const dis = async (name) => await opts.filter({ hasText: name }).first().evaluate((el) => el.disabled);
if (!(await text("Dragón")).includes("🔒") || !(await dis("Dragón"))) await fail("el dragón debería verse bloqueado para un canal gratis");
if (!(await text("Zorro")).includes("🔒") || !(await dis("Zorro"))) await fail("el zorro debería verse bloqueado");
if (await dis("Shiba")) await fail("el shiba no debería estar bloqueado");
console.log("OK plan gratis: premium y exclusivas salen bloqueadas");

// 6c) el admin la pasa a premium y le da el zorro; se desbloquea (sin que ella haga nada más que recargar)
await adm.page.getByRole("row", { name: /@amiga/ }).getByLabel("Plan de amiga").selectOption("premium");
await adm.page.getByRole("row", { name: /@amiga/ }).getByRole("button", { name: /^Especies/ }).click();
await adm.page.getByLabel("Zorro para amiga").click(); // casilla controlada: el estado cambia cuando responde el servidor
await adm.page.getByRole("button", { name: "Especies (1/1)" }).waitFor();
await friend.page.reload();
await (await who(friend.page)).filter({ hasText: "⭐" }).waitFor();
await friend.page.getByRole("tab", { name: "Ajustes" }).click();
if (await dis("Dragón")) await fail("el dragón debería estar desbloqueado con plan premium");
if (await dis("Zorro")) await fail("el zorro debería estar desbloqueado con permiso");
console.log("OK plan premium y permiso de especie desbloquean en su panel");

// 7) la amiga no puede usar la API de canales
const forbidden = await friend.page.evaluate(async () => (await fetch("/api/admin/channels")).status);
if (forbidden !== 403) await fail("la amiga pudo pedir /channels: " + forbidden);
console.log("OK una streamer no accede a la lista de canales (403)");

// 6d) clave personal de respaldo: el admin la genera, la amiga entra con ella sin Twitch
await adm.page.getByRole("row", { name: /@amiga/ }).getByRole("button", { name: "Generar clave" }).click();
const key = await adm.page.getByLabel("Clave generada").inputValue();
if (!/^spk_[\w-]{43}$/.test(key)) await fail("clave inesperada: " + key);
await adm.page.getByRole("button", { name: "Ya la copié" }).click();
const viaKey = await newCtx();
await viaKey.page.goto(`${BASE}/admin`);
if ((await viaKey.page.getByLabel("Clave de acceso").count()) !== 0) await fail("la clave debería estar escondida hasta pulsar el botón");
await viaKey.page.getByRole("button", { name: "Entrar con clave" }).click();
await viaKey.page.getByLabel("Clave de acceso").fill("spk_" + "a".repeat(43));
await viaKey.page.getByRole("button", { name: "Entrar", exact: true }).click();
await viaKey.page.getByText("Clave incorrecta.").waitFor();
await viaKey.page.getByLabel("Clave de acceso").fill(key);
await viaKey.page.getByRole("button", { name: "Entrar", exact: true }).click();
await (await who(viaKey.page)).filter({ hasText: "Amiga" }).waitFor();
if ((await viaKey.page.getByRole("tab", { name: "Canales" }).count()) !== 0) await fail("la clave personal no debe dar acceso a Canales");
console.log("OK clave personal: la genera el admin y la amiga entra sin Twitch (solo a su canal)");

// regenerar cierra la sesión que se abrió con la clave anterior
adm.page.once("dialog", (d) => d.accept());
await adm.page.getByRole("row", { name: /@amiga/ }).getByRole("button", { name: "Regenerar" }).click();
const key2 = await adm.page.getByLabel("Clave generada").inputValue();
const stale = await viaKey.page.evaluate(async () => (await fetch("/api/admin/me")).status);
if (stale !== 401) await fail("la sesión de la clave anterior siguió viva: " + stale);
await adm.page.getByRole("button", { name: "Ya la copié" }).click();
console.log("OK regenerar la clave cierra las sesiones anteriores");
// con la clave nueva vuelve a entrar (esta sesión se usa en el paso siguiente)
await viaKey.page.reload();
await viaKey.page.getByRole("button", { name: "Entrar con clave" }).click();
await viaKey.page.getByLabel("Clave de acceso").fill(key2);
await viaKey.page.getByRole("button", { name: "Entrar", exact: true }).click();
await (await who(viaKey.page)).filter({ hasText: "Amiga" }).waitFor();

// 8) el admin la quita → su sesión se cierra enseguida
adm.page.once("dialog", (d) => d.accept());
await adm.page.getByRole("row", { name: /@amiga/ }).getByRole("button", { name: "Quitar" }).click();
await adm.page.waitForFunction(() => !document.body.innerText.includes("@amiga"), null, { timeout: 8000 });
const after = await friend.page.evaluate(async () => (await fetch("/api/admin/me")).status);
if (after !== 401) await fail("la sesión de la amiga siguió viva: " + after);
const afterKey = await viaKey.page.evaluate(async () => (await fetch("/api/admin/me")).status);
if (afterKey !== 401) await fail("la sesión abierta con clave siguió viva: " + afterKey);
const retry = await viaKey.page.evaluate(async (k) => (await fetch("/auth/key", { method: "POST", headers: { "content-type": "application/json", "x-streampets-csrf": "1" }, body: JSON.stringify({ key: k }) })).status, key2);
if (retry !== 401) await fail("la clave de un canal quitado siguió sirviendo: " + retry);
console.log("OK al quitarla, su sesión se cierra");

// 9) salir cierra la sesión de la dueña
await openMenu(owner.page);
await owner.page.getByRole("menuitem", { name: "Salir" }).click();
await owner.page.getByRole("link", { name: "Entrar con Twitch" }).waitFor();
const out = await owner.page.evaluate(async () => (await fetch("/api/admin/me")).status);
if (out !== 401) await fail("la sesión no se cerró: " + out);
if ((await themeOf(owner.page)) !== "morado") await fail("al salir la entrada debe volver a morado: " + (await themeOf(owner.page)));
if ((await picker(owner.page).count()) !== 0) await fail("la entrada no debería tener selector de color");
await adm.page.screenshot({ path: shot });
console.log("OK salir cierra la sesión");

if (errors.length) await fail("errores de consola: " + errors.join(" | "));
await cleanup();
console.log("E2E LOGIN COMPLETO");
process.exit(0);
