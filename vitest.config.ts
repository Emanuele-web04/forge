import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The desktop suite runs memory-hard key derivation (scrypt) and live
    // BetterWright vault tests. On a shared, heavily concurrent host, they
    // can exceed the default 5s.
    testTimeout: 30_000,
  },
  resolve: {
    alias: [
      {
        find: /^@synara\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "./packages/contracts/src/index.ts"),
      },
      // The web app's `~` alias (only workspace that defines one), so its
      // modules stay importable from tests without rewriting to relative paths.
      {
        find: /^~\//,
        replacement: `${path.resolve(import.meta.dirname, "./apps/web/src")}/`,
      },
    ],
  },
});
