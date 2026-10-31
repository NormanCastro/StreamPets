import type { ChatService } from "../domain/chat-service.js";
import { TwitchChatClient } from "./chat-client.js";
import type { ClientLogger, TwitchChatStatus } from "./chat-client.js";

export interface TwitchChatManagerOptions {
  service: ChatService;
  url?: string | undefined;
  auth?: { login: string; token: string } | undefined;
  log: ClientLogger;
  /** Solo para pruebas. */
  idleTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  joinIntervalMs?: number;
}

/**
 * Una sola conexión a Twitch para todos los canales de la plataforma. Sabe a qué streamer
 * pertenece cada canal y le entrega a ese streamer (y solo a él) los mensajes de su chat.
 */
export class TwitchChatManager {
  private readonly client: TwitchChatClient;
  private readonly byChannel = new Map<string, string>();
  private readonly channelOf = new Map<string, string>();

  constructor(o: TwitchChatManagerOptions) {
    this.client = new TwitchChatClient({
      ...(o.url ? { url: o.url } : {}),
      auth: o.auth,
      log: o.log,
      ...(o.idleTimeoutMs !== undefined ? { idleTimeoutMs: o.idleTimeoutMs } : {}),
      ...(o.backoffMinMs !== undefined ? { backoffMinMs: o.backoffMinMs } : {}),
      ...(o.backoffMaxMs !== undefined ? { backoffMaxMs: o.backoffMaxMs } : {}),
      ...(o.joinIntervalMs !== undefined ? { joinIntervalMs: o.joinIntervalMs } : {}),
      onMessage: (m) => {
        const streamerId = this.byChannel.get(m.channel);
        if (!streamerId) return;
        o.service
          .handleMessage({
            streamerId,
            twitchUserId: m.userId,
            login: m.login,
            displayName: m.displayName,
            isSubscriber: m.isSubscriber,
          })
          .catch((err: unknown) => o.log.error({ err }, "Twitch: no se pudo asignar mascota"));
      },
    });
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  /** Asocia el canal a un streamer y empieza a leerlo. Si el streamer cambió de canal, deja el anterior. */
  add(streamerId: string, channel: string): void {
    const previous = this.channelOf.get(streamerId);
    if (previous !== undefined && previous !== channel) this.drop(previous);
    this.channelOf.set(streamerId, channel);
    this.byChannel.set(channel, streamerId);
    this.client.join(channel);
  }

  /** Deja de leer el canal de este streamer. */
  remove(streamerId: string): void {
    const channel = this.channelOf.get(streamerId);
    if (channel !== undefined) this.drop(channel);
    this.channelOf.delete(streamerId);
  }

  private drop(channel: string): void {
    this.byChannel.delete(channel);
    this.client.part(channel);
  }

  /** Estado completo (para el administrador). */
  status(): TwitchChatStatus {
    return this.client.status();
  }

  /** Estado visible para un streamer: nada de los canales de los demás. */
  statusFor(streamerId: string): { state: string; reading: boolean } {
    const channel = this.channelOf.get(streamerId);
    return { state: this.client.status().state, reading: channel !== undefined && this.client.isJoined(channel) };
  }
}
