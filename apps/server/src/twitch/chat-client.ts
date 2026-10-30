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
  /** Canal a leer, en minúsculas y sin "#". */
  channel: string;
  url?: string;
  /** Si se omite, se entra como lector anónimo (sin token). Con token es la vía oficial. */
  auth?: { login: string; token: string } | undefined;
  onMessage: (msg: TwitchChatMessage) => void;
  log: ClientLogger;
  /** Sin recibir nada durante este tiempo se da la conexión por muerta y se reconecta. */
  idleTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
}

export type TwitchChatState = "idle" | "connecting" | "connected" | "joined" | "reconnecting" | "failed" | "stopped";

export interface TwitchChatStatus {
  state: TwitchChatState;
  channel: string;
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
 * Lector del chat de un canal de Twitch por IRC sobre WebSocket.
 * Solo lee: nunca envía mensajes al chat. Se reconecta solo si la conexión se cae o Twitch lo pide.
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
  private stopped = false;
  private readonly idleTimeoutMs: number;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly random: () => number;

  constructor(private readonly opts: TwitchChatClientOptions) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;
    this.minMs = opts.backoffMinMs ?? 1_000;
    this.maxMs = opts.backoffMaxMs ?? 30_000;
    this.random = opts.random ?? Math.random;
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
    this.ws?.close();
    this.ws = undefined;
  }

  status(): TwitchChatStatus {
    return {
      state: this.state,
      channel: this.opts.channel,
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
      this.send(ws, `JOIN #${this.opts.channel}`);
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
      this.ws = undefined;
      if (this.stopped || this.state === "failed") return;
      this.scheduleReconnect();
    });
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
      case "ROOMSTATE":
        if (this.state !== "joined") {
          this.state = "joined";
          this.attempt = 0;
          this.opts.log.info({ channel: this.opts.channel, authenticated: this.opts.auth !== undefined }, "Twitch: leyendo el chat");
        }
        return;
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
        if (!chat) return;
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
