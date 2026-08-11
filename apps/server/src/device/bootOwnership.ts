/**
 * Which simulators Synara booted, remembered across process death.
 *
 * `DeviceManager` tracks this in memory, which is enough for a clean quit: the
 * finalizer walks the set and shuts each one down. A crash or a SIGKILL runs no
 * finalizer, so the set dies with the process and the simulators outlive it.
 * That was not merely untidy — the orphan reappeared as `bootSource: "user"`,
 * which meant nothing would ever reclaim it: it fell outside the boot cap, the
 * idle sweep, and the next quit's shutdown, all of which are gated on Synara
 * having booted the device. Each crash leaked one simulator, permanently.
 *
 * The record is a plain JSON file rather than a row in the database because it
 * has to be readable and writable before most of the server exists, and because
 * a corrupt or missing file must degrade to "own nothing" rather than fail a
 * boot. Recovery is deliberately conservative: a device is only reclaimed when
 * it is still booted AND still listed as ours, so a udid the user has since
 * booted themselves is never shut down out from under them.
 *
 * @module device/bootOwnership
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

/** Written atomically so a crash mid-write cannot leave an unparsable file. */
interface BootOwnershipFile {
  readonly version: 1;
  /** Which process wrote this, so a live sibling's devices are left alone. */
  readonly pid: number;
  readonly udids: readonly string[];
}

export interface BootOwnershipStore {
  read(): Promise<{ readonly pid: number; readonly udids: readonly string[] } | null>;
  write(udids: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

/** A store that remembers nothing, for tests and unsupported platforms. */
export const NULL_BOOT_OWNERSHIP: BootOwnershipStore = {
  read: async () => null,
  write: async () => undefined,
  clear: async () => undefined,
};

export function makeBootOwnershipStore(
  filePath: string,
  processId: number = process.pid,
): BootOwnershipStore {
  const writeFileAtomically = async (contents: string): Promise<void> => {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${processId}.tmp`;
    await writeFile(temporaryPath, contents, "utf8");
    // Rename is atomic within a filesystem, so a reader sees the old file or
    // the new one, never a half-written one.
    await rename(temporaryPath, filePath);
  };

  return {
    async read() {
      const raw = await readFile(filePath, "utf8").catch(() => null);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<BootOwnershipFile>;
        if (parsed.version !== 1 || !Array.isArray(parsed.udids)) return null;
        const udids = parsed.udids.filter((udid): udid is string => typeof udid === "string");
        return { pid: typeof parsed.pid === "number" ? parsed.pid : 0, udids };
      } catch {
        // Unparsable means we cannot prove ownership, and shutting down a
        // device we do not own is worse than leaking one.
        return null;
      }
    },

    async write(udids) {
      const file: BootOwnershipFile = { version: 1, pid: processId, udids: [...udids] };
      await writeFileAtomically(JSON.stringify(file)).catch(() => undefined);
    },

    async clear() {
      await writeFileAtomically(
        JSON.stringify({ version: 1, pid: processId, udids: [] } satisfies BootOwnershipFile),
      ).catch(() => undefined);
    },
  };
}

/**
 * Which recorded udids should be shut down at startup.
 *
 * Only devices that are still booted and were recorded by a process that is no
 * longer running: a record left by a live sibling server belongs to it, and a
 * device that is already shut down needs nothing.
 */
export function orphanedBootUdids(
  recorded: { readonly pid: number; readonly udids: readonly string[] } | null,
  bootedUdids: readonly string[],
  isProcessAlive: (pid: number) => boolean,
): readonly string[] {
  if (recorded === null || recorded.udids.length === 0) return [];
  if (recorded.pid > 0 && isProcessAlive(recorded.pid)) return [];
  const booted = new Set(bootedUdids);
  return recorded.udids.filter((udid) => booted.has(udid));
}

/** True when a pid is still running, used to spare a live sibling's devices. */
export function processIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
