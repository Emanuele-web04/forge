import os from "node:os";
import path from "node:path";
import { defineConfig, mergeConfig } from "vite";

import appConfig from "../vite.config";

// The app config is a factory (React Compiler is gated on `command`), so it is
// resolved with the real env before merging: `vite build` compiles, `vite
// preview` serves the built output.
export default defineConfig((env) =>
  mergeConfig(appConfig(env), {
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
          concurrent: path.resolve(import.meta.dirname, "concurrent.html"),
        },
      },
    },
  }),
);
