#!/usr/bin/env node
// Simula gente escribiendo en el chat (solo con ENABLE_DEV_CHAT activo en el servidor).
// Uso: ADMIN_TOKEN=... node scripts/simulate-chat.mjs [--url http://localhost:3000] [--count 8] [--interval 1500] [--sub-ratio 0.3]
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : [])),
);
const url = (args.url ?? process.env.SERVER_URL ?? "http://localhost:3000").replace(/\/$/, "");
const token = process.env.ADMIN_TOKEN;
const count = Number(args.count ?? 8);
const interval = Number(args.interval ?? 1500);
const subRatio = Number(args["sub-ratio"] ?? 0.3);

if (!token) {
  console.error("Falta ADMIN_TOKEN (el que muestra el servidor al arrancar en desarrollo).");
  process.exit(1);
}

const NAMES = ["luna", "kiko", "nazhi", "mochi", "tomi", "sol", "pepa", "rayo", "nube", "canela", "bruno", "mora",
  "fenix", "gala", "ico", "lola", "max", "nina", "olaf", "pipa", "rita", "simba", "thor", "uma", "vega", "yuki", "zoe"];
const people = Array.from({ length: count }, (_, i) => ({
  login: `${NAMES[i % NAMES.length]}${i >= NAMES.length ? i : ""}`,
  isSubscriber: Math.random() < subRatio,
}));

async function say(p) {
  const res = await fetch(`${url}/api/admin/dev/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(p),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

console.log(`Simulando ${count} espectadores en ${url} (Ctrl+C para parar)`);
for (;;) {
  const p = people[Math.floor(Math.random() * people.length)];
  try {
    const r = await say(p);
    console.log(`${new Date().toLocaleTimeString()}  ${p.login.padEnd(12)} -> ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`);
  } catch (err) {
    console.error(String(err.message ?? err));
  }
  await new Promise((r) => setTimeout(r, interval * (0.5 + Math.random())));
}
