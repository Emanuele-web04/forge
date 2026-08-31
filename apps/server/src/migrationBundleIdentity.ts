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
    if (input.launcherDigest !== undefined) {
      throw new MigrationRuntimeIdentityMismatchError({
        kind: "launcher-bundle",
        expectedDigest: input.launcherDigest,
        actualDigest: "no embedded migration source identity",
      });
    }
    return;
  }

  if (input.launcherDigest !== undefined) {
    const mismatch = findMigrationRuntimeIdentityMismatch({
      embeddedDigest: input.embeddedDigest,
      launcherDigest: input.launcherDigest,
    });
    if (mismatch) throw new MigrationRuntimeIdentityMismatchError(mismatch);
    return;
  }

  const sourceText = readMigrationSourceIfPresent(input.cwd);
  const mismatch = findMigrationRuntimeIdentityMismatch({
    embeddedDigest: input.embeddedDigest,
    sourceText,
  });
  if (mismatch) throw new MigrationRuntimeIdentityMismatchError(mismatch);
}

function readMigrationSourceIfPresent(cwd: string): string | undefined {
  const checkoutRoot = findSynaraSourceCheckoutRoot(cwd);
  if (checkoutRoot === null) return undefined;
  const sourcePath = path.resolve(checkoutRoot, MIGRATION_RUNTIME_SOURCE_RELATIVE_PATH);
  try {
    return fs.readFileSync(sourcePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

function findSynaraSourceCheckoutRoot(cwd: string): string | null {
  let candidate = path.resolve(cwd);
  for (;;) {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(candidate, "package.json"), "utf8"),
      ) as { readonly name?: unknown };
      if (packageJson.name === "@synara/monorepo") return candidate;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}
