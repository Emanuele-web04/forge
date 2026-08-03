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
export function deviceHelperCacheKey(xcodebuildVersionOutput: string): string | null {
  const version = /Xcode\s+([\d.]+)/u.exec(xcodebuildVersionOutput)?.[1];
  const build = /Build version\s+(\S+)/u.exec(xcodebuildVersionOutput)?.[1];
  if (!version && !build) return null;
  return `${version ?? "unknown"}-${build ?? "unknown"}`;
}
