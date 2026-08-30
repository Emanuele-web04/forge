import { DatabaseSync } from "node:sqlite";
import nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
  migrationBackupProvenancePath,
} from "@synara/shared/migrationRecovery";

import {
  FAILED_MIGRATION_BUNDLE_RETENTION,
  MIGRATION_BACKUP_RETENTION,
  MigrationDivergenceConsentRequiredError,
  MigrationRecoveryRequiredError,
  TRACKER_REPAIR_SNAPSHOT_RETENTION,
  createMigrationBackup,
  estimateMigrationBackupRequiredBytes,
  inspectPendingMigrationRecovery,
  migrationBackupDirectory,
  migrationRecoveryMarkerPath,
  reclaimOrphanedMigrationArtifacts,
  requireNoPendingMigrationRecovery,
  restoreMarkedMigrationBackup,
  resumeMarkedMigration,
  runWithPreMigrationBackup,
} from "./MigrationBackup.ts";
import { migrationEntries, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";

const tempDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

async function makeDbPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-migration-backup-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

const runWithDatabase = <A, E>(dbPath: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))));

async function backupPaths(dbPath: string): Promise<Array<string>> {
  const directory = migrationBackupDirectory(dbPath);
  const names = await fs.readdir(directory).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  });
  return names.filter((name) => name.endsWith(".sqlite")).map((name) => path.join(directory, name));
}

/** A July 2026 day, as the compact UTC date every generated artifact name carries. */
const artifactDay = (day: number) => `202607${`${day}`.padStart(2, "0")}`;

/** Ages a marker to the state where startup has stopped retrying and fails closed. */
async function exhaustResumeBudget(markerPath: string): Promise<void> {
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
  await fs.writeFile(
    markerPath,
    `${JSON.stringify({ ...marker, resumeAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS })}\n`,
  );
}

describe("migration backups", () => {
  it("includes committed WAL content in the SQLite snapshot", async () => {
    const dbPath = await makeDbPath();

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`PRAGMA wal_autocheckpoint = 0`;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* sql`CREATE TABLE backup_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO backup_probe(value) VALUES ('committed-in-wal')`;
        const walStat = yield* Effect.promise(() => fs.stat(`${dbPath}-wal`));
        expect(walStat.size).toBeGreaterThan(0);

        yield* runWithPreMigrationBackup(dbPath, Effect.void);
      }),
    );

    const [backupPath] = await backupPaths(dbPath);
    expect(backupPath).toBeDefined();
    const backup = new DatabaseSync(backupPath!, { readOnly: true });
    try {
      expect(backup.prepare("SELECT value FROM backup_probe").get()).toMatchObject({
        value: "committed-in-wal",
      });
      expect(backup.prepare("PRAGMA integrity_check").get()).toMatchObject({
        integrity_check: "ok",
      });
    } finally {
      backup.close();
    }
  });

  it("sizes backup space from logical pages that are still only in the WAL", async () => {
    const dbPath = await makeDbPath();

    const sizing = await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`PRAGMA wal_autocheckpoint = 0`;
        yield* sql`CREATE TABLE sizing_probe(value BLOB NOT NULL)`;
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        const mainFileBytes = (yield* Effect.promise(() => fs.stat(dbPath))).size;

        yield* sql`INSERT INTO sizing_probe(value) VALUES (randomblob(${4 * 1024 * 1024}))`;
        const [pages] = yield* sql<{
          readonly pageCount: number;
          readonly pageSize: number;
        }>`
          SELECT
            page_count AS "pageCount",
            page_size AS "pageSize"
          FROM pragma_page_count(), pragma_page_size()
        `;
        const logicalBytes = Number(pages?.pageCount) * Number(pages?.pageSize);
        const requiredBytes = yield* estimateMigrationBackupRequiredBytes(dbPath);
        const walBytes = (yield* Effect.promise(() => fs.stat(`${dbPath}-wal`))).size;
        return { logicalBytes, mainFileBytes, requiredBytes, walBytes };
      }),
    );

    expect(sizing.walBytes).toBeGreaterThan(sizing.mainFileBytes);
    expect(sizing.logicalBytes).toBeGreaterThan(sizing.mainFileBytes);
    expect(sizing.requiredBytes).toBe(sizing.logicalBytes * 2);
  });

  it("fails closed without mutating marked files, then restores only when explicitly requested", async () => {
    const dbPath = await makeDbPath();

    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* runMigrations({ toMigrationInclusive: 52 });
          yield* sql`CREATE TABLE recovery_probe(value TEXT NOT NULL)`;
          yield* sql`INSERT INTO recovery_probe(value) VALUES ('before-failure')`;
          yield* runWithPreMigrationBackup(
            dbPath,
            Effect.gen(function* () {
              const markerBeforeMutation = JSON.parse(
                yield* Effect.promise(() =>
                  fs.readFile(migrationRecoveryMarkerPath(dbPath), "utf8"),
                ),
              ) as { phase: string };
              expect(markerBeforeMutation.phase).toBe("migration-in-progress");
              yield* sql`DELETE FROM recovery_probe`;
              return yield* Effect.fail(new Error("injected migration failure"));
            }),
          );
        }),
      ),
    ).rejects.toThrow("injected migration failure");

    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const markerText = await fs.readFile(markerPath, "utf8");
    const marker = JSON.parse(markerText) as {
      backupPath: string;
      phase: string;
    };
    expect(marker.backupPath).toContain(migrationBackupDirectory(dbPath));
    expect(marker.phase).toBe("migration-in-progress");
    const backup = new DatabaseSync(marker.backupPath, { readOnly: true });
    try {
      expect(backup.prepare("SELECT value FROM recovery_probe").get()).toMatchObject({
        value: "before-failure",
      });
    } finally {
      backup.close();
    }

    const failedDatabaseText = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(failedDatabaseText.prepare("SELECT value FROM recovery_probe").all()).toEqual([]);
    } finally {
      failedDatabaseText.close();
    }
    // Failing closed is what startup does *after* the bounded self-heal is
    // spent; that terminal state is what the rest of this test asserts on.
    await exhaustResumeBudget(markerPath);
    const blockedMarkerText = await fs.readFile(markerPath, "utf8");
    const databaseStatBeforeStartup = await fs.stat(dbPath);
    const markerStatBeforeStartup = await fs.stat(markerPath);

    await expect(
      Effect.runPromise(
        Layer.build(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))).pipe(
          Effect.scoped,
        ),
      ),
    ).rejects.toThrow(MigrationRecoveryRequiredError);

    expect(await fs.readFile(markerPath, "utf8")).toBe(blockedMarkerText);
    expect((await fs.stat(dbPath)).size).toBe(databaseStatBeforeStartup.size);
    expect((await fs.stat(dbPath)).mtimeMs).toBe(databaseStatBeforeStartup.mtimeMs);
    expect((await fs.stat(markerPath)).mtimeMs).toBe(markerStatBeforeStartup.mtimeMs);
    const stillFailed = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(stillFailed.prepare("SELECT value FROM recovery_probe").all()).toEqual([]);
    } finally {
      stillFailed.close();
    }

    const orphanFailedWal = `${dbPath}.failed-migration-orphan-wal`;
    const orphanFailedShm = `${dbPath}.failed-migration-orphan-shm`;
    await fs.writeFile(orphanFailedWal, "orphan");
    await fs.writeFile(orphanFailedShm, "orphan");
    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));
    await expect(fs.stat(orphanFailedWal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(orphanFailedShm)).rejects.toMatchObject({ code: "ENOENT" });

    const restoredValue = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly value: string }>`SELECT value FROM recovery_probe`;
        return rows[0]?.value;
      }).pipe(
        Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      ),
    );
    expect(restoredValue).toBe("before-failure");

    const restored = new DatabaseSync(dbPath, { readOnly: true });
    expect(restored.prepare("PRAGMA integrity_check").get()).toMatchObject({
      integrity_check: "ok",
    });
    restored.close();
    await expect(fs.stat(markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await fs.readdir(path.dirname(dbPath))).some((name) =>
        name.startsWith(`${path.basename(dbPath)}.failed-migration-`),
      ),
    ).toBe(true);
  });

  it("publishes a private marker atomically with no temporary marker left behind", async () => {
    const dbPath = await makeDbPath();

    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 52 });
          yield* sql`CREATE TABLE marker_probe(value TEXT NOT NULL)`;
          yield* runWithPreMigrationBackup(dbPath, Effect.fail(new Error("leave durable marker")));
        }),
      ),
    ).rejects.toThrow("leave durable marker");

    const markerPath = migrationRecoveryMarkerPath(dbPath);
    expect(JSON.parse(await fs.readFile(markerPath, "utf8"))).toMatchObject({
      databasePath: dbPath,
      phase: "migration-in-progress",
    });
    expect(
      (await fs.readdir(path.dirname(dbPath))).filter(
        (name) => name.startsWith(`${path.basename(markerPath)}.`) && name.endsWith(".partial"),
      ),
    ).toEqual([]);
    if (process.platform !== "win32") {
      expect((await fs.stat(markerPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects symlinked markers and non-generated nested backup paths", async () => {
    const dbPath = await makeDbPath();
    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const outsideMarker = path.join(path.dirname(dbPath), "outside-marker.json");
    await fs.writeFile(outsideMarker, "{}\n");
    await fs.symlink(outsideMarker, markerPath);

    await expect(Effect.runPromise(requireNoPendingMigrationRecovery(dbPath))).rejects.toThrow(
      "could not be validated",
    );
    expect(await fs.readFile(outsideMarker, "utf8")).toBe("{}\n");

    await fs.unlink(markerPath);
    const backupDirectory = migrationBackupDirectory(dbPath);
    const nestedDirectory = path.join(backupDirectory, "nested");
    await fs.mkdir(nestedDirectory, { recursive: true });
    const nestedBackup = path.join(
      nestedDirectory,
      `${path.basename(dbPath)}.pre-migration-v52-to-v53-20260713T120000000Z-${randomUUID()}.sqlite`,
    );
    await fs.writeFile(nestedBackup, "not-used");
    await fs.writeFile(
      markerPath,
      `${JSON.stringify({ databasePath: dbPath, backupPath: nestedBackup })}\n`,
    );

    await expect(Effect.runPromise(requireNoPendingMigrationRecovery(dbPath))).rejects.toThrow(
      "invalid backup",
    );
  });

  it("removes every migration partial regardless of age, and only stale restore copies", async () => {
    const dbPath = await makeDbPath();
    const backupDirectory = migrationBackupDirectory(dbPath);
    await fs.mkdir(backupDirectory, { recursive: true });
    const stalePartial = path.join(
      backupDirectory,
      `.${path.basename(dbPath)}.pre-migration-abandoned.sqlite.partial`,
    );
    const recentPartial = path.join(
      backupDirectory,
      `.${path.basename(dbPath)}.pre-migration-active.sqlite.partial`,
    );
    await fs.writeFile(stalePartial, "stale");
    await fs.writeFile(recentPartial, "recent");
    const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await fs.utimes(stalePartial, staleDate, staleDate);

    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 52 });
          yield* sql`CREATE TABLE artifact_probe(value TEXT NOT NULL)`;
          yield* sql`INSERT INTO artifact_probe(value) VALUES ('restorable')`;
          yield* runWithPreMigrationBackup(
            dbPath,
            Effect.fail(new Error("leave recovery artifacts")),
          );
        }),
      ),
    ).rejects.toThrow("leave recovery artifacts");

    // Age is deliberately not a factor for partials. Only the lock holder can
    // write one, so a partial observed at startup always outlived its writer —
    // and an age cutoff here is what let a restart loop accumulate hundreds of
    // gigabytes of unreclaimable snapshots.
    await expect(fs.stat(stalePartial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(recentPartial)).rejects.toMatchObject({ code: "ENOENT" });

    const staleRestore = `${dbPath}.00000000-0000-0000-0000-000000000000.restore`;
    const recentRestore = `${dbPath}.11111111-1111-1111-1111-111111111111.restore`;
    await fs.writeFile(staleRestore, "stale");
    await fs.writeFile(recentRestore, "recent");
    await fs.utimes(staleRestore, staleDate, staleDate);

    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));

    await expect(fs.stat(staleRestore)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(recentRestore)).resolves.toBeDefined();
  });

  it("reclaims stranded partials at startup even while failing closed on recovery", async () => {
    // Regression: a database needing recovery fails closed before it can ever
    // reach the backup path, so nothing reclaimed the partials each restart
    // left behind. A crash-looping desktop shell turned that into hundreds of
    // gigabytes of unreferenced snapshots in minutes.
    const dbPath = await makeDbPath();
    const backupDirectory = migrationBackupDirectory(dbPath);

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* sql`CREATE TABLE wedge_probe(value TEXT NOT NULL)`;
        yield* runWithPreMigrationBackup(dbPath, Effect.fail(new Error("wedge the database")));
      }),
    ).catch(() => undefined);

    const markerPath = migrationRecoveryMarkerPath(dbPath);
    expect(await fs.readFile(markerPath, "utf8")).toContain("migration-in-progress");
    // Spend the resume budget so startup is past self-healing and back to
    // failing closed, which is the state this reclaim has to survive.
    await exhaustResumeBudget(markerPath);

    const partials = Array.from(
      { length: 4 },
      (_unused, index) =>
        `.${path.basename(dbPath)}.pre-migration-restart-loop-${index}.sqlite.partial`,
    );
    await Promise.all(
      partials.map((name) => fs.writeFile(path.join(backupDirectory, name), "stranded snapshot")),
    );

    await expect(
      Effect.runPromise(
        Layer.build(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))).pipe(
          Effect.scoped,
        ),
      ),
    ).rejects.toThrow(MigrationRecoveryRequiredError);

    const remaining = await fs.readdir(backupDirectory);
    expect(remaining.filter((name) => name.endsWith(".partial"))).toEqual([]);

    // Reclaiming must never cost the user their restore point.
    expect(await fs.readFile(markerPath, "utf8")).toContain("migration-in-progress");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as { backupPath: string };
    await expect(fs.stat(marker.backupPath)).resolves.toBeDefined();
  });

  it("resumes an interrupted migration on the next startup without taking a second backup", async () => {
    // Regression: 0.6.0 wrote this marker and then refused to open the database
    // forever, with no in-app path back out. Startup must be able to finish the
    // migration it was interrupted during.
    const dbPath = await makeDbPath();

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* sql`CREATE TABLE resume_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO resume_probe(value) VALUES ('survives-resume')`;
        yield* runWithPreMigrationBackup(dbPath, Effect.fail(new Error("interrupted mid-flight")));
      }),
    ).catch(() => undefined);

    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const backupsBefore = await backupPaths(dbPath);
    expect(backupsBefore).toHaveLength(1);
    expect(await fs.readFile(markerPath, "utf8")).toContain("migration-in-progress");

    await Effect.runPromise(
      Layer.build(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))).pipe(
        Effect.scoped,
      ),
    );

    // Success is what clears the marker; nothing else is allowed to.
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    // Re-snapshotting here would both point recovery at the broken database and
    // copy the whole file on every restart.
    expect(await backupPaths(dbPath)).toEqual(backupsBefore);
    const provenance = JSON.parse(
      await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8"),
    ) as { readonly backupPath: string; readonly resumeAttempts: number };
    expect(provenance).toMatchObject({
      backupPath: backupsBefore[0],
      resumeAttempts: 1,
    });

    const healed = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(healed.prepare("SELECT value FROM resume_probe").get()).toMatchObject({
        value: "survives-resume",
      });
      expect(
        healed.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get(),
      ).toMatchObject({ id: Math.max(...migrationEntries.map(([id]) => id)) });
    } finally {
      healed.close();
    }
  });

  it("stops resuming and demands an operator restore once the budget is spent", async () => {
    const dbPath = await makeDbPath();

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* runWithPreMigrationBackup(dbPath, Effect.fail(new Error("interrupted mid-flight")));
      }),
    ).catch(() => undefined);

    const markerPath = migrationRecoveryMarkerPath(dbPath);
    await expect(Effect.runPromise(inspectPendingMigrationRecovery(dbPath))).resolves.toMatchObject(
      {
        resumeAttempts: 0,
      },
    );

    await exhaustResumeBudget(markerPath);

    await expect(Effect.runPromise(inspectPendingMigrationRecovery(dbPath))).rejects.toThrow(
      MigrationRecoveryRequiredError,
    );
    // The snapshot the operator restores from must still be intact.
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as { backupPath: string };
    await expect(fs.stat(marker.backupPath)).resolves.toBeDefined();
  });

  it("charges a resume attempt even when the retry dies mid-migration", async () => {
    const dbPath = await makeDbPath();

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* runWithPreMigrationBackup(dbPath, Effect.fail(new Error("interrupted mid-flight")));
      }),
    ).catch(() => undefined);

    const marker = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
    expect(marker).not.toBeNull();
    await Effect.runPromise(
      resumeMarkedMigration(dbPath, marker!, Effect.fail(new Error("died again"))),
    ).catch(() => undefined);

    // Charged up front: a process killed mid-migration must not get a free retry,
    // or a deterministic failure loops forever.
    await expect(Effect.runPromise(inspectPendingMigrationRecovery(dbPath))).resolves.toMatchObject(
      {
        resumeAttempts: 1,
      },
    );
  });

  it("retains the marker when a resumed migration has a duplicate-looking failure", async () => {
    const dbPath = await makeDbPath();

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* runWithPreMigrationBackup(dbPath, Effect.fail(new Error("interrupted mid-flight")));
      }),
    ).catch(() => undefined);

    const marker = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
    expect(marker).not.toBeNull();
    await expect(
      Effect.runPromise(
        resumeMarkedMigration(
          dbPath,
          marker!,
          Effect.fail(new Error("duplicate column name: fingerprint_version")),
        ),
      ),
    ).rejects.toThrow("duplicate column name");

    const chargedMarker = JSON.parse(
      await fs.readFile(migrationRecoveryMarkerPath(dbPath), "utf8"),
    ) as {
      readonly resumeAttempts: number;
      readonly backupPath: string;
    };
    expect(chargedMarker.resumeAttempts).toBe(1);
    await expect(fs.stat(chargedMarker.backupPath)).resolves.toBeDefined();
    await expect(Effect.runPromise(requireNoPendingMigrationRecovery(dbPath))).rejects.toThrow(
      MigrationRecoveryRequiredError,
    );
  });

  it("reclaims no files through a symlinked backup-directory root", async () => {
    if (process.platform === "win32") return;

    const dbPath = await makeDbPath();
    const otherDbPath = await makeDbPath();
    const backupDirectory = migrationBackupDirectory(dbPath);
    const otherBackupDirectory = migrationBackupDirectory(otherDbPath);
    await fs.mkdir(otherBackupDirectory, { recursive: true });
    await fs.symlink(otherBackupDirectory, backupDirectory, "dir");

    const foreignPartial = path.join(
      otherBackupDirectory,
      `.${path.basename(dbPath)}.pre-migration-foreign.sqlite.partial`,
    );
    await fs.writeFile(foreignPartial, "belongs to another database");

    await Effect.runPromise(reclaimOrphanedMigrationArtifacts(dbPath));

    expect((await fs.lstat(backupDirectory)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(foreignPartial, "utf8")).resolves.toBe("belongs to another database");
  });

  it("reclaims stranded marker partials without touching a live marker", async () => {
    const dbPath = await makeDbPath();
    await fs.writeFile(dbPath, "");
    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const strandedMarkerPartial = `${markerPath}.${randomUUID()}.partial`;
    const strandedBackupPartial = path.join(
      migrationBackupDirectory(dbPath),
      `.${path.basename(dbPath)}.pre-migration-20260101T000000Z-v0.6.0.${randomUUID()}.partial`,
    );
    await fs.mkdir(migrationBackupDirectory(dbPath), { recursive: true });
    await fs.writeFile(strandedMarkerPartial, "half-written");
    await fs.writeFile(strandedBackupPartial, "half-written");
    await fs.writeFile(markerPath, "{}");

    await Effect.runPromise(reclaimOrphanedMigrationArtifacts(dbPath));

    await expect(fs.stat(strandedMarkerPartial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(strandedBackupPartial)).rejects.toMatchObject({ code: "ENOENT" });
    // The marker itself is the recovery authority; the sweep must never take it.
    await expect(fs.stat(markerPath)).resolves.toBeDefined();
    await expect(fs.stat(dbPath)).resolves.toBeDefined();
  });

  it("retains the marker when the first migration has a duplicate-looking failure", async () => {
    const dbPath = await makeDbPath();

    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 52 });
          yield* sql`CREATE TABLE reapply_probe(value TEXT NOT NULL)`;
          yield* runWithPreMigrationBackup(
            dbPath,
            Effect.fail(new Error("duplicate column name: fingerprint_version")),
          );
        }),
      ),
    ).rejects.toThrow("duplicate column name");

    const markerPath = migrationRecoveryMarkerPath(dbPath);
    await expect(fs.stat(markerPath)).resolves.toBeDefined();
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as {
      readonly backupPath: string;
      readonly resumeAttempts: number;
    };
    expect(marker.resumeAttempts).toBe(0);
    await expect(fs.stat(marker.backupPath)).resolves.toBeDefined();
    await expect(Effect.runPromise(requireNoPendingMigrationRecovery(dbPath))).rejects.toThrow(
      MigrationRecoveryRequiredError,
    );
  });

  it("clears the marker after the real migrator completes an idempotent replay", async () => {
    const dbPath = await makeDbPath();
    const latestId = Math.max(...migrationEntries.map(([id]) => id));

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`CREATE TABLE replay_recovery_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO replay_recovery_probe(value) VALUES ('preserved')`;

        // Reproduce the tracker state left by lineage reconciliation after the
        // released migration-54 renumbering. The schema already contains this
        // range, so every replayed migration must be genuinely idempotent.
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 54`;
        const replayed = yield* runWithPreMigrationBackup(dbPath, runMigrations());
        expect(replayed[0]?.[0]).toBe(54);
        expect(replayed.at(-1)?.[0]).toBe(latestId);
      }),
    );

    await expect(fs.stat(migrationRecoveryMarkerPath(dbPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await backupPaths(dbPath)).toHaveLength(1);
    const provenance = JSON.parse(
      await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8"),
    ) as {
      readonly backupPath: string;
      readonly databasePath: string;
      readonly phase: string;
    };
    expect(provenance).toMatchObject({
      databasePath: dbPath,
      phase: "migration-completed",
    });
    await expect(fs.stat(provenance.backupPath)).resolves.toBeDefined();

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(database.prepare("SELECT value FROM replay_recovery_probe").get()).toMatchObject({
        value: "preserved",
      });
      expect(
        database.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get(),
      ).toMatchObject({ id: latestId });
    } finally {
      database.close();
    }
  });

  it("requires consent bound to the inspected database lineage before reconciliation", async () => {
    const dbPath = await makeDbPath();
    const latestId = Math.max(...migrationEntries.map(([id]) => id));

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* runMigrations({ toMigrationInclusive: 16 });
        for (let id = 17; id <= latestId + 2; id += 1) {
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (${id}, ${`ImportedMigration${id}`})
          `;
        }
        yield* sql`CREATE TABLE imported_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO imported_probe(value) VALUES ('imported-state')`;

        const blocked = yield* Effect.flip(runWithPreMigrationBackup(dbPath, runMigrations()));
        expect(blocked).toBeInstanceOf(MigrationDivergenceConsentRequiredError);
        if (!(blocked instanceof MigrationDivergenceConsentRequiredError)) return;
        expect(blocked.challenge).toMatchObject({
          databasePath: dbPath,
          firstDivergedId: 17,
          highWaterMark: latestId + 2,
          recordedName: "ImportedMigration17",
        });
        expect(yield* Effect.promise(() => backupPaths(dbPath))).toEqual([]);

        yield* sql`
          UPDATE effect_sql_migrations
          SET name = 'ChangedAfterInspection'
          WHERE migration_id = ${latestId + 2}
        `;
        const staleConsent = yield* Effect.flip(
          runWithPreMigrationBackup(dbPath, runMigrations(), {
            divergenceConsent: blocked.challenge.consentToken,
          }),
        );
        expect(staleConsent).toBeInstanceOf(MigrationDivergenceConsentRequiredError);
        if (!(staleConsent instanceof MigrationDivergenceConsentRequiredError)) return;
        expect(staleConsent.challenge.consentToken).not.toBe(blocked.challenge.consentToken);

        yield* runWithPreMigrationBackup(dbPath, runMigrations(), {
          divergenceConsent: staleConsent.challenge.consentToken,
        });
      }),
    );

    const [backupPath] = await backupPaths(dbPath);
    const backup = new DatabaseSync(backupPath!, { readOnly: true });
    try {
      expect(
        backup.prepare("SELECT name FROM effect_sql_migrations WHERE migration_id = 17").get(),
      ).toMatchObject({ name: "ImportedMigration17" });
      expect(backup.prepare("SELECT value FROM imported_probe").get()).toMatchObject({
        value: "imported-state",
      });
      expect(
        backup
          .prepare("SELECT name FROM effect_sql_migrations WHERE migration_id = ?")
          .get(latestId + 2),
      ).toMatchObject({ name: "ChangedAfterInspection" });
    } finally {
      backup.close();
    }

    const provenance = JSON.parse(
      await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8"),
    ) as {
      readonly backupPath: string;
      readonly lineageDivergence: Record<string, unknown>;
      readonly restore: {
        readonly executable: string;
        readonly arguments: readonly string[];
      };
      readonly sourceVersion: string;
      readonly targetVersion: number;
    };
    expect(provenance).toMatchObject({
      backupPath,
      restore: {
        executable: "synara-restore-migration-backup",
        arguments: [dbPath],
      },
      sourceVersion: `imported-v${latestId + 2}-from17`,
      targetVersion: latestId,
      lineageDivergence: {
        firstDivergedId: 17,
        recordedName: "ImportedMigration17",
      },
    });
  });

  it("requires consent for divergence after a legacy migration-32 tracker row", async () => {
    const dbPath = await makeDbPath();

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 31 });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES
            (32, 'LegacyImportedSchemaLineage'),
            (33, 'UnexpectedMigrationAfterLegacy32')
        `;

        const blocked = yield* Effect.flip(runWithPreMigrationBackup(dbPath, Effect.void));
        expect(blocked).toBeInstanceOf(MigrationDivergenceConsentRequiredError);
        if (!(blocked instanceof MigrationDivergenceConsentRequiredError)) return;
        expect(blocked.challenge).toMatchObject({
          firstDivergedId: 33,
          recordedName: "UnexpectedMigrationAfterLegacy32",
        });
      }),
    );

    expect(await backupPaths(dbPath)).toEqual([]);
  });

  it("keeps reviewed migration aliases on the automatic upgrade path", async () => {
    const dbPath = await makeDbPath();

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 53 });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (54, 'ProjectPullRequestPins')
        `;

        yield* runWithPreMigrationBackup(dbPath, runMigrations());

        const repaired = yield* sql<{ readonly name: string }>`
          SELECT name FROM effect_sql_migrations WHERE migration_id = 54
        `;
        expect(repaired[0]?.name).toBe("DurableProviderCommandDelivery");
      }),
    );

    const provenance = JSON.parse(
      await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8"),
    ) as { readonly lineageDivergence: unknown };
    expect(provenance.lineageDivergence).toBeNull();
  });

  it("restores the exact completed backup after the active marker is cleared", async () => {
    const dbPath = await makeDbPath();

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* sql`CREATE TABLE completed_restore_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO completed_restore_probe(value) VALUES ('before-upgrade')`;
        yield* runWithPreMigrationBackup(dbPath, runMigrations());
        yield* sql`UPDATE completed_restore_probe SET value = 'after-upgrade'`;
      }),
    );

    await expect(fs.stat(migrationRecoveryMarkerPath(dbPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));

    const restored = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM completed_restore_probe").get()).toMatchObject({
        value: "before-upgrade",
      });
      expect(
        restored.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get(),
      ).toMatchObject({ id: 52 });
    } finally {
      restored.close();
    }

    const provenance = JSON.parse(
      await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8"),
    ) as { readonly phase: string; readonly restoredAt?: string };
    expect(provenance.phase).toBe("migration-restored");
    expect(provenance.restoredAt).toBeTypeOf("string");
  });

  it("keeps an active restore marker until restored provenance is durable", async () => {
    const dbPath = await makeDbPath();

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* runWithPreMigrationBackup(dbPath, Effect.fail(new Error("interrupted mid-flight")));
      }),
    ).catch(() => undefined);

    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const provenancePath = migrationBackupProvenancePath(dbPath);
    await fs.mkdir(provenancePath);

    await expect(Effect.runPromise(restoreMarkedMigrationBackup(dbPath))).rejects.toThrow();
    const strandedMarker = JSON.parse(await fs.readFile(markerPath, "utf8")) as {
      readonly phase: string;
      readonly resumeAttempts: number;
    };
    expect(strandedMarker).toMatchObject({
      phase: "migration-restore-in-progress",
      resumeAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
    });
    await expect(Effect.runPromise(inspectPendingMigrationRecovery(dbPath))).rejects.toThrow(
      MigrationRecoveryRequiredError,
    );
  });

  it("prunes versioned snapshots to the bounded retention count", async () => {
    const dbPath = await makeDbPath();
    await fs.mkdir(migrationBackupDirectory(dbPath), { recursive: true, mode: 0o755 });
    await fs.chmod(migrationBackupDirectory(dbPath), 0o755);

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE prune_probe(value TEXT NOT NULL)`;
        for (let version = 0; version < MIGRATION_BACKUP_RETENTION + 3; version += 1) {
          yield* createMigrationBackup(dbPath, {
            sourceVersion: `v${version}`,
            targetVersion: version + 1,
          });
        }
      }),
    );

    const retainedBackups = await backupPaths(dbPath);
    expect(retainedBackups).toHaveLength(MIGRATION_BACKUP_RETENTION);
    if (process.platform !== "win32") {
      expect((await fs.stat(migrationBackupDirectory(dbPath))).mode & 0o777).toBe(0o700);
      for (const backupPath of retainedBackups) {
        expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
      }
    }
  });

  it("starts a new database without creating a meaningless backup", async () => {
    const dbPath = await makeDbPath();

    const startDatabase = () =>
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          yield* runWithPreMigrationBackup(dbPath, runMigrations());
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM effect_sql_migrations
          `;
          return rows[0]?.count ?? 0;
        }),
      );

    const migrationCount = await startDatabase();

    expect(migrationCount).toBe(migrationEntries.length);
    expect(await backupPaths(dbPath)).toEqual([]);

    // A current schema is a no-op startup and must not consume retention slots.
    expect(await startDatabase()).toBe(migrationEntries.length);
    expect(await backupPaths(dbPath)).toEqual([]);
  });

  it("repairs SQLite files before the live connection executes any statement", async () => {
    const dbPath = await makeDbPath();
    const sqlitePaths = new Set([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
    const asyncOpen = vi.spyOn(nodeFs.promises, "open");
    const syncOpen = vi.spyOn(nodeFs, "openSync");
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT 1`;
        }).pipe(
          Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
        ),
      );

      const firstPrepareOrder = prepare.mock.invocationCallOrder[0];
      expect(firstPrepareOrder).toBeDefined();
      const sqliteOpenOrders = [
        ...asyncOpen.mock.calls.map((args, index) => ({
          path: String(args[0]),
          order: asyncOpen.mock.invocationCallOrder[index],
        })),
        ...syncOpen.mock.calls.map((args, index) => ({
          path: String(args[0]),
          order: syncOpen.mock.invocationCallOrder[index],
        })),
      ].filter(({ path: openedPath }) => sqlitePaths.has(openedPath));

      expect(sqliteOpenOrders.length).toBeGreaterThan(0);
      for (const { order } of sqliteOpenOrders) {
        expect(order).toBeLessThan(firstPrepareOrder!);
      }
    } finally {
      asyncOpen.mockRestore();
      syncOpen.mockRestore();
      prepare.mockRestore();
    }
  });

  it("bounds every unreferenced artifact family without touching the live database", async () => {
    // Regression: retention only ever matched the `pre-migration-` prefix, so
    // `failed-migration-` bundles and legacy `pre-tracker-repair-` snapshots —
    // both full-size copies of the database — could never be reclaimed by any
    // code path a normal install runs.
    const dbPath = await makeDbPath();
    const dbDirectory = path.dirname(dbPath);
    const basename = path.basename(dbPath);
    const backupDirectory = migrationBackupDirectory(dbPath);
    await fs.mkdir(backupDirectory, { recursive: true });

    const liveFiles = [
      dbPath,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
      migrationRecoveryMarkerPath(dbPath),
    ];
    await Promise.all(liveFiles.map((filePath) => fs.writeFile(filePath, "live")));

    // Ordering must come from the name, so mtime is deliberately the inverse.
    const failedBundles = [1, 2, 3, 4, 5, 6].map(
      (value) => `${basename}.failed-migration-${artifactDay(value)}T120000000Z-${randomUUID()}`,
    );
    await Promise.all(
      failedBundles.flatMap((name, index) =>
        ["", "-wal", "-shm"].map(async (sidecar) => {
          const filePath = path.join(dbDirectory, `${name}${sidecar}`);
          await fs.writeFile(filePath, "moved aside");
          const inverted = new Date(Date.now() - index * 60_000);
          await fs.utimes(filePath, inverted, inverted);
        }),
      ),
    );
    const strandedSidecars = ["-wal", "-shm"].map(
      (sidecar) => `${basename}.failed-migration-${artifactDay(9)}T120000000Z-stranded${sidecar}`,
    );
    const undatedBundle = `${basename}.failed-migration-legacy-without-a-timestamp`;
    await Promise.all(
      [...strandedSidecars, undatedBundle, `${undatedBundle}-wal`].map((name) =>
        fs.writeFile(path.join(dbDirectory, name), "unrankable"),
      ),
    );

    // The short `YYYYMMDDThhmm` stamp is the form the released writer used.
    const trackerRepairs = [1, 2, 3].map(
      (value) => `${basename}.pre-tracker-repair-v0.6.0-${artifactDay(value)}T1355.sqlite`,
    );
    const undatedTrackerRepair = `${basename}.pre-tracker-repair-v0.6.0-unknown.sqlite`;
    const preMigrationBackups = [1, 2].map(
      (value) =>
        `${basename}.pre-migration-v52-to-v53-${artifactDay(value)}T120000000Z-${randomUUID()}.sqlite`,
    );
    await Promise.all(
      [...trackerRepairs, undatedTrackerRepair, ...preMigrationBackups].map((name) =>
        fs.writeFile(path.join(backupDirectory, name), "snapshot"),
      ),
    );

    await Effect.runPromise(reclaimOrphanedMigrationArtifacts(dbPath));

    const remainingBesideDatabase = await fs.readdir(dbDirectory);
    expect(
      remainingBesideDatabase
        .filter((name) => name.startsWith(`${basename}.failed-migration-`))
        .toSorted(),
    ).toEqual(
      [
        ...failedBundles
          .slice(-FAILED_MIGRATION_BUNDLE_RETENTION)
          .flatMap((name) => [name, `${name}-wal`, `${name}-shm`]),
        // Unrankable names are retained, never guessed at. Sidecars with no
        // bundle to restore are reclaimed and never occupy a retention slot.
        undatedBundle,
        `${undatedBundle}-wal`,
      ].toSorted(),
    );
    for (const filePath of liveFiles) {
      expect(await fs.readFile(filePath, "utf8")).toBe("live");
    }

    const remainingBackups = await fs.readdir(backupDirectory);
    expect(
      remainingBackups.filter((name) => name.includes("pre-tracker-repair")).toSorted(),
    ).toEqual(
      [
        ...trackerRepairs.slice(-TRACKER_REPAIR_SNAPSHOT_RETENTION),
        undatedTrackerRepair,
      ].toSorted(),
    );
    // Restorable snapshots are off limits before the recovery marker is validated.
    expect(remainingBackups.filter((name) => name.includes("pre-migration")).toSorted()).toEqual(
      [...preMigrationBackups].toSorted(),
    );
  });

  it("bounds failed-migration bundles on the normal startup path", async () => {
    // The explicit restore command was the only caller that ever pruned these,
    // and most installs never run it — so a 1.2 GB copy of the database sat
    // beside it indefinitely.
    const dbPath = await makeDbPath();
    const basename = path.basename(dbPath);

    const startDatabase = () =>
      Effect.runPromise(
        Layer.build(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))).pipe(
          Effect.scoped,
        ),
      );
    await startDatabase();

    const bundles = [1, 2, 3, 4, 5].map(
      (value) => `${basename}.failed-migration-${artifactDay(value)}T120000000Z-${randomUUID()}`,
    );
    await Promise.all(
      bundles.map((name) => fs.writeFile(path.join(path.dirname(dbPath), name), "moved aside")),
    );

    await startDatabase();

    const remaining = (await fs.readdir(path.dirname(dbPath))).filter((name) =>
      name.startsWith(`${basename}.failed-migration-`),
    );
    expect(remaining.toSorted()).toEqual(
      bundles.slice(-FAILED_MIGRATION_BUNDLE_RETENTION).toSorted(),
    );
    await expect(fs.stat(dbPath)).resolves.toBeDefined();
  });

  it("keeps the live database and WAL private without a shared-memory sidecar", async () => {
    const dbPath = await makeDbPath();

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE permission_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO permission_probe(value) VALUES ('private')`;
        if (process.platform !== "win32") {
          for (const filePath of [dbPath, `${dbPath}-wal`]) {
            const stat = yield* Effect.promise(() => fs.stat(filePath));
            expect(stat.mode & 0o777).toBe(0o600);
          }
        }
        yield* Effect.promise(async () => {
          await expect(fs.stat(`${dbPath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
        });
      }).pipe(
        Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      ),
    );
    expect(await backupPaths(dbPath)).toEqual([]);
  });
});
