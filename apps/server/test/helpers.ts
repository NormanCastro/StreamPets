import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { ServerMessage } from "@streampets/shared";
import { createDb } from "../src/db/client.js";
import type { DbHandle } from "../src/db/client.js";
import * as repo from "../src/db/repo.js";
import { ChatService } from "../src/domain/chat-service.js";
import type { Broadcaster, ChatInput } from "../src/domain/chat-service.js";
import { seededRng } from "../src/domain/rng.js";
import type { Clock } from "../src/domain/rng.js";
import { SpeciesCatalog } from "../src/domain/species.js";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, "../drizzle");
export const ASSETS_DIR = resolve(here, "../../../shared-public/assets");

/**
 * Base de datos de pruebas. Por defecto PGlite en memoria; si TEST_DATABASE_URL está definida,
 * se usa ese Postgres real (se vacía antes de migrar).
 */
export async function makeTestDb(): Promise<DbHandle> {
  const url = process.env["TEST_DATABASE_URL"];
  const handle = await createDb({ databaseUrl: url });
  if (url) {
    await handle.db.execute(sql`drop schema if exists drizzle cascade`);
    await handle.db.execute(sql`drop schema if exists public cascade`);
    await handle.db.execute(sql`create schema public`);
  }
  await handle.migrate(MIGRATIONS_DIR);
  return handle;
}

export class FakeClock implements Clock {
  constructor(public t = 1_700_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class RecordingBroadcaster implements Broadcaster {
  readonly events: Array<{ streamerId: string; message: ServerMessage }> = [];
  emit(streamerId: string, message: ServerMessage): void {
    this.events.push({ streamerId, message });
  }
  types(streamerId?: string): string[] {
    return this.events.filter((e) => streamerId === undefined || e.streamerId === streamerId).map((e) => e.message.type);
  }
  clear(): void {
    this.events.length = 0;
  }
}

export const silentLog = { warn: () => undefined, error: () => undefined };

export function makeCatalog(ids: string[] = ["shiba", "cat", "bunny"]): SpeciesCatalog {
  return new SpeciesCatalog(ids.map((id) => ({ id, name: id, url: `/assets/species/${id}/species.json` })));
}

export interface Harness {
  handle: DbHandle;
  clock: FakeClock;
  broadcaster: RecordingBroadcaster;
  catalog: SpeciesCatalog;
  service: ChatService;
  streamerId: string;
  streamerLogin: string;
  /** Crea otro servicio sobre la misma base (simula reiniciar el servidor). */
  newService(): ChatService;
}

export async function makeHarness(opts: { species?: string[]; streamerLogin?: string } = {}): Promise<Harness> {
  const handle = await makeTestDb();
  const clock = new FakeClock();
  const broadcaster = new RecordingBroadcaster();
  const catalog = makeCatalog(opts.species);
  const streamerLogin = opts.streamerLogin ?? "streamer";
  const streamer = await repo.ensureStreamer(handle.db, { login: streamerLogin, displayName: "Streamer" });
  const newService = (): ChatService =>
    new ChatService({ db: handle.db, broadcaster, species: catalog, clock, rng: seededRng(7), log: silentLog });
  return {
    handle,
    clock,
    broadcaster,
    catalog,
    service: newService(),
    streamerId: streamer.id,
    streamerLogin,
    newService,
  };
}

export function chat(streamerId: string, login: string, over: Partial<ChatInput> = {}): ChatInput {
  return {
    streamerId,
    twitchUserId: over.twitchUserId ?? `id-${login}`,
    login,
    displayName: over.displayName ?? login,
    isSubscriber: over.isSubscriber ?? false,
    ...over,
  };
}
