import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
  migrationBackupDirectory,
  migrationBackupProvenancePath,
  migrationRecoveryMarkerPath,
  parseMigrationSchemaTooNewStartupBlock,
} from "@synara/shared/migrationRecovery";

import {
  inspectCompletedMigrationBackupForSchemaTooNew,
  restoreMarkedMigrationBackup,
} from "./MigrationBackup.ts";
import { MigrationSchemaTooNewError } from "./Errors.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import {
  MigrationSchemaTooNewStartupBlockError,
  createMigrationSchemaTooNewStartupBlockError,
} from "./MigrationSchemaTooNewStartupBlock.ts";
import { migrationEntries } from "./Migrations.ts";

const tempDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

async function makeDatabasePath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-schema-too-new-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

function writeTrackedDatabase(databasePath: string, migrationId: number): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );
    const insert = database.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
    );
    let latestWrittenMigrationId = 0;
    for (const [knownMigrationId, name] of migrationEntries) {
      if (knownMigrationId > migrationId) break;
      insert.run(knownMigrationId, name);
      latestWrittenMigrationId = knownMigrationId;
    }
    for (
      let futureMigrationId = latestWrittenMigrationId + 1;
      futureMigrationId <= migrationId;
      futureMigrationId += 1
    ) {
      insert.run(futureMigrationId, `FutureMigration${futureMigrationId}`);
    }
  } finally {
    database.close();
  }
}

function writeImportedTrackedDatabase(databasePath: string, migrationId: number): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );
    const insert = database.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
    );
    for (const [knownMigrationId, name] of migrationEntries) {
      if (knownMigrationId > 16) break;
      insert.run(knownMigrationId, name);
    }
    for (
      let importedMigrationId = 17;
      importedMigrationId <= migrationId;
      importedMigrationId += 1
    ) {
      insert.run(importedMigrationId, `ImportedMigration${importedMigrationId}`);
    }
  } finally {
    database.close();
  }
}

function writeFutureCanonicalDatabase(databasePath: string): number {
  const database = new DatabaseSync(databasePath);
  const latestMigrationId = Math.max(...migrationEntries.map(([migrationId]) => migrationId));
  try {
    database.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );
    const insert = database.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
    );
    for (const [migrationId, name] of migrationEntries) insert.run(migrationId, name);
    insert.run(latestMigrationId + 1, "FutureMigration");
  } finally {
    database.close();
  }
  return latestMigrationId;
}

function generatedBackupPath(databasePath: string, suffix: string, targetVersion: number): string {
  return path.join(
    migrationBackupDirectory(databasePath),
    `${path.basename(databasePath)}.pre-migration-v1-to-v${targetVersion}-20260830T120000000Z-${suffix}.sqlite`,
  );
}

async function writeCompletedProvenance(input: {
  readonly databasePath: string;
  readonly backupPath: string;
  readonly targetVersion: number;
}): Promise<void> {
  await fs.writeFile(
    migrationBackupProvenancePath(input.databasePath),
    `${JSON.stringify({
      version: 1,
      databasePath: input.databasePath,
      backupPath: input.backupPath,
      sourceVersion: "v1",
      targetVersion: input.targetVersion,
      phase: "migration-completed",
      createdAt: "2026-08-30T12:00:00.000Z",
      completedAt: "2026-08-30T12:01:00.000Z",
      resumeAttempts: 0,
    })}\n`,
  );
}

async function writeActiveRecoveryMarker(input: {
  readonly databasePath: string;
  readonly backupPath: string;
  readonly targetVersion: number;
  readonly phase?: string;
}): Promise<void> {
  await fs.writeFile(
    migrationRecoveryMarkerPath(input.databasePath),
    `${JSON.stringify({
      version: 1,
      databasePath: input.databasePath,
      backupPath: input.backupPath,
      sourceVersion: "v1",
      targetVersion: input.targetVersion,
      phase: input.phase ?? "migration-in-progress",
      createdAt: "2026-08-30T12:02:00.000Z",
      resumeAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
    })}\n`,
  );
}

const firstUuid = "00000000-0000-4000-8000-000000000001";
const secondUuid = "00000000-0000-4000-8000-000000000002";

describe("completed migration backup recovery", () => {
  it("emits a structured block from the real persistence startup path", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = writeFutureCanonicalDatabase(databasePath);
    let startupError: unknown;

    try {
      await Effect.runPromise(
        Layer.build(
          makeSqlitePersistenceLive(databasePath).pipe(Layer.provide(NodeServices.layer)),
        ).pipe(Effect.scoped),
      );
    } catch (cause) {
      startupError = cause;
    }

    expect(startupError).toBeInstanceOf(MigrationSchemaTooNewStartupBlockError);
    expect(parseMigrationSchemaTooNewStartupBlock((startupError as Error).message)).toEqual({
      version: 1,
      databasePath,
      databaseMigrationId: latestMigrationId + 1,
      latestSupportedMigrationId: latestMigrationId,
      recovery: { kind: "restore-unavailable", reason: "missing-provenance" },
    });
  });

  it("uses completed provenance when the successful migration removed its marker", async () => {
    const databasePath = await makeDatabasePath();
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, 97);
    writeTrackedDatabase(backupPath, 90);
    await writeCompletedProvenance({ databasePath, backupPath, targetVersion: 97 });

    await expect(fs.stat(migrationRecoveryMarkerPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const recovery = await inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
      databaseMigrationId: 97,
      latestSupportedMigrationId: 96,
    });
    expect(recovery).toEqual({
      kind: "restore-available",
      backupPath,
      provenancePath: migrationBackupProvenancePath(databasePath),
      backupMigrationId: 90,
    });

    const startupError = await createMigrationSchemaTooNewStartupBlockError(
      databasePath,
      new MigrationSchemaTooNewError({
        databaseMigrationId: 97,
        latestSupportedMigrationId: 96,
      }),
    );
    expect(parseMigrationSchemaTooNewStartupBlock(startupError.message)).toMatchObject({
      databasePath,
      databaseMigrationId: 97,
      latestSupportedMigrationId: 96,
      recovery,
    });
  });

  it("ignores newer-looking files and selects only the provenance-bound backup", async () => {
    const databasePath = await makeDatabasePath();
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const exactBackupPath = generatedBackupPath(databasePath, firstUuid, 97);
    const unrelatedBackupPath = generatedBackupPath(databasePath, secondUuid, 99);
    writeTrackedDatabase(exactBackupPath, 90);
    writeTrackedDatabase(unrelatedBackupPath, 99);
    await writeCompletedProvenance({
      databasePath,
      backupPath: exactBackupPath,
      targetVersion: 97,
    });

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: 97,
        latestSupportedMigrationId: 96,
      }),
    ).resolves.toMatchObject({ kind: "restore-available", backupPath: exactBackupPath });
  });

  it("withholds restore when the exact backup is newer than this build", async () => {
    const databasePath = await makeDatabasePath();
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, 97);
    writeTrackedDatabase(backupPath, 97);
    await writeCompletedProvenance({ databasePath, backupPath, targetVersion: 98 });

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: 98,
        latestSupportedMigrationId: 96,
      }),
    ).resolves.toEqual({ kind: "restore-unavailable", reason: "incompatible-backup" });
  });

  it("allows a restorable imported lineage even when its numeric IDs exceed this build", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = Math.max(...migrationEntries.map(([migrationId]) => migrationId));
    const databaseMigrationId = latestMigrationId + 20;
    const importedBackupMigrationId = latestMigrationId + 10;
    writeTrackedDatabase(databasePath, databaseMigrationId);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, databaseMigrationId);
    writeImportedTrackedDatabase(backupPath, importedBackupMigrationId);
    await writeCompletedProvenance({
      databasePath,
      backupPath,
      targetVersion: databaseMigrationId,
    });

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId,
        latestSupportedMigrationId: latestMigrationId,
      }),
    ).resolves.toMatchObject({
      kind: "restore-available",
      backupPath,
      backupMigrationId: importedBackupMigrationId,
    });

    await Effect.runPromise(
      restoreMarkedMigrationBackup(databasePath, {
        expectedBackupPath: backupPath,
        expectedProvenancePath: migrationBackupProvenancePath(databasePath),
      }),
    );
    const restored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        restored
          .prepare("SELECT MAX(migration_id) AS migrationId FROM effect_sql_migrations")
          .get(),
      ).toMatchObject({ migrationId: importedBackupMigrationId });
    } finally {
      restored.close();
    }
  });

  it("withholds restore when the exact backup has an incompatible shared lineage", async () => {
    const databasePath = await makeDatabasePath();
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, 97);
    writeTrackedDatabase(backupPath, 90);
    const backup = new DatabaseSync(backupPath);
    try {
      backup
        .prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?")
        .run("UnknownSharedMigration", migrationEntries[0]![0]);
    } finally {
      backup.close();
    }
    await writeCompletedProvenance({ databasePath, backupPath, targetVersion: 97 });

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: 97,
        latestSupportedMigrationId: 96,
      }),
    ).resolves.toEqual({ kind: "restore-unavailable", reason: "incompatible-backup" });
  });

  it("withholds restore when the provenance is missing or its exact backup is corrupt", async () => {
    const databasePath = await makeDatabasePath();

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: 97,
        latestSupportedMigrationId: 96,
      }),
    ).resolves.toEqual({ kind: "restore-unavailable", reason: "missing-provenance" });

    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, 97);
    await fs.writeFile(backupPath, "not sqlite");
    await writeCompletedProvenance({ databasePath, backupPath, targetVersion: 97 });

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: 97,
        latestSupportedMigrationId: 96,
      }),
    ).resolves.toEqual({ kind: "restore-unavailable", reason: "invalid-backup" });
  });

  it("revalidates compatibility before the restore mutates the live database", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = Math.max(...migrationEntries.map(([migrationId]) => migrationId));
    const newerMigrationId = latestMigrationId + 1;
    writeTrackedDatabase(databasePath, newerMigrationId);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, newerMigrationId);
    writeTrackedDatabase(backupPath, newerMigrationId);
    await writeCompletedProvenance({
      databasePath,
      backupPath,
      targetVersion: newerMigrationId,
    });

    await expect(Effect.runPromise(restoreMarkedMigrationBackup(databasePath))).rejects.toThrow(
      `Migration backup schema ${newerMigrationId} is newer than this build`,
    );
    const liveDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        liveDatabase
          .prepare("SELECT MAX(migration_id) AS migrationId FROM effect_sql_migrations")
          .get(),
      ).toMatchObject({ migrationId: newerMigrationId });
    } finally {
      liveDatabase.close();
    }
  });

  it("restores the explicitly selected completed backup instead of a leftover active marker", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = Math.max(...migrationEntries.map(([migrationId]) => migrationId));
    const databaseMigrationId = latestMigrationId + 1;
    const selectedBackupMigrationId = Math.max(latestMigrationId - 5, 0);
    writeTrackedDatabase(databasePath, databaseMigrationId);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const selectedBackupPath = generatedBackupPath(databasePath, firstUuid, databaseMigrationId);
    const activeBackupPath = generatedBackupPath(databasePath, secondUuid, databaseMigrationId);
    writeTrackedDatabase(selectedBackupPath, selectedBackupMigrationId);
    writeTrackedDatabase(activeBackupPath, latestMigrationId);
    await writeCompletedProvenance({
      databasePath,
      backupPath: selectedBackupPath,
      targetVersion: databaseMigrationId,
    });
    await writeActiveRecoveryMarker({
      databasePath,
      backupPath: activeBackupPath,
      targetVersion: databaseMigrationId,
    });

    await Effect.runPromise(
      restoreMarkedMigrationBackup(databasePath, {
        expectedBackupPath: selectedBackupPath,
        expectedProvenancePath: migrationBackupProvenancePath(databasePath),
      }),
    );

    const restored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        restored
          .prepare("SELECT MAX(migration_id) AS migrationId FROM effect_sql_migrations")
          .get(),
      ).toMatchObject({ migrationId: selectedBackupMigrationId });
    } finally {
      restored.close();
    }
    await expect(fs.stat(migrationRecoveryMarkerPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(migrationBackupProvenancePath(databasePath), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      backupPath: selectedBackupPath,
      phase: "migration-restored",
    });
  });

  it("keeps the live database usable when completed-provenance validation fails", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = Math.max(...migrationEntries.map(([migrationId]) => migrationId));
    const databaseMigrationId = latestMigrationId + 1;
    writeTrackedDatabase(databasePath, databaseMigrationId);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, databaseMigrationId);
    await fs.writeFile(backupPath, "not sqlite");
    await writeCompletedProvenance({
      databasePath,
      backupPath,
      targetVersion: databaseMigrationId,
    });

    await expect(
      Effect.runPromise(
        restoreMarkedMigrationBackup(databasePath, {
          expectedBackupPath: backupPath,
          expectedProvenancePath: migrationBackupProvenancePath(databasePath),
        }),
      ),
    ).rejects.toThrow();

    await expect(fs.stat(migrationRecoveryMarkerPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(migrationBackupProvenancePath(databasePath), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      backupPath,
      phase: "migration-completed",
    });
    const live = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        live.prepare("SELECT MAX(migration_id) AS migrationId FROM effect_sql_migrations").get(),
      ).toMatchObject({ migrationId: databaseMigrationId });
    } finally {
      live.close();
    }
  });

  it("recovers an exact restore after a crash strands the live database mid-swap", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = Math.max(...migrationEntries.map(([migrationId]) => migrationId));
    const databaseMigrationId = latestMigrationId + 1;
    const backupMigrationId = Math.max(latestMigrationId - 5, 0);
    writeTrackedDatabase(databasePath, databaseMigrationId);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, databaseMigrationId);
    writeTrackedDatabase(backupPath, backupMigrationId);
    await writeCompletedProvenance({
      databasePath,
      backupPath,
      targetVersion: databaseMigrationId,
    });
    await writeActiveRecoveryMarker({
      databasePath,
      backupPath,
      targetVersion: databaseMigrationId,
      phase: "migration-restore-in-progress",
    });
    await fs.rename(databasePath, `${databasePath}.stranded-after-restore-crash`);

    await Effect.runPromise(
      restoreMarkedMigrationBackup(databasePath, {
        expectedBackupPath: backupPath,
        expectedProvenancePath: migrationBackupProvenancePath(databasePath),
      }),
    );

    const restored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        restored
          .prepare("SELECT MAX(migration_id) AS migrationId FROM effect_sql_migrations")
          .get(),
      ).toMatchObject({ migrationId: backupMigrationId });
    } finally {
      restored.close();
    }
    await expect(fs.stat(migrationRecoveryMarkerPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
