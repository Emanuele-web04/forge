import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
  migrationBackupDirectory,
  migrationBackupProvenancePath,
  migrationRecoveryMarkerPath,
  parseMigrationRecoveryResumeState,
  type MigrationSchemaTooNewRecovery,
} from "@synara/shared/migrationRecovery";
export {
  migrationBackupDirectory,
  migrationBackupProvenancePath,
  migrationRecoveryMarkerPath,
} from "@synara/shared/migrationRecovery";

import { ensurePrivateDirectorySync, repairPrivateFile } from "../privatePathPermissions.ts";
import { withDatabaseLifecycleLock } from "./DatabaseLifecycleLock.ts";
import {
  createMigrationDivergenceConsentChallenge,
  MigrationDivergenceConsentRequiredError,
  type MigrationDivergencePlan,
} from "./MigrationDivergenceConsent.ts";
export { MigrationDivergenceConsentRequiredError } from "./MigrationDivergenceConsent.ts";
import {
  findFirstMigrationLineageDivergence,
  LAST_SHARED_LINEAGE_MIGRATION_ID,
  migrationEntries,
  planLegacyMigration32Rename,
  planMigrationLineageAliasRepairs,
} from "./Migrations.ts";

/** Keep at most this many finished pre-migration SQLite backups (issue #618). */
export const MIGRATION_BACKUP_RETENTION = 5;
export const FAILED_MIGRATION_BUNDLE_RETENTION = 3;

const STALE_RECOVERY_ARTIFACT_AGE_MS = 24 * 60 * 60 * 1_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class MigrationRecoveryRequiredError extends Error {
  readonly _tag = "MigrationRecoveryRequiredError";

  constructor(
    readonly dbPath: string,
    readonly markerPath: string,
    readonly backupPath: string,
    detail?: string,
  ) {
    super(
      `Migration recovery is required for ${dbPath}.${detail ? ` ${detail}` : ""} Stop every Synara process, then run: synara-restore-migration-backup ${shellQuote(dbPath)}`,
    );
    this.name = "MigrationRecoveryRequiredError";
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "an unknown amount";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Raised instead of starting a backup that cannot possibly fit. Failing here is
 * deliberate: migrating without a restorable snapshot risks the user's data,
 * and half-writing one risks their disk.
 */
export class InsufficientMigrationBackupSpaceError extends Error {
  readonly _tag = "InsufficientMigrationBackupSpaceError";

  constructor(
    readonly requiredBytes: number,
    readonly availableBytes: number,
    readonly directory: string,
  ) {
    super(
      `Not enough free disk space to back up the database before upgrading it. ` +
        `About ${formatBytes(requiredBytes)} is needed in ${directory}, but only ` +
        `${formatBytes(availableBytes)} is free. Free up disk space and start Synara again.`,
    );
    this.name = "InsufficientMigrationBackupSpaceError";
  }
}

const MIGRATION_BACKUP_FREE_SPACE_FACTOR = 2;

const logicalDatabaseSizeBytes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly pageCount: number;
    readonly pageSize: number;
  }>`
    SELECT
      page_count AS "pageCount",
      page_size AS "pageSize"
    FROM pragma_page_count(), pragma_page_size()
  `;
  const pageCount = Number(rows[0]?.pageCount);
  const pageSize = Number(rows[0]?.pageSize);
  const logicalBytes = pageCount * pageSize;
  return Number.isFinite(logicalBytes) && logicalBytes >= 0 ? logicalBytes : null;
});

/**
 * Estimates the largest useful SQLite snapshot before applying a safety
 * factor. `page_count * page_size` describes the connection's logical database
 * and therefore includes committed pages that are still only in the WAL.
 *
 * If the PRAGMAs are unavailable, the main file plus the physical WAL is a
 * conservative fallback. Failure to inspect either source is deliberately
 * represented as `null`; an indeterminate estimate must not block a legitimate
 * upgrade.
 */
export const estimateMigrationBackupRequiredBytes = (dbPath: string) =>
  Effect.gen(function* () {
    const logicalBytes = yield* logicalDatabaseSizeBytes.pipe(
      Effect.matchCause({
        onFailure: () => null,
        onSuccess: (bytes) => bytes,
      }),
    );
    return yield* Effect.promise(async () => {
      let mainFileBytes: number;
      try {
        mainFileBytes = (await fs.stat(dbPath)).size;
      } catch {
        return null;
      }

      let snapshotBytes: number;
      if (logicalBytes !== null) {
        snapshotBytes = Math.max(mainFileBytes, logicalBytes);
      } else {
        let walBytes = 0;
        try {
          walBytes = (await fs.stat(`${dbPath}-wal`)).size;
        } catch {
          // The WAL is optional, and an unreadable fallback must not make
          // startup less reliable than it was before the space guard existed.
        }
        snapshotBytes = mainFileBytes + walBytes;
      }

      const requiredBytes = snapshotBytes * MIGRATION_BACKUP_FREE_SPACE_FACTOR;
      return Number.isFinite(requiredBytes) && requiredBytes >= 0 ? requiredBytes : null;
    });
  });

/**
 * Refuses to begin a snapshot the filesystem cannot hold. A `statfs` that is
 * unavailable or racing must never block a legitimate upgrade, so an
 * indeterminate answer is treated as "proceed".
 */
async function assertBackupSpaceAvailable(
  requiredBytes: number | null,
  backupDirectory: string,
): Promise<void> {
  if (requiredBytes === null) return;
  let availableBytes: number;
  try {
    const filesystem = await fs.statfs(backupDirectory);
    availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  } catch {
    return;
  }
  if (!Number.isFinite(requiredBytes) || !Number.isFinite(availableBytes)) return;
  if (availableBytes < requiredBytes) {
    throw new InsufficientMigrationBackupSpaceError(requiredBytes, availableBytes, backupDirectory);
  }
}

type MigrationBackupPlan = MigrationDivergencePlan;

export type MigrationBackupResult = MigrationBackupPlan & {
  readonly backupPath: string;
  readonly createdAt: string;
};

const attemptPromise = <A>(tryPromise: () => Promise<A>) =>
  Effect.tryPromise({ try: tryPromise, catch: (cause) => cause });

const latestMigrationId = Math.max(...migrationEntries.map(([id]) => id));

function migrationLineageFingerprint(
  recorded: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(recorded.map(({ migration_id, name }) => [migration_id, name])))
    .digest("hex");
}

export const inspectMigrationBackupPlan = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `;
  if (tables.length === 0) {
    return null;
  }

  const hasTracker = tables.some((table) => table.name === "effect_sql_migrations");
  if (!hasTracker) {
    return { sourceVersion: "untracked", targetVersion: latestMigrationId };
  }

  const recordedResult = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
  `.pipe(
    Effect.map((rows) => ({ status: "read" as const, rows })),
    Effect.catch(() => Effect.succeed({ status: "malformed" as const })),
  );
  if (recordedResult.status === "malformed") {
    return { sourceVersion: "malformed-tracker", targetVersion: latestMigrationId };
  }
  const recorded = recordedResult.rows;
  const userTables = tables.filter((table) => table.name !== "effect_sql_migrations");
  if (recorded.length === 0) {
    return userTables.length === 0
      ? null
      : { sourceVersion: "untracked", targetVersion: latestMigrationId };
  }

  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name] as const));
  const highWaterMark = recorded[recorded.length - 1]!.migration_id;
  const inspectedNames = new Map(recordedNames);
  const migration32Rename = planLegacyMigration32Rename(recordedNames);
  if (migration32Rename !== null) {
    inspectedNames.set(32, migration32Rename);
  }
  for (const repair of planMigrationLineageAliasRepairs(inspectedNames)) {
    if (repair.kind === "rename") {
      inspectedNames.set(repair.migrationId, repair.name);
    } else {
      inspectedNames.delete(repair.migrationId);
    }
  }
  const inspectedHighWaterMark = Math.max(...inspectedNames.keys(), 0);
  // This is the same post-alias predicate the reconciler uses. Sharing it keeps
  // "this database needs consent" and "this database will be replayed" aligned.
  const firstDiverged = findFirstMigrationLineageDivergence(inspectedNames, inspectedHighWaterMark);
  if (firstDiverged !== undefined) {
    const [firstDivergedId, expectedName] = firstDiverged;
    // Shared-lineage divergence is rejected before the migrator mutates data.
    if (firstDivergedId <= LAST_SHARED_LINEAGE_MIGRATION_ID) {
      return null;
    }
    return {
      sourceVersion:
        migration32Rename === null
          ? `imported-v${highWaterMark}-from${firstDivergedId}`
          : `v${highWaterMark}-legacy32`,
      targetVersion: latestMigrationId,
      lineageDivergence: {
        firstDivergedId,
        expectedName,
        recordedName: inspectedNames.get(firstDivergedId) ?? "<missing>",
        highWaterMark,
        lineageFingerprint: migrationLineageFingerprint(recorded),
      },
    };
  }

  if (migration32Rename !== null) {
    return { sourceVersion: `v${highWaterMark}-legacy32`, targetVersion: latestMigrationId };
  }

  if (highWaterMark < latestMigrationId) {
    return { sourceVersion: `v${highWaterMark}`, targetVersion: latestMigrationId };
  }
  return null;
});

function compactTimestamp(date: Date): string {
  return date.toISOString().replaceAll(/[-:.]/gu, "");
}

function safeVersionLabel(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "-");
}

async function ensurePrivateBackupDirectory(directory: string): Promise<void> {
  ensurePrivateDirectorySync(directory);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw cause;
  } finally {
    await handle.close();
  }
}

/**
 * Flushes a freshly written regular file to stable storage.
 *
 * The handle is opened read-write on purpose. Windows `FlushFileBuffers`
 * requires `GENERIC_WRITE`, so syncing through an `O_RDONLY` handle fails there
 * with EPERM/EACCES — which is how a full-size `.partial` snapshot was stranded
 * on every single backup attempt.
 */
async function syncRegularFile(filePath: string): Promise<void> {
  const flags =
    process.platform === "win32" ? fsConstants.O_RDWR : fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
  const handle = await fs.open(filePath, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateRegularFile(filePath: string) {
  await repairPrivateFile(filePath);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Migration backup is not a regular file: ${filePath}`);
  }
  return stat;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return process.platform === "win32" || (left.dev === right.dev && left.ino === right.ino);
}

async function assertDirectoryIdentity(directory: string, openedStat: Stats): Promise<void> {
  const currentStat = await fs.lstat(directory);
  if (
    !currentStat.isDirectory() ||
    currentStat.isSymbolicLink() ||
    !sameFileIdentity(openedStat, currentStat)
  ) {
    throw new Error(`Directory identity changed while it was open: ${directory}`);
  }
}

function nullOnMissing(cause: unknown): null {
  if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw cause;
}

/**
 * The only guarded way this module is allowed to delete files.
 *
 * `names` lists the directory's regular files (readdir's `isFile()` is already
 * false for symlinks), `lstat` reads one of them, and `unlink` removes one only
 * after re-checking that it is still a regular, non-symlinked file.
 *
 * The directory itself is opened with no-follow semantics and kept open for the
 * whole sweep. This prevents a symlinked backup root from redirecting cleanup
 * into another database's directory; identity checks before every unlink also
 * reject replacement of the root while cleanup is running. A missing directory
 * is not an error — nothing to reclaim is the expected steady state.
 */
type DirectorySweep = {
  readonly names: ReadonlyArray<string>;
  readonly lstat: (name: string) => Promise<Stats | null>;
  readonly unlink: (name: string) => Promise<void>;
};

async function withCleanupDirectory(
  directory: string,
  sweep: (context: DirectorySweep) => Promise<void>,
): Promise<void> {
  const pathStat = await fs.lstat(directory).catch(nullOnMissing);
  if (pathStat === null) return;
  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw new Error(`Cleanup root is not a real directory: ${directory}`);
  }

  const run = async (openedStat: Stats) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await sweep({
      names: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
      lstat: (name) => fs.lstat(path.join(directory, name)).catch(nullOnMissing),
      unlink: async (name) => {
        const artifactPath = path.join(directory, name);
        const stat = await fs.lstat(artifactPath).catch(nullOnMissing);
        if (!stat || !stat.isFile() || stat.isSymbolicLink()) return;
        await assertDirectoryIdentity(directory, openedStat);
        await fs.unlink(artifactPath).catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        });
      },
    });
  };

  // Windows cannot portably open and fsync directory handles. The lstat checks
  // still reject symlink roots there; on Unix, keep an O_NOFOLLOW descriptor
  // open for the entire destructive sweep.
  if (process.platform === "win32") {
    await run(pathStat);
    return;
  }

  const directoryHandle = await fs.open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const openedStat = await directoryHandle.stat();
    if (!openedStat.isDirectory() || !sameFileIdentity(openedStat, pathStat)) {
      throw new Error(`Cleanup root changed while it was opened: ${directory}`);
    }
    await run(openedStat);
  } finally {
    await directoryHandle.close();
  }
}

/**
 * Removes matching regular files from a directory.
 *
 * `olderThanMs` restricts removal to artifacts that have aged past a cutoff.
 * Omitting it removes every match regardless of age, which is only correct for
 * artifacts whose exclusive owner is the caller holding the lifecycle lock.
 */
async function removeRegularFiles(
  directory: string,
  matches: (name: string) => boolean,
  options: { readonly olderThanMs?: number } = {},
): Promise<void> {
  await withCleanupDirectory(directory, async ({ names, lstat, unlink }) => {
    const cutoff =
      options.olderThanMs === undefined
        ? Number.POSITIVE_INFINITY
        : Date.now() - options.olderThanMs;
    await Promise.all(
      names.filter(matches).map(async (name) => {
        if (cutoff !== Number.POSITIVE_INFINITY) {
          const stat = await lstat(name);
          if (!stat || stat.mtimeMs >= cutoff) return;
        }
        await unlink(name);
      }),
    );
  });
}

const removeStaleRegularFiles = (directory: string, matches: (name: string) => boolean) =>
  removeRegularFiles(directory, matches, { olderThanMs: STALE_RECOVERY_ARTIFACT_AGE_MS });

/**
 * Matches the temporary snapshot `createMigrationBackup` writes before renaming
 * a finished backup into place.
 *
 * The leading dot is load-bearing: it is precisely why these orphans never
 * matched the finished-backup prefix that retention pruning filters on, so a
 * stranded partial could never be reclaimed by any existing cleanup path.
 */
function isMigrationBackupPartial(dbBasename: string): (name: string) => boolean {
  const partialPrefix = `.${dbBasename}.pre-migration-`;
  return (name) => name.startsWith(partialPrefix) && name.endsWith(".partial");
}

/**
 * Matches a temporary migration-state JSON file before its atomic rename.
 *
 * These land next to the database rather than in the backup directory, so the
 * backup-partial sweep never sees them. The write window is tiny, but a crash
 * inside it strands the file permanently — in the very directory whose file churn
 * is what users notice.
 */
function isAtomicMigrationJsonPartial(basename: string): (name: string) => boolean {
  const partialPrefix = `${basename}.`;
  return (name) => name !== basename && name.startsWith(partialPrefix) && name.endsWith(".partial");
}

const BUNDLE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;
const BUNDLE_SIDECAR_PATTERN = /-(?:wal|shm)$/u;

/**
 * Matches the compact UTC timestamp every generated artifact carries.
 *
 * `compactTimestamp` has emitted `YYYYMMDDThhmmssmmmZ` for as long as this
 * module has existed, but artifacts written by older releases (the
 * `pre-tracker-repair` snapshots) use the shorter `YYYYMMDDThhmm` form, so both
 * the seconds and the milliseconds are optional and the `Z` is not required.
 * The digit lookarounds stop a longer run of digits from being read as a
 * timestamp that happens to start inside it.
 */
const ARTIFACT_TIMESTAMP_PATTERN =
  /(?<!\d)(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(\d{3})?Z?(?!\d)/gu;

/**
 * Orders retention on the timestamp the writer encoded into the filename.
 *
 * The name is the only ordering key that survives a restore, a copy, or a
 * backup tool, all of which rewrite `mtime` freely — and reordering a family by
 * mtime is how the *newest* snapshot could be the one that gets pruned.
 *
 * Returns `null` for a name whose timestamp cannot be read. Callers must treat
 * that as "retain, never delete": an artifact whose age is unknown cannot be
 * proven older than the ones being kept.
 */
function artifactTimestampMs(name: string): number | null {
  let parsed: number | null = null;
  for (const match of name.matchAll(ARTIFACT_TIMESTAMP_PATTERN)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    const millisecond = match[7] === undefined ? 0 : Number(match[7]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    if (hour > 23 || minute > 59 || second > 59) continue;
    parsed = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  }
  return parsed;
}

/**
 * One prefix-delimited family of migration artifacts, and how much of it to keep.
 *
 * `directory` is part of the descriptor on purpose: the snapshot families live
 * in `migrationBackupDirectory(dbPath)` while the failed-migration bundles live
 * beside the database in `path.dirname(dbPath)`, and a family pointed at the
 * wrong tree would either reclaim nothing or reclaim something it does not own.
 */
type MigrationArtifactFamily = {
  readonly directory: string;
  /** Full filename prefix, database basename included. Never matches the live database. */
  readonly prefix: string;
  /** Suffix every member carries, when the family has one. */
  readonly suffix?: string;
  /** How many of the newest members survive. */
  readonly retention: number;
  /** Members own their SQLite `-wal`/`-shm` sidecars and are reclaimed together. */
  readonly bundled?: boolean;
  /** Repair 0600/regular-file expectations while walking the family. */
  readonly ensurePrivate?: boolean;
};

/**
 * Keeps the newest `retention` members of one family and reclaims the rest.
 *
 * This is the single implementation of retention for every artifact family. The
 * families differ only in where they live, what they are named, how many to
 * keep, and whether they carry sidecars — never in their safety rules, which is
 * why those rules live here once: regular files only, no symlink following, no
 * deletion of a name the prefix does not claim, no deletion of a name whose age
 * cannot be established, and ENOENT tolerated throughout.
 */
async function pruneMigrationArtifactFamily(family: MigrationArtifactFamily): Promise<void> {
  const suffix = family.suffix ?? "";
  await withCleanupDirectory(family.directory, async ({ names, unlink }) => {
    const present = new Set(names);
    const members = new Set(
      names
        .filter((name) => name.startsWith(family.prefix) && name.endsWith(suffix))
        .map((name) => (family.bundled ? name.replace(BUNDLE_SIDECAR_PATTERN, "") : name)),
    );

    const ranked = (
      await Promise.all(
        [...members].map(async (name) => {
          if (family.bundled && !present.has(name)) {
            // A crash can leave only WAL/SHM sidecars. They are not a restorable
            // bundle, so they never occupy a retention slot and are reclaimed
            // outright instead of being ranked against real artifacts.
            await Promise.all(
              BUNDLE_SIDECAR_SUFFIXES.map((sidecar) => unlink(`${name}${sidecar}`)),
            );
            return null;
          }
          const timestampMs = artifactTimestampMs(name);
          if (timestampMs === null) return null;
          if (
            family.ensurePrivate &&
            (await ensurePrivateRegularFile(path.join(family.directory, name)).catch(
              nullOnMissing,
            )) === null
          ) {
            return null;
          }
          return { name, timestampMs };
        }),
      )
    ).filter(
      (member): member is { readonly name: string; readonly timestampMs: number } =>
        member !== null,
    );

    ranked.sort(
      (left, right) => right.timestampMs - left.timestampMs || right.name.localeCompare(left.name),
    );
    await Promise.all(
      ranked
        .slice(Math.max(0, family.retention))
        .flatMap(({ name }) =>
          family.bundled
            ? ["", ...BUNDLE_SIDECAR_SUFFIXES].map((sidecar) => unlink(`${name}${sidecar}`))
            : [unlink(name)],
        ),
    );
  });
}

/** Restorable snapshots this codebase writes before it migrates a database. */
const preMigrationBackupFamily = (dbPath: string, retention: number): MigrationArtifactFamily => ({
  directory: migrationBackupDirectory(dbPath),
  prefix: `${path.basename(dbPath)}.pre-migration-`,
  suffix: ".sqlite",
  retention,
  ensurePrivate: true,
});

/**
 * Full-size snapshots an older release wrote beside real backups before it
 * repaired a malformed migration tracker.
 *
 * Nothing in this codebase writes them any more and no recovery path can
 * restore from one, so they are pure one-shot diagnostics — which is exactly
 * why no prune ever matched them and why a stranded copy sat unreclaimed for
 * the lifetime of the install. They are the same size as the database itself,
 * and the snapshot taken minutes either side of one is already retained by the
 * `pre-migration` family, so a single newest copy is kept purely as a forensic
 * last resort.
 */
export const TRACKER_REPAIR_SNAPSHOT_RETENTION = 1;

const trackerRepairSnapshotFamily = (dbPath: string): MigrationArtifactFamily => ({
  directory: migrationBackupDirectory(dbPath),
  prefix: `${path.basename(dbPath)}.pre-tracker-repair-`,
  suffix: ".sqlite",
  retention: TRACKER_REPAIR_SNAPSHOT_RETENTION,
  ensurePrivate: true,
});

/**
 * The live database an explicit restore moved aside, with its WAL and SHM.
 *
 * These land next to the database rather than in the backup directory. They can
 * hold writes made after the last snapshot, so more than one is kept — but they
 * are also full-size copies, which is why the bound matters.
 */
const failedMigrationBundleFamily = (dbPath: string): MigrationArtifactFamily => ({
  directory: path.dirname(dbPath),
  prefix: `${path.basename(dbPath)}.failed-migration-`,
  retention: FAILED_MIGRATION_BUNDLE_RETENTION,
  bundled: true,
});

const pruneFailedMigrationBundles = (dbPath: string): Promise<void> =>
  pruneMigrationArtifactFamily(failedMigrationBundleFamily(dbPath));

/**
 * Reclaims every artifact family a migration can strand, except the restorable
 * `pre-migration` snapshots.
 *
 * Those are deliberately excluded: this runs on the normal startup path, ahead
 * of the guard that validates the recovery marker, so it must not be able to
 * remove the snapshot the marker points at. The families it does prune are the
 * ones no code path ever restores from, and therefore the ones that could grow
 * without bound — a failed-migration bundle was only ever pruned by the
 * explicit restore command, which most installs never run.
 */
const pruneUnreferencedMigrationArtifacts = (dbPath: string): Promise<void> =>
  Promise.all([
    pruneMigrationArtifactFamily(trackerRepairSnapshotFamily(dbPath)),
    pruneFailedMigrationBundles(dbPath),
  ]).then(() => undefined);

/**
 * Applies retention to every migration artifact family, each independently.
 *
 * Per-family retention is the point: a shared bound would let one family's churn
 * evict another's, and a single prefix match is what left the `failed-migration`
 * and `pre-tracker-repair` families unreclaimable for their entire existence.
 */
export const pruneMigrationBackups = (dbPath: string, retention = MIGRATION_BACKUP_RETENTION) =>
  attemptPromise(async () => {
    // Orphaned partials are unreferenced by construction: the only writer holds
    // the database lifecycle lock, and a partial that outlived its writer can
    // never be promoted to a backup. Reclaim them unconditionally — an age
    // cutoff here is what allowed them to accumulate without bound.
    await removeRegularFiles(
      migrationBackupDirectory(dbPath),
      isMigrationBackupPartial(path.basename(dbPath)),
    );
    await Promise.all([
      pruneMigrationArtifactFamily(preMigrationBackupFamily(dbPath, retention)),
      pruneUnreferencedMigrationArtifacts(dbPath),
    ]);
  });

export const createMigrationBackup = (dbPath: string, plan: MigrationBackupPlan) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const backupDirectory = migrationBackupDirectory(dbPath);
    yield* attemptPromise(() => ensurePrivateBackupDirectory(backupDirectory));
    const basename = path.basename(dbPath);
    // Unconditional, not age-gated. Every partial found here outlived the
    // process that wrote it, and the 24h staleness cutoff that used to guard
    // this sweep is what let a restart loop accumulate them without bound.
    yield* attemptPromise(() =>
      removeRegularFiles(backupDirectory, isMigrationBackupPartial(basename)),
    );
    const requiredBytes = yield* estimateMigrationBackupRequiredBytes(dbPath);
    yield* attemptPromise(() => assertBackupSpaceAvailable(requiredBytes, backupDirectory));
    const createdAt = new Date().toISOString();
    const uniqueSuffix = `${compactTimestamp(new Date(createdAt))}-${randomUUID()}`;
    const finalName = `${basename}.pre-migration-${safeVersionLabel(plan.sourceVersion)}-to-v${plan.targetVersion}-${uniqueSuffix}.sqlite`;
    const backupPath = path.join(backupDirectory, finalName);
    const temporaryPath = path.join(backupDirectory, `.${finalName}.partial`);

    yield* Effect.gen(function* () {
      yield* sql`VACUUM INTO ${temporaryPath}`;
      yield* attemptPromise(async () => {
        await ensurePrivateRegularFile(temporaryPath);
        await syncRegularFile(temporaryPath);
        await fs.rename(temporaryPath, backupPath);
        await syncDirectory(backupDirectory);
      });
    }).pipe(
      // Must span the whole critical section, not just the vacuum. A failure
      // while syncing or renaming otherwise strands a full-size copy of the
      // database that no cleanup path could reclaim.
      Effect.tapError(() => attemptPromise(() => fs.unlink(temporaryPath)).pipe(Effect.ignore)),
    );
    yield* pruneMigrationBackups(dbPath);
    return { ...plan, backupPath, createdAt } satisfies MigrationBackupResult;
  });

/** Durably replaces private JSON in one atomic rename; never leaves a partial behind. */
async function writePrivateJsonFile(filePath: string, payload: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.partial`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await ensurePrivateRegularFile(temporaryPath);
    await syncRegularFile(temporaryPath);
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (cause) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw cause;
  }
}

function migrationRecoveryPayload(dbPath: string, backup: MigrationBackupResult) {
  return {
    version: 1,
    databasePath: dbPath,
    backupPath: backup.backupPath,
    sourceVersion: backup.sourceVersion,
    targetVersion: backup.targetVersion,
    lineageDivergence: backup.lineageDivergence ?? null,
    phase: "migration-in-progress",
    createdAt: backup.createdAt,
    resumeAttempts: 0,
    restore: {
      executable: "synara-restore-migration-backup",
      arguments: [dbPath],
    },
    recovery:
      "Stop every Synara process, then run the explicit migration-backup restore command for this database.",
  } as const;
}

const writeRecoveryMarker = (dbPath: string, payload: Record<string, unknown>) =>
  attemptPromise(() => writePrivateJsonFile(migrationRecoveryMarkerPath(dbPath), payload));

const writeCompletedMigrationProvenance = (dbPath: string, payload: Record<string, unknown>) =>
  attemptPromise(() =>
    writePrivateJsonFile(migrationBackupProvenancePath(dbPath), {
      ...payload,
      version: 1,
      databasePath: dbPath,
      phase: "migration-completed",
      completedAt: new Date().toISOString(),
    }),
  );

const removeRecoveryMarker = (dbPath: string) =>
  attemptPromise(async () => {
    await fs.unlink(migrationRecoveryMarkerPath(dbPath));
    await syncDirectory(path.dirname(dbPath));
  });

const removeRecoveryMarkerIfPresent = async (dbPath: string): Promise<void> => {
  try {
    await fs.unlink(migrationRecoveryMarkerPath(dbPath));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  await syncDirectory(path.dirname(dbPath));
};

export interface RunWithPreMigrationBackupOptions {
  readonly divergenceConsent?: string | undefined;
}

export const runWithPreMigrationBackup = <A, E, R>(
  dbPath: string,
  migration: Effect.Effect<A, E, R>,
  options: RunWithPreMigrationBackupOptions = {},
) =>
  Effect.gen(function* () {
    const plan = yield* inspectMigrationBackupPlan;
    if (plan) {
      const challenge = createMigrationDivergenceConsentChallenge(dbPath, plan);
      if (challenge && options.divergenceConsent !== challenge.consentToken) {
        return yield* Effect.fail(new MigrationDivergenceConsentRequiredError(challenge));
      }
    }
    const backup = plan ? yield* createMigrationBackup(dbPath, plan) : null;
    const recoveryPayload = backup ? migrationRecoveryPayload(dbPath, backup) : null;
    if (recoveryPayload) {
      // This write-ahead marker must be durable before migrations can mutate
      // the live database. A later startup will fail closed until an operator
      // explicitly restores the known-good snapshot.
      yield* writeRecoveryMarker(dbPath, recoveryPayload);
    }
    const result = yield* migration;
    if (recoveryPayload) {
      yield* writeCompletedMigrationProvenance(dbPath, recoveryPayload);
      yield* removeRecoveryMarker(dbPath);
    }
    return result;
  });

/**
 * Restores a standalone SQLite migration snapshot. The caller must stop every
 * process using the database first; stale WAL/SHM files are moved aside with
 * the failed main database so they cannot replay into the restored snapshot.
 */
const restoreSqliteMigrationBackup = (input: {
  readonly dbPath: string;
  readonly backupPath: string;
  readonly latestSupportedMigrationId: number;
  readonly beforeLiveDatabaseSwap?: (() => Promise<void>) | undefined;
  readonly afterLiveDatabaseRollback?: (() => Promise<void>) | undefined;
}) =>
  attemptPromise(async () => {
    const sourceInspection = await inspectSqliteMigrationBackup(input.backupPath);
    assertMigrationBackupCompatible(sourceInspection, input.latestSupportedMigrationId);
    const dbDirectory = path.dirname(input.dbPath);
    const dbBasename = path.basename(input.dbPath);
    await removeStaleRegularFiles(
      dbDirectory,
      (name) => name.startsWith(`${dbBasename}.`) && name.endsWith(".restore"),
    );
    const restoredTemporaryPath = `${input.dbPath}.${randomUUID()}.restore`;
    try {
      await fs.copyFile(input.backupPath, restoredTemporaryPath, fsConstants.COPYFILE_EXCL);
      await ensurePrivateRegularFile(restoredTemporaryPath);
      await syncRegularFile(restoredTemporaryPath);
      const copiedInspection = await inspectSqliteMigrationBackup(restoredTemporaryPath);
      assertMigrationBackupCompatible(copiedInspection, input.latestSupportedMigrationId);
      if (copiedInspection.migrationId !== sourceInspection.migrationId) {
        throw new Error(`Migration backup changed while it was copied: ${input.backupPath}`);
      }
    } catch (cause) {
      await fs.unlink(restoredTemporaryPath).catch(() => undefined);
      throw cause;
    }

    const failedSuffix = `.failed-migration-${compactTimestamp(new Date())}-${randomUUID()}`;
    const moved: Array<readonly [string, string]> = [];
    let swapPrepared = false;
    try {
      swapPrepared = true;
      await input.beforeLiveDatabaseSwap?.();
      for (const suffix of ["", "-wal", "-shm"]) {
        const source = `${input.dbPath}${suffix}`;
        const destination = `${input.dbPath}${failedSuffix}${suffix}`;
        try {
          await fs.rename(source, destination);
          moved.push([source, destination]);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }
      await fs.rename(restoredTemporaryPath, input.dbPath);
    } catch (cause) {
      // Rollback is valid only before the restored main database is installed.
      await fs.unlink(restoredTemporaryPath).catch(() => undefined);
      let rollbackSucceeded = true;
      for (const [source, destination] of moved.reverse()) {
        await fs.rename(destination, source).catch(() => {
          rollbackSucceeded = false;
        });
      }
      if (swapPrepared && rollbackSucceeded) {
        await input.afterLiveDatabaseRollback?.();
      }
      throw cause;
    }

    // Make the database/WAL/SHM swap durable before the caller records the
    // completed restore and clears the marker. Until both happen, a crash or
    // cleanup failure remains an explicit, retryable recovery state.
    await syncDirectory(path.dirname(input.dbPath));
    await pruneFailedMigrationBundles(input.dbPath);
    await syncDirectory(path.dirname(input.dbPath));
  });

interface SqliteMigrationBackupInspection {
  readonly migrationId: number;
  readonly lineage: "canonical" | "imported" | "incompatible";
}

async function inspectSqliteMigrationBackup(
  backupPath: string,
): Promise<SqliteMigrationBackupInspection> {
  const backupStat = await fs.lstat(backupPath);
  if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
    throw new Error(`Migration backup is not a regular file: ${backupPath}`);
  }

  let integrity: unknown;
  let migration: SqliteMigrationBackupInspection;
  if (process.versions.bun !== undefined) {
    const { Database } = await import("bun:sqlite");
    const database = new Database(backupPath, { readonly: true });
    try {
      integrity = database.query("PRAGMA integrity_check").get();
      migration = readBunMigrationInspection(database);
    } finally {
      database.close();
    }
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(backupPath, { readOnly: true });
    try {
      integrity = database.prepare("PRAGMA integrity_check").get();
      migration = readNodeMigrationInspection(database);
    } finally {
      database.close();
    }
  }
  if (
    !integrity ||
    typeof integrity !== "object" ||
    !Object.values(integrity as Record<string, unknown>).includes("ok")
  ) {
    throw new Error(`Migration backup failed SQLite integrity_check: ${backupPath}`);
  }
  return migration;
}

function readBunMigrationInspection(
  database: import("bun:sqlite").Database,
): SqliteMigrationBackupInspection {
  const tracker = database
    .query(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
    )
    .get();
  if (!tracker) return inspectMigrationRows([]);
  return inspectMigrationRows(
    database
      .query(
        "SELECT migration_id AS migrationId, name FROM effect_sql_migrations ORDER BY migration_id ASC",
      )
      .all(),
  );
}

function readNodeMigrationInspection(
  database: import("node:sqlite").DatabaseSync,
): SqliteMigrationBackupInspection {
  const tracker = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
    )
    .get();
  if (!tracker) return inspectMigrationRows([]);
  return inspectMigrationRows(
    database
      .prepare(
        "SELECT migration_id AS migrationId, name FROM effect_sql_migrations ORDER BY migration_id ASC",
      )
      .all(),
  );
}

function inspectMigrationRows(rows: ReadonlyArray<unknown>): SqliteMigrationBackupInspection {
  const recordedNames = new Map<number, string>();
  for (const row of rows) {
    const migration = row as { readonly migrationId?: unknown; readonly name?: unknown };
    if (
      typeof migration.migrationId !== "number" ||
      !Number.isSafeInteger(migration.migrationId) ||
      migration.migrationId < 0 ||
      typeof migration.name !== "string"
    ) {
      throw new Error("Migration backup has an unreadable migration tracker.");
    }
    recordedNames.set(migration.migrationId, migration.name);
  }

  for (const repair of planMigrationLineageAliasRepairs(recordedNames)) {
    if (repair.kind === "rename") {
      recordedNames.set(repair.migrationId, repair.name);
    } else {
      recordedNames.delete(repair.migrationId);
    }
  }
  const migrationId = Math.max(...recordedNames.keys(), 0);
  const divergence = findFirstMigrationLineageDivergence(recordedNames, migrationId);
  return {
    migrationId,
    lineage:
      divergence === undefined
        ? "canonical"
        : divergence[0] > LAST_SHARED_LINEAGE_MIGRATION_ID
          ? "imported"
          : "incompatible",
  };
}

function assertMigrationBackupCompatible(
  inspection: SqliteMigrationBackupInspection,
  latestSupportedMigrationId: number,
): void {
  if (inspection.lineage === "incompatible") {
    throw new Error("Migration backup has an unrecognized migration lineage.");
  }
  if (inspection.lineage === "canonical" && inspection.migrationId > latestSupportedMigrationId) {
    throw new Error(
      `Migration backup schema ${inspection.migrationId} is newer than this build ` +
        `(latest supported migration: ${latestSupportedMigrationId}).`,
    );
  }
}

export type MigrationRecoveryMarker = {
  readonly markerPath: string;
  readonly backupPath: string;
  /** How many times startup has already re-run the interrupted migration. */
  readonly resumeAttempts: number;
  /** The marker verbatim, so a resume can bump one field without losing the rest. */
  readonly payload: Record<string, unknown>;
};

function generatedBackupNamePattern(dbPath: string): RegExp {
  const escapedBasename = path.basename(dbPath).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^${escapedBasename}\\.pre-migration-[A-Za-z0-9_-]+-to-v\\d+-\\d{8}T\\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.sqlite$`,
    "iu",
  );
}

async function readRegularFileNoFollow(filePath: string): Promise<string> {
  const pathStat = await fs.lstat(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`Path is not a real regular file: ${filePath}`);
  }
  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await fs.open(filePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Path is not a regular file: ${filePath}`);
    if (process.platform !== "win32" && (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino)) {
      throw new Error(`Path identity changed while it was opened: ${filePath}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readMigrationBackupRecord(
  dbPath: string,
  recordPath: string,
  recordLabel: string,
): Promise<MigrationRecoveryMarker | null> {
  let recordText: string;
  try {
    recordText = await readRegularFileNoFollow(recordPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }

  const record = JSON.parse(recordText) as {
    readonly databasePath?: unknown;
    readonly backupPath?: unknown;
  };
  if (record.databasePath !== dbPath || typeof record.backupPath !== "string") {
    throw new Error(`Invalid ${recordLabel}: ${recordPath}`);
  }
  const resumeState = parseMigrationRecoveryResumeState(recordText);
  if (resumeState === null) {
    throw new Error(`${recordLabel} has an unreadable resume counter: ${recordPath}`);
  }
  const backupDirectory = path.resolve(migrationBackupDirectory(dbPath));
  const backupDirectoryStat = await fs.lstat(backupDirectory);
  if (!backupDirectoryStat.isDirectory() || backupDirectoryStat.isSymbolicLink()) {
    throw new Error(`Invalid migration backup directory: ${backupDirectory}`);
  }
  const backupPath = path.resolve(record.backupPath);
  const backupName = path.basename(backupPath);
  if (
    record.backupPath !== backupPath ||
    path.dirname(backupPath) !== backupDirectory ||
    !generatedBackupNamePattern(dbPath).test(backupName)
  ) {
    throw new Error(`${recordLabel} references an invalid backup: ${backupPath}`);
  }
  const backupStat = await fs.lstat(backupPath);
  if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
    throw new Error(`${recordLabel} references a non-regular backup: ${backupPath}`);
  }
  const canonicalBackupDirectory = await fs.realpath(backupDirectory);
  const canonicalBackupPath = await fs.realpath(backupPath);
  if (path.dirname(canonicalBackupPath) !== canonicalBackupDirectory) {
    throw new Error(`${recordLabel} backup escapes its canonical directory: ${backupPath}`);
  }
  return {
    markerPath: recordPath,
    backupPath,
    resumeAttempts: resumeState.attempts,
    payload: record as Record<string, unknown>,
  };
}

const readMigrationRecoveryMarker = (dbPath: string) =>
  readMigrationBackupRecord(
    dbPath,
    migrationRecoveryMarkerPath(dbPath),
    "migration recovery marker",
  );

const readCompletedMigrationProvenance = (dbPath: string) =>
  readMigrationBackupRecord(
    dbPath,
    migrationBackupProvenancePath(dbPath),
    "migration backup provenance",
  );

export async function inspectCompletedMigrationBackupForSchemaTooNew(
  dbPath: string,
  input: {
    readonly databaseMigrationId: number;
    readonly latestSupportedMigrationId: number;
  },
): Promise<MigrationSchemaTooNewRecovery> {
  let record: MigrationRecoveryMarker | null;
  try {
    record = await readCompletedMigrationProvenance(dbPath);
  } catch {
    return { kind: "restore-unavailable", reason: "invalid-provenance" };
  }
  if (!record) {
    return { kind: "restore-unavailable", reason: "missing-provenance" };
  }
  if (
    record.payload.phase !== "migration-completed" ||
    record.payload.targetVersion !== input.databaseMigrationId
  ) {
    return { kind: "restore-unavailable", reason: "invalid-provenance" };
  }

  let inspection: SqliteMigrationBackupInspection;
  try {
    inspection = await inspectSqliteMigrationBackup(record.backupPath);
  } catch {
    return { kind: "restore-unavailable", reason: "invalid-backup" };
  }
  if (
    inspection.lineage === "incompatible" ||
    (inspection.lineage === "canonical" &&
      inspection.migrationId > input.latestSupportedMigrationId)
  ) {
    return { kind: "restore-unavailable", reason: "incompatible-backup" };
  }
  return {
    kind: "restore-available",
    backupPath: record.backupPath,
    provenancePath: record.markerPath,
    backupMigrationId: inspection.migrationId,
  };
}

/**
 * Reclaims stranded migration artifacts before startup can fail closed.
 *
 * A database that already needs recovery never reaches the backup path, so this
 * must run ahead of {@link requireNoPendingMigrationRecovery}. Without it a
 * wedged install keeps every partial its restart loop produced — the failure
 * mode that filled hundreds of gigabytes in minutes.
 *
 * Four things are swept: snapshot partials, marker partials, provenance
 * partials, and artifact families that no recovery path can restore from.
 * Removing partials unconditionally is safe only
 * because every caller holds the database lifecycle lock, which makes this
 * process their sole owner; the retained families are bounded rather than
 * emptied. It never removes a finished `pre-migration` backup, never a live
 * marker, never the database or its WAL/SHM.
 */
export const reclaimOrphanedMigrationArtifacts = (dbPath: string) =>
  attemptPromise(async () => {
    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const provenancePath = migrationBackupProvenancePath(dbPath);
    await Promise.all([
      removeRegularFiles(
        migrationBackupDirectory(dbPath),
        isMigrationBackupPartial(path.basename(dbPath)),
      ),
      removeRegularFiles(
        path.dirname(markerPath),
        isAtomicMigrationJsonPartial(path.basename(markerPath)),
      ),
      removeRegularFiles(
        path.dirname(provenancePath),
        isAtomicMigrationJsonPartial(path.basename(provenancePath)),
      ),
      pruneUnreferencedMigrationArtifacts(dbPath),
    ]);
  }).pipe(Effect.ignore);

/** Read-only startup guard. It never restores, renames, or removes recovery files. */
export const requireNoPendingMigrationRecovery = (dbPath: string) =>
  attemptPromise(async () => {
    const marker = await readValidatedRecoveryMarker(dbPath);
    if (marker) {
      throw new MigrationRecoveryRequiredError(dbPath, marker.markerPath, marker.backupPath);
    }
  });

async function readValidatedRecoveryMarker(
  dbPath: string,
): Promise<MigrationRecoveryMarker | null> {
  try {
    return await readMigrationRecoveryMarker(dbPath);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new MigrationRecoveryRequiredError(
      dbPath,
      migrationRecoveryMarkerPath(dbPath),
      "unknown",
      `The recovery marker could not be validated: ${detail}.`,
    );
  }
}

/**
 * Read-only startup gate that permits a bounded self-heal.
 *
 * Returns the pending marker when startup is still allowed to re-run the
 * interrupted migration, `null` when nothing is pending, and fails closed with
 * {@link MigrationRecoveryRequiredError} once the resume budget is spent or the
 * marker cannot be validated. Like the strict guard, it never restores,
 * renames, or removes anything.
 */
export const inspectPendingMigrationRecovery = (dbPath: string) =>
  attemptPromise(async () => {
    const marker = await readValidatedRecoveryMarker(dbPath);
    if (marker && marker.resumeAttempts >= MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS) {
      throw new MigrationRecoveryRequiredError(
        dbPath,
        marker.markerPath,
        marker.backupPath,
        `Startup already re-ran the interrupted migration ${marker.resumeAttempts} time(s) without success.`,
      );
    }
    return marker;
  });

/**
 * Re-runs the migration an earlier startup was interrupted during.
 *
 * Deliberately does *not* take a fresh backup and does *not* rewrite the
 * marker's backup pointer: the snapshot this database must fall back to is the
 * one captured before the first attempt. Re-snapshotting here would both point
 * recovery at an already-broken database and copy the full file on every
 * restart — the exact behaviour that filled disks in the field.
 *
 * The attempt is charged to the durable budget *before* the migration runs, so
 * a process that dies mid-migration still consumes one attempt and the loop
 * terminates. Only success clears the marker. Effect's SQL migrator rolls its
 * transaction back when a migration statement fails, so treating a
 * duplicate-looking error as success would merely hide the restore point while
 * leaving the same migration ready to fail again on the next startup.
 */
export const resumeMarkedMigration = <A, E, R>(
  dbPath: string,
  marker: MigrationRecoveryMarker,
  migration: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* Effect.logWarning("Resuming an interrupted database migration", {
      databasePath: dbPath,
      backupPath: marker.backupPath,
      previousAttempts: marker.resumeAttempts,
      remainingAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS - marker.resumeAttempts,
    });
    const resumedPayload = {
      ...marker.payload,
      resumeAttempts: marker.resumeAttempts + 1,
      lastResumeAt: new Date().toISOString(),
    };
    yield* attemptPromise(() => writePrivateJsonFile(marker.markerPath, resumedPayload));
    const result = yield* migration;
    yield* writeCompletedMigrationProvenance(dbPath, resumedPayload);
    yield* removeRecoveryMarker(dbPath);
    yield* Effect.logInfo("Interrupted database migration completed on resume", {
      databasePath: dbPath,
    });
    return result;
  });

/**
 * Explicit one-shot restore path for the active recovery marker or the latest
 * completed migration provenance. The operator must stop every Synara process
 * before invoking it; startup itself deliberately never calls this function.
 */
export interface RestoreMarkedMigrationBackupOptions {
  readonly expectedBackupPath?: string | undefined;
  readonly expectedProvenancePath?: string | undefined;
}

export const restoreMarkedMigrationBackup = (
  dbPath: string,
  options: RestoreMarkedMigrationBackupOptions = {},
) =>
  withDatabaseLifecycleLock(
    dbPath,
    attemptPromise(async () => {
      const hasExpectedCompletedBackup =
        options.expectedBackupPath !== undefined || options.expectedProvenancePath !== undefined;
      if (
        hasExpectedCompletedBackup &&
        (options.expectedBackupPath === undefined || options.expectedProvenancePath === undefined)
      ) {
        throw new Error("Both expected migration backup and provenance paths are required.");
      }
      let activeMarker: MigrationRecoveryMarker | null;
      if (hasExpectedCompletedBackup) {
        try {
          activeMarker = await readMigrationRecoveryMarker(dbPath);
        } catch {
          activeMarker = null;
        }
      } else {
        activeMarker = await readMigrationRecoveryMarker(dbPath);
      }
      const completedProvenance =
        hasExpectedCompletedBackup || !activeMarker
          ? await readCompletedMigrationProvenance(dbPath)
          : null;
      const matchingRestoreMarker =
        hasExpectedCompletedBackup &&
        activeMarker !== null &&
        activeMarker.backupPath === options.expectedBackupPath &&
        activeMarker.payload.phase === "migration-restore-in-progress"
          ? activeMarker
          : null;
      const record = hasExpectedCompletedBackup
        ? (matchingRestoreMarker ?? completedProvenance)
        : (activeMarker ?? completedProvenance);
      if (!record) {
        throw new Error(
          `No migration recovery marker or completed backup provenance exists for ${dbPath}.`,
        );
      }
      if (hasExpectedCompletedBackup) {
        if (
          completedProvenance === null ||
          completedProvenance.backupPath !== options.expectedBackupPath ||
          completedProvenance.markerPath !== options.expectedProvenancePath
        ) {
          throw new Error("Completed migration provenance no longer matches the selected backup.");
        }
      }

      const restoringCompletedProvenance = record === completedProvenance;
      if (restoringCompletedProvenance) {
        if (record.payload.phase !== "migration-completed") {
          throw new Error(`Migration backup provenance is not restorable: ${record.markerPath}`);
        }
        const liveInspection = await inspectSqliteMigrationBackup(dbPath);
        if (record.payload.targetVersion !== liveInspection.migrationId) {
          throw new Error(
            `Migration backup provenance does not describe the current database: ${record.markerPath}`,
          );
        }
      }
      const restoreMarkerPath = migrationRecoveryMarkerPath(dbPath);
      const restoreMarkerPayload = {
        ...record.payload,
        version: 1,
        databasePath: dbPath,
        backupPath: record.backupPath,
        phase: "migration-restore-in-progress",
        restoreStartedAt: new Date().toISOString(),
        resumeAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
      };
      await Effect.runPromise(
        restoreSqliteMigrationBackup({
          dbPath,
          backupPath: record.backupPath,
          latestSupportedMigrationId: latestMigrationId,
          // Defer the fail-closed marker until the backup has been copied and
          // verified. If the live swap then rolls back completely, restore the
          // marker state that existed before this explicit attempt.
          beforeLiveDatabaseSwap: () =>
            writePrivateJsonFile(restoreMarkerPath, restoreMarkerPayload),
          afterLiveDatabaseRollback: restoringCompletedProvenance
            ? () => removeRecoveryMarkerIfPresent(dbPath)
            : () => writePrivateJsonFile(record.markerPath, record.payload),
        }),
      );
      await writePrivateJsonFile(migrationBackupProvenancePath(dbPath), {
        ...record.payload,
        version: 1,
        databasePath: dbPath,
        phase: "migration-restored",
        restoredAt: new Date().toISOString(),
      });
      await fs.unlink(migrationRecoveryMarkerPath(dbPath)).catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      });
      await syncDirectory(path.dirname(dbPath));
    }),
  );
