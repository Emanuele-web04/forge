import * as path from "node:path";

import {
  createMigrationDivergenceConsentToken,
  MIGRATION_DIVERGENCE_CONSENT_ENV,
  migrationBackupDirectory,
  serializeMigrationDivergenceConsentChallenge,
  type MigrationDivergenceConsentChallenge,
} from "@synara/shared/migrationRecovery";

export interface MigrationLineageDivergence {
  readonly firstDivergedId: number;
  readonly expectedName: string;
  readonly recordedName: string;
  readonly highWaterMark: number;
  readonly lineageFingerprint: string;
}

export interface MigrationDivergencePlan {
  readonly sourceVersion: string;
  readonly targetVersion: number;
  readonly lineageDivergence?: MigrationLineageDivergence | undefined;
}

export class MigrationDivergenceConsentRequiredError extends Error {
  readonly _tag = "MigrationDivergenceConsentRequiredError";

  constructor(readonly challenge: MigrationDivergenceConsentChallenge) {
    super(formatConsentRequiredMessage(challenge));
    this.name = "MigrationDivergenceConsentRequiredError";
  }
}

export function createMigrationDivergenceConsentChallenge(
  dbPath: string,
  plan: MigrationDivergencePlan,
): MigrationDivergenceConsentChallenge | null {
  const divergence = plan.lineageDivergence;
  if (!divergence) return null;

  const databasePath = path.resolve(dbPath);
  const binding = {
    version: 1,
    databasePath,
    sourceVersion: plan.sourceVersion,
    targetVersion: plan.targetVersion,
    ...divergence,
  } as const;
  return {
    ...binding,
    backupDirectory: path.resolve(migrationBackupDirectory(databasePath)),
    consentToken: createMigrationDivergenceConsentToken(binding),
  };
}

function formatConsentRequiredMessage(challenge: MigrationDivergenceConsentChallenge): string {
  return (
    `Migration ${challenge.firstDivergedId} in ${challenge.databasePath} is recorded as ` +
    `"${challenge.recordedName}" but this build expects "${challenge.expectedName}". ` +
    `Repair would rewrite migration tracker rows from ${challenge.firstDivergedId} and replay ` +
    `through ${challenge.targetVersion}. To approve only this inspected database and lineage, ` +
    `restart once with ${MIGRATION_DIVERGENCE_CONSENT_ENV}=${challenge.consentToken}. ` +
    `Synara will first create a recovery backup in ${challenge.backupDirectory}.\n` +
    serializeMigrationDivergenceConsentChallenge(challenge)
  );
}
