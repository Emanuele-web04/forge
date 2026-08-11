import os from "node:os";
import path from "node:path";
import { mergeConfig } from "vite";

import appConfig from "../vite.config";

export default mergeConfig(appConfig, {
  build: {
    emptyOutDir: true,
    outDir: path.join(os.tmpdir(), "synara-perf-dist"),
    rollupOptions: {
      input: path.resolve(import.meta.dirname, "index.html"),
    },
  },
});
