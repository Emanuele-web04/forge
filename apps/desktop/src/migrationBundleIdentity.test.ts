import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { migrationRuntimeSourceDigest } from "@synara/shared/migrationRecovery";

import { inspectDesktopMigrationRuntimeIdentity } from "./migrationBundleIdentity";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function sourceCheckout(source: string): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synara-desktop-migration-bundle-"));
  tempDirectories.push(appRoot);
  const sourcePath = path.join(appRoot, "apps/server/src/persistence/Migrations.ts");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, source);
  return appRoot;
}

describe("inspectDesktopMigrationRuntimeIdentity", () => {
  it("fails closed when a built desktop has no embedded identity", () => {
    expect(() =>
      inspectDesktopMigrationRuntimeIdentity({
        appRoot: sourceCheckout("current source"),
        isPackaged: false,
        embeddedDigest: null,
      }),
    ).toThrow(/no embedded migration source identity/u);
  });

  it("reports a source mismatch in development", () => {
    const mismatch = inspectDesktopMigrationRuntimeIdentity({
      appRoot: sourceCheckout("current source"),
      isPackaged: false,
      embeddedDigest: migrationRuntimeSourceDigest("stale bundle"),
    });

    expect(mismatch?.kind).toBe("source-bundle");
  });

  it("skips checkout inspection for packaged apps", () => {
    expect(
      inspectDesktopMigrationRuntimeIdentity({
        appRoot: sourceCheckout("current source"),
        isPackaged: true,
        embeddedDigest: migrationRuntimeSourceDigest("stale bundle"),
      }),
    ).toBeNull();
  });
});
