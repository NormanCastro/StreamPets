import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import * as repo from "./db/repo.js";
import { SpeciesCatalog } from "./domain/species.js";
import { startTwitchChat } from "./twitch/start.js";

const SWEEP_MS = 5_000;
const FLUSH_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const handle = await createDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
  await handle.migrate(config.migrationsDir);
  const streamer = await repo.ensureStreamer(handle.db, {
    login: config.streamerLogin,
    displayName: config.streamerDisplayName,
  });
  const species = SpeciesCatalog.fromAssetsDir(config.assetsDir);

  let twitchStatus: (() => unknown) | undefined;
  const { app, service } = await buildApp({
    db: handle.db,
    species,
    adminToken: config.adminToken,
    streamerId: streamer.id,
    assetsDir: config.assetsDir,
    overlayDist: config.overlayDist,
    dashboardDist: config.dashboardDist,
    allowedOrigins: config.allowedOrigins,
    enableDevChat: config.enableDevChat,
    trustProxy: config.trustProxy,
    logLevel: config.logLevel,
    twitchStatus: () => twitchStatus?.() ?? null,
  });

  const twitch = config.twitchChatEnabled
    ? startTwitchChat({
        service,
        streamerId: streamer.id,
        channel: config.twitchChannel,
        url: config.twitchIrcUrl,
        auth: config.twitchAuth,
        log: app.log,
      })
    : undefined;
  twitchStatus = twitch ? () => twitch.status() : undefined;

  const guard = (name: string, fn: () => Promise<unknown>) => () => {
    fn().catch((err: unknown) => app.log.error({ err }, `fallo en ${name}`));
  };
  const sweepTimer = setInterval(guard("sweep", () => service.sweep()), SWEEP_MS);
  const flushTimer = setInterval(guard("flush", () => service.flush()), FLUSH_MS);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "cerrando");
    clearInterval(sweepTimer);
    clearInterval(flushTimer);
    twitch?.stop();
    try {
      await app.close();
      await service.flush();
      await handle.close();
    } catch (err) {
      app.log.error({ err }, "error al cerrar");
      process.exitCode = 1;
    }
    process.exit();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
  if (config.adminTokenGenerated) {
    app.log.warn(`ADMIN_TOKEN no definido: usando uno temporal de desarrollo: ${config.adminToken}`);
  }
  app.log.info(
    { db: handle.kind, streamer: streamer.login, devChat: config.enableDevChat, twitchChat: config.twitchChatEnabled },
    "StreamPets listo",
  );
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(err);
  process.exit(1);
});
