import WebSocket from "ws";
import { parseIrcLine, toChatMessage } from "./irc.js";
import type { TwitchChatMessage } from "./irc.js";

export const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443";

export interface ClientLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface TwitchChatClientOptions {
  /** Canales a leer desde el inicio, en minúsculas y sin "#". Se pueden sumar y quitar con join/part. */
  channels?: string[];
  url?: string;
  /** Si se omite, se entra como lector anónimo (sin token). Con token es la vía oficial. */
  auth?: { login: string; token: string } | undefined;
  onMessage: (msg: TwitchChatMessage) => void;
  log: ClientLogger;
  /** Sin recibir nada durante este tiempo se da la conexión por muerta y se reconecta. */
  idleTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Pausa entre un JOIN y el siguiente, para no pasarse del límite de Twitch al entrar a muchos canales. */
  joinIntervalMs?: number;
  random?: () => number;
}

export type TwitchChatState = "idle" | "connecting" | "connected" | "joined" | "reconnecting" | "failed" | "stopped";

export interface TwitchChatStatus {
  state: TwitchChatState;
  /** Canales que se quieren leer. */
  channels: string[];
  /** Cuántos de ellos ya confirmó Twitch. */
  joinedChannels: number;
  authenticated: boolean;
  /** Mensajes de chat recibidos desde que arrancó el servidor. */
  messages: number;
  lastMessageAt: number | null;
  reconnects: number;
}

/** Espera antes del intento n (0 = primero): crece al doble hasta un tope, con ±25 % de variación. */
export function nextDelay(attempt: number, minMs: number, maxMs: number, random: () => number): number {
  const base = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30));
  return Math.round(base * (0.75 + random() * 0.5));
}

const MAX_FRAME_BYTES = 64 * 1024;

/**
 * Lector del chat de uno o varios canales de Twitch por IRC sobre WebSocket (una sola conexión).
 * Solo lee: nunca envía mensajes al chat. Se reconecta solo si la conexión se cae o Twitch lo pide,
 * y vuelve a entrar a todos los canales.
 */
export class TwitchChatClient {
  private ws: WebSocket | undefined;
  private state: TwitchChatState = "idle";
  private attempt = 0;
  private reconnects = 0;
  private messages = 0;
  private lastMessageAt: number | null = null;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private joinTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly wanted = new Set<string>();
  private readonly joined = new Set<string>();
  private joinQueue: string[] = [];
  private readonly idleTimeoutMs: number;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly joinIntervalMs: number;
  private readonly random: () => number;

  constructor(private readonly opts: TwitchChatClientOptions) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;
    this.minMs = opts.backoffMinMs ?? 1_000;
    this.maxMs = opts.backoffMaxMs ?? 30_000;
    this.joinIntervalMs = opts.joinIntervalMs ?? 500;
    this.random = opts.random ?? Math.random;
    for (const c of opts.channels ?? []) this.wanted.add(c);
  }

  start(): void {
    if (this.state !== "idle") return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.state = "stopped";
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.joinTimer);
    this.ws?.close();
    this.ws = undefined;
  }

  /** Empieza a leer otro canal (también con la conexión ya abierta). */
  join(channel: string): void {
    if (this.wanted.has(channel)) return;
    this.wanted.add(channel);
    if (this.ws && (this.state === "connected" || this.state === "joined")) this.queueJoin(this.ws, channel);
  }

  /** Deja de leer un canal: aunque Twitch siga mandando algo, ya no se entrega. */
  part(channel: string): void {
    if (!this.wanted.delete(channel)) return;
    this.joined.delete(channel);
    this.joinQueue = this.joinQueue.filter((c) => c !== channel);
    if (this.ws) this.send(this.ws, `PART #${channel}`);
  }

  isJoined(channel: string): boolean {
    return this.joined.has(channel);
  }

  status(): TwitchChatStatus {
    return {
      state: this.state,
      channels: [...this.wanted].sort(),
      joinedChannels: this.joined.size,
      authenticated: this.opts.auth !== undefined,
      messages: this.messages,
      lastMessageAt: this.lastMessageAt,
      reconnects: this.reconnects,
    };
  }

  private connect(): void {
    if (this.stopped) return;
    this.state = this.reconnects === 0 && this.attempt === 0 ? "connecting" : "reconnecting";
    const ws = new WebSocket(this.opts.url ?? TWITCH_IRC_URL, { maxPayload: MAX_FRAME_BYTES });
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.state = "connected";
      this.joined.clear();
      this.armIdle(ws);
      // Sin "tags" no llegan ni el id de usuario ni las insignias; "tags" exige "commands".
      this.send(ws, "CAP REQ :twitch.tv/tags twitch.tv/commands");
      if (this.opts.auth) {
        this.send(ws, `PASS oauth:${this.opts.auth.token}`);
        this.send(ws, `NICK ${this.opts.auth.login}`);
      } else {
        // Lector anónimo: nick "justinfan" + número y cualquier contraseña no vacía.
        this.send(ws, "PASS anonymous");
        this.send(ws, `NICK justinfan${10_000 + Math.floor(this.random() * 89_999)}`);
      }
      this.joinQueue = [...this.wanted];
      this.drainJoins(ws);
    });

    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      this.armIdle(ws);
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
      for (const line of text.split("\n")) this.handleLine(ws, line);
    });

    ws.on("error", (err) => {
      // Detrás de este evento siempre llega "close", que es quien reintenta.
      this.opts.log.warn({ err: err.message }, "Twitch: error de conexión");
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      clearTimeout(this.idleTimer);
      clearTimeout(this.joinTimer);
      this.ws = undefined;
      this.joined.clear();
      if (this.stopped || this.state === "failed") return;
      this.scheduleReconnect();
    });
  }

  private queueJoin(ws: WebSocket, channel: string): void {
    if (!this.joinQueue.includes(channel)) this.joinQueue.push(channel);
    if (this.joinTimer === undefined) this.drainJoins(ws);
  }

  /** Manda un JOIN por turno, con una pausa entre ellos. */
  private drainJoins(ws: WebSocket): void {
    this.joinTimer = undefined;
    if (this.ws !== ws) return;
    const channel = this.joinQueue.shift();
    if (channel === undefined) return;
    if (this.wanted.has(channel)) this.send(ws, `JOIN #${channel}`);
    if (this.joinQueue.length > 0) {
      this.joinTimer = setTimeout(() => this.drainJoins(ws), this.joinIntervalMs);
    }
  }

  private handleLine(ws: WebSocket, line: string): void {
    const msg = parseIrcLine(line);
    if (!msg) return;
    switch (msg.command) {
      case "PING":
        this.send(ws, `PONG :${msg.params[msg.params.length - 1] ?? "tmi.twitch.tv"}`);
        return;
      case "RECONNECT":
        this.opts.log.info({}, "Twitch pidió reconectar");
        ws.close();
        return;
      case "ROOMSTATE": {
        const channel = (msg.params[0] ?? "").replace(/^#/, "").toLowerCase();
        if (this.wanted.has(channel) && !this.joined.has(channel)) {
          this.joined.add(channel);
          this.opts.log.info({ channel, authenticated: this.opts.auth !== undefined }, "Twitch: leyendo el chat");
        }
        if (this.state !== "joined") {
          this.state = "joined";
          this.attempt = 0;
        }
        return;
      }
      case "CAP":
        if (msg.params.includes("NAK")) this.fail(ws, "Twitch rechazó las capacidades del chat (sin ellas no se pueden identificar los usuarios)");
        return;
      case "NOTICE": {
        const text = msg.params[msg.params.length - 1] ?? "";
        if (/Login authentication failed|Improperly formatted auth/i.test(text)) {
          this.fail(ws, `Twitch rechazó el token del chat: ${text}`);
        } else {
          this.opts.log.warn({ notice: text }, "Twitch: aviso del servidor");
        }
        return;
      }
      case "PRIVMSG": {
        const chat = toChatMessage(msg);
        if (!chat || !this.wanted.has(chat.channel)) return;
        this.messages++;
        this.lastMessageAt = Date.now();
        try {
          this.opts.onMessage(chat);
        } catch (err) {
          this.opts.log.error({ err }, "Twitch: fallo al procesar un mensaje");
        }
        return;
      }
      default:
        return;
    }
  }

  /** Error que no se arregla reintentando (token inválido, capacidades rechazadas). */
  private fail(ws: WebSocket, reason: string): void {
    this.state = "failed";
    this.opts.log.error({ reason }, "Twitch: lector detenido");
    ws.close();
  }

  private scheduleReconnect(): void {
    const delay = nextDelay(this.attempt, this.minMs, this.maxMs, this.random);
    this.attempt++;
    this.reconnects++;
    this.state = "reconnecting";
    this.opts.log.warn({ inMs: delay, attempt: this.attempt }, "Twitch: conexión perdida, reintentando");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private armIdle(ws: WebSocket): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.ws !== ws) return;
      this.opts.log.warn({ afterMs: this.idleTimeoutMs }, "Twitch: sin señales, se reinicia la conexión");
      ws.terminate();
    }, this.idleTimeoutMs);
  }

  private send(ws: WebSocket, line: string): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(line);
  }
}
