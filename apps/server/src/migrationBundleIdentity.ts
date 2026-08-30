import * as fs from "node:fs";
import * as path from "node:path";

import {
  MIGRATION_RUNTIME_SOURCE_RELATIVE_PATH,
  findMigrationRuntimeIdentityMismatch,
  type MigrationRuntimeIdentityMismatch,
} from "@synara/shared/migrationRecovery";

declare const __SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST__: string;

export class MigrationRuntimeIdentityMismatchError extends Error {
  readonly _tag = "MigrationRuntimeIdentityMismatchError";

  constructor(readonly mismatch: MigrationRuntimeIdentityMismatch) {
    const [relationship, recovery] =
      mismatch.kind === "launcher-bundle"
        ? [
            "desktop and server bundles were built from different migration sources",
            "Rebuild with bun run build:desktop before starting Synara.",
          ]
        : [
            "the server bundle was built from a different migration source than this checkout",
            "Rebuild the server with bun run build before starting Synara.",
          ];
    super(
      `Refusing database startup because ${relationship}. ` +
        `Expected ${mismatch.expectedDigest}, but the server bundle contains ` +
        `${mismatch.actualDigest}. ${recovery}`,
    );
    this.name = "MigrationRuntimeIdentityMismatchError";
  }
}

export function embeddedMigrationRuntimeSourceDigest(): string | null {
  return typeof __SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST__ === "string"
    ? __SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST__
    : null;
}

export function verifyMigrationRuntimeIdentity(input: {
  readonly cwd: string;
  readonly embeddedDigest: string | null;
  readonly launcherDigest?: string | undefined;
}): void {
  if (input.embeddedDigest === null) {
    if (input.launcherDigest) {
      throw new Error(
        "Refusing database startup because the server bundle has no migration source identity. " +
          "Rebuild with bun run build:desktop before starting Synara.",
      );
    }
    return;
  }

  const sourceText = readMigrationSourceIfPresent(input.cwd);
  const mismatch = findMigrationRuntimeIdentityMismatch({
    embeddedDigest: input.embeddedDigest,
    launcherDigest: input.launcherDigest,
    sourceText,
  });
  if (mismatch) throw new MigrationRuntimeIdentityMismatchError(mismatch);
}

function readMigrationSourceIfPresent(cwd: string): string | undefined {
  if (!isSynaraSourceCheckout(cwd)) return undefined;
  const sourcePath = path.resolve(cwd, MIGRATION_RUNTIME_SOURCE_RELATIVE_PATH);
  try {
    return fs.readFileSync(sourcePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

function isSynaraSourceCheckout(cwd: string): boolean {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(cwd, "package.json"), "utf8")) as {
      readonly name?: unknown;
    };
    return packageJson.name === "@synara/monorepo";
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}
