// Bundles the standalone launcher into a self-contained Node ESM artifact so
// packaged CLI/desktop builds can ship it without the monorepo source tree.

import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/launcher.ts"],
  format: ["esm"],
  outDir: "dist",
  sourcemap: false,
  clean: true,
  noExternal: (id) => id.startsWith("@synara/"),
  inlineOnly: false,
});
