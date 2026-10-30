import { defineConfig } from "drizzle-kit";

// Solo se usa para generar migraciones SQL (pnpm --filter @streampets/server db:generate).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
