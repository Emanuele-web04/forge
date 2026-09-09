import * as path from "node:path";

import { Effect } from "effect";

import {
  restoreMarkedMigrationBackup,
  type RestoreMarkedMigrationBackupOptions,
} from "./persistence/MigrationBackup.ts";

const USAGE =
  "Usage: synara-restore-migration-backup <absolute-database-path> " +
  "[--backup-path <absolute-backup-path> --provenance-path <absolute-provenance-path>]";
const STOP_PROCESSES_WARNING =
  "WARNING: Stop every Synara process before restoring a migration backup.";

type RestoreMigrationBackupOutput = Pick<Console, "error" | "log" | "warn">;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function runRestoreMigrationBackupCli(
  args: ReadonlyArray<string>,
  output: RestoreMigrationBackupOutput = console,
): Promise<number> {
  output.warn(STOP_PROCESSES_WARNING);

  const dbPath = args[0];
  if (!dbPath) {
    output.error(USAGE);
    return 2;
  }
  if (!path.isAbsolute(dbPath)) {
    output.error(`Database path must be absolute: ${dbPath}\n${USAGE}`);
    return 2;
  }

  let options: RestoreMarkedMigrationBackupOptions = {};
  if (args.length > 1) {
    const backupPath = args[2];
    const provenancePath = args[4];
    if (
      args.length !== 5 ||
      args[1] !== "--backup-path" ||
      args[3] !== "--provenance-path" ||
      !backupPath ||
      !provenancePath
    ) {
      output.error(USAGE);
      return 2;
    }
    if (!path.isAbsolute(backupPath) || !path.isAbsolute(provenancePath)) {
      output.error(`Backup and provenance paths must be absolute.\n${USAGE}`);
      return 2;
    }
    options = { expectedBackupPath: backupPath, expectedProvenancePath: provenancePath };
  }

  try {
    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath, options));
    output.log(`Restored migration backup for ${dbPath}`);
    return 0;
  } catch (cause) {
    output.error(`Failed to restore migration backup for ${dbPath}: ${errorMessage(cause)}`);
    return 1;
  }
}

const entryPointNames = new Set([
  "restoreMigrationBackup.ts",
  "restoreMigrationBackup.mjs",
  "restoreMigrationBackup.cjs",
  "synara-restore-migration-backup",
]);

if (process.argv[1] && entryPointNames.has(path.basename(process.argv[1]))) {
  void runRestoreMigrationBackupCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
