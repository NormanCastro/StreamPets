import { defineConfig } from "vite";

export default defineConfig({
  // Los assets (especies) viven en una carpeta compartida con el servidor y el overlay.
  publicDir: "../../shared-public",
  server: { host: "0.0.0.0", port: 5173 },
  build: { target: "es2022", sourcemap: true },
});
