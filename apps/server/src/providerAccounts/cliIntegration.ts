// CLI integration for managed accounts: installs/uninstalls the provider
// shims into <account-root>/bin and reports health (installed state,
// launcher version, PATH visibility). This module is the single source of
// truth for shim scripts; nothing ships pre-generated shims.

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderAccountsIntegrationStatus } from "@synara/contracts";
import {
  providerShimCommands,
  SYNARA_LAUNCHER_SHIM,
} from "@synara/shared/providerAccounts/launcherProtocol";
import { Data, Effect } from "effect";

export class CliIntegrationError extends Data.TaggedError("CliIntegrationError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const VERSION_FILE = "launcher-version";

// The standalone launcher entry point, resolved relative to this module.
// Packaged CLI/desktop artifacts stage a self-contained bundle next to the
// server bundle (dist/account-launcher/bin/launcher.mjs); a source checkout
// falls back to the TypeScript entry in the launcher workspace.
const defaultLauncherEntry = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packagedEntry = path.resolve(moduleDir, "account-launcher/bin/launcher.mjs");
  if (existsSync(packagedEntry)) return packagedEntry;
  return path.resolve(moduleDir, "../../../account-launcher/src/launcher.ts");
};

// The launcher package.json is the single source of truth for the installed
// launcher version; a hardcoded constant here would silently drift.
const readLauncherVersion = async (launcherEntry: string): Promise<string> => {
  const packageJsonPath = path.resolve(path.dirname(launcherEntry), "..", "package.json");
  const parsed = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`No version field in ${packageJsonPath}.`);
  }
  return parsed.version;
};

// Single-quote a path for /bin/sh so spaces or metacharacters in the
// account root or checkout path cannot break out of the shim command.
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export interface CliIntegrationInput {
  readonly root: string;
  readonly launcherEntry?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

// The bundled launcher artifact runs under Node; only the TypeScript source
// entry from a checkout needs Bun.
const launcherRuntime = (launcherEntry: string): string =>
  launcherEntry.endsWith(".ts") ? "bun" : "node";

const shimScript = (shimName: string, launcherEntry: string): string =>
  [
    "#!/bin/sh",
    "# Synara provider shim (installed by Synara CLI integration).",
    `${SYNARA_LAUNCHER_SHIM}=${shimName} exec ${launcherRuntime(launcherEntry)} ${shellQuote(launcherEntry)} "$@"`,
    "",
  ].join("\n");

export type CliIntegrationShape = ReturnType<typeof makeCliIntegration>;

export function makeCliIntegration(input: CliIntegrationInput) {
  const { root } = input;
  const launcherEntry = input.launcherEntry ?? defaultLauncherEntry();
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const shimDir = path.join(root, "bin");

  const tryFs = <A>(operation: string, detail: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new CliIntegrationError({ operation, detail, cause }),
    });

  const shimNames = [...Object.values(providerShimCommands)];

  const isShimDirOnPath = (): boolean => {
    const pathValue = env.PATH ?? "";
    return pathValue.split(path.delimiter).some((entry) => {
      if (entry.length === 0) return false;
      return path.resolve(entry) === path.resolve(shimDir);
    });
  };

  const getStatus: Effect.Effect<ProviderAccountsIntegrationStatus, CliIntegrationError> = tryFs(
    "cliIntegration.getStatus",
    "Failed to inspect the CLI integration state.",
    async () => {
      const installed = await Promise.all(
        shimNames.map(async (name) => {
          try {
            await fs.access(path.join(shimDir, name), fs.constants.X_OK);
            return true;
          } catch {
            return false;
          }
        }),
      );
      const allInstalled = installed.every((flag) => flag);
      let launcherVersion: string | undefined;
      try {
        launcherVersion = (await fs.readFile(path.join(shimDir, VERSION_FILE), "utf8")).trim();
      } catch {
        launcherVersion = undefined;
      }
      let launcherEntryExists = true;
      try {
        await fs.access(launcherEntry);
      } catch {
        launcherEntryExists = false;
      }
      return {
        cliIntegrationEnabled: allInstalled,
        launcherInstalled: allInstalled,
        ...(launcherVersion !== undefined && launcherVersion.length > 0 ? { launcherVersion } : {}),
        shimDir,
        shimDirOnPath: isShimDirOnPath(),
        launcherEntryExists,
        platformSupported: platform !== "win32",
      } satisfies ProviderAccountsIntegrationStatus;
    },
  );

  const install = Effect.gen(function* () {
    if (platform === "win32") {
      return yield* new CliIntegrationError({
        operation: "cliIntegration.install",
        detail: "CLI integration is not supported on Windows yet.",
      });
    }
    yield* tryFs(
      "cliIntegration.install",
      `Failed to install provider shims into ${shimDir}.`,
      async () => {
        try {
          await fs.access(launcherEntry);
        } catch {
          throw new Error(`Launcher entry point not found at ${launcherEntry}.`);
        }
        const launcherVersion = await readLauncherVersion(launcherEntry);
        await fs.mkdir(shimDir, { recursive: true, mode: 0o755 });
        for (const name of shimNames) {
          const shimPath = path.join(shimDir, name);
          await fs.writeFile(shimPath, shimScript(name, launcherEntry), { mode: 0o755 });
          await fs.chmod(shimPath, 0o755);
        }
        await fs.writeFile(path.join(shimDir, VERSION_FILE), `${launcherVersion}\n`, {
          mode: 0o644,
        });
      },
    );
    return yield* getStatus;
  });

  const uninstall = Effect.gen(function* () {
    yield* tryFs(
      "cliIntegration.uninstall",
      `Failed to remove provider shims from ${shimDir}.`,
      async () => {
        for (const name of [...shimNames, VERSION_FILE]) {
          await fs.rm(path.join(shimDir, name), { force: true });
        }
        await fs.rmdir(shimDir).catch(() => undefined);
      },
    );
    return yield* getStatus;
  });

  const update = (enabled: boolean) => (enabled ? install : uninstall);

  // Shims must shadow the real provider binaries: any shim whose command
  // resolves to another PATH directory first is reported so the doctor can
  // flag it.
  const listShadowedShims = tryFs(
    "cliIntegration.listShadowedShims",
    "Failed to inspect shim PATH precedence.",
    async () => {
      const searchDirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
      const shadowed: Array<string> = [];
      for (const name of shimNames) {
        for (const dir of searchDirs) {
          try {
            await fs.access(path.join(dir, name), fs.constants.X_OK);
          } catch {
            continue;
          }
          if (path.resolve(dir) !== path.resolve(shimDir)) shadowed.push(name);
          break;
        }
      }
      return shadowed;
    },
  );

  return {
    shimDir,
    launcherEntry,
    getStatus,
    install,
    uninstall,
    update,
    isShimDirOnPath,
    listShadowedShims,
  };
}
