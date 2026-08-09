/**
 * Device helper cache location, shared by the server and the smoke CLI.
 *
 * The helper links private CoreSimulator/SimulatorKit frameworks whose symbols
 * move between Xcode releases, so a compiled binary is only valid for the
 * toolchain that produced it and the cache is keyed on that toolchain.
 *
 * This lives in `@synara/shared` because two independent callers derive the
 * same path: `IosSimulatorBackend` (which builds the helper on first attach)
 * and `scripts/device-helper-smoke.ts` (which builds it to verify a release).
 * They previously derived it separately and disagreed, so a passing smoke test
 * populated a directory the server never looked in and the server rebuilt from
 * scratch. One derivation, one directory.
 *
 * @module deviceHelperCache
 */

/** `~/Library/Caches/synara/device-helper` — callers pass their own home dir. */
export const DEVICE_HELPER_CACHE_SEGMENTS = [
  "Library",
  "Caches",
  "synara",
  "device-helper",
] as const;

export const DEVICE_HELPER_BINARY_NAME = "synara-device-helper";

/** Physical helper source directory passed from packaged desktop to its backend child. */
export const DEVICE_HELPER_SOURCE_DIR_ENV = "SYNARA_DEVICE_HELPER_SOURCE_DIR";

/**
 * Derive the cache key from `xcodebuild -version` output, which looks like:
 *
 * ```
 * Xcode 26.2
 * Build version 17C52
 * ```
 *
 * Both fields are included: the build number alone is unique in practice, but
 * the marketing version makes a stale cache directory legible to anyone
 * looking at it. Returns null when the output is unrecognizable, so callers
 * can report a setup problem rather than caching under a garbage key.
 */
export function deviceHelperCacheKey(
  xcodebuildVersionOutput: string,
  sourceRevision?: string,
): string | null {
  const version = /Xcode\s+([\d.]+)/u.exec(xcodebuildVersionOutput)?.[1];
  const build = /Build version\s+(\S+)/u.exec(xcodebuildVersionOutput)?.[1];
  if (!version && !build) return null;
  const toolchain = `${version ?? "unknown"}-${build ?? "unknown"}`;
  return sourceRevision ? `${toolchain}-${sourceRevision}` : toolchain;
}

/**
 * A short digest of the helper's own sources, folded into the cache key.
 *
 * The toolchain alone is not enough. A cached binary stays valid for its Xcode
 * version forever, so shipping a fix to the helper leaves every existing user
 * running the binary they already built: the source changes, the key does not,
 * and the rebuild never happens. Hashing the sources means a helper change
 * invalidates the cache the same way an Xcode upgrade does.
 */
export interface DeviceHelperSourceFile {
  readonly name: string;
  readonly contents: string;
}

export function deviceHelperSourceRevision(files: readonly DeviceHelperSourceFile[]): string {
  // Name and contents both, so a rename is a change; sorted so directory order
  // cannot make the same tree hash two different ways.
  const canonical = [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((file) => `${file.name}\0${file.contents}`)
    .join("\0");

  // FNV-1a, 32-bit: no crypto import in a package shared with the browser, and
  // collisions only cost a missed rebuild between two specific source trees.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Read the helper sources and digest them.
 *
 * Both the server and the smoke CLI need this, and they must agree: the smoke
 * run used to derive the key from the toolchain alone, so once the digest was
 * added it built into a directory the server never read, and the server rebuilt
 * from scratch. One derivation, one directory.
 *
 * `readSourceFile` is injected so this module stays free of Node imports and
 * remains importable from the browser bundle.
 */
export async function readDeviceHelperSourceRevision(
  helperSourceDir: string,
  io: {
    readonly listSources: (dir: string) => Promise<readonly string[]>;
    readonly readFile: (file: string) => Promise<string>;
    readonly join: (...parts: string[]) => string;
  },
): Promise<string | undefined> {
  const sourcesDir = io.join(helperSourceDir, "Sources");
  const names = await io.listSources(sourcesDir).catch(() => null);
  if (names === null) return undefined;

  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      contents: await io.readFile(io.join(sourcesDir, name)).catch(() => ""),
    })),
  );
  // build.sh drives the compile, so a change to it changes the binary too.
  const script = await io.readFile(io.join(helperSourceDir, "build.sh")).catch(() => "");
  return deviceHelperSourceRevision([...files, { name: "build.sh", contents: script }]);
}
