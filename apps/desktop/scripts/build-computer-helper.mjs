#!/usr/bin/env node

// Builds the macOS computer-use helper for development or desktop packaging.
// Release artifacts use this at build time so end users receive a signed helper
// and never need Xcode merely to use computer control.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDirectory = dirname(scriptPath);
const repoRoot = resolve(scriptsDirectory, "../../..");
const sourceDirectory = join(repoRoot, "apps/server/native/computer-use-macos");
const buildScript = join(sourceDirectory, "build.sh");

// The one description of the helper bundle, shared with the TypeScript
// packaging config so the plist macOS shows and the path electron-builder signs
// can never name two different bundles.
const bundleManifestPath = join(repoRoot, "packages/shared/src/computerHelperBundle.json");
const bundle = JSON.parse(readFileSync(bundleManifestPath, "utf8"));

/**
 * The helper's bundle identifier, derived from the app's own.
 *
 * `packages/shared/src/desktopIdentity.ts` is the single source of Synara's
 * bundle ID, and the helper's is that ID plus the suffix in the manifest —
 * macOS files the helper's TCC grants under it, and the Swift helper's
 * "never drive Synara" guard matches windows against the app's ID. This script
 * runs under plain `node` and cannot import the TypeScript module, so the
 * constant is read out of it and a miss is fatal: a rebrand must break this
 * build rather than ship a helper claiming an identity nothing else uses.
 */
function synaraProductionBundleId() {
  const identitySource = readFileSync(
    join(repoRoot, "packages/shared/src/desktopIdentity.ts"),
    "utf8",
  );
  const match = /export const SYNARA_PRODUCTION_BUNDLE_ID\s*=\s*"([^"]+)"/.exec(identitySource);
  if (!match) {
    throw new Error(
      "Could not read SYNARA_PRODUCTION_BUNDLE_ID from packages/shared/src/desktopIdentity.ts",
    );
  }
  return match[1];
}

export const computerHelperBundleIdentifier = `${synaraProductionBundleId()}.${bundle.bundleIdentifierSuffix}`;
// The helper ships inside Synara.app and is replaced with it, so it carries the
// app's version rather than a frozen "1". macOS shows this in Privacy & Security
// next to the entry the user is being asked to trust.
const helperVersion = JSON.parse(
  readFileSync(join(repoRoot, "apps/desktop/package.json"), "utf8"),
).version;

export const defaultComputerHelperPath = join(
  repoRoot,
  "apps/desktop/.electron-runtime/computer-use",
  bundle.bundleName,
);

const helperExecutableRelativePath = join("Contents", "MacOS", bundle.binaryName);
const helperInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Synara</string>
  <key>CFBundleExecutable</key>
  <string>${bundle.binaryName}</string>
  <key>CFBundleIdentifier</key>
  <string>${computerHelperBundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Synara</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${helperVersion}</string>
  <key>CFBundleVersion</key>
  <string>${helperVersion}</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSScreenCaptureUsageDescription</key>
  <string>${bundle.screenRecordingUsageDescription}</string>
</dict>
</plist>
`;

/**
 * The deployment target every triple carries, from the same manifest the app's
 * `LSMinimumSystemVersion` and the backend's availability floor read. Building
 * lower than the app claims to support ships a helper that cannot launch on a
 * Mac the installer accepted.
 */
const MINIMUM_MACOS_VERSION = bundle.minimumMacosVersion;
const MACHINE_TRIPLE_PREFIX = { arm64: "arm64", x64: "x86_64" };

function computerHelperTarget(arch) {
  return { arch, triple: `${MACHINE_TRIPLE_PREFIX[arch]}-apple-macosx${MINIMUM_MACOS_VERSION}` };
}

export function computerHelperTargetsForArch(arch) {
  switch (arch) {
    case "arm64":
    case "x64":
      return [computerHelperTarget(arch)];
    case "universal":
      return [computerHelperTarget("arm64"), computerHelperTarget("x64")];
    default:
      throw new Error(`Unsupported computer helper architecture: ${arch}`);
  }
}

/** Memoized: the toolchain cannot change inside one process. */
let toolchainDescription = null;

/**
 * What `build.sh` will actually compile with. `build.sh` resolves everything
 * through `xcrun`, so the Swift driver's own version banner — which names the
 * Swift release, the target, and the toolchain path — is the honest identity of
 * the compiler. It goes into the fingerprint because a toolchain upgrade
 * produces a different binary from identical sources, and a cache that ignored
 * it happily reused a helper built by the previous Xcode.
 *
 * A machine that cannot answer contributes a constant instead of failing: the
 * build itself will report a missing toolchain far better than the cache key
 * can, and until then an unknown toolchain simply never matches a known one.
 */
function toolchain() {
  if (toolchainDescription !== null) return toolchainDescription;
  const result = spawnSync("xcrun", ["swiftc", "-version"], { encoding: "utf8" });
  const banner = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  toolchainDescription = result.status === 0 && banner ? banner : "unknown-toolchain";
  return toolchainDescription;
}

/**
 * Everything that can change the produced binary. Mirrors the AppSnap helper's
 * cache so a repeat packaging run — or a developer rebuilding after touching an
 * unrelated file — does not pay a whole-module-optimization Swift compile
 * (twice, for a universal build) to reproduce a byte-identical helper.
 */
function buildFingerprint({ arch, sources, targets }) {
  const hash = createHash("sha256");
  hash.update("synara-computer-helper-build-v2\0");
  hash.update(toolchain());
  hash.update("\0");
  hash.update(arch);
  hash.update("\0");
  hash.update(JSON.stringify(targets));
  hash.update("\0");
  hash.update(helperInfoPlist);
  hash.update("\0");
  hash.update(readFileSync(scriptPath));
  hash.update("\0");
  hash.update(readFileSync(buildScript));
  for (const source of sources) {
    hash.update("\0");
    hash.update(source);
    hash.update("\0");
    hash.update(readFileSync(source));
  }
  return hash.digest("hex");
}

function helperSources() {
  const sourcesDirectory = join(sourceDirectory, "Sources");
  const sources = readdirSync(sourcesDirectory)
    .filter((name) => name.endsWith(".swift"))
    .toSorted()
    .map((name) => join(sourcesDirectory, name));
  if (sources.length === 0) {
    throw new Error(`No Swift sources found in ${sourcesDirectory}.`);
  }
  return sources;
}

function isUsableCachedBuild(outputPath, metadataPath, fingerprint) {
  if (!existsSync(outputPath) || !existsSync(metadataPath)) return false;
  try {
    if (JSON.parse(readFileSync(metadataPath, "utf8")).fingerprint !== fingerprint) return false;
    // A bundle whose signature no longer verifies is not reusable: electron-builder
    // re-signs it in place, and a half-signed leftover fails packaging later.
    return (
      spawnSync("codesign", ["--verify", "--strict", outputPath], { encoding: "utf8" }).status === 0
    );
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  if (result.status === 0) return;
  const detail = [result.stdout, result.stderr]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
  throw new Error(
    `Computer helper command failed (${command} ${args.join(" ")}): ${result.status ?? "unknown"}${detail ? `\n${detail}` : ""}`,
  );
}

export function buildComputerHelper({
  arch = process.arch,
  outputPath = defaultComputerHelperPath,
  quiet = false,
} = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The computer-use helper can only be built on macOS.");
  }
  if (!existsSync(buildScript)) {
    throw new Error(`Computer helper build script is missing: ${buildScript}`);
  }

  const targets = computerHelperTargetsForArch(arch);
  const sources = helperSources();
  const resolvedOutputPath = resolve(outputPath);
  const metadataPath = `${resolvedOutputPath}.build.json`;
  const fingerprint = buildFingerprint({ arch, sources, targets });
  if (isUsableCachedBuild(resolvedOutputPath, metadataPath, fingerprint)) {
    if (!quiet) {
      console.error(`[computer-use] Reusing ${arch} helper at ${resolvedOutputPath}`);
    }
    return resolvedOutputPath;
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "synara-computer-helper-"));
  try {
    const moduleCacheDirectory = join(temporaryDirectory, "module-cache");
    mkdirSync(moduleCacheDirectory, { recursive: true });
    const thinBinaries = [];
    for (const target of targets) {
      const outputDirectory = join(temporaryDirectory, target.arch);
      run("/bin/bash", [buildScript, outputDirectory], {
        env: {
          ...process.env,
          CLANG_MODULE_CACHE_PATH: moduleCacheDirectory,
          SWIFT_MODULECACHE_PATH: moduleCacheDirectory,
          SYNARA_COMPUTER_HELPER_TARGET: target.triple,
          // Always optimized: an unoptimized helper measurably changes the input
          // and capture latencies this helper exists to keep low, so a dev build
          // that differs from the shipped one would hide regressions until
          // packaging. Iterating on the Swift itself is the one case that wants
          // a faster compile, and that runs build.sh directly with
          // SYNARA_COMPUTER_HELPER_OPTIMIZE=debug.
          SYNARA_COMPUTER_HELPER_OPTIMIZE: "release",
        },
      });
      thinBinaries.push(join(outputDirectory, bundle.binaryName));
    }

    const unsignedBinary = join(temporaryDirectory, bundle.binaryName);
    if (thinBinaries.length === 1) {
      copyFileSync(thinBinaries[0], unsignedBinary);
    } else {
      run("xcrun", ["lipo", "-create", ...thinBinaries, "-output", unsignedBinary]);
    }

    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    const pendingPath = `${resolvedOutputPath}.tmp-${process.pid}`;
    rmSync(pendingPath, { recursive: true, force: true });
    const pendingExecutable = join(pendingPath, helperExecutableRelativePath);
    mkdirSync(dirname(pendingExecutable), { recursive: true });
    copyFileSync(unsignedBinary, pendingExecutable);
    chmodSync(pendingExecutable, 0o755);
    writeFileSync(join(pendingPath, "Contents", "Info.plist"), helperInfoPlist, "utf8");
    // One signature, on the bundle. Signing the loose binary first was redundant
    // — the bundle signature supersedes it — and `--deep` is deprecated by Apple
    // for exactly this shape: there is one nested executable and signing the
    // bundle covers it. A release build replaces this ad-hoc identity: signing
    // walks everything under the packaged `Contents/`, and any nested `.app` it
    // finds there is re-signed as a bundle in its own right.
    run("codesign", ["--force", "--sign", "-", "--timestamp=none", pendingPath]);
    rmSync(resolvedOutputPath, { recursive: true, force: true });
    renameSync(pendingPath, resolvedOutputPath);

    const pendingMetadataPath = `${metadataPath}.tmp-${process.pid}`;
    rmSync(pendingMetadataPath, { force: true });
    writeFileSync(pendingMetadataPath, `${JSON.stringify({ fingerprint })}\n`, { mode: 0o600 });
    rmSync(metadataPath, { force: true });
    renameSync(pendingMetadataPath, metadataPath);

    if (!quiet) {
      console.error(`[computer-use] Built ${arch} helper at ${resolvedOutputPath}`);
    }
    return resolvedOutputPath;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const SUPPORTED_ARCHES = new Set(["arm64", "x64", "universal"]);

function requireValue(args, index, flag) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseCommandLine(args) {
  let arch = process.arch;
  let outputPath = defaultComputerHelperPath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--arch":
        index += 1;
        arch = requireValue(args, index, "--arch");
        if (!SUPPORTED_ARCHES.has(arch)) {
          throw new Error(`--arch requires one of ${[...SUPPORTED_ARCHES].join(", ")}.`);
        }
        break;
      case "--output":
        index += 1;
        outputPath = requireValue(args, index, "--output");
        break;
      case "--release":
        // Accepted and ignored: every build is optimized now, but the desktop
        // packaging script drives this helper and the AppSnap one through one
        // shared command line that still passes `--release`, and rejecting it
        // here would fail the release build.
        break;
      default:
        throw new Error(`Unknown computer helper build argument: ${argument}`);
    }
  }
  return { arch, outputPath };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    buildComputerHelper(parseCommandLine(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
