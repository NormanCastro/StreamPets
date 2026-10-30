import { defineConfig } from "vite";

// El servidor sirve esta página en /overlay/pets/:token y los sprites en /assets.
export default defineConfig({
  base: "/overlay/",
  publicDir: false,
  server: {
    port: 5174,
    proxy: {
      "/ws": { target: "ws://localhost:3000", ws: true },
      "/api": "http://localhost:3000",
      "/assets": "http://localhost:3000",
    },
  },
  build: { target: "es2022", sourcemap: true },
});
