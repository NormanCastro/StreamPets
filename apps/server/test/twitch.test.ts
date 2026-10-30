import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { loadConfig, ConfigError } from "../src/config.js";
import * as repo from "../src/db/repo.js";
import { TwitchChatClient, nextDelay } from "../src/twitch/chat-client.js";
import type { TwitchChatClientOptions } from "../src/twitch/chat-client.js";
import { parseIrcLine, toChatMessage } from "../src/twitch/irc.js";
import type { TwitchChatMessage } from "../src/twitch/irc.js";
import { startTwitchChat } from "../src/twitch/start.js";
import { makeHarness } from "./helpers.js";
import type { Harness } from "./helpers.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando condición");
    await wait(10);
  }
}

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

function privmsg(login: string, userId: string, opts: { badges?: string; display?: string; channel?: string } = {}): string {
  const tags = [
    `badges=${opts.badges ?? ""}`,
    `display-name=${opts.display ?? login}`,
    `user-id=${userId}`,
    "tmi-sent-ts=1700000000000",
  ].join(";");
  return `@${tags} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #${opts.channel ?? "canal"} :hola`;
}

// ───────────────────────────── parser ─────────────────────────────

describe("parseIrcLine", () => {
  it("separa etiquetas, prefijo, comando y texto", () => {
    const m = parseIrcLine("@a=1;b=;c :nick!u@h PRIVMSG #canal :hola mundo : con dos puntos\r\n");
    expect(m?.command).toBe("PRIVMSG");
    expect(m?.prefix).toBe("nick!u@h");
    expect(m?.params).toEqual(["#canal", "hola mundo : con dos puntos"]);
    expect(Object.fromEntries(m?.tags ?? [])).toEqual({ a: "1", b: "", c: "" });
  });

  it("deshace los escapes de las etiquetas", () => {
    const m = parseIrcLine("@display-name=Lu\\sna\\:\\\\x\\n :a!a@a PRIVMSG #c :x");
    expect(m?.tags.get("display-name")).toBe("Lu na;\\x\n");
  });

  it("acepta líneas sin etiquetas ni prefijo", () => {
    expect(parseIrcLine("PING :tmi.twitch.tv")).toMatchObject({ command: "PING", params: ["tmi.twitch.tv"], prefix: undefined });
    expect(parseIrcLine("RECONNECT")).toMatchObject({ command: "RECONNECT", params: [] });
  });

  it("devuelve undefined con basura o líneas vacías", () => {
    expect(parseIrcLine("")).toBeUndefined();
    expect(parseIrcLine("\r\n")).toBeUndefined();
    expect(parseIrcLine("@solo=etiquetas")).toBeUndefined();
    expect(parseIrcLine(":solo.prefijo")).toBeUndefined();
  });

  it("no se deja envenenar por etiquetas con nombres peligrosos", () => {
    const m = parseIrcLine("@__proto__=x;constructor=y :a!a@a PRIVMSG #c :x");
    expect(m?.tags.get("__proto__")).toBe("x");
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>)["__proto__"]).not.toBe("x");
  });
});

describe("toChatMessage", () => {
  const get = (line: string): TwitchChatMessage | undefined => {
    const m = parseIrcLine(line);
    return m ? toChatMessage(m) : undefined;
  };

  it("extrae usuario, nombre y estado de suscriptor", () => {
    expect(get(privmsg("luna", "123", { badges: "subscriber/6,premium/1", display: "Luna" }))).toEqual({
      userId: "123",
      login: "luna",
      displayName: "Luna",
      isSubscriber: true,
    });
  });

  it("founder también cuenta como sub; moderador, vip o broadcaster no", () => {
    expect(get(privmsg("a", "1", { badges: "founder/0" }))?.isSubscriber).toBe(true);
    expect(get(privmsg("b", "2", { badges: "moderator/1,vip/1" }))?.isSubscriber).toBe(false);
    expect(get(privmsg("c", "3", { badges: "broadcaster/1" }))?.isSubscriber).toBe(false);
    expect(get(privmsg("d", "4", { badges: "" }))?.isSubscriber).toBe(false);
  });

  it("sin display-name usa el login", () => {
    expect(get(privmsg("kiko", "5", { display: "" }))?.displayName).toBe("kiko");
  });

  it("descarta lo que no es un mensaje de usuario válido", () => {
    expect(get(":tmi.twitch.tv ROOMSTATE #canal")).toBeUndefined();
    expect(get("@badges=;user-id=1 :a!a@a PRIVMSG #c :x")?.login).toBe("a");
    expect(get("@badges= :a!a@a PRIVMSG #c :x")).toBeUndefined(); // sin user-id
    expect(get("@user-id=abc :a!a@a PRIVMSG #c :x")).toBeUndefined(); // id no numérico
    expect(get("@user-id=1 :a!a@a PRIVMSG alguien :x")).toBeUndefined(); // no es un canal
    expect(get("@user-id=1 :sin-bang PRIVMSG #c :x")).toBeUndefined(); // sin login en el prefijo
    expect(get("@user-id=1 :mal$login!x@x PRIVMSG #c :x")).toBeUndefined(); // login inválido
  });
});

describe("nextDelay", () => {
  it("duplica hasta el tope y varía ±25 %", () => {
    const mid = () => 0.5; // factor 1.0
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => nextDelay(n, 1000, 30_000, mid))).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(nextDelay(0, 1000, 30_000, () => 0)).toBe(750);
    expect(nextDelay(0, 1000, 30_000, () => 0.999999)).toBe(1250);
    expect(nextDelay(1000, 1000, 30_000, mid)).toBe(30_000);
  });
});

// ───────────────────────────── servidor IRC falso ─────────────────────────────

interface Conn {
  ws: WebSocket;
  lines: string[];
}
type Mode = "normal" | "authfail" | "nak" | "silent";

class FakeIrc {
  readonly conns: Conn[] = [];
  private constructor(
    readonly wss: WebSocketServer,
    public mode: Mode,
  ) {}
  static async start(mode: Mode = "normal"): Promise<FakeIrc> {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const fake = new FakeIrc(wss, mode);
    wss.on("connection", (ws) => {
      const conn: Conn = { ws, lines: [] };
      fake.conns.push(conn);
      ws.on("message", (d) => {
        for (const line of d.toString().split("\r\n")) {
          if (!line) continue;
          conn.lines.push(line);
          if (fake.mode === "nak" && line.startsWith("CAP REQ")) ws.send(":tmi.twitch.tv CAP * NAK :twitch.tv/tags");
          if (fake.mode === "authfail" && line.startsWith("PASS")) ws.send(":tmi.twitch.tv NOTICE * :Login authentication failed");
          if (fake.mode === "normal" && line.startsWith("JOIN #")) ws.send(`:tmi.twitch.tv ROOMSTATE ${line.slice(5)}`);
        }
      });
    });
    return fake;
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }
  /** Envía varias líneas IRC a la conexión (por defecto la última). */
  say(lines: string[], conn: Conn | undefined = this.conns[this.conns.length - 1]): void {
    conn?.ws.send(lines.join("\r\n") + "\r\n");
  }
  async close(): Promise<void> {
    for (const c of this.conns) c.ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

let irc: FakeIrc;
let client: TwitchChatClient | undefined;
afterEach(async () => {
  client?.stop();
  client = undefined;
  await irc?.close();
});

function mk(over: Partial<TwitchChatClientOptions> = {}): { client: TwitchChatClient; got: TwitchChatMessage[] } {
  const got: TwitchChatMessage[] = [];
  client = new TwitchChatClient({
    channel: "canal",
    url: irc.url,
    onMessage: (m) => got.push(m),
    log: silent,
    backoffMinMs: 20,
    backoffMaxMs: 80,
    ...over,
  });
  client.start();
  return { client, got };
}

describe("TwitchChatClient", () => {
  beforeEach(async () => {
    irc = await FakeIrc.start();
  });

  it("entra como anónimo: pide capacidades, usa nick justinfan y se une al canal", async () => {
    mk();
    await waitFor(() => (irc.conns[0]?.lines.length ?? 0) >= 4);
    const lines = irc.conns[0]?.lines ?? [];
    expect(lines[0]).toBe("CAP REQ :twitch.tv/tags twitch.tv/commands");
    expect(lines.find((l) => l.startsWith("PASS "))?.length).toBeGreaterThan(5); // contraseña no vacía
    expect(lines.find((l) => l.startsWith("NICK "))).toMatch(/^NICK justinfan\d+$/);
    expect(lines).toContain("JOIN #canal");
    expect(lines.join("\n")).not.toContain("oauth:");
  });

  it("con cuenta y token usa la autenticación oficial", async () => {
    mk({ auth: { login: "mibot", token: "abcdefghij1234567890" } });
    await waitFor(() => (irc.conns[0]?.lines.length ?? 0) >= 4);
    const lines = irc.conns[0]?.lines ?? [];
    expect(lines).toContain("PASS oauth:abcdefghij1234567890");
    expect(lines).toContain("NICK mibot");
    expect(lines.indexOf("PASS oauth:abcdefghij1234567890")).toBeLessThan(lines.indexOf("NICK mibot")); // PASS antes que NICK
    expect(client?.status().authenticated).toBe(true);
  });

  it("pasa a 'joined' al recibir ROOMSTATE", async () => {
    const { client: c } = mk();
    await waitFor(() => c.status().state === "joined");
    expect(c.status()).toMatchObject({ state: "joined", channel: "canal", authenticated: false, reconnects: 0 });
  });

  it("entrega los mensajes de chat con su estado de sub y descarta el resto", async () => {
    const { got } = mk();
    await waitFor(() => (irc.conns[0]?.lines.length ?? 0) >= 4);
    irc.say([
      privmsg("luna", "100", { badges: "subscriber/3", display: "Luna" }),
      ":tmi.twitch.tv USERNOTICE #canal :algo",
      "@badges=;user-id=oops :x!x@x PRIVMSG #canal :id inválido",
      privmsg("kiko", "200"),
    ]);
    await waitFor(() => got.length === 2);
    expect(got).toEqual([
      { userId: "100", login: "luna", displayName: "Luna", isSubscriber: true },
      { userId: "200", login: "kiko", displayName: "kiko", isSubscriber: false },
    ]);
    expect(client?.status().messages).toBe(2);
    expect(client?.status().lastMessageAt).not.toBeNull();
  });

  it("procesa varias líneas en un mismo paquete y con saltos CRLF", async () => {
    const { got } = mk();
    await waitFor(() => (irc.conns[0]?.lines.length ?? 0) >= 4);
    irc.say(Array.from({ length: 25 }, (_, i) => privmsg(`user${i}`, String(1000 + i))));
    await waitFor(() => got.length === 25);
  });

  it("responde PING con PONG y el mismo texto", async () => {
    mk();
    await waitFor(() => (irc.conns[0]?.lines.length ?? 0) >= 4);
    irc.say(["PING :tmi.twitch.tv"]);
    await waitFor(() => irc.conns[0]?.lines.includes("PONG :tmi.twitch.tv") ?? false);
  });

  it("al recibir RECONNECT se reconecta y vuelve a unirse al canal", async () => {
    const { client: c } = mk();
    await waitFor(() => c.status().state === "joined");
    irc.say([":tmi.twitch.tv RECONNECT"]);
    await waitFor(() => irc.conns.length === 2 && c.status().state === "joined");
    expect(irc.conns[1]?.lines).toContain("JOIN #canal");
  });

  it("si la conexión se corta, reintenta sola y sigue entregando mensajes", async () => {
    const { client: c, got } = mk();
    await waitFor(() => c.status().state === "joined");
    irc.conns[0]?.ws.terminate();
    await waitFor(() => irc.conns.length === 2 && c.status().state === "joined");
    expect(c.status().reconnects).toBe(1);
    irc.say([privmsg("luna", "100")]);
    await waitFor(() => got.length === 1);
  });

  it("reintenta varias veces si el servidor está caído y se recupera cuando vuelve", async () => {
    const { client: c } = mk({ url: "ws://127.0.0.1:1" }); // puerto sin nadie escuchando
    await waitFor(() => c.status().reconnects >= 3, 5000);
    expect(c.status().state).toBe("reconnecting");
    c.stop();
  });

  it("reinicia una conexión muda (sin PING ni mensajes) pasado el tiempo límite", async () => {
    irc.mode = "silent";
    const { client: c } = mk({ idleTimeoutMs: 150 });
    await waitFor(() => irc.conns.length >= 2, 4000);
    expect(c.status().reconnects).toBeGreaterThanOrEqual(1);
  });

  it("un token rechazado detiene el lector y no insiste", async () => {
    irc.mode = "authfail";
    const { client: c } = mk({ auth: { login: "mibot", token: "tokenincorrecto123" } });
    await waitFor(() => c.status().state === "failed");
    await wait(250);
    expect(irc.conns).toHaveLength(1);
    expect(c.status().state).toBe("failed");
  });

  it("si Twitch rechaza las capacidades (NAK) se detiene", async () => {
    irc.mode = "nak";
    const { client: c } = mk();
    await waitFor(() => c.status().state === "failed");
    await wait(200);
    expect(irc.conns).toHaveLength(1);
  });

  it("stop() cierra la conexión y no vuelve a conectar", async () => {
    const { client: c } = mk();
    await waitFor(() => c.status().state === "joined");
    c.stop();
    await wait(250);
    expect(c.status().state).toBe("stopped");
    expect(irc.conns).toHaveLength(1);
  });

  it("nunca envía mensajes al chat", async () => {
    const { client: c } = mk();
    await waitFor(() => c.status().state === "joined");
    irc.say([privmsg("luna", "100"), "PING :tmi.twitch.tv"]);
    await wait(150);
    const sent = (irc.conns[0]?.lines ?? []).filter((l) => /^PRIVMSG/i.test(l));
    expect(sent).toEqual([]);
  });

  it("un error dentro de onMessage no tumba la conexión", async () => {
    let calls = 0;
    const { client: c } = mk({
      onMessage: () => {
        calls++;
        throw new Error("boom");
      },
    });
    await waitFor(() => c.status().state === "joined");
    irc.say([privmsg("a", "1"), privmsg("b", "2")]);
    await waitFor(() => calls === 2);
    expect(c.status().state).toBe("joined");
  });
});

// ───────────────────────────── integración con las mascotas ─────────────────────────────

describe("chat de Twitch -> mascotas", () => {
  let h: Harness;
  beforeEach(async () => {
    irc = await FakeIrc.start();
    h = await makeHarness({ streamerLogin: "canal" });
  });
  afterEach(async () => {
    client?.stop();
    client = undefined;
    await h.handle.close();
  });

  const start = () => {
    client = startTwitchChat({
      service: h.service,
      streamerId: h.streamerId,
      channel: "canal",
      url: irc.url,
      log: silent,
      backoffMinMs: 20,
      backoffMaxMs: 80,
    });
    return client;
  };

  it("quien escribe recibe mascota; bots y la streamer se ignoran; los subs quedan marcados", async () => {
    const c = start();
    await waitFor(() => c.status().state === "joined");
    irc.say([
      privmsg("luna", "100", { badges: "subscriber/3", display: "Luna" }),
      privmsg("kiko", "200"),
      privmsg("nightbot", "300", { badges: "moderator/1" }),
      privmsg("canal", "400", { badges: "broadcaster/1" }),
      privmsg("luna", "100", { badges: "subscriber/3", display: "Luna" }),
    ]);
    await waitFor(() => c.status().messages === 5);
    await wait(300);

    const names = (await h.service.snapshot(h.streamerId)).pets.map((p) => p.name).sort();
    expect(names).toEqual(["Luna", "kiko"]);

    await h.service.flush();
    const luna = await repo.findViewerByTwitchId(h.handle.db, h.streamerId, "100");
    expect(luna?.viewer.isSubscriber).toBe(true);
    expect(luna?.viewer.messageCount).toBe(2);
    expect((await repo.findViewerByTwitchId(h.handle.db, h.streamerId, "200"))?.viewer.isSubscriber).toBe(false);
    expect(await repo.findViewerByTwitchId(h.handle.db, h.streamerId, "300")).toBeUndefined();
    expect(await repo.findViewerByTwitchId(h.handle.db, h.streamerId, "400")).toBeUndefined();
  });

  it("con 'solo subs' activado, los demás no reciben mascota", async () => {
    await repo.updateSettings(h.handle.db, h.streamerId, { subsOnly: true });
    await h.service.refreshSettings(h.streamerId);
    const c = start();
    await waitFor(() => c.status().state === "joined");
    irc.say([privmsg("luna", "100", { badges: "subscriber/1" }), privmsg("kiko", "200")]);
    await waitFor(() => c.status().messages === 2);
    await wait(300);
    expect((await h.service.snapshot(h.streamerId)).pets.map((p) => p.name)).toEqual(["luna"]);
  });

  it("un diluvio de mensajes del mismo usuario crea una sola mascota", async () => {
    const c = start();
    await waitFor(() => c.status().state === "joined");
    irc.say(Array.from({ length: 60 }, () => privmsg("luna", "100")));
    await waitFor(() => c.status().messages === 60);
    await wait(300);
    expect(await h.service.activeCount(h.streamerId)).toBe(1);
  });
});

// ───────────────────────────── configuración ─────────────────────────────

describe("configuración de Twitch", () => {
  const base = { NODE_ENV: "test" };

  it("viene apagada por defecto", () => {
    expect(loadConfig({ ...base }).twitchChatEnabled).toBe(false);
  });

  it("usa STREAMER_LOGIN como canal y lo deja limpio (sin @ ni mayúsculas)", () => {
    const c = loadConfig({ ...base, TWITCH_CHAT_ENABLED: "true", STREAMER_LOGIN: " @NazhiTV " });
    expect(c).toMatchObject({ twitchChatEnabled: true, twitchChannel: "nazhitv", streamerLogin: "nazhitv", twitchAuth: undefined });
  });

  it("TWITCH_CHANNEL manda sobre STREAMER_LOGIN", () => {
    expect(loadConfig({ ...base, TWITCH_CHAT_ENABLED: "1", STREAMER_LOGIN: "a", TWITCH_CHANNEL: "#Otro" }).twitchChannel).toBe("otro");
  });

  it("exige decir el canal: no vale leer el de ejemplo", () => {
    expect(() => loadConfig({ ...base, TWITCH_CHAT_ENABLED: "true" })).toThrow(ConfigError);
  });

  it("rechaza canales inválidos", () => {
    expect(() => loadConfig({ ...base, TWITCH_CHAT_ENABLED: "true", STREAMER_LOGIN: "con espacio" })).toThrow(/no es válido/);
  });

  it("cuenta y token van juntos, y el prefijo oauth: se quita", () => {
    expect(() => loadConfig({ ...base, TWITCH_CHAT_ENABLED: "true", STREAMER_LOGIN: "a", TWITCH_OAUTH_TOKEN: "abcdefghij12" })).toThrow(/van juntos/);
    expect(() => loadConfig({ ...base, TWITCH_CHAT_ENABLED: "true", STREAMER_LOGIN: "a", TWITCH_BOT_LOGIN: "bot" })).toThrow(/van juntos/);
    const c = loadConfig({ ...base, TWITCH_CHAT_ENABLED: "true", STREAMER_LOGIN: "a", TWITCH_BOT_LOGIN: "MiBot", TWITCH_OAUTH_TOKEN: "oauth:abcdefghij1234567890" });
    expect(c.twitchAuth).toEqual({ login: "mibot", token: "abcdefghij1234567890" });
  });

  it("rechaza un token con formato imposible", () => {
    expect(() =>
      loadConfig({ ...base, TWITCH_CHAT_ENABLED: "true", STREAMER_LOGIN: "a", TWITCH_BOT_LOGIN: "bot", TWITCH_OAUTH_TOKEN: "corto" }),
    ).toThrow(/formato/);
  });

  it("con el chat apagado no valida nada de Twitch", () => {
    expect(() => loadConfig({ ...base, TWITCH_OAUTH_TOKEN: "x" })).not.toThrow();
  });
});
