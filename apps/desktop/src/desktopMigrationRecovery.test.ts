import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS } from "@synara/shared/migrationRecovery";

import {
  hasVerifiedDesktopMigrationRestore,
  hasPendingDesktopMigrationRecovery,
  invalidMigrationStartupRecoveryChoices,
  recoverDesktopMigrationIfRequired,
  requiresDesktopMigrationRecovery,
  resolveDesktopMigrationRecoveryPaths,
  resolveDesktopMigrationRestoreCandidate,
  restoreDesktopMigrationBackup,
  type DesktopMigrationRecoveryPaths,
} from "./desktopMigrationRecovery";

describe("desktop migration recovery", () => {
  it("offers safe updater escape hatches when structured recovery details are invalid", () => {
    expect(
      invalidMigrationStartupRecoveryChoices({
        canInstallUpdate: true,
        canOpenReleasePage: true,
      }),
    ).toEqual([
      { label: "Update Synara and restart", decision: "install-update" },
      { label: "Download latest release", decision: "open-release-page" },
      { label: "Open logs", decision: "open-logs" },
      { label: "Quit", decision: "quit" },
    ]);
    expect(
      invalidMigrationStartupRecoveryChoices({
        canInstallUpdate: false,
        canOpenReleasePage: false,
      }),
    ).toEqual([
      { label: "Open logs", decision: "open-logs" },
      { label: "Quit", decision: "quit" },
    ]);
  });

  it("targets the same production database and bundled restore authority as the server", () => {
    expect(
      resolveDesktopMigrationRecoveryPaths({
        baseDir: Path.join(Path.sep, "home", "synara"),
        appRoot: Path.join(Path.sep, "app"),
        isDevelopment: false,
      }),
    ).toEqual({
      dbPath: Path.join(Path.sep, "home", "synara", "userdata", "state.sqlite"),
      markerPath: Path.join(
        Path.sep,
        "home",
        "synara",
        "userdata",
        "state.sqlite.migration-recovery.json",
      ),
      provenancePath: Path.join(
        Path.sep,
        "home",
        "synara",
        "userdata",
        "state.sqlite.migration-backup.json",
      ),
      restoreEntryPath: Path.join(
        Path.sep,
        "app",
        "apps",
        "server",
        "dist",
        "restoreMigrationBackup.mjs",
      ),
    });
  });

  it("uses the isolated development database when the desktop backend receives a dev URL", () => {
    const paths = resolveDesktopMigrationRecoveryPaths({
      baseDir: Path.join(Path.sep, "home", "synara"),
      appRoot: Path.join(Path.sep, "repo"),
      isDevelopment: true,
    });

    expect(paths.dbPath).toBe(Path.join(Path.sep, "home", "synara", "dev", "state.sqlite"));
  });

  it("continues only when the server-owned command clears the durable marker", async () => {
    const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "synara-desktop-recovery-"));
    const dbPath = Path.join(directory, "state.sqlite");
    const paths: DesktopMigrationRecoveryPaths = {
      dbPath,
      markerPath: `${dbPath}.migration-recovery.json`,
      provenancePath: `${dbPath}.migration-backup.json`,
      restoreEntryPath: Path.join(directory, "restore.mjs"),
    };
    await FS.writeFile(paths.markerPath, "pending", "utf8");
    await FS.writeFile(
      paths.restoreEntryPath,
      'import fs from "node:fs/promises"; await fs.writeFile(`${process.argv[2]}.restore-args.json`, JSON.stringify(process.argv.slice(3))); await fs.unlink(`${process.argv[2]}.migration-recovery.json`); console.log("restored");',
      "utf8",
    );
    const expectedBackupPath = `${dbPath}.backups/exact.sqlite`;

    await expect(
      restoreDesktopMigrationBackup({
        executablePath: process.execPath,
        nodeArgs: [],
        paths,
        cwd: directory,
        env: process.env,
        expectedBackupPath,
        expectedProvenancePath: paths.provenancePath,
      }),
    ).resolves.toBe("restored");
    await expect(FS.access(paths.markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      FS.readFile(`${dbPath}.restore-args.json`, "utf8").then(JSON.parse),
    ).resolves.toEqual([
      "--backup-path",
      expectedBackupPath,
      "--provenance-path",
      paths.provenancePath,
    ]);
  });

  it("fails closed when a successful command leaves the recovery marker behind", async () => {
    const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "synara-desktop-recovery-"));
    const dbPath = Path.join(directory, "state.sqlite");
    const paths: DesktopMigrationRecoveryPaths = {
      dbPath,
      markerPath: `${dbPath}.migration-recovery.json`,
      provenancePath: `${dbPath}.migration-backup.json`,
      restoreEntryPath: Path.join(directory, "restore.mjs"),
    };
    await FS.writeFile(paths.markerPath, "pending", "utf8");
    await FS.writeFile(paths.restoreEntryPath, "process.exitCode = 0;", "utf8");

    await expect(
      restoreDesktopMigrationBackup({
        executablePath: process.execPath,
        nodeArgs: [],
        paths,
        cwd: directory,
        env: process.env,
      }),
    ).rejects.toThrow("without clearing its recovery marker");
  });

  it("does not prompt or mutate startup when no recovery marker exists", async () => {
    const choose = vi.fn();
    const restore = vi.fn();

    await expect(
      recoverDesktopMigrationIfRequired({
        requiresRecovery: () => false,
        markerRemains: () => false,
        choose,
        restore,
        installUpdate: vi.fn(),
        openReleasePage: vi.fn(),
        requestRestart: vi.fn(),
        requestQuit: vi.fn(),
        formatError: String,
        log: vi.fn(),
      }),
    ).resolves.toBe("continue");
    expect(choose).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("retries a failed restore and keeps the backend blocked until the user quits", async () => {
    const choose = vi.fn().mockResolvedValueOnce("restore").mockResolvedValueOnce("quit");
    const requestQuit = vi.fn();

    await expect(
      recoverDesktopMigrationIfRequired({
        requiresRecovery: () => true,
        markerRemains: () => true,
        choose,
        restore: vi.fn().mockRejectedValue(new Error("database is locked")),
        installUpdate: vi.fn(),
        openReleasePage: vi.fn(),
        requestRestart: vi.fn(),
        requestQuit,
        formatError: (error) => (error as Error).message,
        log: vi.fn(),
      }),
    ).resolves.toBe("quit-requested");
    expect(choose).toHaveBeenNthCalledWith(2, {
      previousFailure: { attempt: "restore", message: "database is locked" },
    });
    expect(requestQuit).toHaveBeenCalledWith("migration recovery declined");
  });

  it("requests a clean relaunch only after restore clears the marker", async () => {
    let markerExists = true;
    const requestRestart = vi.fn();
    const requestQuit = vi.fn();

    await expect(
      recoverDesktopMigrationIfRequired({
        requiresRecovery: () => markerExists,
        markerRemains: () => markerExists,
        choose: vi.fn().mockResolvedValue("restore"),
        restore: vi.fn(async () => {
          markerExists = false;
        }),
        installUpdate: vi.fn(),
        openReleasePage: vi.fn(),
        requestRestart,
        requestQuit,
        formatError: String,
        log: vi.fn(),
      }),
    ).resolves.toBe("restart-requested");
    expect(requestRestart).toHaveBeenCalledTimes(1);
    expect(requestQuit).toHaveBeenCalledWith("migration recovery restart");
  });

  it("does not accept a restore that leaves a marker the backend could still retry", async () => {
    // The gate answers false for such a marker, so verifying with it would call
    // this restore a success and hand the backend the unrepaired database.
    const choose = vi.fn().mockResolvedValueOnce("restore").mockResolvedValueOnce("quit");
    const requestRestart = vi.fn();

    await expect(
      recoverDesktopMigrationIfRequired({
        requiresRecovery: () => true,
        markerRemains: () => true,
        choose,
        restore: vi.fn(),
        installUpdate: vi.fn(),
        openReleasePage: vi.fn(),
        requestRestart,
        requestQuit: vi.fn(),
        formatError: (error) => (error as Error).message,
        log: vi.fn(),
      }),
    ).resolves.toBe("quit-requested");
    expect(requestRestart).not.toHaveBeenCalled();
    expect(choose).toHaveBeenNthCalledWith(2, {
      previousFailure: {
        attempt: "restore",
        message: "Migration recovery completed without clearing its recovery marker.",
      },
    });
  });

  it("stops startup once the update install handoff has started", async () => {
    const choose = vi.fn().mockResolvedValue("install-update");
    const restore = vi.fn();
    const requestQuit = vi.fn();

    await expect(
      recoverDesktopMigrationIfRequired({
        requiresRecovery: () => true,
        markerRemains: () => true,
        choose,
        restore,
        installUpdate: vi.fn().mockResolvedValue(null),
        openReleasePage: vi.fn(),
        requestRestart: vi.fn(),
        requestQuit,
        formatError: String,
        log: vi.fn(),
      }),
    ).resolves.toBe("update-requested");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    // The updater owns this quit; a second one would turn the install into a
    // plain app quit.
    expect(requestQuit).not.toHaveBeenCalled();
  });

  it("reprompts with the update failure instead of blaming the restore", async () => {
    const choose = vi.fn().mockResolvedValueOnce("install-update").mockResolvedValueOnce("quit");

    await expect(
      recoverDesktopMigrationIfRequired({
        requiresRecovery: () => true,
        markerRemains: () => true,
        choose,
        restore: vi.fn(),
        installUpdate: vi.fn().mockResolvedValue("no newer release is available"),
        openReleasePage: vi.fn(),
        requestRestart: vi.fn(),
        requestQuit: vi.fn(),
        formatError: String,
        log: vi.fn(),
      }),
    ).resolves.toBe("quit-requested");
    expect(choose).toHaveBeenNthCalledWith(2, {
      previousFailure: { attempt: "update", message: "no newer release is available" },
    });
  });

  it("opens the release page without restoring, then keeps prompting", async () => {
    const choose = vi.fn().mockResolvedValueOnce("open-release-page").mockResolvedValueOnce("quit");
    const openReleasePage = vi.fn();
    const restore = vi.fn();

    await expect(
      recoverDesktopMigrationIfRequired({
        requiresRecovery: () => true,
        markerRemains: () => true,
        choose,
        restore,
        installUpdate: vi.fn(),
        openReleasePage,
        requestRestart: vi.fn(),
        requestQuit: vi.fn(),
        formatError: String,
        log: vi.fn(),
      }),
    ).resolves.toBe("quit-requested");
    expect(openReleasePage).toHaveBeenCalledTimes(1);
    // Downloading is not an answer to the prompt: the database is still blocked.
    expect(restore).not.toHaveBeenCalled();
    expect(choose).toHaveBeenCalledTimes(2);
  });

  it("opens logs without retrying the backend or restore", async () => {
    const choose = vi.fn().mockResolvedValueOnce("open-logs").mockResolvedValueOnce("quit");
    const openLogs = vi.fn();
    const restore = vi.fn();

    await expect(
      recoverDesktopMigrationIfRequired({
        requiresRecovery: () => true,
        markerRemains: () => true,
        choose,
        restore,
        installUpdate: vi.fn(),
        openReleasePage: vi.fn(),
        openLogs,
        requestRestart: vi.fn(),
        requestQuit: vi.fn(),
        formatError: String,
        log: vi.fn(),
      }),
    ).resolves.toBe("quit-requested");
    expect(openLogs).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
  });

  it("verifies that completed provenance records the exact restored backup", async () => {
    const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "synara-desktop-provenance-"));
    const paths = resolveDesktopMigrationRecoveryPaths({
      baseDir: directory,
      appRoot: directory,
      isDevelopment: false,
    });
    const backupPath = Path.join(directory, "exact.sqlite");
    await FS.mkdir(Path.dirname(paths.provenancePath), { recursive: true });
    await FS.writeFile(
      paths.provenancePath,
      JSON.stringify({
        databasePath: paths.dbPath,
        backupPath,
        phase: "migration-restored",
        restoredAt: "2026-08-30T12:00:00.000Z",
      }),
    );

    expect(hasVerifiedDesktopMigrationRestore(paths, backupPath)).toBe(true);
    expect(hasVerifiedDesktopMigrationRestore(paths, `${backupPath}.other`)).toBe(false);
  });

  it("accepts a restore candidate only for the exact desktop database and provenance", () => {
    const paths = resolveDesktopMigrationRecoveryPaths({
      baseDir: Path.join(Path.sep, "home", "synara"),
      appRoot: Path.join(Path.sep, "app"),
      isDevelopment: false,
    });
    const block = {
      version: 1 as const,
      databasePath: paths.dbPath,
      databaseMigrationId: 97,
      latestSupportedMigrationId: 96,
      recovery: {
        kind: "restore-available" as const,
        backupPath: `${paths.dbPath}.backups/exact.sqlite`,
        provenancePath: paths.provenancePath,
        backupMigrationId: 90,
      },
    };

    expect(resolveDesktopMigrationRestoreCandidate(paths, block)).toEqual(block.recovery);
    expect(
      resolveDesktopMigrationRestoreCandidate(paths, {
        ...block,
        databasePath: `${paths.dbPath}.other`,
      }),
    ).toBeNull();
    expect(
      resolveDesktopMigrationRestoreCandidate(paths, {
        ...block,
        recovery: { ...block.recovery, provenancePath: `${paths.provenancePath}.other` },
      }),
    ).toBeNull();
  });

  it("relaunches only after the exact completed restore is verified", async () => {
    const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "synara-desktop-relaunch-"));
    const paths = resolveDesktopMigrationRecoveryPaths({
      baseDir: directory,
      appRoot: directory,
      isDevelopment: false,
    });
    const backupPath = Path.join(directory, "exact.sqlite");
    const events: Array<string> = [];

    await expect(
      recoverDesktopMigrationIfRequired({
        requiresRecovery: () => true,
        markerRemains: () => !hasVerifiedDesktopMigrationRestore(paths, backupPath),
        choose: vi.fn().mockResolvedValue("restore"),
        restore: async () => {
          events.push("restore");
          await FS.mkdir(Path.dirname(paths.provenancePath), { recursive: true });
          await FS.writeFile(
            paths.provenancePath,
            JSON.stringify({
              databasePath: paths.dbPath,
              backupPath,
              phase: "migration-restored",
              restoredAt: "2026-08-30T12:00:00.000Z",
            }),
          );
        },
        installUpdate: vi.fn(),
        openReleasePage: vi.fn(),
        requestRestart: () => events.push("restart"),
        requestQuit: () => events.push("quit"),
        formatError: String,
        log: vi.fn(),
      }),
    ).resolves.toBe("restart-requested");
    expect(events).toEqual(["restore", "restart", "quit"]);
  });
});

describe("requiresDesktopMigrationRecovery", () => {
  async function withMarker(
    contents: string | null,
    assert: (paths: DesktopMigrationRecoveryPaths) => void,
  ): Promise<void> {
    const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "synara-recovery-gate-"));
    try {
      const paths = resolveDesktopMigrationRecoveryPaths({
        baseDir: directory,
        appRoot: directory,
        isDevelopment: false,
      });
      await FS.mkdir(Path.dirname(paths.markerPath), { recursive: true });
      if (contents !== null) await FS.writeFile(paths.markerPath, contents, "utf8");
      assert(paths);
    } finally {
      await FS.rm(directory, { recursive: true, force: true });
    }
  }

  it("does not block while the backend still has resume attempts left", async () => {
    await withMarker(JSON.stringify({ resumeAttempts: 0 }), (paths) => {
      expect(hasPendingDesktopMigrationRecovery(paths)).toBe(true);
      expect(requiresDesktopMigrationRecovery(paths)).toBe(false);
    });
  });

  it("treats a marker written before the resume path existed as fully retryable", async () => {
    // This is the shape every 0.6.0 install is wedged on; blocking it would
    // hide the self-heal the upgrade exists to deliver.
    await withMarker(JSON.stringify({ phase: "migration-in-progress" }), (paths) => {
      expect(requiresDesktopMigrationRecovery(paths)).toBe(false);
    });
  });

  it("blocks once the resume budget is spent", async () => {
    await withMarker(
      JSON.stringify({ resumeAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS }),
      (paths) => {
        expect(requiresDesktopMigrationRecovery(paths)).toBe(true);
      },
    );
  });

  it("blocks on a marker it cannot parse", async () => {
    await withMarker("{ not json", (paths) => {
      expect(requiresDesktopMigrationRecovery(paths)).toBe(true);
    });
  });

  it("does not block when no marker exists", async () => {
    await withMarker(null, (paths) => {
      expect(requiresDesktopMigrationRecovery(paths)).toBe(false);
    });
  });
});
