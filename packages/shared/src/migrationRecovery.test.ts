import { describe, expect, it } from "vitest";

import {
  createMigrationDivergenceConsentToken,
  MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX,
  MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
  findMigrationRuntimeIdentityMismatch,
  migrationBackupDirectory,
  migrationBackupProvenancePath,
  migrationRecoveryMarkerPath,
  migrationRuntimeSourceDigest,
  parseMigrationDivergenceConsentChallenge,
  parseMigrationRecoveryResumeState,
  serializeMigrationDivergenceConsentChallenge,
  type MigrationDivergenceConsentChallenge,
} from "./migrationRecovery";

const divergenceChallengeWithoutToken: Omit<MigrationDivergenceConsentChallenge, "consentToken"> = {
  version: 1,
  databasePath: "/data/state.sqlite",
  backupDirectory: "/data/state.sqlite.backups",
  sourceVersion: "imported-v90-from90",
  targetVersion: 96,
  firstDivergedId: 90,
  expectedName: "ProjectionThreadMessageTextSegments",
  recordedName: "AuthSessionRenewalPolicy",
  highWaterMark: 90,
  lineageFingerprint: "a".repeat(64),
};
const divergenceChallenge: MigrationDivergenceConsentChallenge = {
  ...divergenceChallengeWithoutToken,
  consentToken: createMigrationDivergenceConsentToken(divergenceChallengeWithoutToken),
};

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

describe("migration divergence consent challenge", () => {
  it("round-trips through a single machine-readable output line", () => {
    const serialized = serializeMigrationDivergenceConsentChallenge(divergenceChallenge);

    expect(serialized.startsWith(MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX)).toBe(true);
    expect(
      parseMigrationDivergenceConsentChallenge(`startup failed\n${serialized}\nstack trace`),
    ).toEqual(divergenceChallenge);
  });

  it("fails closed for malformed or incomplete challenge output", () => {
    expect(parseMigrationDivergenceConsentChallenge("unrelated output")).toBeNull();
    expect(
      parseMigrationDivergenceConsentChallenge(
        `${MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX}{"version":1}`,
      ),
    ).toBeNull();
    expect(
      parseMigrationDivergenceConsentChallenge(
        `${MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX}{not-json}`,
      ),
    ).toBeNull();
    expect(
      parseMigrationDivergenceConsentChallenge(
        `${MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX}{not-json}\n${serializeMigrationDivergenceConsentChallenge(divergenceChallenge)}`,
      ),
    ).toEqual(divergenceChallenge);
  });

  it("uses the final token-bound record when database text contains a valid lookalike", () => {
    const injectedWithoutToken = {
      ...divergenceChallengeWithoutToken,
      databasePath: "/attacker-selected/state.sqlite",
      backupDirectory: "/attacker-selected/state.sqlite.backups",
      recordedName: "InjectedMigration",
    };
    const injected = {
      ...injectedWithoutToken,
      consentToken: createMigrationDivergenceConsentToken(injectedWithoutToken),
    };

    expect(
      parseMigrationDivergenceConsentChallenge(
        `${serializeMigrationDivergenceConsentChallenge(injected)}\n${serializeMigrationDivergenceConsentChallenge(divergenceChallenge)}\n`,
      ),
    ).toEqual(divergenceChallenge);
  });

  it("rejects a structurally valid record whose token does not bind its fields", () => {
    expect(
      parseMigrationDivergenceConsentChallenge(
        serializeMigrationDivergenceConsentChallenge({
          ...divergenceChallenge,
          databasePath: "/substituted/state.sqlite",
        }),
      ),
    ).toBeNull();
  });
});

describe("migration runtime source identity", () => {
  it("is deterministic and changes with the migration source", () => {
    const first = migrationRuntimeSourceDigest("export const migrations = [1];\n");

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(migrationRuntimeSourceDigest("export const migrations = [1];\n")).toBe(first);
    expect(migrationRuntimeSourceDigest("export const migrations = [1, 2];\n")).not.toBe(first);
  });

  it("distinguishes launcher and checked-out source mismatches", () => {
    const embeddedDigest = migrationRuntimeSourceDigest("embedded");
    const launcherDigest = migrationRuntimeSourceDigest("launcher");

    expect(findMigrationRuntimeIdentityMismatch({ embeddedDigest, launcherDigest })).toEqual({
      kind: "launcher-bundle",
      expectedDigest: launcherDigest,
      actualDigest: embeddedDigest,
    });
    expect(findMigrationRuntimeIdentityMismatch({ embeddedDigest, sourceText: "source" })).toEqual({
      kind: "source-bundle",
      expectedDigest: migrationRuntimeSourceDigest("source"),
      actualDigest: embeddedDigest,
    });
    expect(
      findMigrationRuntimeIdentityMismatch({ embeddedDigest, sourceText: "embedded" }),
    ).toBeNull();
    expect(findMigrationRuntimeIdentityMismatch({ embeddedDigest, launcherDigest: "" })?.kind).toBe(
      "launcher-bundle",
    );
    expect(findMigrationRuntimeIdentityMismatch({ embeddedDigest, sourceText: "" })?.kind).toBe(
      "source-bundle",
    );
  });
});
