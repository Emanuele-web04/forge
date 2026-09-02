import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { migrationRuntimeSourceDigest } from "@synara/shared/migrationRecovery";

import {
  MigrationRuntimeIdentityMismatchError,
  verifyMigrationRuntimeIdentity,
} from "./migrationBundleIdentity";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function sourceCheckout(source: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synara-migration-bundle-"));
  tempDirectories.push(cwd);
  const sourcePath = path.join(cwd, "apps/server/src/persistence/Migrations.ts");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"@synara/monorepo"}\n');
  fs.writeFileSync(sourcePath, source);
  return cwd;
}

describe("verifyMigrationRuntimeIdentity", () => {
  it("accepts a bundle built from the checked-out migration source", () => {
    const source = "export const migrations = [1];\n";
    const embeddedDigest = migrationRuntimeSourceDigest(source);

    expect(() =>
      verifyMigrationRuntimeIdentity({ cwd: sourceCheckout(source), embeddedDigest }),
    ).not.toThrow();
  });

  it("refuses a stale bundle before database startup", () => {
    expect(() =>
      verifyMigrationRuntimeIdentity({
        cwd: sourceCheckout("current source"),
        embeddedDigest: migrationRuntimeSourceDigest("stale bundle"),
      }),
    ).toThrow(MigrationRuntimeIdentityMismatchError);
  });

  it("refuses desktop and server bundles built from different migration sources", () => {
    expect(() =>
      verifyMigrationRuntimeIdentity({
        cwd: sourceCheckout("same source"),
        embeddedDigest: migrationRuntimeSourceDigest("server bundle"),
        launcherDigest: migrationRuntimeSourceDigest("desktop bundle"),
      }),
    ).toThrow(/desktop and server bundles were built from different migration sources/u);
  });

  it("classifies a missing server identity as a runtime identity mismatch", () => {
    expect(() =>
      verifyMigrationRuntimeIdentity({
        cwd: sourceCheckout("same source"),
        embeddedDigest: null,
        launcherDigest: migrationRuntimeSourceDigest("desktop bundle"),
      }),
    ).toThrow(MigrationRuntimeIdentityMismatchError);
  });

  it("checks the source checkout when launched from a nested package", () => {
    const checkout = sourceCheckout("current source");
    const nestedCwd = path.join(checkout, "apps/server");
    fs.writeFileSync(path.join(nestedCwd, "package.json"), '{"name":"@synara/cli"}\n');

    expect(() =>
      verifyMigrationRuntimeIdentity({
        cwd: nestedCwd,
        embeddedDigest: migrationRuntimeSourceDigest("stale bundle"),
      }),
    ).toThrow(MigrationRuntimeIdentityMismatchError);
  });

  it("does not inspect a coincidental checkout after launcher and bundle identities match", () => {
    const digest = migrationRuntimeSourceDigest("matching bundles");

    expect(() =>
      verifyMigrationRuntimeIdentity({
        cwd: sourceCheckout("unrelated checkout source"),
        embeddedDigest: digest,
        launcherDigest: digest,
      }),
    ).not.toThrow();
  });

  it("does not parse cwd package metadata after launcher and bundle identities match", () => {
    const cwd = sourceCheckout("unrelated checkout source");
    fs.writeFileSync(path.join(cwd, "package.json"), "{");
    const digest = migrationRuntimeSourceDigest("matching bundles");

    expect(() =>
      verifyMigrationRuntimeIdentity({ cwd, embeddedDigest: digest, launcherDigest: digest }),
    ).not.toThrow();
  });
});
