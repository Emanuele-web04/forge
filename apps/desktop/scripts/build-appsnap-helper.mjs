#!/usr/bin/env node

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
const desktopDirectory = resolve(scriptsDirectory, "..");
const sourceDirectory = join(desktopDirectory, "native", "appsnap");

export const defaultAppSnapHelperPath = join(
  desktopDirectory,
  ".electron-runtime",
  "appsnap",
  "synara-appsnap-helper",
);

const frameworkArguments = [
  "-framework",
  "AppKit",
  "-framework",
  "Carbon",
  "-framework",
  "CoreGraphics",
  "-framework",
  "CoreImage",
  "-framework",
  "CoreMedia",
  "-framework",
  "CoreVideo",
  "-framework",
  "ScreenCaptureKit",
];

export function swiftTargetsForArch(arch) {
  switch (arch) {
    case "arm64":
      return [{ arch: "arm64", target: "arm64-apple-macos12.3" }];
    case "x64":
      return [{ arch: "x64", target: "x86_64-apple-macos12.3" }];
    case "universal":
      return [
        { arch: "arm64", target: "arm64-apple-macos12.3" },
        { arch: "x64", target: "x86_64-apple-macos12.3" },
      ];
    default:
      throw new Error(`Unsupported AppSnap helper architecture: ${arch}`);
  }
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: desktopDirectory,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  if (result.status === 0) {
    return;
  }

  const details = [result.stdout, result.stderr]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  const suffix = details ? `\n${details}` : "";
  throw new Error(
    `AppSnap helper command failed (${command} ${arguments_.join(" ")}): ${result.status ?? "unknown"}${suffix}`,
  );
}

function buildFingerprint({ arch, release, sources, targets }) {
  const hash = createHash("sha256");
  hash.update("synara-appsnap-helper-build-v1\0");
  hash.update(arch);
  hash.update("\0");
  hash.update(release ? "release" : "debug");
  hash.update("\0");
  hash.update(JSON.stringify(targets));
  hash.update("\0");
  hash.update(JSON.stringify(frameworkArguments));
  hash.update("\0");
  hash.update(readFileSync(scriptPath));
  for (const source of sources) {
    hash.update("\0");
    hash.update(source);
    hash.update("\0");
    hash.update(readFileSync(source));
  }
  return hash.digest("hex");
}

function isUsableCachedBuild(outputPath, metadataPath, fingerprint) {
  if (!existsSync(outputPath) || !existsSync(metadataPath)) {
    return false;
  }
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (metadata.fingerprint !== fingerprint) {
      return false;
    }
    const verification = spawnSync("codesign", ["--verify", "--strict", outputPath], {
      encoding: "utf8",
    });
    return verification.status === 0;
  } catch {
    return false;
  }
}

export function buildAppSnapHelper({
  arch = process.arch,
  outputPath = defaultAppSnapHelperPath,
  release = false,
  quiet = false,
} = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The AppSnap helper can only be built on macOS.");
  }

  const targets = swiftTargetsForArch(arch);
  const sources = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => join(sourceDirectory, name));
  if (sources.length === 0) {
    throw new Error(`No Swift sources found in ${sourceDirectory}.`);
  }

  const resolvedOutputPath = resolve(outputPath);
  const metadataPath = `${resolvedOutputPath}.build.json`;
  const fingerprint = buildFingerprint({ arch, release, sources, targets });
  if (isUsableCachedBuild(resolvedOutputPath, metadataPath, fingerprint)) {
    if (!quiet) {
      console.error(`[appsnap] Reusing ${arch} Swift helper at ${resolvedOutputPath}`);
    }
    return resolvedOutputPath;
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-helper-"));
  const moduleCacheDirectory = join(temporaryDirectory, "module-cache");
  const buildEnvironment = {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCacheDirectory,
    SWIFT_MODULECACHE_PATH: moduleCacheDirectory,
  };

  try {
    const thinBinaries = [];
    for (const target of targets) {
      const thinBinary = join(temporaryDirectory, `synara-appsnap-helper-${target.arch}`);
      const optimizationArguments = release
        ? ["-O", "-whole-module-optimization"]
        : ["-Onone", "-g"];
      run(
        "xcrun",
        [
          "swiftc",
          ...optimizationArguments,
          "-module-name",
          "SynaraAppSnapHelper",
          "-target",
          target.target,
          ...frameworkArguments,
          ...sources,
          "-o",
          thinBinary,
        ],
        { env: buildEnvironment },
      );
      thinBinaries.push(thinBinary);
    }

    const unsignedBinary = join(temporaryDirectory, "synara-appsnap-helper");
    if (thinBinaries.length === 1) {
      copyFileSync(thinBinaries[0], unsignedBinary);
    } else {
      run("xcrun", ["lipo", "-create", ...thinBinaries, "-output", unsignedBinary]);
    }

    // Dev helpers are ad-hoc signed. electron-builder replaces this signature
    // with the release identity because the packaged path is listed in mac.binaries.
    run("codesign", ["--force", "--sign", "-", "--timestamp=none", unsignedBinary]);

    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    const pendingOutputPath = `${resolvedOutputPath}.tmp-${process.pid}`;
    rmSync(pendingOutputPath, { force: true });
    copyFileSync(unsignedBinary, pendingOutputPath);
    chmodSync(pendingOutputPath, 0o755);
    rmSync(resolvedOutputPath, { force: true });
    renameSync(pendingOutputPath, resolvedOutputPath);

    const pendingMetadataPath = `${metadataPath}.tmp-${process.pid}`;
    rmSync(pendingMetadataPath, { force: true });
    writeFileSync(pendingMetadataPath, `${JSON.stringify({ fingerprint })}\n`, { mode: 0o600 });
    rmSync(metadataPath, { force: true });
    renameSync(pendingMetadataPath, metadataPath);

    if (!quiet) {
      console.error(
        `[appsnap] Built ${arch} Swift helper for macOS 12.3+ at ${resolvedOutputPath}`,
      );
    }
    return resolvedOutputPath;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseCommandLine(arguments_) {
  let arch = process.arch;
  let outputPath = defaultAppSnapHelperPath;
  let release = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case "--arch":
        index += 1;
        if (index >= arguments_.length) {
          throw new Error("--arch requires arm64, x64, or universal.");
        }
        arch = arguments_[index];
        break;
      case "--output":
        index += 1;
        if (index >= arguments_.length) {
          throw new Error("--output requires a path.");
        }
        outputPath = arguments_[index];
        break;
      case "--release":
        release = true;
        break;
      default:
        throw new Error(`Unknown AppSnap helper build argument: ${argument}`);
    }
  }

  return { arch, outputPath, release };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    buildAppSnapHelper(parseCommandLine(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
