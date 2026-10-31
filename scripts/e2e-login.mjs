// Login con Twitch de punta a punta: servidor real + dashboard en Chromium + un Twitch de mentira local.
// (No habla con el Twitch verdadero: eso solo se puede probar con las credenciales reales.)
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
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
      });
      const sig = createSign("RSA-SHA256").update(`${h}.${c}`).sign(privateKey).toString("base64url");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: `${h}.${c}.${sig}`, access_token: "x" }));
    });
  } else res.writeHead(404).end();
});
await new Promise((r) => twitch.listen(TW_PORT, "127.0.0.1", r));

const server = spawn("pnpm", ["--filter", "@streampets/server", "exec", "tsx", "src/index.ts"], {
  env: {
    ...process.env, PORT: String(PORT), ADMIN_TOKEN: ADMIN, LOG_LEVEL: "warn", HOST: "127.0.0.1",
    PGLITE_DIR: mkdtempSync(join(tmpdir(), "sp-")), STREAMER_LOGIN: "nazhika",
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
  page.on("console", (m) => { if (m.type() === "error" && !/status of (401|403|400)/.test(m.text())) errors.push(m.text()); });
  return { ctx, page };
};

// 1) la pantalla de entrada muestra el botón de Twitch
const owner = await newCtx();
await owner.page.goto(`${BASE}/admin`);
await owner.page.getByRole("link", { name: "Entrar con Twitch" }).waitFor();
await owner.page.screenshot({ path: shot.replace(".png", "-login.png") });
console.log("OK botón «Entrar con Twitch» visible");

// 2) la dueña entra con Twitch → ve su panel y la pestaña de admin NO aparece (no entró con la clave)
nextUser = { sub: "100", login: "nazhika" };
await owner.page.getByRole("link", { name: "Entrar con Twitch" }).click();
await owner.page.getByText("@nazhika").waitFor();
await owner.page.getByRole("tab", { name: "Mascotas" }).waitFor();
if ((await owner.page.getByRole("tab", { name: "Canales" }).count()) !== 0) await fail("un streamer con sesión ve la pestaña Canales");
console.log("OK entra con Twitch como streamer (sin pestaña Canales)");

// 3) la sesión sobrevive a recargar
await owner.page.reload();
await owner.page.getByText("@nazhika").waitFor();
console.log("OK la sesión sobrevive al recargar");

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
await adm.page.getByLabel("Clave de administración").fill(ADMIN);
await adm.page.getByRole("button", { name: "Entrar", exact: true }).click();
await adm.page.getByRole("tab", { name: "Canales" }).click();
await adm.page.getByLabel("Usuario de Twitch a autorizar").fill("@Amiga");
await adm.page.getByRole("button", { name: "Autorizar canal" }).click();
await adm.page.getByText("@amiga").waitFor();
console.log("OK el admin autoriza un canal");

// 6) la amiga entra y ve SU panel vacío (sin las mascotas de la dueña)
const friend = await newCtx();
nextUser = { sub: "200", login: "amiga" };
await friend.page.goto(`${BASE}/admin`);
await friend.page.getByRole("link", { name: "Entrar con Twitch" }).click();
await friend.page.getByText("@amiga").waitFor();
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

// 7) la amiga no puede usar la API de canales
const forbidden = await friend.page.evaluate(async () => (await fetch("/api/admin/channels")).status);
if (forbidden !== 403) await fail("la amiga pudo pedir /channels: " + forbidden);
console.log("OK una streamer no accede a la lista de canales (403)");

// 8) el admin la quita → su sesión se cierra enseguida
adm.page.once("dialog", (d) => d.accept());
await adm.page.getByRole("row", { name: /@amiga/ }).getByRole("button", { name: "Quitar" }).click();
await adm.page.waitForFunction(() => !document.body.innerText.includes("@amiga"), null, { timeout: 8000 });
const after = await friend.page.evaluate(async () => (await fetch("/api/admin/me")).status);
if (after !== 401) await fail("la sesión de la amiga siguió viva: " + after);
console.log("OK al quitarla, su sesión se cierra");

// 9) salir cierra la sesión de la dueña
await owner.page.getByRole("button", { name: "Salir" }).click();
await owner.page.getByRole("link", { name: "Entrar con Twitch" }).waitFor();
const out = await owner.page.evaluate(async () => (await fetch("/api/admin/me")).status);
if (out !== 401) await fail("la sesión no se cerró: " + out);
await adm.page.screenshot({ path: shot });
console.log("OK salir cierra la sesión");

if (errors.length) await fail("errores de consola: " + errors.join(" | "));
await cleanup();
console.log("E2E LOGIN COMPLETO");
process.exit(0);
