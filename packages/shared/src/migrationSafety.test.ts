import { describe, expect, it } from "vitest";

import {
  MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX,
  findMigrationRuntimeIdentityMismatch,
  migrationRuntimeSourceDigest,
  parseMigrationDivergenceConsentChallenge,
  serializeMigrationDivergenceConsentChallenge,
  type MigrationDivergenceConsentChallenge,
} from "./migrationSafety";

const challenge: MigrationDivergenceConsentChallenge = {
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
  consentToken: "b".repeat(64),
};

describe("migration divergence consent challenge", () => {
  it("round-trips through a single machine-readable output line", () => {
    const serialized = serializeMigrationDivergenceConsentChallenge(challenge);

    expect(serialized.startsWith(MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX)).toBe(true);
    expect(
      parseMigrationDivergenceConsentChallenge(`startup failed\n${serialized}\nstack trace`),
    ).toEqual(challenge);
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
        `${MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX}{not-json}\n${serializeMigrationDivergenceConsentChallenge(challenge)}`,
      ),
    ).toEqual(challenge);
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
