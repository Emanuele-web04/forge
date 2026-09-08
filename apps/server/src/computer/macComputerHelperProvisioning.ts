/**
 * Building and caching the native macOS computer-use helper.
 *
 * The helper resolves private Quartz/AppKit SPI at runtime whose symbols move
 * between macOS and Xcode releases, so — exactly like the iOS device helper —
 * a compiled binary is only valid for the toolchain that produced it and the
 * cache is keyed on that toolchain plus a digest of the helper's own sources
 * (so shipping a helper fix invalidates the cache the same way a toolchain
 * upgrade does). The source digest is the device helper's own, from
 * `@synara/shared/deviceHelperCache`, and so is the hash the key is built with.
 * The *toolchain* half differs on purpose: the device helper links private
 * frameworks that only a full Xcode ships and keys on `xcodebuild -version`,
 * while this one needs nothing beyond the Command Line Tools and keys on the
 * Swift driver banner that `build.sh` will actually compile with. The cache
 * directory and binary name differ too, because the two helpers must not
 * overwrite each other's builds.
 *
 * All filesystem and process access is injected so the whole module is
 * unit-testable on a Linux CI host that has no Xcode.
 *
 * @module computer/macComputerHelperProvisioning
 */
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import {
  COMPUTER_HELPER_BINARY_NAME,
  COMPUTER_HELPER_BINARY_PATH_ENV,
  COMPUTER_HELPER_BUNDLED_EXPECTED_ENV,
  COMPUTER_HELPER_MINIMUM_MACOS_VERSION,
  COMPUTER_HELPER_SOURCE_DIR_ENV,
  COMPUTER_HELPER_SOURCE_DIR_NAME,
} from "@synara/shared/computerHelperPaths";
import {
  deviceHelperSourceRevision,
  readDeviceHelperSourceRevision,
} from "@synara/shared/deviceHelperCache";

/** `~/Library/Caches/synara/computer-helper` — its own directory, not the device helper's. */
export const COMPUTER_HELPER_CACHE_SEGMENTS = [
  "Library",
  "Caches",
  "synara",
  "computer-helper",
] as const;

// Re-exported rather than redeclared: the packaging config, the desktop main
// process and this resolver all have to agree on the variable's name, and the
// second spelling of it here was a rename waiting to silently disable the
// source fallback.
export { COMPUTER_HELPER_BINARY_NAME, COMPUTER_HELPER_SOURCE_DIR_ENV };

export const COMPUTER_HELPER_CACHE_ROOT = path.join(homedir(), ...COMPUTER_HELPER_CACHE_SEGMENTS);

/**
 * Resolve the helper sources in both execution layouts.
 *
 * Source modules live under `src/computer`, while tsdown collapses the server
 * into `dist/index.*` and the build copies the helper beside that bundle.
 * Checking the bundled layout first makes packaged desktop and published CLI
 * builds use their staged asset without changing the development path. This is
 * the exact shape `resolveDeviceHelperSourceDir` uses for the device helper.
 */
export function resolveComputerHelperSourceDir(
  moduleDirectory: string,
  sourceExists: (candidate: string) => boolean = (candidate) =>
    existsSync(path.join(candidate, "build.sh")),
  configuredDirectory: string | undefined = process.env[COMPUTER_HELPER_SOURCE_DIR_ENV],
): string {
  if (configuredDirectory) {
    const external = path.resolve(configuredDirectory);
    if (sourceExists(external)) return external;
  }
  const bundled = path.resolve(moduleDirectory, COMPUTER_HELPER_SOURCE_DIR_NAME);
  if (sourceExists(bundled)) return bundled;
  return path.resolve(
    moduleDirectory,
    "..",
    "..",
    COMPUTER_HELPER_SOURCE_SEGMENT,
    COMPUTER_HELPER_SOURCE_DIR_NAME,
  );
}

/** The repository directory the development source tree lives under. */
const COMPUTER_HELPER_SOURCE_SEGMENT = "native";

/**
 * Whether a resolved source directory sits inside the packaged app archive.
 *
 * `app.asar` is a single file that `stat` happily walks into and a compiler
 * cannot read at all, so a build launched against a path inside it fails
 * several minutes in with a Swift error about a missing file — the least
 * informative possible way to say "this build has no source fallback". A
 * packaged desktop build ships a signed helper and points at it with
 * `COMPUTER_HELPER_BINARY_PATH_ENV`; if that binary is gone, compiling is not
 * the remedy.
 */
export function isArchivedHelperSourceDir(directory: string): boolean {
  return directory.split(path.sep).includes("app.asar");
}

/**
 * The cache directory name for a given Swift toolchain and helper source tree.
 *
 * The device helper keys on `xcodebuild -version`, whose two lines parse into a
 * legible `26.2-17C52`. This helper needs only the Command Line Tools, so its
 * probe is `xcrun swiftc -version` and there is no Xcode build number to read —
 * the banner names the Swift release, the swiftlang build and the clang build,
 * which is a more precise statement of what will produce the binary anyway.
 * The marketing version is kept in the directory name so a stale cache is
 * legible to whoever is looking at it, and the whole banner is digested after
 * it so two installs reporting the same Swift version cannot share a directory.
 *
 * The digest is `deviceHelperSourceRevision`, the same FNV-1a used for the
 * source revision — this is a cache key, not a security boundary, and a second
 * hash implementation would be one more thing to keep in step.
 *
 * Null when the toolchain said nothing, so callers report a setup problem
 * rather than caching under a garbage key.
 */
export function computerHelperCacheKey(
  swiftVersionOutput: string,
  sourceRevision?: string,
): string | null {
  const banner = swiftVersionOutput.trim();
  if (!banner) return null;
  const version = /Apple Swift version\s+([\d.]+)/u.exec(banner)?.[1] ?? "unknown";
  const toolchain = `swift-${version}-${deviceHelperSourceRevision([{ name: "toolchain", contents: banner }])}`;
  return sourceRevision ? `${toolchain}-${sourceRevision}` : toolchain;
}

/**
 * Where macOS keeps its own product version.
 *
 * `os.release()` reports the Darwin kernel version, which does not map cleanly
 * onto the product version this has to compare against — macOS 12.2 is Darwin
 * 21.3 and macOS 12.3 is Darwin 21.4, so the minor numbers are offset, and the
 * major numbers stopped tracking at macOS 15. `sw_vers` answers exactly but
 * costs a subprocess on a path that runs at boot for every user. This file is
 * the same answer for the price of one small read.
 */
export const MACOS_SYSTEM_VERSION_PLIST_PATH = "/System/Library/CoreServices/SystemVersion.plist";

/** `ProductVersion` out of `SystemVersion.plist`, or null when the file is not what it should be. */
export function parseMacosProductVersion(plistXml: string): string | null {
  const match = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plistXml);
  return match?.[1]?.trim() || null;
}

/** `"12.3.1"` → `[12, 3, 1]`, with `NaN` for anything that is not a number. */
function versionComponents(value: string): number[] {
  return value.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isInteger(parsed) ? parsed : Number.NaN;
  });
}

/**
 * Whether a macOS product version is older than the helper's deployment target.
 *
 * The helper is compiled against `macosx12.3` because ScreenCaptureKit needs
 * 12.3. Launched on anything older it dies in dyld, which reaches the user as
 * "computer control is broken" rather than "this Mac is too old for it".
 *
 * An unreadable or unparseable version answers `false`. A version string nobody
 * recognises is a bad reason to take a working feature away; the helper's own
 * launch failure is a better one.
 */
export function macosBelowHelperFloor(
  productVersion: string | null,
  floor: string = COMPUTER_HELPER_MINIMUM_MACOS_VERSION,
): boolean {
  const actual = productVersion === null ? [Number.NaN] : versionComponents(productVersion);
  const required = versionComponents(floor);
  if (actual.some(Number.isNaN) || required.some(Number.isNaN)) return false;
  for (let index = 0; index < required.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/** What the user is told when their macOS predates the helper's deployment target. */
export const MACOS_BELOW_HELPER_FLOOR_MESSAGE =
  `Computer control needs macOS ${COMPUTER_HELPER_MINIMUM_MACOS_VERSION} or later: ` +
  "the helper captures the screen with ScreenCaptureKit, which earlier releases do not have.";

export interface ProcessRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MacHelperProvisionerOptions {
  readonly helperSourceDir: string;
  readonly bundledBinaryPath?: string;
  /**
   * Whether this build is supposed to ship a helper binary. Defaults to the
   * desktop's `COMPUTER_HELPER_BUNDLED_EXPECTED_ENV` flag; see that constant.
   */
  readonly bundledBinaryExpected?: boolean;
  readonly helperCacheRoot?: string;
  /** Runs a subprocess to completion; injected so tests never touch a real toolchain. */
  readonly run: (
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs: number; readonly env?: NodeJS.ProcessEnv },
  ) => Promise<ProcessRunResult>;
  /** `true` when a file exists; defaults to a real `stat`. */
  readonly fileExists?: (candidate: string) => Promise<boolean>;
  readonly readSources?: (dir: string) => Promise<readonly string[]>;
  readonly readSourceFile?: (file: string) => Promise<string>;
  /** Reads `SystemVersion.plist`; injected so tests never depend on the host's macOS version. */
  readonly readSystemVersionPlist?: () => Promise<string>;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The build failed and will keep failing the same way until the toolchain or
 * the sources change, so the backend remembers this instead of retrying a build
 * on every action. Distinct type so `availability()` can turn it into a
 * `backend-unavailable` card rather than a generic error.
 */
export class MacHelperBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MacHelperBuildError";
  }
}

/**
 * Builds and caches the helper binary. One instance per backend; concurrent
 * callers of `ensureBinary` share a single compilation via the backend's own
 * memoization, so this class stays stateless beyond its injected IO.
 */
export class MacComputerHelperProvisioner {
  private readonly helperSourceDir: string;
  private readonly bundledBinaryPath: string | undefined;
  private readonly bundledBinaryExpected: boolean;
  private readonly helperCacheRoot: string;
  /**
   * How many times this provisioner has actually compiled the helper.
   *
   * Exposed because the settings card's sentence depends on it: a packaged build
   * ships a signed helper and a warm cache serves an earlier compile, and
   * telling the user Synara "built" the helper in either case is simply false.
   */
  private compiledCount = 0;
  /**
   * In-flight or successful `xcrun swiftc -version`; the active toolchain cannot
   * change here. Cleared again when the read fails, so a failure is never the
   * remembered answer.
   */
  private swiftToolchainPromise: Promise<string | null> | undefined;
  /** The host's macOS product version, read at most once. */
  private macosVersionPromise: Promise<string | null> | undefined;
  private readonly run: MacHelperProvisionerOptions["run"];
  private readonly fileExists: (candidate: string) => Promise<boolean>;
  private readonly readSources: (dir: string) => Promise<readonly string[]>;
  private readonly readSourceFile: (file: string) => Promise<string>;
  private readonly readSystemVersionPlist: () => Promise<string>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: MacHelperProvisionerOptions) {
    this.helperSourceDir = options.helperSourceDir;
    this.bundledBinaryPath =
      options.bundledBinaryPath ??
      options.env?.[COMPUTER_HELPER_BINARY_PATH_ENV] ??
      process.env[COMPUTER_HELPER_BINARY_PATH_ENV];
    this.bundledBinaryExpected =
      options.bundledBinaryExpected ??
      (options.env ?? process.env)[COMPUTER_HELPER_BUNDLED_EXPECTED_ENV] === "1";
    this.helperCacheRoot = options.helperCacheRoot ?? COMPUTER_HELPER_CACHE_ROOT;
    this.run = options.run;
    this.fileExists =
      options.fileExists ??
      ((candidate) =>
        stat(candidate).then(
          () => true,
          () => false,
        ));
    this.readSources = options.readSources ?? ((dir) => readdir(dir));
    this.readSourceFile = options.readSourceFile ?? ((file) => readFile(file, "utf8"));
    this.readSystemVersionPlist =
      options.readSystemVersionPlist ?? (() => readFile(MACOS_SYSTEM_VERSION_PLIST_PATH, "utf8"));
    this.env = options.env ?? process.env;
  }

  /**
   * `xcrun swiftc -version`, spawned at most once per provisioner once it
   * answers, and retried on the next call while it does not.
   *
   * `xcrun swiftc`, not `xcodebuild`: `build.sh` resolves everything through
   * `xcrun`, links no private framework, and compiles perfectly well against
   * the Command Line Tools alone. Gating on `xcodebuild` told every CLT-only
   * Mac that it had no toolchain and refused a build it could have run — and
   * then advised installing Xcode, which was not the missing piece. The Swift
   * driver's own banner is also the honest cache key: it names the compiler
   * that will actually produce the binary, which is what a stale cache has to
   * be invalidated against. (`apps/desktop/scripts/build-computer-helper.mjs`
   * keys its own fingerprint on the same banner.)
   *
   * `probeAvailability()` calls this twice over — once directly and once
   * through the cache key — and it runs at boot for every user on every
   * platform check. The active toolchain cannot change under a running server
   * without a restart (it is `xcode-select`'d machine state), so a successful
   * read is memoized forever, while the source hash below is deliberately left
   * live: sources *do* change while a developer works, and a stale key there
   * would serve a stale binary.
   *
   * A *failure* is never memoized. Every way this read can fail is transient —
   * the 20-second timeout firing under load, a first-run license prompt holding
   * the toolchain, a spawn that lost a race with an Xcode upgrade — and caching
   * one would convince the backend that the machine has no toolchain until the
   * server is restarted. Concurrent callers still share the single in-flight
   * spawn; only once it settles as a failure is the memo dropped, so the next
   * call after that starts a fresh probe.
   *
   * Never throws: a missing toolchain is an expected state, reported as `null`.
   */
  private async swiftToolchainVersion(): Promise<string | null> {
    if (this.swiftToolchainPromise === undefined) {
      const attempt: Promise<string | null> = this.run("xcrun", ["swiftc", "-version"], {
        timeoutMs: 20_000,
        env: this.env,
      })
        // Blank stdout is as useless as a non-zero exit: it cannot key a cache
        // directory, so it counts as a failed read rather than a toolchain.
        .then((value) => (value.code === 0 && value.stdout.trim() ? value.stdout : null))
        .catch(() => null)
        .then((output) => {
          // Guarded against a later attempt having already replaced this one, so
          // a slow failure cannot evict the successful read that followed it.
          if (output === null && this.swiftToolchainPromise === attempt) {
            this.swiftToolchainPromise = undefined;
          }
          return output;
        });
      this.swiftToolchainPromise = attempt;
    }
    return await this.swiftToolchainPromise;
  }

  /** How many cold Swift compiles this provisioner has run. */
  get compiledBuilds(): number {
    return this.compiledCount;
  }

  /**
   * Whether a Swift toolchain is present to build with. The Command Line Tools
   * are enough; a full Xcode is not required.
   */
  async swiftToolchainPresent(): Promise<boolean> {
    return (await this.swiftToolchainVersion()) !== null;
  }

  /**
   * Whether this Mac predates the helper's `macosx12.3` deployment target.
   *
   * Read once and remembered including the failure: unlike the toolchain probe
   * there is no transient way for this to go wrong, and the answer cannot
   * change while the process runs.
   */
  async macosBelowFloor(): Promise<boolean> {
    this.macosVersionPromise ??= this.readSystemVersionPlist()
      .then(parseMacosProductVersion)
      .catch(() => null);
    return macosBelowHelperFloor(await this.macosVersionPromise);
  }

  /** Signed helper shipped inside Synara.app, when this is a packaged desktop build. */
  async bundledBinary(): Promise<string | null> {
    const candidate = this.bundledBinaryPath?.trim();
    if (!candidate) return null;
    return (await this.fileExists(candidate)) ? candidate : null;
  }

  /** The cached binary path if one exists for the current toolchain and sources, else null. */
  async cachedBinaryPath(): Promise<string | null> {
    const key = await this.buildKey().catch(() => null);
    if (key === null) return null;
    const binaryPath = path.join(this.helperCacheRoot, key, COMPUTER_HELPER_BINARY_NAME);
    return (await this.fileExists(binaryPath)) ? binaryPath : null;
  }

  /**
   * The cached binary, or a fresh build of it. Throws `MacHelperBuildError` with
   * an actionable message when the toolchain is missing or the compile fails.
   */
  async ensureBinary(): Promise<string> {
    const bundled = await this.bundledBinary();
    if (bundled) return bundled;
    if (await this.macosBelowFloor()) {
      throw new MacHelperBuildError(MACOS_BELOW_HELPER_FLOOR_MESSAGE);
    }
    const cached = await this.cachedBinaryPath();
    if (cached) return cached;

    if (isArchivedHelperSourceDir(this.helperSourceDir)) {
      throw new MacHelperBuildError(this.missingBundledHelperMessage());
    }
    const key = await this.buildKey().catch(() => null);
    if (key === null) {
      throw new MacHelperBuildError(
        this.bundledBinaryExpected
          ? this.missingBundledHelperMessage("no Swift toolchain is installed")
          : "Could not find a Swift toolchain to build the macOS computer-use helper. " +
              "Install the Xcode command line tools with: xcode-select --install",
      );
    }
    const outputDirectory = path.join(this.helperCacheRoot, key);
    const buildScript = path.join(this.helperSourceDir, "build.sh");
    this.compiledCount += 1;
    const result = await this.run("/bin/sh", [buildScript, outputDirectory], {
      // A cold Swift compile of the helper is minutes, not seconds; a false
      // timeout would throw away a build that was about to succeed.
      timeoutMs: 300_000,
      env: this.env,
    }).catch((error: unknown) => {
      throw new MacHelperBuildError(
        `Computer helper build could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new MacHelperBuildError(
        this.bundledBinaryExpected
          ? this.missingBundledHelperMessage(detail || "the source fallback failed to compile")
          : `Computer helper build failed${detail ? `: ${detail}` : ""}. ` +
              "Verify the Xcode command line tools are installed (xcode-select --install) " +
              "and, if you use a full Xcode, that its license is accepted " +
              "(sudo xcodebuild -license accept).",
      );
    }
    const binaryPath = path.join(outputDirectory, COMPUTER_HELPER_BINARY_NAME);
    if (!(await this.fileExists(binaryPath))) {
      throw new MacHelperBuildError("Computer helper build produced no binary.");
    }
    return binaryPath;
  }

  /**
   * What a packaged build says when the helper it shipped with is not there.
   *
   * "Install Xcode" is advice for a developer with a source checkout. A user
   * running an installed Synara whose helper was quarantined, stripped, or
   * never copied has no use for it — the app is supposed to carry a signed
   * helper, and the honest instruction is to get one back. The source fallback
   * staged under `Resources` is still tried first; this is what is said once
   * that has also failed, and the reason it failed is carried along so a
   * support request has something in it.
   */
  private missingBundledHelperMessage(detail?: string): string {
    return (
      "This Synara installation is missing the macOS computer-use helper it ships with" +
      (detail ? ` and could not rebuild it (${detail})` : "; the source fallback is unavailable") +
      ". Reinstall Synara."
    );
  }

  private async buildKey(): Promise<string> {
    const versionOutput = await this.swiftToolchainVersion();
    const revision = await this.sourceRevision();
    const key = versionOutput === null ? null : computerHelperCacheKey(versionOutput, revision);
    if (key === null) {
      throw new MacHelperBuildError("Could not determine the Swift toolchain version.");
    }
    return key;
  }

  private async sourceRevision(): Promise<string | undefined> {
    return await readDeviceHelperSourceRevision(this.helperSourceDir, {
      listSources: (dir) => Promise.resolve(this.readSources(dir)) as Promise<readonly string[]>,
      readFile: (file) => this.readSourceFile(file),
      join: path.join,
    });
  }
}
