import { describe, expect, it } from "vitest";
import {
  serializeMigrationDivergenceConsentChallenge,
  type MigrationDivergenceConsentChallenge,
} from "@synara/shared/migrationRecovery";

import { BackendStartupBlockDetector } from "./backendStartupBlock";

const divergenceChallenge: MigrationDivergenceConsentChallenge = {
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

describe("BackendStartupBlockDetector", () => {
  it("recognizes a live database owner across output chunks", () => {
    const detector = new BackendStartupBlockDetector();

    detector.push("[13:46:08.637] ERROR: DatabaseLifecycle");
    detector.push(
      "LockedError: Database lifecycle is locked: owner pid 21610 is live (state.sqlite.lifecycle-lock)\n",
    );

    expect(detector.read()).toEqual({ kind: "database-locked", ownerPid: 21610 });
  });

  it("still classifies a database lock when owner metadata is unavailable", () => {
    const detector = new BackendStartupBlockDetector();

    detector.push("DatabaseLifecycleLockedError: refusing concurrent database access\n");

    expect(detector.read()).toEqual({ kind: "database-locked", ownerPid: null });
  });

  it("recognizes migration recovery as a relaunch-only startup block", () => {
    const detector = new BackendStartupBlockDetector();

    detector.push("MigrationRecoveryRequiredError: Migration recovery is required");

    expect(detector.read()).toEqual({ kind: "migration-recovery-required" });
  });

  it("extracts a divergence consent challenge across output chunks", () => {
    const detector = new BackendStartupBlockDetector();
    const serialized = serializeMigrationDivergenceConsentChallenge(divergenceChallenge);

    detector.push(`MigrationDivergenceConsentRequiredError: blocked\n${serialized.slice(0, 80)}`);
    detector.push(`${serialized.slice(80)}\n    at migrate`);

    expect(detector.read()).toEqual({
      kind: "migration-divergence-consent-required",
      challenge: divergenceChallenge,
    });
  });

  it("preserves a consent challenge larger than the general output buffer", () => {
    const detector = new BackendStartupBlockDetector();
    const challenge = {
      ...divergenceChallenge,
      recordedName: "x".repeat(20_000),
    };
    const serialized = serializeMigrationDivergenceConsentChallenge(challenge);

    detector.push(`MigrationDivergenceConsentRequiredError: blocked\n${serialized.slice(0, 100)}`);
    detector.push(serialized.slice(100));

    expect(detector.read()).toEqual({
      kind: "migration-divergence-consent-required",
      challenge,
    });
  });

  it("recognizes a migration bundle identity mismatch", () => {
    const detector = new BackendStartupBlockDetector();

    detector.push(
      "MigrationRuntimeIdentityMismatchError: desktop and server bundles were built from different migration sources\n",
    );

    expect(detector.read()).toEqual({ kind: "migration-runtime-identity-mismatch" });
  });

  it("ignores unrelated startup failures", () => {
    const detector = new BackendStartupBlockDetector();

    detector.push("Error: address already in use");

    expect(detector.read()).toBeNull();
  });
});
