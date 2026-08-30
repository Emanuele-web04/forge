import { createHash } from "node:crypto";

export const MIGRATION_DIVERGENCE_CONSENT_ENV = "SYNARA_MIGRATION_DIVERGENCE_CONSENT";
export const MIGRATION_RUNTIME_SOURCE_DIGEST_ENV = "SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST";
export const MIGRATION_RUNTIME_SOURCE_RELATIVE_PATH =
  "apps/server/src/persistence/Migrations.ts";
export const MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX =
  "SYNARA_MIGRATION_DIVERGENCE_CONSENT_REQUIRED=";

export interface MigrationDivergenceConsentChallenge {
  readonly version: 1;
  readonly databasePath: string;
  readonly backupDirectory: string;
  readonly sourceVersion: string;
  readonly targetVersion: number;
  readonly firstDivergedId: number;
  readonly expectedName: string;
  readonly recordedName: string;
  readonly highWaterMark: number;
  readonly lineageFingerprint: string;
  readonly consentToken: string;
}

export interface MigrationRuntimeIdentityMismatch {
  readonly kind: "launcher-bundle" | "source-bundle";
  readonly expectedDigest: string;
  readonly actualDigest: string;
}

export function migrationRuntimeSourceDigest(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function findMigrationRuntimeIdentityMismatch(input: {
  readonly embeddedDigest: string;
  readonly launcherDigest?: string | undefined;
  readonly sourceText?: string | undefined;
}): MigrationRuntimeIdentityMismatch | null {
  if (
    input.launcherDigest !== undefined &&
    input.launcherDigest !== input.embeddedDigest
  ) {
    return {
      kind: "launcher-bundle",
      expectedDigest: input.launcherDigest,
      actualDigest: input.embeddedDigest,
    };
  }

  const sourceDigest =
    input.sourceText === undefined ? undefined : migrationRuntimeSourceDigest(input.sourceText);
  if (sourceDigest !== undefined && sourceDigest !== input.embeddedDigest) {
    return {
      kind: "source-bundle",
      expectedDigest: sourceDigest,
      actualDigest: input.embeddedDigest,
    };
  }
  return null;
}

export function serializeMigrationDivergenceConsentChallenge(
  challenge: MigrationDivergenceConsentChallenge,
): string {
  return `${MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX}${JSON.stringify(challenge)}`;
}

export function parseMigrationDivergenceConsentChallenge(
  output: string,
): MigrationDivergenceConsentChallenge | null {
  let searchFrom = 0;
  for (;;) {
    const prefixIndex = output.indexOf(
      MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX,
      searchFrom,
    );
    if (prefixIndex === -1) return null;

    const payloadStart = prefixIndex + MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX.length;
    const lineEnd = output.indexOf("\n", payloadStart);
    const payload = output.slice(payloadStart, lineEnd === -1 ? undefined : lineEnd).trim();
    try {
      const parsed: unknown = JSON.parse(payload);
      if (isMigrationDivergenceConsentChallenge(parsed)) return parsed;
    } catch {
      // Continue to a later machine-readable line if untrusted error text
      // happened to contain the prefix first.
    }
    searchFrom = payloadStart;
  }
}

function isMigrationDivergenceConsentChallenge(
  value: unknown,
): value is MigrationDivergenceConsentChallenge {
  if (typeof value !== "object" || value === null) return false;
  const challenge = value as Record<string, unknown>;
  return (
    challenge.version === 1 &&
    isNonEmptyString(challenge.databasePath) &&
    isNonEmptyString(challenge.backupDirectory) &&
    isNonEmptyString(challenge.sourceVersion) &&
    isNonNegativeInteger(challenge.targetVersion) &&
    isNonNegativeInteger(challenge.firstDivergedId) &&
    isNonEmptyString(challenge.expectedName) &&
    isNonEmptyString(challenge.recordedName) &&
    isNonNegativeInteger(challenge.highWaterMark) &&
    isSha256(challenge.lineageFingerprint) &&
    isSha256(challenge.consentToken)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
