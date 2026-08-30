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
