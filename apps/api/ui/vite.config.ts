// FILE: ui/vite.config.ts
// Purpose: Builds the account ceremony UI served by the API at non-/api paths.
// Layer: Account UI build config
// Depends on: Vite, React plugin, Tailwind v4 plugin.

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const uiRoot = fileURLToPath(new URL(".", import.meta.url));
const apiPort = Number(process.env.PORT ?? 8788);

export default defineConfig({
  root: uiRoot,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5788,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
});
