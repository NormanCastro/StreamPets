import type { WebSocket } from "ws";
import type { ServerMessage } from "@streampets/shared";
import type { Db } from "../db/client.js";
import * as repo from "../db/repo.js";
import type { Broadcaster } from "../domain/chat-service.js";
import { hashToken, looksLikeOverlayToken } from "../lib/tokens.js";

interface Client {
  socket: WebSocket;
  streamerId: string;
  overlayId: string;
  alive: boolean;
}

export const MAX_CONNECTIONS_PER_OVERLAY = 5;
const HEARTBEAT_MS = 15_000;

export type ConnectResult = { ok: true } | { ok: false; reason: "bad-token" | "too-many" };

/**
 * Overlays conectados, agrupados por streamer. Implementa Broadcaster: el servicio de chat
 * emite eventos y el hub los reparte solo a los overlays de ese streamer.
 */
export class OverlayHub implements Broadcaster {
  private readonly rooms = new Map<string, Set<Client>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly snapshot: (streamerId: string) => Promise<ServerMessage & { type: "snapshot" }>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const room of this.rooms.values()) for (const c of room) c.socket.close(1001, "server shutting down");
    this.rooms.clear();
  }

  emit(streamerId: string, message: ServerMessage): void {
    const room = this.rooms.get(streamerId);
    if (!room) return;
    const data = JSON.stringify(message);
    for (const c of room) this.send(c, data);
  }

  connectionCount(streamerId?: string): number {
    if (streamerId) return this.rooms.get(streamerId)?.size ?? 0;
    let n = 0;
    for (const room of this.rooms.values()) n += room.size;
    return n;
  }

  /** Cierra todas las conexiones de un overlay (al revocarlo o rotar su token). */
  closeOverlay(overlayId: string): void {
    for (const room of this.rooms.values()) {
      for (const c of room) if (c.overlayId === overlayId) c.socket.close(4001, "token revoked");
    }
  }

  /** Valida el token y registra el socket. Si no es válido lo cierra con un código claro. */
  async connect(socket: WebSocket, token: string | undefined): Promise<ConnectResult> {
    socket.on("error", () => undefined);
    if (!token || !looksLikeOverlayToken(token)) return this.reject(socket, "bad-token");

    const overlay = await repo.findActiveOverlayByHash(this.db, hashToken(token));
    if (!overlay) return this.reject(socket, "bad-token");
    if (socket.readyState !== socket.OPEN) return { ok: true };

    let room = this.rooms.get(overlay.streamerId);
    if (!room) this.rooms.set(overlay.streamerId, (room = new Set()));
    let same = 0;
    for (const c of room) if (c.overlayId === overlay.id) same++;
    if (same >= MAX_CONNECTIONS_PER_OVERLAY) return this.reject(socket, "too-many");

    const client: Client = { socket, streamerId: overlay.streamerId, overlayId: overlay.id, alive: true };
    room.add(client);
    const remove = (): void => {
      const r = this.rooms.get(client.streamerId);
      r?.delete(client);
      if (r && r.size === 0) this.rooms.delete(client.streamerId);
    };
    socket.on("close", remove);
    socket.on("pong", () => {
      client.alive = true;
    });
    // El overlay es de solo lectura: cualquier cosa que envíe se ignora.
    socket.on("message", () => undefined);

    try {
      this.send(client, JSON.stringify(await this.snapshot(overlay.streamerId)));
    } catch {
      socket.close(1011, "snapshot failed");
    }
    return { ok: true };
  }

  private reject(socket: WebSocket, reason: "bad-token" | "too-many"): ConnectResult {
    socket.close(reason === "bad-token" ? 4001 : 4002, reason);
    return { ok: false, reason };
  }

  private send(client: Client, data: string): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    // Un overlay que no drena su cola está colgado: se corta en vez de acumular memoria.
    if (client.socket.bufferedAmount > 1_000_000) {
      client.socket.terminate();
      return;
    }
    client.socket.send(data);
  }

  private heartbeat(): void {
    const hb = JSON.stringify({ type: "hb" } satisfies ServerMessage);
    for (const room of this.rooms.values()) {
      for (const c of room) {
        if (!c.alive) {
          c.socket.terminate();
          continue;
        }
        c.alive = false;
        try {
          c.socket.ping();
        } catch {
          c.socket.terminate();
          continue;
        }
        this.send(c, hb);
      }
    }
  }
}
