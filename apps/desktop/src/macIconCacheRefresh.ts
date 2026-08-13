import * as Path from "node:path";

// Pure helpers for refreshing the macOS Launch Services / IconServices cache
// after an in-place update. The side-effectful orchestration (file IO, touching
// the bundle, spawning lsregister) stays in main.ts; keeping the path/version
// logic here makes it unit-testable without booting Electron.

// Stable across macOS releases; main.ts still verifies it exists before use.
export const LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";

const LAUNCH_VERSION_RECORD_FILENAME = "last-launch-version.json";

export function resolveLaunchVersionRecordPath(userDataPath: string): string {
  return Path.join(userDataPath, LAUNCH_VERSION_RECORD_FILENAME);
}

// Parse the persisted record, tolerating a missing (null), corrupt, or
// unexpectedly-shaped file by treating it as "no record".
export function parseLastLaunchVersion(rawContents: string | null): string | null {
  if (rawContents === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rawContents);
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const value = (parsed as { version?: unknown }).version;
      return typeof value === "string" ? value : null;
    }
  } catch {
    // Corrupt or non-JSON file: treat as no record.
  }
  return null;
}

export function serializeLaunchVersionRecord(version: string): string {
  return `${JSON.stringify({ version }, null, 2)}\n`;
}

// A null previous version (fresh profile, or first launch after this feature
// shipped) counts as a change, so users already stuck on a stale cached icon get
// fixed by the first update that includes this code rather than the one after.
export function shouldRefreshIconCache(
  previousVersion: string | null,
  currentVersion: string,
): boolean {
  return previousVersion !== currentVersion;
}

// Resolve the running `.app` bundle (…/Synara.app) from the Electron executable
// inside Contents/MacOS. Returns null off macOS or when the layout is unexpected.
export function resolveMacAppBundlePath(
  execPath: string,
  platform: NodeJS.Platform,
): string | null {
  if (platform !== "darwin") {
    return null;
  }
  const bundlePath = Path.resolve(execPath, "..", "..", "..");
  return bundlePath.endsWith(".app") ? bundlePath : null;
}
