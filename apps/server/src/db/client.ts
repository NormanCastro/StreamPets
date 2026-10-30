import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.js";

/** Tipo común a node-postgres y PGlite: el resto del código no sabe cuál se usa. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

export interface DbHandle {
  db: Db;
  kind: "postgres" | "pglite";
  /** Aplica las migraciones SQL pendientes. */
  migrate(migrationsFolder: string): Promise<void>;
  close(): Promise<void>;
}

export interface DbOptions {
  /** Cadena de conexión a Postgres. Sin ella se usa PGlite. */
  databaseUrl?: string | undefined;
  /** Carpeta de datos de PGlite. Si es undefined, PGlite vive en memoria. */
  pgliteDir?: string | undefined;
}

export async function createDb(opts: DbOptions): Promise<DbHandle> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 });
    // Un error en una conexión ociosa no debe tumbar el proceso.
    pool.on("error", (err) => console.error("[db] error en conexión ociosa:", err.message));
    const db = drizzlePg(pool, { schema });
    return {
      db,
      kind: "postgres",
      migrate: (folder) => migratePg(db, { migrationsFolder: folder }),
      close: () => pool.end(),
    };
  }

  if (opts.pgliteDir) mkdirSync(opts.pgliteDir, { recursive: true });
  const client = opts.pgliteDir ? new PGlite(opts.pgliteDir) : new PGlite();
  await client.waitReady;
  const db = drizzlePglite(client, { schema });
  return {
    db,
    kind: "pglite",
    migrate: (folder) => migratePglite(db, { migrationsFolder: folder }),
    close: () => client.close(),
  };
}
