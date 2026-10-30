import type { ChatService } from "../domain/chat-service.js";
import { TwitchChatClient } from "./chat-client.js";
import type { ClientLogger } from "./chat-client.js";

export interface StartTwitchChatOptions {
  service: ChatService;
  streamerId: string;
  channel: string;
  url?: string | undefined;
  auth?: { login: string; token: string } | undefined;
  log: ClientLogger;
  /** Solo para pruebas. */
  idleTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

/** Conecta el chat de un canal con el servicio que reparte las mascotas. */
export function startTwitchChat(o: StartTwitchChatOptions): TwitchChatClient {
  const client = new TwitchChatClient({
    channel: o.channel,
    ...(o.url ? { url: o.url } : {}),
    auth: o.auth,
    log: o.log,
    ...(o.idleTimeoutMs ? { idleTimeoutMs: o.idleTimeoutMs } : {}),
    ...(o.backoffMinMs ? { backoffMinMs: o.backoffMinMs } : {}),
    ...(o.backoffMaxMs ? { backoffMaxMs: o.backoffMaxMs } : {}),
    onMessage: (m) => {
      o.service
        .handleMessage({
          streamerId: o.streamerId,
          twitchUserId: m.userId,
          login: m.login,
          displayName: m.displayName,
          isSubscriber: m.isSubscriber,
        })
        .catch((err: unknown) => o.log.error({ err }, "Twitch: no se pudo asignar mascota"));
    },
  });
  client.start();
  return client;
}
