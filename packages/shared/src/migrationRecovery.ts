import { createHash } from "node:crypto";

// The desktop preflight and server recovery guard must agree on the durable marker name.
export function migrationRecoveryMarkerPath(dbPath: string): string {
  return `${dbPath}.migration-recovery.json`;
}

export function migrationBackupDirectory(dbPath: string): string {
  return `${dbPath}.backups`;
}

export function migrationBackupProvenancePath(dbPath: string): string {
  return `${dbPath}.migration-backup.json`;
}

/**
 * How many times startup may re-run an interrupted migration before it stops
 * trying and demands the explicit operator restore.
 *
 * The marker is written *ahead* of the first migration statement, so its
 * presence proves an attempt started — not that the database is half-written.
 * Re-running is safe because the resume path never takes a second backup and
 * never rewrites the marker's backup pointer: if the retry fails, the original
 * snapshot and the manual restore command are still exactly where they were.
 * The bound is what keeps a deterministic failure from re-running migrations on
 * every process restart.
 */
export const MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS = 2;

export interface MigrationRecoveryResumeState {
  readonly attempts: number;
  readonly exhausted: boolean;
}

/**
 * Reads the resume budget out of a marker's raw JSON.
 *
 * Returns `null` when the marker cannot be trusted (unreadable JSON, or a
 * counter that is not a non-negative integer). Callers must treat `null` as
 * "recovery required" — an unparseable marker is exactly the case where
 * guessing is unsafe.
 *
 * A marker with no counter at all was written by a build that predates the
 * resume path; it gets the full budget, which is what lets an already-wedged
 * install heal itself after an upgrade.
 */
export function parseMigrationRecoveryResumeState(
  markerText: string,
): MigrationRecoveryResumeState | null {
  let payload: unknown;
  try {
    payload = JSON.parse(markerText);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const raw = (payload as { readonly resumeAttempts?: unknown }).resumeAttempts;
  if (raw === undefined) {
    return { attempts: 0, exhausted: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS <= 0 };
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;

  return { attempts: raw, exhausted: raw >= MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS };
}

export const MIGRATION_DIVERGENCE_CONSENT_ENV = "SYNARA_MIGRATION_DIVERGENCE_CONSENT";
export const MIGRATION_RUNTIME_SOURCE_DIGEST_ENV = "SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST";
export const MIGRATION_RUNTIME_SOURCE_RELATIVE_PATH = "apps/server/src/persistence/Migrations.ts";
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

type MigrationDivergenceConsentBinding = Omit<
  MigrationDivergenceConsentChallenge,
  "backupDirectory" | "consentToken"
>;

export function createMigrationDivergenceConsentToken(
  challenge: MigrationDivergenceConsentBinding,
): string {
  const binding = {
    version: challenge.version,
    databasePath: challenge.databasePath,
    sourceVersion: challenge.sourceVersion,
    targetVersion: challenge.targetVersion,
    firstDivergedId: challenge.firstDivergedId,
    expectedName: challenge.expectedName,
    recordedName: challenge.recordedName,
    highWaterMark: challenge.highWaterMark,
    lineageFingerprint: challenge.lineageFingerprint,
  } as const;
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
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
  if (input.launcherDigest !== undefined && input.launcherDigest !== input.embeddedDigest) {
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
  let authoritativeChallenge: MigrationDivergenceConsentChallenge | null = null;
  for (;;) {
    const prefixIndex = output.indexOf(MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX, searchFrom);
    if (prefixIndex === -1) return authoritativeChallenge;

    const payloadStart = prefixIndex + MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX.length;
    if (prefixIndex > 0 && output[prefixIndex - 1] !== "\n") {
      searchFrom = payloadStart;
      continue;
    }
    const lineEnd = output.indexOf("\n", payloadStart);
    const payload = output.slice(payloadStart, lineEnd === -1 ? undefined : lineEnd).trim();
    try {
      const parsed: unknown = JSON.parse(payload);
      if (
        isMigrationDivergenceConsentChallenge(parsed) &&
        parsed.consentToken === createMigrationDivergenceConsentToken(parsed)
      ) {
        // The server emits its authoritative machine record after the human
        // error text. Migration names come from the database and may contain
        // an earlier lookalike prefix, so only the final valid record is safe
        // to present to the user.
        authoritativeChallenge = parsed;
      }
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
