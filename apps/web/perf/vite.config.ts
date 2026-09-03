import os from "node:os";
import path from "node:path";
import { mergeConfig } from "vite";

import appConfig from "../vite.config";

export default mergeConfig(appConfig, {
  resolve: {
    alias: {
      // Production-mode React with the Profiler enabled, so harness runs can report
      // real commit counts/durations without dev-build overhead skewing timings.
      "react-dom/client": "react-dom/profiling",
    },
  },
  build: {
    emptyOutDir: true,
    outDir: path.join(os.tmpdir(), "synara-perf-dist"),
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, "index.html"),
        pipeline: path.resolve(import.meta.dirname, "pipeline.html"),
      },
    },
  },
});
