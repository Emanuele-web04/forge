// FILE: tsdown.config.ts
// Purpose: Builds the Synara server CLI and controls diagnostic source maps.
// Layer: Server build config
// Depends on: tsdown.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";
import {
  MIGRATION_RUNTIME_SOURCE_RELATIVE_PATH,
  migrationRuntimeSourceDigest,
} from "../../packages/shared/src/migrationSafety.ts";

const sourcemapEnv = process.env.SYNARA_SERVER_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationRuntimeSource = fs.readFileSync(
  path.join(repoRoot, MIGRATION_RUNTIME_SOURCE_RELATIVE_PATH),
  "utf8",
);

export default defineConfig({
  entry: ["src/index.ts", "src/restoreMigrationBackup.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  // Bun builtins only resolve at runtime under Bun; MigrationBackup.ts guards
  // the import behind a `process.versions.bun` check.
  external: [/^bun:/u],
  sourcemap: buildSourcemap,
  define: {
    __SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST__: JSON.stringify(
      migrationRuntimeSourceDigest(migrationRuntimeSource),
    ),
  },
  clean: true,
  noExternal: (id) => id.startsWith("@synara/"),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
