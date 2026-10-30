import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Los tests pueden correr contra un Postgres real (TEST_DATABASE_URL) que comparten: en serie.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
