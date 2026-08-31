import * as fs from "node:fs";
import * as path from "node:path";

import {
  MIGRATION_RUNTIME_SOURCE_RELATIVE_PATH,
  findMigrationRuntimeIdentityMismatch,
  type MigrationRuntimeIdentityMismatch,
} from "@synara/shared/migrationRecovery";

declare const __SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST__: string;

export function embeddedDesktopMigrationRuntimeSourceDigest(): string | null {
  return typeof __SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST__ === "string"
    ? __SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST__
    : null;
}

export function inspectDesktopMigrationRuntimeIdentity(input: {
  readonly appRoot: string;
  readonly isPackaged: boolean;
  readonly embeddedDigest: string | null;
}): MigrationRuntimeIdentityMismatch | null {
  if (input.embeddedDigest === null) {
    throw new Error("The desktop bundle has no embedded migration source identity.");
  }
  if (input.isPackaged) return null;

  const sourcePath = path.join(input.appRoot, MIGRATION_RUNTIME_SOURCE_RELATIVE_PATH);
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(sourcePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }

  return findMigrationRuntimeIdentityMismatch({
    embeddedDigest: input.embeddedDigest,
    sourceText,
  });
}
