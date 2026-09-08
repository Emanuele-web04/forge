import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      hookTimeout: 15_000,
      testTimeout: 15_000,
    },
  }),
);
