import { describe, expect, it } from "vitest";

import {
  MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
  migrationBackupDirectory,
  migrationBackupProvenancePath,
  migrationRecoveryMarkerPath,
  parseMigrationRecoveryResumeState,
} from "./migrationRecovery";

describe("migration recovery paths", () => {
  it("derives the marker and backup directory from the database path", () => {
    expect(migrationRecoveryMarkerPath("/data/state.sqlite")).toBe(
      "/data/state.sqlite.migration-recovery.json",
    );
    expect(migrationBackupDirectory("/data/state.sqlite")).toBe("/data/state.sqlite.backups");
    expect(migrationBackupProvenancePath("/data/state.sqlite")).toBe(
      "/data/state.sqlite.migration-backup.json",
    );
  });
});

describe("parseMigrationRecoveryResumeState", () => {
  const marker = (value: Record<string, unknown>) => JSON.stringify(value);

  it("gives markers written before the resume path existed a full budget", () => {
    // Every install wedged by 0.6.0 carries a counter-less marker. Treating it
    // as spent would deny the self-heal to exactly the population that needs it.
    expect(parseMigrationRecoveryResumeState(marker({ phase: "migration-in-progress" }))).toEqual({
      attempts: 0,
      exhausted: false,
    });
  });

  it("reports the budget as spent at the limit and beyond", () => {
    expect(
      parseMigrationRecoveryResumeState(
        marker({ resumeAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS - 1 }),
      ),
    ).toMatchObject({ exhausted: false });
    expect(
      parseMigrationRecoveryResumeState(
        marker({ resumeAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS }),
      ),
    ).toMatchObject({ exhausted: true });
    expect(
      parseMigrationRecoveryResumeState(
        marker({ resumeAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS + 5 }),
      ),
    ).toMatchObject({ exhausted: true });
  });

  it("refuses to guess at a marker it cannot trust", () => {
    // Callers fail closed on null, so every unreadable shape must land here
    // rather than silently resolving to a retryable zero.
    expect(parseMigrationRecoveryResumeState("{ not json")).toBeNull();
    expect(parseMigrationRecoveryResumeState("null")).toBeNull();
    expect(parseMigrationRecoveryResumeState('"a string"')).toBeNull();
    expect(parseMigrationRecoveryResumeState(marker({ resumeAttempts: -1 }))).toBeNull();
    expect(parseMigrationRecoveryResumeState(marker({ resumeAttempts: 1.5 }))).toBeNull();
    expect(parseMigrationRecoveryResumeState(marker({ resumeAttempts: "2" }))).toBeNull();
    expect(parseMigrationRecoveryResumeState(marker({ resumeAttempts: null }))).toBeNull();
  });
});
