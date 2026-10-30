import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// El servidor sirve el dashboard compilado en /admin/. En desarrollo, /api se redirige al servidor.
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  server: {
    port: 5175,
    proxy: { "/api": "http://localhost:3000", "/assets": "http://localhost:3000" },
  },
  build: { target: "es2022", sourcemap: true },
});
