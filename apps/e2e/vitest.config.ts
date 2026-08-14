import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      hookTimeout: 90_000,
      testTimeout: 90_000,
    },
  }),
);
