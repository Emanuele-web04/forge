import {
  serializeMigrationSchemaTooNewStartupBlock,
  type MigrationSchemaTooNewStartupBlock,
} from "@synara/shared/migrationRecovery";

import { MigrationSchemaTooNewError } from "./Errors.ts";
import { inspectCompletedMigrationBackupForSchemaTooNew } from "./MigrationBackup.ts";

export class MigrationSchemaTooNewStartupBlockError extends Error {
  readonly block: MigrationSchemaTooNewStartupBlock;

  constructor(cause: MigrationSchemaTooNewError, block: MigrationSchemaTooNewStartupBlock) {
    super(`${cause.message}\n${serializeMigrationSchemaTooNewStartupBlock(block)}`, { cause });
    this.name = "MigrationSchemaTooNewStartupBlockError";
    this.block = block;
  }
}

export async function createMigrationSchemaTooNewStartupBlockError(
  dbPath: string,
  cause: MigrationSchemaTooNewError,
): Promise<MigrationSchemaTooNewStartupBlockError> {
  const recovery = await inspectCompletedMigrationBackupForSchemaTooNew(dbPath, cause);
  return new MigrationSchemaTooNewStartupBlockError(cause, {
    version: 1,
    databasePath: dbPath,
    databaseMigrationId: cause.databaseMigrationId,
    latestSupportedMigrationId: cause.latestSupportedMigrationId,
    recovery,
  });
}
