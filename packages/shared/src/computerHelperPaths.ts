/**
 * Where the macOS computer-use helper lives, in every build shape.
 *
 * Four independent callers need the same answer and previously each spelled it
 * out by hand: the desktop main process (both to tell its backend child where
 * the helper is and to run the permission preflight itself), the packaging
 * config that stages and signs the bundle, and the build script that produces
 * it. A rename in one place left the others pointing at a path that no longer
 * existed — and because a missing helper degrades silently to "no computer
 * control", nothing failed at build time. One derivation, one bundle name.
 *
 * The paths are macOS-only. Nothing here should be joined onto a Windows or
 * Linux install root; `COMPUTER_HELPER_BINARY_PATH_ENV` is likewise only set by
 * a packaged darwin build.
 *
 * @module computerHelperPaths
 */
import computerHelperBundle from "./computerHelperBundle.json" with { type: "json" };
import { SYNARA_PRODUCTION_BUNDLE_ID } from "@synara/shared/desktopIdentity";

/** The helper executable's file name, inside the bundle and in dev builds. */
export const COMPUTER_HELPER_BINARY_NAME = computerHelperBundle.binaryName;

/**
 * The oldest macOS the helper can run on.
 *
 * `build.sh` targets `macosx12.3` because ScreenCaptureKit needs 12.3, so a
 * helper launched on anything older fails in dyld with nothing an operator can
 * act on. Three places have to agree about that number — the app's
 * `LSMinimumSystemVersion`, the compiler triples, and the backend's passive
 * availability probe — and this is the one they read.
 */
export const COMPUTER_HELPER_MINIMUM_MACOS_VERSION = computerHelperBundle.minimumMacosVersion;

/**
 * The helper's app bundle. It is a bundle, not a loose binary, because a bundle
 * is the unit macOS signs and notarizes, and the helper has to carry the app's
 * Team ID and hardened runtime of its own. (The TCC grants themselves are filed
 * against the app, not against this bundle — see `computerPermissions`.)
 */
export const COMPUTER_HELPER_BUNDLE_NAME = computerHelperBundle.bundleName;

/**
 * The helper's bundle identifier, derived rather than spelled out.
 *
 * It is the identity codesign and notarization see, and the Swift helper refuses
 * to drive any window whose owner is Synara itself by matching the app's own
 * identifier — so the helper's identity has to be a child of the app's, not an
 * independently maintained constant that a rebrand could leave behind under the
 * old name. Privacy & Security never shows this string: a TCC check made inside
 * the helper is answered against its responsible process, which is Synara.
 */
export const COMPUTER_HELPER_BUNDLE_IDENTIFIER = `${SYNARA_PRODUCTION_BUNDLE_ID}.${computerHelperBundle.bundleIdentifierSuffix}`;

/** Path of the executable within its own bundle. */
export const COMPUTER_HELPER_BUNDLE_EXECUTABLE_SEGMENTS = [
  "Contents",
  "MacOS",
  COMPUTER_HELPER_BINARY_NAME,
] as const;

/** Where the packaged bundle sits inside `Synara.app`. */
export const COMPUTER_HELPER_PACKAGED_SEGMENTS = [
  "Contents",
  "Helpers",
  COMPUTER_HELPER_BUNDLE_NAME,
] as const;

/**
 * The bundle a development build writes, relative to the repository root.
 * `apps/desktop/scripts/build-computer-helper.mjs` writes here by default.
 */
export const COMPUTER_HELPER_DEV_BUNDLE_SEGMENTS = [
  "apps",
  "desktop",
  ".electron-runtime",
  "computer-use",
  COMPUTER_HELPER_BUNDLE_NAME,
] as const;

/**
 * The loose binary `apps/server/native/computer-use-macos/build.sh` writes,
 * relative to the repository root. A developer who ran the Swift build directly
 * gets a working helper without the bundle wrapper.
 */
export const COMPUTER_HELPER_DEV_RAW_SEGMENTS = [
  "apps",
  "server",
  "native",
  "computer-use-macos",
  "build",
  COMPUTER_HELPER_BINARY_NAME,
] as const;

/** Signed macOS computer-use helper embedded by the desktop release build. */
export const COMPUTER_HELPER_BINARY_PATH_ENV = "SYNARA_COMPUTER_HELPER_BINARY_PATH";

/**
 * Set by a packaged desktop build to say "a helper binary ships with this app".
 *
 * `COMPUTER_HELPER_BINARY_PATH_ENV` is only set when the file is actually
 * there, so its absence cannot distinguish "this build never had a helper"
 * (a development checkout, the CLI) from "this build shipped one and it is
 * gone" (quarantine, a partial install, a broken signature). Those want
 * opposite advice: the first is told how to build one, the second is told to
 * reinstall Synara — and telling a user of a packaged app to install Xcode is
 * the wrong end of a support conversation. This flag is what tells them apart.
 */
export const COMPUTER_HELPER_BUNDLED_EXPECTED_ENV = "SYNARA_COMPUTER_HELPER_BUNDLED";

/**
 * Where the server's source-build fallback should compile from.
 *
 * A packaged desktop build must set this: without it the fallback resolves the
 * sources relative to its own module, which in a packaged app is a path inside
 * `app.asar` — visible to `stat`, unreadable to a compiler. The desktop points
 * it at the copy staged beside the app instead.
 */
export const COMPUTER_HELPER_SOURCE_DIR_ENV = "SYNARA_COMPUTER_HELPER_SOURCE_DIR";

/**
 * The staged source directory's name inside a packaged app's `Resources`, and
 * the name `apps/server/scripts/cli.ts` stages under `dist`. One name, so the
 * packaging config, the desktop's environment and the server's resolver cannot
 * drift apart.
 */
export const COMPUTER_HELPER_SOURCE_DIR_NAME = "computer-use-macos";

/**
 * Joins segments with `/`. The packaging config and the electron-builder globs
 * are POSIX-shaped regardless of host, and these paths only ever describe a
 * macOS bundle, so a platform-aware join would be wrong here.
 */
function posixJoin(...segments: readonly string[]): string {
  return segments.join("/");
}

/** `Contents/Helpers/Synara Computer Use.app`, for electron-builder. */
export const COMPUTER_HELPER_PACKAGED_BUNDLE_PATH = posixJoin(...COMPUTER_HELPER_PACKAGED_SEGMENTS);

/** `Contents/Helpers/Synara Computer Use.app/Contents/MacOS/synara-computer-helper`. */
export const COMPUTER_HELPER_PACKAGED_EXECUTABLE_PATH = posixJoin(
  ...COMPUTER_HELPER_PACKAGED_SEGMENTS,
  ...COMPUTER_HELPER_BUNDLE_EXECUTABLE_SEGMENTS,
);

/** `apps/desktop/.electron-runtime/computer-use/Synara Computer Use.app`. */
export const COMPUTER_HELPER_DEV_BUNDLE_PATH = posixJoin(...COMPUTER_HELPER_DEV_BUNDLE_SEGMENTS);
