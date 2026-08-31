// FILE: tsdown.config.ts
// Purpose: Builds Electron main/preload code and controls diagnostic source maps.
// Layer: Desktop build config
// Depends on: tsdown.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

const sourcemapEnv = process.env.SYNARA_DESKTOP_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";
const windowsUpdaterPublisher = process.env.AZURE_TRUSTED_SIGNING_SUBJECT_DN?.trim() ?? "";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationRuntimeSource = fs.readFileSync(
  path.join(repoRoot, "apps/server/src/persistence/Migrations.ts"),
  "utf8",
);
const migrationRuntimeSourceDigest = createHash("sha256")
  .update(migrationRuntimeSource, "utf8")
  .digest("hex");

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: buildSourcemap,
  outExtensions: () => ({ js: ".js" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    // Electron exposes this builtin only at runtime; keeping it external avoids
    // asking Rolldown to resolve a package that intentionally does not exist.
    external: ["original-fs"],
    define: {
      __SYNARA_WINDOWS_UPDATER_PUBLISHER__: JSON.stringify(windowsUpdaterPublisher),
      __SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST__: JSON.stringify(migrationRuntimeSourceDigest),
    },
    noExternal: (id) => id.startsWith("@synara/"),
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
  {
    ...shared,
    entry: ["src/browserAnnotations/guestPreload.ts"],
  },
]);
