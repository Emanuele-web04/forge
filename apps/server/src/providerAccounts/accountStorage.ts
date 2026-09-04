import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AppProcessLease,
  ProviderAccountRecord,
  type AccountSurface,
  type SupportedAccountProvider,
} from "@synara/contracts";
import { secretName } from "@synara/shared/providerAccounts/accountIds";
import {
  accountDir,
  accountJsonPath,
  accountSecretPath,
  accountsDir,
  activePointerDir,
  activePointerPath,
  appLeasesDir,
  launcherDiagnosticsDir,
  pendingDir,
  pendingPath,
  secretsDir,
  versionFilePath,
} from "@synara/shared/providerAccounts/accountPaths";
import { Data, Effect, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite";
import { ensurePrivateDirectorySync, PRIVATE_DIRECTORY_MODE } from "../privatePathPermissions";

export const ACCOUNT_ROOT_SCHEMA_VERSION = "1";

// Journal marker for the pending → ordinal move. It is written into the
// reserved ordinal directory before any content moves and removed only after
// the move completes, so a directory that still carries it is incomplete.
export const FINALIZE_MARKER_FILE = "finalize.json";

export class ProviderAccountStorageError extends Data.TaggedError("ProviderAccountStorageError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const storageError =
  (operation: string, detail: string) =>
  (cause: unknown): ProviderAccountStorageError =>
    new ProviderAccountStorageError({ operation, detail, cause });

const tryFs = <A>(operation: string, detail: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: storageError(operation, detail) });

const decodeAccountRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProviderAccountRecord),
);
const encodeAccountRecord = Schema.encodeEffect(Schema.fromJsonString(ProviderAccountRecord));
const decodeAppLease = Schema.decodeUnknownEffect(Schema.fromJsonString(AppProcessLease));
const encodeAppLease = Schema.encodeEffect(Schema.fromJsonString(AppProcessLease));

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

export interface AccountStorageInput {
  readonly root: string;
}

export type AccountStorageShape = ReturnType<typeof makeAccountStorage>;

export function makeAccountStorage(input: AccountStorageInput) {
  const { root } = input;
  // Serializes ordinal allocation and pointer writes within this process; the
  // filesystem layout keeps cross-process writers safe via atomic renames.
  const providerLocks = new Map<SupportedAccountProvider, Semaphore.Semaphore>();
  const providerLock = (provider: SupportedAccountProvider): Semaphore.Semaphore => {
    let lock = providerLocks.get(provider);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      providerLocks.set(provider, lock);
    }
    return lock;
  };

  const withProviderLock = <A, E, R>(
    provider: SupportedAccountProvider,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => providerLock(provider).withPermits(1)(effect);

  const ensureRoot = Effect.gen(function* () {
    const existingVersion = yield* tryFs(
      "accountStorage.ensureRoot",
      `Failed to initialize account root ${root}.`,
      async () => {
        for (const dir of [
          root,
          activePointerDir(root),
          path.join(root, "accounts"),
          path.join(root, "pending"),
          path.join(root, "locks"),
          secretsDir(root),
          appLeasesDir(root),
          launcherDiagnosticsDir(root),
        ]) {
          ensurePrivateDirectorySync(dir);
        }
        return readFileIfExists(versionFilePath(root));
      },
    );
    if (existingVersion === null) {
      yield* writeFileStringAtomically({
        filePath: versionFilePath(root),
        contents: ACCOUNT_ROOT_SCHEMA_VERSION,
      }).pipe(
        Effect.mapError(
          storageError("accountStorage.ensureRoot", "Failed to write account root version file."),
        ),
      );
    }
  });

  const readVersion = tryFs(
    "accountStorage.readVersion",
    "Failed to read account root version file.",
    async () => (await readFileIfExists(versionFilePath(root)))?.trim() ?? null,
  );

  // A missing pointer means the native account zero; an existing but invalid
  // pointer fails closed so a corrupted file can never silently route work to
  // the native credentials (review finding 6).
  const readActiveOrdinal = (provider: SupportedAccountProvider) =>
    tryFs(
      "accountStorage.readActiveOrdinal",
      `Failed to read active pointer for '${provider}'.`,
      () => readFileIfExists(activePointerPath(root, provider)),
    ).pipe(
      Effect.flatMap((contents) => {
        if (contents === null) return Effect.succeed(null);
        const trimmed = contents.trim();
        const ordinal = /^(0|[1-9][0-9]*)$/.test(trimmed) ? Number(trimmed) : Number.NaN;
        return Number.isSafeInteger(ordinal) && ordinal >= 0
          ? Effect.succeed(ordinal)
          : Effect.fail(
              new ProviderAccountStorageError({
                operation: "accountStorage.readActiveOrdinal",
                detail: `Active pointer for '${provider}' is corrupted. Repair it from Synara → Settings → Accounts, or delete ${activePointerPath(root, provider)} to reset to the native account.`,
              }),
            );
      }),
    );

  const writeActiveOrdinal = (provider: SupportedAccountProvider, ordinal: number) =>
    ensureRoot.pipe(
      Effect.andThen(
        writeFileStringAtomically({
          filePath: activePointerPath(root, provider),
          contents: String(ordinal),
        }).pipe(
          Effect.mapError(
            storageError(
              "accountStorage.writeActiveOrdinal",
              `Failed to write active pointer for '${provider}'.`,
            ),
          ),
        ),
      ),
    );

  const readAccount = (provider: SupportedAccountProvider, ordinal: number) =>
    tryFs(
      "accountStorage.readAccount",
      `Failed to read account record for '${provider}' ordinal ${ordinal}.`,
      () => readFileIfExists(accountJsonPath(root, provider, ordinal)),
    ).pipe(
      Effect.flatMap((contents) =>
        contents === null
          ? Effect.succeed(null)
          : decodeAccountRecord(contents).pipe(
              Effect.mapError(
                storageError(
                  "accountStorage.readAccount",
                  `Account record for '${provider}' ordinal ${ordinal} is invalid.`,
                ),
              ),
            ),
      ),
    );

  const writeAccount = (record: ProviderAccountRecord) =>
    encodeAccountRecord(record).pipe(
      Effect.mapError(
        storageError(
          "accountStorage.writeAccount",
          `Failed to encode account record for '${record.provider}' ordinal ${record.ordinal}.`,
        ),
      ),
      Effect.flatMap((contents) =>
        tryFs(
          "accountStorage.writeAccount",
          `Failed to prepare account directory for '${record.provider}' ordinal ${record.ordinal}.`,
          async () => {
            ensurePrivateDirectorySync(accountDir(root, record.provider, record.ordinal));
          },
        ).pipe(
          Effect.andThen(
            writeFileStringAtomically({
              filePath: accountJsonPath(root, record.provider, record.ordinal),
              contents,
            }).pipe(
              Effect.mapError(
                storageError(
                  "accountStorage.writeAccount",
                  `Failed to write account record for '${record.provider}' ordinal ${record.ordinal}.`,
                ),
              ),
            ),
          ),
        ),
      ),
    );

  const listOrdinals = (provider: SupportedAccountProvider) =>
    tryFs(
      "accountStorage.listOrdinals",
      `Failed to list account directories for '${provider}'.`,
      async () => {
        try {
          const entries = await fs.readdir(accountsDir(root, provider), { withFileTypes: true });
          return entries
            .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name))
            .map((entry) => Number(entry.name))
            .toSorted((left, right) => left - right);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw cause;
        }
      },
    );

  const listAccounts = (provider: SupportedAccountProvider) =>
    listOrdinals(provider).pipe(
      Effect.flatMap((ordinals) =>
        Effect.forEach(ordinals, (ordinal) => readAccount(provider, ordinal)),
      ),
      Effect.map((records) => records.filter((record) => record !== null)),
    );

  const nextOrdinal = (provider: SupportedAccountProvider) =>
    listOrdinals(provider).pipe(
      Effect.map((ordinals) => (ordinals.length === 0 ? 1 : Math.max(...ordinals) + 1)),
    );

  // Reserves the next ordinal by atomically creating its account directory
  // (mkdir without recursive fails with EEXIST if another writer won the
  // race). Cross-process safe: the directory itself is the reservation.
  const reserveOrdinalDirectory = (provider: SupportedAccountProvider) =>
    ensureRoot.pipe(
      Effect.andThen(
        tryFs(
          "accountStorage.reserveOrdinalDirectory",
          `Failed to reserve an account directory for '${provider}'.`,
          async () => {
            ensurePrivateDirectorySync(accountsDir(root, provider));
            for (let attempt = 0; attempt < 50; attempt += 1) {
              const entries = await fs.readdir(accountsDir(root, provider));
              const ordinals = entries
                .filter((name) => /^[1-9][0-9]*$/.test(name))
                .map((name) => Number(name));
              const candidate = ordinals.length === 0 ? 1 : Math.max(...ordinals) + 1;
              try {
                await fs.mkdir(accountDir(root, provider, candidate), {
                  mode: PRIVATE_DIRECTORY_MODE,
                });
                return candidate;
              } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
              }
            }
            throw new Error(`Could not reserve an ordinal for '${provider}' after 50 attempts.`);
          },
        ),
      ),
    );

  const releaseOrdinalDirectory = (provider: SupportedAccountProvider, ordinal: number) =>
    tryFs(
      "accountStorage.releaseOrdinalDirectory",
      `Failed to release reserved account directory for '${provider}' ordinal ${ordinal}.`,
      () => fs.rm(accountDir(root, provider, ordinal), { recursive: true, force: true }),
    );

  const createPendingDirectory = (provider: SupportedAccountProvider, operationId: string) =>
    ensureRoot.pipe(
      Effect.andThen(
        tryFs(
          "accountStorage.createPendingDirectory",
          `Failed to create pending directory for '${provider}' operation '${operationId}'.`,
          async () => {
            const directory = pendingPath(root, provider, operationId);
            ensurePrivateDirectorySync(path.join(directory, "agent", "home"));
            return directory;
          },
        ),
      ),
    );

  // Allocates the ordinal only at finalization so failed or cancelled logins
  // never consume account numbers. The ordinal directory is reserved
  // atomically and stays in place while the pending contents move into it
  // entry by entry: every rename targets a non-existent path, which is atomic
  // on both POSIX and Windows (directory replacement via rename is
  // POSIX-only), and the reserved directory is never deleted mid-flight, so
  // no concurrent writer can claim the same ordinal. A journal marker written
  // before the first move and removed after the last one lets restart
  // recovery detect a crash mid-move (see recoverIncompleteFinalizations).
  const finalizePendingDirectory = (provider: SupportedAccountProvider, operationId: string) =>
    withProviderLock(
      provider,
      reserveOrdinalDirectory(provider).pipe(
        Effect.flatMap((ordinal) =>
          tryFs(
            "accountStorage.finalizePendingDirectory",
            `Failed to finalize pending directory for '${provider}' operation '${operationId}'.`,
            async () => {
              const pending = pendingPath(root, provider, operationId);
              const target = accountDir(root, provider, ordinal);
              const marker = path.join(target, FINALIZE_MARKER_FILE);
              try {
                await fs.writeFile(
                  marker,
                  JSON.stringify({
                    operationId,
                    pid: process.pid,
                    startedAt: new Date().toISOString(),
                  }),
                  { mode: 0o600 },
                );
              } catch (cause) {
                // Nothing moved yet: the reservation is safe to drop.
                await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
                throw cause;
              }
              const moved: string[] = [];
              try {
                for (const entry of await fs.readdir(pending)) {
                  if (entry === "operation.json") continue;
                  await fs.rename(path.join(pending, entry), path.join(target, entry));
                  moved.push(entry);
                }
              } catch (cause) {
                // Undo: return moved entries to the pending directory so the
                // login's credentials are preserved, then drop the
                // reservation. If the undo itself fails, the marker lets
                // restart recovery remove the incomplete directory.
                let restored = true;
                for (const entry of moved) {
                  try {
                    await fs.rename(path.join(target, entry), path.join(pending, entry));
                  } catch {
                    restored = false;
                  }
                }
                if (restored) {
                  await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
                }
                throw cause;
              }
              await fs.rm(pending, { recursive: true, force: true }).catch(() => undefined);
              // Commit point: without the marker the directory is a complete
              // account slot. Cleanup is best effort; the credentials are
              // already in place, so a failure here must not roll back.
              await fs.rm(marker, { force: true }).catch(() => undefined);
              await fs.chmod(target, PRIVATE_DIRECTORY_MODE).catch(() => undefined);
              return ordinal;
            },
          ),
        ),
      ),
    );

  const isPidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // Startup recovery for finalizations interrupted by a crash: an ordinal
  // directory that still carries the finalize marker never completed its
  // move. If the account record exists the move finished and only the marker
  // cleanup was lost; otherwise the directory is incomplete, was never
  // referenced by any record, and is removed so the ordinal can be reused.
  // Directories whose marker names a live sibling process are in-flight and
  // left alone.
  const recoverIncompleteFinalizations = (provider: SupportedAccountProvider) =>
    withProviderLock(
      provider,
      tryFs(
        "accountStorage.recoverIncompleteFinalizations",
        `Failed to recover incomplete finalizations for '${provider}'.`,
        async () => {
          let entries: Dirent[];
          try {
            entries = await fs.readdir(accountsDir(root, provider), { withFileTypes: true });
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
            throw cause;
          }
          for (const entry of entries) {
            if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue;
            const dir = path.join(accountsDir(root, provider), entry.name);
            const marker = await readFileIfExists(path.join(dir, FINALIZE_MARKER_FILE));
            if (marker === null) continue;
            let ownerPid: number | undefined;
            try {
              const parsed = JSON.parse(marker) as { pid?: number };
              if (
                typeof parsed.pid === "number" &&
                Number.isInteger(parsed.pid) &&
                parsed.pid > 0
              ) {
                ownerPid = parsed.pid;
              }
            } catch {
              // A corrupted marker still means the finalize never committed.
            }
            if (ownerPid !== undefined && ownerPid !== process.pid && isPidAlive(ownerPid)) {
              continue;
            }
            if ((await readFileIfExists(path.join(dir, "account.json"))) !== null) {
              await fs.rm(path.join(dir, FINALIZE_MARKER_FILE), { force: true });
            } else {
              await fs.rm(dir, { recursive: true, force: true });
            }
          }
        },
      ),
    );

  const reconnectBackupPath = (provider: SupportedAccountProvider, ordinal: number) =>
    path.join(accountDir(root, provider, ordinal), "agent", "home.reconnect-backup");

  // Commits a staged reconnect: the pending login home replaces the live
  // agent home via rename, with the previous home parked as a backup until
  // the swap completes. A failure mid-swap restores the backup so the live
  // credentials are never lost; a crash mid-swap is repaired by
  // recoverReconnectBackups on the next startup.
  const commitReconnectHome = (
    provider: SupportedAccountProvider,
    operationId: string,
    ordinal: number,
  ) =>
    withProviderLock(
      provider,
      tryFs(
        "accountStorage.commitReconnectHome",
        `Failed to commit reconnected credentials for '${provider}' ordinal ${ordinal}.`,
        async () => {
          const liveHome = path.join(accountDir(root, provider, ordinal), "agent", "home");
          const stagedHome = path.join(pendingPath(root, provider, operationId), "agent", "home");
          const backup = reconnectBackupPath(provider, ordinal);
          ensurePrivateDirectorySync(path.dirname(liveHome));
          await fs.rm(backup, { recursive: true, force: true });
          let hadLive = false;
          try {
            await fs.rename(liveHome, backup);
            hadLive = true;
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          }
          try {
            await fs.rename(stagedHome, liveHome);
          } catch (cause) {
            if (hadLive) await fs.rename(backup, liveHome).catch(() => undefined);
            throw cause;
          }
          await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
          await fs
            .rm(pendingPath(root, provider, operationId), { recursive: true, force: true })
            .catch(() => undefined);
        },
      ),
    );

  // Repairs the crash windows of commitReconnectHome: a backup with no live
  // home means the swap was interrupted after parking the old credentials, so
  // the backup is restored; a backup next to a live home means the swap
  // completed and only the cleanup was lost, so the backup is discarded.
  const recoverReconnectBackups = (provider: SupportedAccountProvider) =>
    listOrdinals(provider).pipe(
      Effect.flatMap((ordinals) =>
        tryFs(
          "accountStorage.recoverReconnectBackups",
          `Failed to recover reconnect backups for '${provider}'.`,
          async () => {
            for (const ordinal of ordinals) {
              const backup = reconnectBackupPath(provider, ordinal);
              const liveHome = path.join(accountDir(root, provider, ordinal), "agent", "home");
              if ((await fs.stat(backup).catch(() => null)) === null) continue;
              if ((await fs.stat(liveHome).catch(() => null)) === null) {
                await fs.rename(backup, liveHome);
              } else {
                await fs.rm(backup, { recursive: true, force: true });
              }
            }
          },
        ),
      ),
    );

  // Non-secret connect operation metadata persisted alongside the pending
  // login directory so interrupted operations survive a server restart.
  const pendingOperationJsonPath = (provider: SupportedAccountProvider, operationId: string) =>
    path.join(pendingPath(root, provider, operationId), "operation.json");

  const writePendingOperation = (
    provider: SupportedAccountProvider,
    operationId: string,
    contents: string,
  ) =>
    writeFileStringAtomically({
      filePath: pendingOperationJsonPath(provider, operationId),
      contents,
    }).pipe(
      Effect.mapError(
        storageError(
          "accountStorage.writePendingOperation",
          `Failed to write pending operation metadata for '${provider}' operation '${operationId}'.`,
        ),
      ),
    );

  const readPendingOperation = (provider: SupportedAccountProvider, operationId: string) =>
    tryFs(
      "accountStorage.readPendingOperation",
      `Failed to read pending operation metadata for '${provider}' operation '${operationId}'.`,
      () => readFileIfExists(pendingOperationJsonPath(provider, operationId)),
    );

  const cancelPendingDirectory = (provider: SupportedAccountProvider, operationId: string) =>
    tryFs(
      "accountStorage.cancelPendingDirectory",
      `Failed to remove pending directory for '${provider}' operation '${operationId}'.`,
      () => fs.rm(pendingPath(root, provider, operationId), { recursive: true, force: true }),
    );

  const cleanupPendingDirectories = (provider: SupportedAccountProvider) =>
    tryFs(
      "accountStorage.cleanupPendingDirectories",
      `Failed to clean pending directories for '${provider}'.`,
      () => fs.rm(pendingDir(root, provider), { recursive: true, force: true }),
    );

  const listPendingOperations = (provider: SupportedAccountProvider) =>
    tryFs(
      "accountStorage.listPendingOperations",
      `Failed to list pending directories for '${provider}'.`,
      async () => {
        try {
          const entries = await fs.readdir(pendingDir(root, provider), { withFileTypes: true });
          return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw cause;
        }
      },
    );

  // Secrets live in the account root (0600 files) so the standalone launcher
  // can resolve managed API keys without a running server.
  const readSecret = (
    provider: SupportedAccountProvider,
    ordinal: number,
    surface: AccountSurface,
  ) =>
    tryFs(
      "accountStorage.readSecret",
      `Failed to read secret '${secretName(provider, ordinal, surface)}'.`,
      () => readFileIfExists(accountSecretPath(root, provider, ordinal, surface)),
    );

  const writeSecret = (
    provider: SupportedAccountProvider,
    ordinal: number,
    surface: AccountSurface,
    value: string,
  ) =>
    ensureRoot.pipe(
      Effect.andThen(
        writeFileStringAtomically({
          filePath: accountSecretPath(root, provider, ordinal, surface),
          contents: value,
          mode: 0o600,
        }).pipe(
          Effect.mapError(
            storageError(
              "accountStorage.writeSecret",
              `Failed to write secret '${secretName(provider, ordinal, surface)}'.`,
            ),
          ),
        ),
      ),
    );

  const deleteSecret = (
    provider: SupportedAccountProvider,
    ordinal: number,
    surface: AccountSurface,
  ) =>
    tryFs(
      "accountStorage.deleteSecret",
      `Failed to delete secret '${secretName(provider, ordinal, surface)}'.`,
      () => fs.rm(accountSecretPath(root, provider, ordinal, surface), { force: true }),
    );

  const appLeasePath = (provider: SupportedAccountProvider, ordinal: number) =>
    path.join(appLeasesDir(root), `${provider}-${ordinal}.json`);

  const readAppLease = (provider: SupportedAccountProvider, ordinal: number) =>
    tryFs(
      "accountStorage.readAppLease",
      `Failed to read app lease for '${provider}' ordinal ${ordinal}.`,
      () => readFileIfExists(appLeasePath(provider, ordinal)),
    ).pipe(
      Effect.flatMap((contents) =>
        contents === null
          ? Effect.succeed(null)
          : decodeAppLease(contents).pipe(Effect.orElseSucceed(() => null)),
      ),
    );

  const writeAppLease = (lease: AppProcessLease) =>
    encodeAppLease(lease).pipe(
      Effect.mapError(
        storageError(
          "accountStorage.writeAppLease",
          `Failed to encode app lease for '${lease.provider}' ordinal ${lease.ordinal}.`,
        ),
      ),
      Effect.flatMap((contents) =>
        writeFileStringAtomically({
          filePath: appLeasePath(lease.provider, lease.ordinal),
          contents,
        }).pipe(
          Effect.mapError(
            storageError(
              "accountStorage.writeAppLease",
              `Failed to write app lease for '${lease.provider}' ordinal ${lease.ordinal}.`,
            ),
          ),
        ),
      ),
    );

  const clearAppLease = (provider: SupportedAccountProvider, ordinal: number) =>
    tryFs(
      "accountStorage.clearAppLease",
      `Failed to clear app lease for '${provider}' ordinal ${ordinal}.`,
      () => fs.rm(appLeasePath(provider, ordinal), { force: true }),
    );

  const hiddenMarkerPath = (provider: SupportedAccountProvider, ordinal: number) =>
    path.join(accountDir(root, provider, ordinal), "hidden");

  const hideAccount = (provider: SupportedAccountProvider, ordinal: number) =>
    writeFileStringAtomically({
      filePath: hiddenMarkerPath(provider, ordinal),
      contents: "",
    }).pipe(
      Effect.mapError(
        storageError(
          "accountStorage.hideAccount",
          `Failed to hide account '${provider}' ordinal ${ordinal}.`,
        ),
      ),
    );

  const isAccountHidden = (provider: SupportedAccountProvider, ordinal: number) =>
    tryFs(
      "accountStorage.isAccountHidden",
      `Failed to inspect hidden marker for '${provider}' ordinal ${ordinal}.`,
      async () => (await readFileIfExists(hiddenMarkerPath(provider, ordinal))) !== null,
    );

  return {
    root,
    ensureRoot,
    readVersion,
    withProviderLock,
    readActiveOrdinal,
    writeActiveOrdinal,
    readAccount,
    writeAccount,
    listOrdinals,
    listAccounts,
    nextOrdinal,
    reserveOrdinalDirectory,
    releaseOrdinalDirectory,
    createPendingDirectory,
    finalizePendingDirectory,
    recoverIncompleteFinalizations,
    commitReconnectHome,
    recoverReconnectBackups,
    writePendingOperation,
    readPendingOperation,
    cancelPendingDirectory,
    cleanupPendingDirectories,
    listPendingOperations,
    readSecret,
    writeSecret,
    deleteSecret,
    readAppLease,
    writeAppLease,
    clearAppLease,
    hideAccount,
    isAccountHidden,
  };
}
