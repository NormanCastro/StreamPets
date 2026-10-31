import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import * as repo from "./db/repo.js";
import { SpeciesCatalog } from "./domain/species.js";
import { TwitchOAuth } from "./auth/twitch-oauth.js";
import { TwitchChatManager } from "./twitch/start.js";

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
  // El canal del dueño siempre está autorizado.
  await repo.addAllowedChannel(handle.db, config.streamerLogin);
  const species = SpeciesCatalog.fromAssetsDir(config.assetsDir);

  const oauth = config.twitchLogin
    ? new TwitchOAuth({
        clientId: config.twitchLogin.clientId,
        clientSecret: config.twitchLogin.clientSecret,
        redirectUri: config.twitchLogin.redirectUri,
        ...(config.twitchLogin.idBaseUrl ? { idBaseUrl: config.twitchLogin.idBaseUrl } : {}),
      })
    : undefined;

  let chat: TwitchChatManager | undefined;
  const { app, service } = await buildApp({
    db: handle.db,
    species,
    adminToken: config.adminToken,
    streamerId: streamer.id,
    ownerLogin: config.streamerLogin,
    auth: { cookieSecure: config.cookieSecure, publicOrigin: config.publicOrigin, sessionTtlMs: config.sessionTtlMs },
    oauth,
    onStreamerReady: (id, login) => chat?.add(id, login),
    onChannelRemoved: (id) => chat?.remove(id),
    assetsDir: config.assetsDir,
    overlayDist: config.overlayDist,
    dashboardDist: config.dashboardDist,
    allowedOrigins: config.allowedOrigins,
    enableDevChat: config.enableDevChat,
    trustProxy: config.trustProxy,
    logLevel: config.logLevel,
    twitchStatus: (id, role) => (chat ? (role === "admin" ? chat.status() : chat.statusFor(id)) : null),
  });

  if (config.twitchChatEnabled) {
    chat = new TwitchChatManager({ service, url: config.twitchIrcUrl, auth: config.twitchAuth, log: app.log });
    chat.start();
    // Canal del dueño (puede ser distinto del login si se definió TWITCH_CHANNEL) y los demás autorizados.
    chat.add(streamer.id, config.twitchChannel);
    for (const c of await repo.listActiveStreamerChannels(handle.db)) {
      if (c.streamerId !== streamer.id) chat.add(c.streamerId, c.login);
    }
  }

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
    chat?.stop();
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
    {
      db: handle.kind,
      streamer: streamer.login,
      devChat: config.enableDevChat,
      twitchChat: config.twitchChatEnabled,
      twitchLogin: oauth !== undefined,
    },
    "StreamPets listo",
  );
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(err);
  process.exit(1);
});
