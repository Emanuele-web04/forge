import { Effect, Layer, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { MigrationSchemaTooNewError } from "../Errors.ts";
import {
  inspectPendingMigrationRecovery,
  reclaimOrphanedMigrationArtifacts,
  resumeMarkedMigration,
  runWithPreMigrationBackup,
  type MigrationRecoveryMarker,
} from "../MigrationBackup.ts";
import { createMigrationSchemaTooNewStartupBlockError } from "../MigrationSchemaTooNewStartupBlock.ts";
import { ensurePrivateFileSync, repairPrivateFile } from "../../privatePathPermissions.ts";
import { ServerConfig } from "../../config.ts";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "../DatabaseLifecycleLock.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = (
  config: RuntimeSqliteLayerConfig,
): Layer.Layer<SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const runtime = process.versions.bun !== undefined ? "bun" : "node";
    const loader = defaultSqliteClientLoaders[runtime];
    const clientModule = yield* Effect.promise<Loader>(loader);
    return clientModule.layer(config);
  }).pipe(Layer.unwrap);

function errnoCode(cause: unknown): string | undefined {
  const error = cause as (Error & { readonly code?: string; readonly cause?: unknown }) | null;
  return error?.code ?? (error?.cause as NodeJS.ErrnoException | undefined)?.code;
}

const repairSqliteFilePermissions = (dbPath: string) =>
  Effect.promise(async () => {
    await repairPrivateFile(dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      await repairPrivateFile(`${dbPath}${suffix}`).catch((cause) => {
        if (errnoCode(cause) !== "ENOENT") throw cause;
      });
    }
  });

interface SqliteSetupOptions {
  readonly dbPath?: string | undefined;
  readonly pendingRecovery?: MigrationRecoveryMarker | null | undefined;
  readonly divergenceConsent?: string | undefined;
}

const makeSetup = ({
  dbPath,
  pendingRecovery = null,
  divergenceConsent,
}: SqliteSetupOptions = {}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (dbPath) {
        // The runtime owns this database for its entire lifetime (enforced by
        // DatabaseLifecycleLock), so make SQLite enforce the same boundary.
        // This must happen before the first WAL access: SQLite then keeps its
        // WAL index in heap memory instead of memory-mapping a shared `-shm`
        // file that an unrelated sqlite client could truncate or rebuild.
        const lockingModeRows = yield* sql<{ readonly locking_mode: string }>`
          PRAGMA locking_mode = EXCLUSIVE;
        `;
        const lockingMode = lockingModeRows[0]?.locking_mode;
        if (lockingMode?.toLowerCase() !== "exclusive") {
          return yield* Effect.fail(
            new Error(
              `SQLite exclusive locking mode could not be enabled (result: ${lockingMode ?? "unknown"})`,
            ),
          );
        }
      }
      yield* sql`PRAGMA busy_timeout = 5000;`;
      const journalModeRows = yield* sql<{ readonly journal_mode: string }>`
        PRAGMA journal_mode = WAL;
      `;
      const journalMode = journalModeRows[0]?.journal_mode;
      if (journalMode?.toLowerCase() !== "wal") {
        yield* Effect.logWarning("SQLite WAL journal mode could not be enabled", {
          resultingJournalMode: journalMode ?? "unknown",
        });
      }
      // synchronous = NORMAL under WAL preserves database consistency and is
      // safe across application crashes (no corruption, no torn writes). The
      // only accepted risk is that an OS crash or power loss may lose the most
      // recent committed transaction(s) that had not yet been checkpointed.
      // That tradeoff is deliberate: at our per-event write rate, FULL's fsync
      // on every commit is too costly, and losing the last few events on a hard
      // power loss is acceptable.
      yield* sql`PRAGMA synchronous = NORMAL;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      // The event log alone can exceed a gigabyte, so the 2MB default page
      // cache thrashes during projector replay and large projection reads.
      // 256MB of page cache (negative value = KiB) keeps the hot b-tree
      // interior pages resident. It is an on-demand ceiling for the single
      // serialized connection, not an upfront allocation. temp_store stays at
      // its default deliberately: the snapshot window queries can build
      // temp b-trees proportional to live-thread history, and MEMORY would
      // turn those into unbounded native RSS; the disk default already keeps
      // small temp structures in memory and only spills when they grow.
      yield* sql`PRAGMA cache_size = -262144;`;
      if (dbPath) {
        // mmap serves large sequential reads (event replay, VACUUM INTO
        // backups) through the OS page cache without double-buffering into
        // the SQLite heap cache. In-memory databases have nothing to map.
        // Accepted tradeoff: with mmap, a device I/O error or an external
        // process truncating the file surfaces as a signal (SIGBUS) instead
        // of a recoverable SQLite error. locking_mode=EXCLUSIVE plus the
        // lifecycle lock make external mutation effectively impossible, and
        // no internal path truncates the live database.
        yield* sql`PRAGMA mmap_size = 1073741824;`;
        // Setting locking_mode changes connection policy; this transaction
        // actually acquires and retains the database lock before startup
        // continues, closing the window where another client could attach.
        yield* sql`BEGIN EXCLUSIVE;`;
        yield* sql`COMMIT;`;
      }
      // A pending marker means an earlier startup was interrupted mid-migration.
      // Resuming reuses that attempt's snapshot instead of taking a second one,
      // so the fallback stays the last known-good database.
      const migrations = dbPath
        ? pendingRecovery
          ? resumeMarkedMigration(dbPath, pendingRecovery, runMigrations())
          : runWithPreMigrationBackup(dbPath, runMigrations(), { divergenceConsent })
        : runMigrations();
      yield* migrations.pipe(
        Effect.catch((cause) =>
          cause instanceof MigrationSchemaTooNewError && dbPath
            ? Effect.promise(() =>
                createMigrationSchemaTooNewStartupBlockError(dbPath, cause),
              ).pipe(Effect.flatMap(Effect.fail))
            : Effect.fail(cause),
        ),
      );
    }),
  );

export const makeSqlitePersistenceLive = (
  dbPath: string,
  options: { readonly divergenceConsent?: string | undefined } = {},
) =>
  Effect.acquireRelease(acquireDatabaseLifecycleLock(dbPath), (lock) =>
    releaseDatabaseLifecycleLock(lock).pipe(Effect.orDie),
  ).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
        // Ahead of the guard on purpose: a database that fails closed below
        // never reaches the backup path, so this is the only opportunity to
        // reclaim artifacts stranded by an earlier failed startup or restore.
        yield* reclaimOrphanedMigrationArtifacts(dbPath);
        const pendingRecovery = yield* inspectPendingMigrationRecovery(dbPath);
        // Set the mode before SQLite opens the database. Never reopen the
        // database, WAL, or SHM merely to chmod them while this connection is
        // live: closing any descriptor for the same inode releases POSIX
        // process locks and can leave a mapped WAL index vulnerable to SIGBUS.
        // SQLite creates its sidecars with the database's private mode.
        yield* Effect.sync(() => ensurePrivateFileSync(dbPath));
        yield* repairSqliteFilePermissions(dbPath);

        return Layer.provideMerge(
          makeSetup({
            dbPath,
            pendingRecovery,
            divergenceConsent: options.divergenceConsent,
          }),
          makeRuntimeSqliteLayer({ filename: dbPath }),
        );
      }),
    ),
    Layer.unwrap,
  );

export const SqlitePersistenceMemory = Layer.provideMerge(
  makeSetup(),
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath, migrationDivergenceConsent }) =>
    makeSqlitePersistenceLive(dbPath, { divergenceConsent: migrationDivergenceConsent }),
  ),
);
