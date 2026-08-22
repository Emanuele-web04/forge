#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Data, Effect, FileSystem, Logger, Option, Path } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  PUBLISH_ICON_OVERRIDES,
} from "../../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import rootPackageJson from "../../../package.json" with { type: "json" };
import serverPackageJson from "../package.json" with { type: "json" };

class CliError extends Data.TaggedError("CliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Some desktop builds do not expose workspace metadata in the root package.json.
// Publish prep only needs the catalog map when it exists.
function resolveRootWorkspaceCatalog(): Record<string, unknown> {
  const rootWorkspaces =
    typeof rootPackageJson === "object" &&
    rootPackageJson !== null &&
    "workspaces" in rootPackageJson
      ? rootPackageJson.workspaces
      : null;

  if (
    typeof rootWorkspaces !== "object" ||
    rootWorkspaces === null ||
    !("catalog" in rootWorkspaces)
  ) {
    return {};
  }

  const catalog = rootWorkspaces.catalog;
  return typeof catalog === "object" && catalog !== null
    ? (catalog as Record<string, unknown>)
    : {};
}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new CliError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

const applyPublishIconOverrides = Effect.fn("applyPublishIconOverrides")(function* (
  repoRoot: string,
  stagedPackageDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of PUBLISH_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(stagedPackageDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing publish icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing publish icon target: ${targetPath}. Run the build subcommand first.`,
      });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied publish icon overrides inside the isolated package stage");
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing development icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing development icon target: ${targetPath}. Build web first.`,
      });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make({
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
          shell: process.platform === "win32",
        })`bun tsdown`,
      );

      // The device backend compiles this helper against the user's installed
      // Xcode on first attach. tsdown bundles JavaScript only, and desktop/CLI
      // packaging stage only `dist`, so leaving the sources under `native`
      // makes the feature work in development but fail in every packaged app.
      const deviceHelperSource = path.join(serverDir, "native/device-helper");
      const deviceHelperTarget = path.join(serverDir, "dist/device-helper");
      yield* fs.copy(deviceHelperSource, deviceHelperTarget);
      yield* fs.chmod(path.join(deviceHelperTarget, "build.sh"), 0o755);
      yield* Effect.log("[cli] Bundled iOS Simulator helper sources into dist/device-helper");

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// distribution staging (shared by publish and pack)
// ---------------------------------------------------------------------------

const stageDistributionPackage = Effect.fn("stageDistributionPackage")(function* (
  appVersion: Option.Option<string>,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const serverDir = path.join(repoRoot, "apps/server");

  // Assert build assets exist
  for (const relPath of [
    "dist/index.mjs",
    "dist/restoreMigrationBackup.mjs",
    "dist/client/index.html",
  ]) {
    const abs = path.join(serverDir, relPath);
    if (!(yield* fs.exists(abs))) {
      return yield* new CliError({
        message: `Missing build asset: ${abs}. Run the build subcommand first.`,
      });
    }
  }

  const version = Option.getOrElse(appVersion, () => serverPackageJson.version);
  const pkg = {
    name: serverPackageJson.name,
    license: serverPackageJson.license,
    repository: serverPackageJson.repository,
    bin: serverPackageJson.bin,
    type: serverPackageJson.type,
    version,
    engines: serverPackageJson.engines,
    files: serverPackageJson.files,
    dependencies: resolveCatalogDependencies(
      serverPackageJson.dependencies as Record<string, unknown>,
      resolveRootWorkspaceCatalog(),
      "apps/server dependencies",
    ),
  };

  const stagedPackageDir = yield* fs.makeTempDirectoryScoped({
    prefix: "synara-cli-publish-",
  });
  yield* fs.copy(path.join(serverDir, "dist"), path.join(stagedPackageDir, "dist"));
  for (const binTarget of Object.values(pkg.bin)) {
    if (typeof binTarget !== "string" || !binTarget.startsWith("dist/")) {
      return yield* new CliError({
        message: `CLI bin target must stay inside the staged dist directory: ${String(binTarget)}`,
      });
    }
    const stagedBinPath = path.join(stagedPackageDir, binTarget);
    if (!(yield* fs.exists(stagedBinPath))) {
      return yield* new CliError({ message: `Missing staged CLI bin target: ${binTarget}` });
    }
    const stagedBin = yield* fs.readFileString(stagedBinPath);
    if (!stagedBin.startsWith("#!/usr/bin/env node\n")) {
      return yield* new CliError({
        message: `Staged CLI bin target is missing its Node shebang: ${binTarget}`,
      });
    }
    yield* fs.chmod(stagedBinPath, 0o755);
  }
  yield* applyPublishIconOverrides(repoRoot, stagedPackageDir);
  yield* fs.writeFileString(
    path.join(stagedPackageDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
  const stagedRootEntries = (yield* fs.readDirectory(stagedPackageDir)).sort();
  if (
    stagedRootEntries.length !== 2 ||
    stagedRootEntries[0] !== "dist" ||
    stagedRootEntries[1] !== "package.json"
  ) {
    return yield* new CliError({
      message: `Unexpected CLI publish-stage entries: ${stagedRootEntries.join(", ")}`,
    });
  }

  return { stagedPackageDir, version };
});

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const { stagedPackageDir } = yield* stageDistributionPackage(config.appVersion);

      const args = ["publish", "--access", config.access, "--tag", config.tag];
      if (config.provenance) args.push("--provenance");
      if (config.dryRun) args.push("--dry-run");

      yield* Effect.log(`[cli] Running from isolated stage: npm ${args.join(" ")}`);
      yield* runCommand(
        ChildProcess.make("npm", [...args], {
          cwd: stagedPackageDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          // Windows needs shell mode to resolve .cmd shims.
          shell: process.platform === "win32",
        }),
      );
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

// ---------------------------------------------------------------------------
// pack subcommand
// ---------------------------------------------------------------------------

const packCmd = Command.make(
  "pack",
  {
    out: Flag.string("out").pipe(Flag.withDefault("release-server")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;

      const { stagedPackageDir, version } = yield* stageDistributionPackage(config.appVersion);

      const outDir = path.isAbsolute(config.out)
        ? config.out
        : path.join(process.cwd(), config.out);
      yield* fs.makeDirectory(outDir, { recursive: true });

      const tarballPath = path.join(outDir, `synara-server-${version}.tar.gz`);
      yield* runCommand(
        ChildProcess.make("tar", ["-czf", tarballPath, "dist", "package.json"], {
          cwd: stagedPackageDir,
          stdout: "inherit",
          stderr: "inherit",
          // Windows needs shell mode to resolve .cmd shims.
          shell: process.platform === "win32",
        }),
      );

      yield* Effect.log(`[cli] Wrote server tarball: ${tarballPath}`);
    }),
).pipe(
  Command.withDescription("Produce a synara-server-<version>.tar.gz from the staged package."),
);

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("Synara server build & publish CLI."),
  Command.withSubcommands([buildCmd, publishCmd, packCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
