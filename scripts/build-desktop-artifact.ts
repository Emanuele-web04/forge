#!/usr/bin/env node
// FILE: build-desktop-artifact.ts
// Purpose: Stages and builds packaged desktop artifacts plus updater metadata for GitHub releases.
// Layer: Release/build script
// Depends on: apps/desktop package metadata, electron-builder, and GitHub release config.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import {
  createDesktopPlatformBuildConfig,
  MAC_APPSNAP_HELPER_STAGE_PATH,
  MAC_DEVICE_HELPER_RESOURCE_PATH,
  validateDesktopNativeBuildHost,
} from "./lib/desktop-platform-build-config.ts";
import { SYNARA_PRODUCTION_BUNDLE_ID } from "@synara/shared/desktopIdentity";
import { parseBooleanEnvValue } from "./lib/env-bool.ts";
import { finalizeSignedMacDmg } from "./lib/mac-dmg-finalize.ts";
import { finalizeMacUpdateZip } from "./lib/mac-update-zip-finalize.ts";
import {
  RELEASE_LOCKFILE_PATH,
  RELEASE_PATCHES_PATH,
  RELEASE_WORKSPACE_MANIFEST_PATHS,
} from "./lib/release-workspace-manifests.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Data, Effect, FileSystem, Layer, Logger, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);
const requireFromScriptsWorkspace = createRequire(new URL("./package.json", import.meta.url));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const ProductionMacIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionMacIconPng),
);
const ProductionMacLegacyIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionMacLegacyIconPng),
);
const ProductionLinuxIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionLinuxIconPng),
);
const ProductionWindowsIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionWindowsIconIco),
);
const NodePtySmokeScript = Effect.zipWith(RepoRoot, Effect.service(Path.Path), (repoRoot, path) =>
  path.join(repoRoot, "scripts/node-pty-smoke.mjs"),
);
const AppSnapHelperBuildScript = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, "apps/desktop/scripts/build-appsnap-helper.mjs"),
);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly sourceCommit: Option.Option<string>;
  readonly sourceTag: Option.Option<string>;
  readonly lockfileSha256: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<string>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

function getDefaultArch(platform: typeof BuildPlatform.Type): typeof BuildArch.Type {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  if (process.arch === "arm64" && config.archChoices.includes("arm64")) {
    return "arm64";
  }
  if (process.arch === "x64" && config.archChoices.includes("x64")) {
    return "x64";
  }

  return config.archChoices[0] ?? "x64";
}

class BuildScriptError extends Data.TaggedError("BuildScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function resolveGitCommitHash(repoRoot: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return undefined;
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(hash)) {
    return undefined;
  }
  return hash.toLowerCase();
}

function resolveLockfileSha256(repoRoot: string): string {
  return createHash("sha256")
    .update(readFileSync(join(repoRoot, "bun.lock")))
    .digest("hex");
}

function resolvePythonForNodeGyp(): string | undefined {
  const configured = process.env.npm_config_python ?? process.env.PYTHON;
  if (configured && existsSync(configured)) {
    return configured;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = join(localAppData, "Programs", "Python", version, "python.exe");
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  const probe = spawnSync("python", ["-c", "import sys;print(sys.executable)"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !existsSync(executable)) {
    return undefined;
  }

  return executable;
}

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly sourceCommit: string | undefined;
  readonly sourceTag: string | undefined;
  readonly lockfileSha256: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: string | undefined;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly synaraCommitHash: string;
  readonly synaraLockfileSha256: string;
  readonly synaraSourceTag: string | null;
  readonly synaraWindowsPublisherSubject: string | null;
  readonly private: true;
  readonly description: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
  readonly overrides: Record<string, unknown>;
}

const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.string("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  subjectDistinguishedName: Config.string("AZURE_TRUSTED_SIGNING_SUBJECT_DN"),
  endpoint: Config.string("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.string("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.string("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.string("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "SYNARA_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.string("SYNARA_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "SYNARA_DESKTOP_ARCH").pipe(Config.option),
  version: Config.string("SYNARA_DESKTOP_VERSION").pipe(Config.option),
  sourceCommit: Config.string("SYNARA_SOURCE_COMMIT").pipe(Config.option),
  sourceTag: Config.string("SYNARA_SOURCE_TAG").pipe(Config.option),
  lockfileSha256: Config.string("SYNARA_LOCKFILE_SHA256").pipe(Config.option),
  outputDir: Config.string("SYNARA_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.string("SYNARA_DESKTOP_SKIP_BUILD").pipe(Config.option),
  keepStage: Config.string("SYNARA_DESKTOP_KEEP_STAGE").pipe(Config.option),
  signed: Config.string("SYNARA_DESKTOP_SIGNED").pipe(Config.option),
  verbose: Config.string("SYNARA_DESKTOP_VERBOSE").pipe(Config.option),
  mockUpdates: Config.string("SYNARA_DESKTOP_MOCK_UPDATES").pipe(Config.option),
  mockUpdateServerPort: Config.string("SYNARA_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));
const resolveBooleanEnv = (name: string, value: Option.Option<string>) =>
  Effect.try({
    try: () =>
      Option.match(value, {
        onNone: () => false,
        onSome: (rawValue) => parseBooleanEnvValue(name, rawValue),
      }),
    catch: (cause) =>
      new BuildScriptError({
        message: cause instanceof Error ? cause.message : `Could not parse ${name}.`,
        cause,
      }),
  });

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig.asEffect();

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(process.platform),
  );

  if (!platform) {
    return yield* new BuildScriptError({
      message: `Unsupported host platform '${process.platform}'.`,
    });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const arch = mergeOptions(input.arch, env.arch, getDefaultArch(platform));
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const sourceCommit = mergeOptions(input.sourceCommit, env.sourceCommit, undefined);
  const sourceTag = mergeOptions(input.sourceTag, env.sourceTag, undefined);
  const lockfileSha256 = mergeOptions(input.lockfileSha256, env.lockfileSha256, undefined);
  const envSkipBuild = yield* resolveBooleanEnv("SYNARA_DESKTOP_SKIP_BUILD", env.skipBuild);
  const envKeepStage = yield* resolveBooleanEnv("SYNARA_DESKTOP_KEEP_STAGE", env.keepStage);
  const envSigned = yield* resolveBooleanEnv("SYNARA_DESKTOP_SIGNED", env.signed);
  const envVerbose = yield* resolveBooleanEnv("SYNARA_DESKTOP_VERBOSE", env.verbose);
  const envMockUpdates = yield* resolveBooleanEnv("SYNARA_DESKTOP_MOCK_UPDATES", env.mockUpdates);
  const releaseDir = resolveBooleanFlag(input.mockUpdates, envMockUpdates)
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, releaseDir),
  );

  const skipBuild = resolveBooleanFlag(input.skipBuild, envSkipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, envKeepStage);
  const signed = resolveBooleanFlag(input.signed, envSigned);
  const verbose = resolveBooleanFlag(input.verbose, envVerbose);
  const mockUpdates = resolveBooleanFlag(input.mockUpdates, envMockUpdates);
  const mockUpdateServerPort = mergeOptions(
    input.mockUpdateServerPort,
    env.mockUpdateServerPort,
    undefined,
  );

  return {
    platform,
    target,
    arch,
    version,
    sourceCommit,
    sourceTag,
    lockfileSha256,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    verbose,
    mockUpdates,
    mockUpdateServerPort,
  } satisfies ResolvedBuildOptions;
});

const commandOutputOptions = (verbose: boolean) =>
  ({
    stdout: verbose ? "inherit" : "ignore",
    stderr: "inherit",
  }) as const;

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new BuildScriptError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
      );
    }

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`iconutil -c icns ${iconsetDir} -o ${targetIcns}`,
    );
  });
}

function stageMacIcons(stageResourcesDir: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const modernIconSource = yield* ProductionMacIconSource;
    if (!(yield* fs.exists(modernIconSource))) {
      return yield* new BuildScriptError({
        message: `Production macOS icon source is missing at ${modernIconSource}`,
      });
    }
    const legacyIconSource = yield* ProductionMacLegacyIconSource;
    if (!(yield* fs.exists(legacyIconSource))) {
      return yield* new BuildScriptError({
        message: `Production legacy macOS icon source is missing at ${legacyIconSource}`,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "synara-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");
    const dockIconPngPath = path.join(stageResourcesDir, "dock-icon.png");

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -z 512 512 ${modernIconSource} --out ${iconPngPath}`,
    );

    // The solid ICNS is the bundle icon on every macOS release; Icon Composer glass alters the mark.
    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -z 1024 1024 ${legacyIconSource} --out ${dockIconPngPath}`,
    );

    yield* generateMacIconSet(legacyIconSource, iconIcnsPath, tmpRoot, path, verbose);
  });
}

function stageLinuxIcons(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionLinuxIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production icon source is missing at ${iconSource}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(iconSource, iconPath);
  });
}

function stageWindowsIcons(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionWindowsIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production Windows icon source is missing at ${iconSource}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    yield* fs.copyFile(iconSource, iconPath);
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
      return yield* new BuildScriptError({
        message: `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
      });
    }
  });
}

function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, unknown> | undefined,
  catalog: Record<string, unknown>,
): Record<string, unknown> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(([dependencyName]) => dependencyName !== "electron"),
  );

  return resolveCatalogDependencies(runtimeDependencies, catalog, "apps/desktop");
}

function resolveGitHubPublishConfig():
  | {
      readonly provider: "github";
      readonly owner: string;
      readonly repo: string;
      readonly releaseType: "release";
    }
  | undefined {
  const rawRepo =
    process.env.SYNARA_DESKTOP_UPDATE_REPOSITORY?.trim() ||
    process.env.GITHUB_REPOSITORY?.trim() ||
    "";
  if (!rawRepo) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    releaseType: "release",
  };
}

const verifyStagedNodePty = Effect.fn("verifyStagedNodePty")(function* (
  stageAppDir: string,
  verbose: boolean,
) {
  const smokeScript = yield* NodePtySmokeScript;
  yield* Effect.log("[desktop-artifact] Verifying staged node-pty native PTY...");
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      env: {
        ...process.env,
        SYNARA_NODE_PTY_SMOKE_REQUIRE_ROOT: stageAppDir,
      },
      ...commandOutputOptions(verbose),
      shell: process.platform === "win32",
    })`node ${smokeScript}`,
  );
});

interface PatchFileExpectation {
  readonly file: string;
  readonly addedLines: ReadonlyArray<string>;
}

function parsePatchAddedLines(patchContents: string): PatchFileExpectation[] {
  const expectations: Array<{ file: string; addedLines: string[] }> = [];
  let current: { file: string; addedLines: string[] } | null = null;
  for (const line of patchContents.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = null;
        continue;
      }
      current = { file: target.startsWith("b/") ? target.slice(2) : target, addedLines: [] };
      expectations.push(current);
      continue;
    }
    if (current && line.startsWith("+")) {
      const added = line.slice(1).trim();
      if (added.length > 0) {
        current.addedLines.push(added);
      }
    }
  }
  return expectations.filter((expectation) => expectation.addedLines.length > 0);
}

// Package managers can silently skip tracked patches when the staged install
// diverges from the repo setup (that shipped broken Windows provider updates
// in v0.5.2–v0.5.5), so fail the build unless every patched line is present.
const verifyStagedPatchedDependencies = Effect.fn("verifyStagedPatchedDependencies")(function* (
  repoRoot: string,
  stageAppDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.log("[desktop-artifact] Verifying staged patched dependencies...");
  for (const [dependency, patchRelativePath] of Object.entries(
    rootPackageJson.patchedDependencies ?? {},
  )) {
    const packageName = dependency.slice(0, dependency.indexOf("@", 1));
    const patchContents = yield* fs.readFileString(path.join(repoRoot, patchRelativePath));
    for (const expectation of parsePatchAddedLines(patchContents)) {
      const stagedFilePath = path.join(stageAppDir, "node_modules", packageName, expectation.file);
      const stagedContents = yield* fs.readFileString(stagedFilePath).pipe(
        Effect.mapError(
          (cause) =>
            new BuildScriptError({
              message: `Patched dependency file is missing from the stage: ${stagedFilePath} (expected by ${patchRelativePath}).`,
              cause,
            }),
        ),
      );
      for (const addedLine of expectation.addedLines) {
        if (!stagedContents.includes(addedLine)) {
          return yield* new BuildScriptError({
            message: `Staged dependency ${packageName} is missing patched content: ${expectation.file} does not contain "${addedLine}" from ${patchRelativePath}. The tracked patch was not applied by the staged install.`,
          });
        }
      }
    }
  }
});

const installFrozenStageDependencies = Effect.fn("installFrozenStageDependencies")(function* (
  repoRoot: string,
  stageAppDir: string,
  platform: typeof BuildPlatform.Type,
  verbose: boolean,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const destination = path.join(stageAppDir, relativePath);
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copyFile(path.join(repoRoot, relativePath), destination);
  }
  yield* fs.copyFile(
    path.join(repoRoot, RELEASE_LOCKFILE_PATH),
    path.join(stageAppDir, RELEASE_LOCKFILE_PATH),
  );
  yield* fs.copy(
    path.join(repoRoot, RELEASE_PATCHES_PATH),
    path.join(stageAppDir, RELEASE_PATCHES_PATH),
  );

  yield* Effect.log(
    "[desktop-artifact] Installing staged production dependencies from the repository lockfile...",
  );
  if (platform === "win") {
    // Bun 1.3.12 needs a platform-only lockfile rewrite while resolving this
    // copied workspace on Windows even though the repository-level frozen
    // install already passed. Its --production flag also forces frozen mode,
    // so use the equivalent dependency omission and allow only the temporary
    // staging copy to update; the verified source lockfile remains untouched.
    yield* runCommand(
      ChildProcess.make({
        cwd: stageAppDir,
        ...commandOutputOptions(verbose),
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
      })`bun install --omit=dev --ignore-scripts --linker hoisted`,
    );
  } else {
    yield* runCommand(
      ChildProcess.make({
        cwd: stageAppDir,
        ...commandOutputOptions(verbose),
      })`bun install --frozen-lockfile --ignore-scripts --linker hoisted`,
    );
  }

  if (platform === "linux") {
    // node-pty's npm package does not ship Linux prebuilds. Keep the frozen
    // install's blanket lifecycle-script block, then rebuild only node-pty so
    // npm supplies node-gyp to its install script and compiles the native
    // binding required by the packaged terminal.
    yield* Effect.log("[desktop-artifact] Building staged Linux node-pty binding...");
    yield* runCommand(
      ChildProcess.make({
        cwd: stageAppDir,
        ...commandOutputOptions(verbose),
      })`npm rebuild node-pty --foreground-scripts`,
    );
  }

  yield* verifyStagedPatchedDependencies(repoRoot, stageAppDir);

  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    if (relativePath !== "package.json") {
      yield* fs.remove(path.join(stageAppDir, relativePath));
    }
  }
  yield* fs.remove(path.join(stageAppDir, RELEASE_LOCKFILE_PATH));
  yield* fs.remove(path.join(stageAppDir, RELEASE_PATCHES_PATH), { recursive: true });
});

const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  productName: string,
  signed: boolean,
  mockUpdates: boolean,
  mockUpdateServerPort: string | undefined,
) {
  const buildConfig: Record<string, unknown> = {
    appId: SYNARA_PRODUCTION_BUNDLE_ID,
    productName,
    artifactName: "Synara-${version}-${arch}.${ext}",
    directories: {
      buildResources: "apps/desktop/resources",
    },
    forceCodeSigning: signed,
  };
  const publishConfig = resolveGitHubPublishConfig();
  if (publishConfig) {
    buildConfig.publish = [publishConfig];
  } else if (mockUpdates) {
    buildConfig.publish = [
      {
        provider: "generic",
        url: `http://localhost:${mockUpdateServerPort ?? 3000}`,
      },
    ];
  }

  const windowsSigningConfig =
    platform === "win" && signed ? yield* AzureTrustedSigningOptionsConfig : undefined;
  const windowsAzureSignOptions = windowsSigningConfig
    ? {
        publisherName: windowsSigningConfig.publisherName,
        endpoint: windowsSigningConfig.endpoint,
        certificateProfileName: windowsSigningConfig.certificateProfileName,
        codeSigningAccountName: windowsSigningConfig.codeSigningAccountName,
        fileDigest: windowsSigningConfig.fileDigest,
        timestampDigest: windowsSigningConfig.timestampDigest,
        timestampRfc3161: windowsSigningConfig.timestampRfc3161,
      }
    : undefined;

  const platformBuildConfigInput = {
    platform,
    target,
    signed,
    ...(windowsAzureSignOptions ? { windowsAzureSignOptions } : {}),
  } as const;

  Object.assign(buildConfig, createDesktopPlatformBuildConfig(platformBuildConfigInput));

  return {
    buildConfig,
    windowsPublisherSubject: windowsSigningConfig?.subjectDistinguishedName ?? null,
  };
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir);
    return;
  }
});

const stageMacAppSnapHelper = Effect.fn("stageMacAppSnapHelper")(function* (
  stageAppDir: string,
  arch: typeof BuildArch.Type,
  verbose: boolean,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const buildScript = yield* AppSnapHelperBuildScript;
  const outputPath = path.join(stageAppDir, MAC_APPSNAP_HELPER_STAGE_PATH);

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* Effect.log(`[desktop-artifact] Building native AppSnap helper (${arch})...`);
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      ...commandOutputOptions(verbose),
    })`node ${buildScript} --arch ${arch} --release --output ${outputPath}`,
  );

  if (!(yield* fs.exists(outputPath))) {
    return yield* new BuildScriptError({
      message: `AppSnap helper build completed but output was not found at ${outputPath}`,
    });
  }
});

const assertPackagedMacDeviceHelper = Effect.fn("assertPackagedMacDeviceHelper")(function* (
  stageDistDir: string,
  productName: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(stageDistDir);
  for (const entry of entries) {
    const packagedEntryPath = path.join(stageDistDir, entry);
    const packagedEntryStat = yield* fs
      .stat(packagedEntryPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!packagedEntryStat || packagedEntryStat.type !== "Directory") continue;

    const helperRoot = path.join(
      packagedEntryPath,
      `${productName}.app`,
      "Contents",
      MAC_DEVICE_HELPER_RESOURCE_PATH,
    );
    if (
      (yield* fs.exists(path.join(helperRoot, "build.sh"))) &&
      (yield* fs.exists(path.join(helperRoot, "Sources/main.swift")))
    ) {
      return;
    }
  }
  return yield* new BuildScriptError({
    message: `Packaged macOS app is missing physical device helper sources under Contents/${MAC_DEVICE_HELPER_RESOURCE_PATH}`,
  });
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new BuildScriptError({
      message: `Unsupported platform '${options.platform}'.`,
    });
  }
  const nativeBuildHostIssue = validateDesktopNativeBuildHost({
    platform: options.platform,
    arch: options.arch,
    hostPlatform: process.platform,
    hostArch: process.arch,
  });
  if (nativeBuildHostIssue) {
    return yield* new BuildScriptError({
      message: nativeBuildHostIssue,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new BuildScriptError({
      message: "Could not resolve production dependencies from apps/server/package.json.",
    });
  }

  const resolvedOverrides = yield* Effect.try({
    try: () =>
      resolveCatalogDependencies(
        rootPackageJson.overrides,
        rootPackageJson.workspaces.catalog,
        "apps/desktop",
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve overrides from package.json.",
        cause,
      }),
  });

  const resolvedServerDependencies = yield* Effect.try({
    try: () =>
      resolveCatalogDependencies(
        serverDependencies,
        rootPackageJson.workspaces.catalog,
        "apps/server",
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve production dependencies from apps/server/package.json.",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () =>
      resolveDesktopRuntimeDependencies(
        desktopPackageJson.dependencies,
        rootPackageJson.workspaces.catalog,
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve desktop runtime dependencies from apps/desktop/package.json.",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const hasSourceCommit = options.sourceCommit !== undefined;
  const hasLockfileSha256 = options.lockfileSha256 !== undefined;
  const exactProvenanceRequested =
    hasSourceCommit || hasLockfileSha256 || options.sourceTag !== undefined;
  if (exactProvenanceRequested && (!hasSourceCommit || !hasLockfileSha256 || !options.version)) {
    return yield* new BuildScriptError({
      message:
        "Exact release provenance requires an explicit build version, source commit, and lockfile SHA-256 together.",
    });
  }

  const resolvedCommitHash = resolveGitCommitHash(repoRoot);
  if (options.sourceCommit && !/^[0-9a-f]{40}$/i.test(options.sourceCommit)) {
    return yield* new BuildScriptError({
      message: `Expected a full 40-character source commit, got '${options.sourceCommit}'.`,
    });
  }
  if (options.sourceCommit && resolvedCommitHash !== options.sourceCommit.toLowerCase()) {
    return yield* new BuildScriptError({
      message: `Release source commit mismatch: expected ${options.sourceCommit}, got ${resolvedCommitHash ?? "unknown"}.`,
    });
  }
  const commitHash = resolvedCommitHash ?? "unknown";
  const resolvedLockfileSha256 = resolveLockfileSha256(repoRoot);
  if (options.lockfileSha256 && !/^[0-9a-f]{64}$/i.test(options.lockfileSha256)) {
    return yield* new BuildScriptError({
      message: `Expected a 64-character lockfile SHA-256, got '${options.lockfileSha256}'.`,
    });
  }
  if (options.lockfileSha256 && resolvedLockfileSha256 !== options.lockfileSha256.toLowerCase()) {
    return yield* new BuildScriptError({
      message: `Release lockfile digest mismatch: expected ${options.lockfileSha256}, got ${resolvedLockfileSha256}.`,
    });
  }
  if (options.sourceTag && options.sourceTag !== `v${appVersion}`) {
    return yield* new BuildScriptError({
      message: `Release source tag ${options.sourceTag} does not match artifact version ${appVersion}.`,
    });
  }
  if (exactProvenanceRequested) {
    const gitStatus = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (gitStatus.status !== 0) {
      return yield* new BuildScriptError({
        message: `Unable to inspect release worktree: ${gitStatus.stderr.trim() || "git failed"}.`,
      });
    }
    if (gitStatus.stdout.trim().length > 0) {
      return yield* new BuildScriptError({
        message: "Release source worktree is not clean; refusing to stage uncommitted bytes.",
      });
    }
  }
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `synara-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* runCommand(
      ChildProcess.make({
        cwd: repoRoot,
        ...commandOutputOptions(options.verbose),
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
      })`bun run build:desktop`,
    );
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(yield* fs.exists(dir))) {
      return yield* new BuildScriptError({
        message: `Missing ${label} at ${dir}. Run 'bun run build:desktop' first.`,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new BuildScriptError({
      message: `Missing bundled server client at ${bundledClientEntry}. Run 'bun run build:desktop' first.`,
    });
  }

  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));

  yield* assertPlatformBuildResources(options.platform, stageResourcesDir, options.verbose);

  if (options.platform === "mac") {
    yield* stageMacAppSnapHelper(stageAppDir, options.arch, options.verbose);
  }

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  yield* fs.copy(stageResourcesDir, path.join(stageAppDir, "apps/desktop/prod-resources"));

  const resolvedBuildConfig = yield* createBuildConfig(
    options.platform,
    options.target,
    desktopPackageJson.productName ?? "Synara",
    options.signed,
    options.mockUpdates,
    options.mockUpdateServerPort,
  );

  const stagePackageJson: StagePackageJson = {
    name: "synara-desktop",
    version: appVersion,
    buildVersion: appVersion,
    synaraCommitHash: commitHash,
    synaraLockfileSha256: resolvedLockfileSha256,
    synaraSourceTag: options.sourceTag ?? null,
    synaraWindowsPublisherSubject: resolvedBuildConfig.windowsPublisherSubject,
    private: true,
    description: "Synara desktop build",
    author: "Emanuele Di Pietro",
    main: "apps/desktop/dist-electron/main.js",
    build: resolvedBuildConfig.buildConfig,
    dependencies: {
      ...resolvedServerDependencies,
      ...resolvedDesktopRuntimeDependencies,
    },
    devDependencies: {
      electron: electronVersion,
    },
    overrides: {
      ...resolvedOverrides,
    },
  };

  yield* installFrozenStageDependencies(repoRoot, stageAppDir, options.platform, options.verbose);

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);

  if (options.platform === "linux") {
    yield* verifyStagedNodePty(stageAppDir, options.verbose);
  }

  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  if (process.platform === "win32") {
    const python = resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  const electronBuilderCliPath = requireFromScriptsWorkspace.resolve("electron-builder/cli.js");
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      env: buildEnv,
      ...commandOutputOptions(options.verbose),
    })`${process.execPath} ${electronBuilderCliPath} ${platformConfig.cliFlag} --${options.arch} --publish never`,
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new BuildScriptError({
      message: `Build completed but dist directory was not found at ${stageDistDir}`,
    });
  }

  if (options.platform === "mac") {
    yield* assertPackagedMacDeviceHelper(stageDistDir, desktopPackageJson.productName ?? "Synara");
  }

  if (options.platform === "mac" && options.target === "dmg" && options.signed) {
    yield* Effect.log("[desktop-artifact] Notarizing and validating signed macOS DMG...");
    const finalizedDmg = yield* Effect.try({
      try: () =>
        finalizeSignedMacDmg({
          stageDistDir,
          appleApiKey: buildEnv.APPLE_API_KEY,
          appleApiKeyId: buildEnv.APPLE_API_KEY_ID,
          appleApiIssuer: buildEnv.APPLE_API_ISSUER,
          verbose: options.verbose,
        }),
      catch: (cause) =>
        new BuildScriptError({
          message: "macOS DMG signing/notarization finalization failed.",
          cause,
        }),
    });
    yield* Effect.log(
      `[desktop-artifact] Signed and notarized macOS DMG (${finalizedDmg.dmgFileName}).`,
    );
  }

  if (options.platform === "mac") {
    yield* Effect.log("[desktop-artifact] Repacking and validating macOS update zip...");
    const finalizedZip = yield* Effect.tryPromise({
      try: () =>
        finalizeMacUpdateZip({
          stageDistDir,
          signed: options.signed,
          verbose: options.verbose,
        }),
      catch: (cause) =>
        new BuildScriptError({
          message: "macOS update zip finalization failed.",
          cause,
        }),
    });
    if (finalizedZip.removedZipBlockmapPath) {
      yield* Effect.log(
        `[desktop-artifact] Removed stale macOS zip blockmap (${path.basename(finalizedZip.removedZipBlockmapPath)}).`,
      );
    }
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat || stat.type !== "File") continue;

    const outputEntry =
      options.platform === "mac" && options.arch !== "arm64" && entry === "latest-mac.yml"
        ? `latest-mac-${options.arch}.yml`
        : entry;
    const to = path.join(options.outputDir, outputEntry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new BuildScriptError({
      message: `Build completed but no files were produced in ${stageDistDir}`,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: SYNARA_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: SYNARA_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: SYNARA_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: SYNARA_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  sourceCommit: Flag.string("source-commit").pipe(
    Flag.withDescription("Expected full source commit (env: SYNARA_SOURCE_COMMIT)."),
    Flag.optional,
  ),
  sourceTag: Flag.string("source-tag").pipe(
    Flag.withDescription("Exact source tag when building a release (env: SYNARA_SOURCE_TAG)."),
    Flag.optional,
  ),
  lockfileSha256: Flag.string("lockfile-sha256").pipe(
    Flag.withDescription("Expected bun.lock SHA-256 (env: SYNARA_LOCKFILE_SHA256)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: SYNARA_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `bun run build:desktop` and use existing dist artifacts (env: SYNARA_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: SYNARA_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: SYNARA_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: SYNARA_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: SYNARA_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.string("mock-update-server-port").pipe(
    Flag.withDescription("Mock update server port (env: SYNARA_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for Synara."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(cliRuntimeLayer),
  NodeRuntime.runMain,
);
