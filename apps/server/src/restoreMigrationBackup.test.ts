import * as fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runRestoreMigrationBackupCli } from "./restoreMigrationBackup.ts";

function captureOutput() {
  const errors: Array<string> = [];
  const logs: Array<string> = [];
  const warnings: Array<string> = [];
  return {
    output: {
      error: (message: string) => errors.push(message),
      log: (message: string) => logs.push(message),
      warn: (message: string) => warnings.push(message),
    },
    errors,
    logs,
    warnings,
  };
}

describe("migration backup recovery CLI", () => {
  it("ships the recovery command from the bundled server package", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly bin?: Record<string, string> };

    expect(packageJson.bin?.["synara-restore-migration-backup"]).toBe(
      "dist/restoreMigrationBackup.mjs",
    );
  });

  it("rejects relative database paths and warns operators to stop Synara", async () => {
    const capture = captureOutput();

    const exitCode = await runRestoreMigrationBackupCli(["state.sqlite"], capture.output);

    expect(exitCode).toBe(2);
    expect(capture.errors.join("\n")).toContain("Database path must be absolute");
    expect(capture.errors.join("\n")).toContain("synara-restore-migration-backup");
    expect(capture.warnings.join("\n")).toContain("Stop every Synara process");
    expect(capture.logs).toEqual([]);
  });

  it("requires a complete absolute backup selection", async () => {
    const incomplete = captureOutput();
    const relative = captureOutput();

    await expect(
      runRestoreMigrationBackupCli(
        ["/data/state.sqlite", "--backup-path", "/data/exact.sqlite"],
        incomplete.output,
      ),
    ).resolves.toBe(2);
    expect(incomplete.errors.join("\n")).toContain("--provenance-path");

    await expect(
      runRestoreMigrationBackupCli(
        [
          "/data/state.sqlite",
          "--backup-path",
          "relative.sqlite",
          "--provenance-path",
          "/data/state.sqlite.migration-backup.json",
        ],
        relative.output,
      ),
    ).resolves.toBe(2);
    expect(relative.errors.join("\n")).toContain("must be absolute");
  });
});
