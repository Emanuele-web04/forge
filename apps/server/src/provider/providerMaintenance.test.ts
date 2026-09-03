import { describe, it, assert } from "@effect/vitest";
import { join } from "node:path";

import { Effect, FileSystem } from "effect";

import {
  createProviderVersionAdvisory,
  deriveNpmGlobalPrefix,
  makeProviderMaintenanceCapabilities,
  parseGenericCliVersion,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
  type PackageManagedProviderMaintenanceDefinition,
} from "./providerMaintenance";

const CODEX_DEFINITION = {
  provider: "codex",
  binaryName: "codex",
  npmPackageName: "@openai/codex",
  homebrew: { name: "codex", kind: "cask" },
  nativeUpdate: null,
} as const satisfies PackageManagedProviderMaintenanceDefinition;

const OPENCODE_DEFINITION = {
  provider: "opencode",
  binaryName: "opencode",
  npmPackageName: "opencode-ai",
  homebrew: { name: "anomalyco/tap/opencode", kind: "formula" },
  latestVersionSource: { kind: "npm", name: "opencode-ai" },
  nativeUpdate: {
    executable: "opencode",
    args: (installSource) =>
      installSource === "unknown" || installSource === "native"
        ? ["upgrade"]
        : ["upgrade", "--method", installSource],
    lockKey: "opencode-native",
    strategy: "always",
    excludedInstallSources: ["homebrew"],
  },
} as const satisfies PackageManagedProviderMaintenanceDefinition;

const CLAUDE_DEFINITION = {
  provider: "claudeAgent",
  binaryName: "claude",
  npmPackageName: "@anthropic-ai/claude-code",
  homebrew: {
    name: "claude-code",
    kind: "cask",
    variants: [
      {
        name: "claude-code@latest",
        kind: "cask",
        isCommandPath: (commandPath: string) =>
          commandPath.toLowerCase().includes("/caskroom/claude-code@latest/"),
      },
    ],
  },
  nativeUpdate: {
    executable: "claude",
    args: () => ["update"],
    lockKey: "claude-native",
    strategy: "matching-path",
    latestVersionSource: null,
    isCommandPath: (commandPath: string) =>
      commandPath.toLowerCase().includes("/.local/share/claude/"),
  },
} as const satisfies PackageManagedProviderMaintenanceDefinition;

/** The trailing name of a probed path, whichever separator the host joined it with. */
function fileNameOf(probedPath: string): string {
  return probedPath.slice(Math.max(probedPath.lastIndexOf("/"), probedPath.lastIndexOf("\\")) + 1);
}

describe("providerMaintenance", () => {
  it("parses generic CLI versions", () => {
    assert.strictEqual(parseGenericCliVersion("codex-cli 0.130.0\n"), "0.130.0");
    assert.strictEqual(parseGenericCliVersion("claude 2.1\n"), "2.1.0");
    assert.strictEqual(parseGenericCliVersion("no version here"), null);
  });

  it("resolves npm global update commands for unqualified binaries", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "codex",
      realCommandPath: "/Users/test/.npm-global/lib/node_modules/@openai/codex/bin/codex",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "npm install -g --prefix /Users/test/.npm-global @openai/codex@latest",
      executable: "npm",
      args: ["install", "-g", "--prefix", "/Users/test/.npm-global", "@openai/codex@latest"],
      lockKey: "npm-global",
    });
  });

  it("pins the npm global prefix that owns the detected binary", () => {
    // npm's global prefix follows the node that runs it, so without --prefix a
    // second node install (e.g. nvm) would receive the update while Synara
    // keeps checking the copy it originally detected.
    assert.strictEqual(
      deriveNpmGlobalPrefix("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"),
      "/opt/homebrew",
    );
    assert.strictEqual(
      deriveNpmGlobalPrefix(
        "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      ),
      "C:\\Users\\Test User\\AppData\\Roaming\\npm",
    );
    // Project-local node_modules paths are not global installs; no prefix.
    assert.strictEqual(deriveNpmGlobalPrefix("/repo/node_modules/.bin/codex"), null);
  });

  it("quotes update command arguments containing spaces", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "codex",
      realCommandPath:
        "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    });

    assert.strictEqual(
      capabilities.update?.command,
      'npm install -g --prefix "C:\\Users\\Test User\\AppData\\Roaming\\npm" @openai/codex@latest',
    );
  });

  it("does not guess an update command for unclassified binaries", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "/custom/bin/codex",
      realCommandPath: "/custom/bin/codex",
    });

    assert.strictEqual(capabilities.update, null);
  });

  it("resolves Homebrew cask update commands", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "/opt/homebrew/bin/codex",
      realCommandPath: "/opt/homebrew/Caskroom/codex/0.130.0/codex",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "brew upgrade --cask codex",
      executable: "brew",
      args: ["upgrade", "--cask", "codex"],
      lockKey: "homebrew",
    });
    assert.strictEqual(capabilities.packageName, null);
  });

  it("keeps native provider update truth with the provider when explicitly configured", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CLAUDE_DEFINITION, {
      binaryPath: "claude",
      realCommandPath: "/Users/test/.local/share/claude/versions/2.1.100/claude",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "claude update",
      executable: "claude",
      args: ["update"],
      lockKey: "claude-native",
    });
    assert.strictEqual(capabilities.latestVersionSource, null);
  });

  it("resolves alternate Homebrew casks from the installed command path", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CLAUDE_DEFINITION, {
      binaryPath: "/opt/homebrew/bin/claude",
      realCommandPath: "/opt/homebrew/Caskroom/claude-code@latest/2.1.100/claude",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "brew upgrade --cask claude-code@latest",
      executable: "brew",
      args: ["upgrade", "--cask", "claude-code@latest"],
      lockKey: "homebrew",
    });
    assert.deepStrictEqual(capabilities.latestVersionSource, {
      kind: "homebrew",
      name: "claude-code@latest",
      homebrewKind: "cask",
    });
  });

  it("uses provider-native update commands with detected install method", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      binaryPath: "opencode",
      realCommandPath: "/Users/test/.local/share/pnpm/opencode",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "opencode upgrade --method pnpm",
      executable: "opencode",
      args: ["upgrade", "--method", "pnpm"],
      lockKey: "opencode-native",
    });
    assert.deepStrictEqual(capabilities.latestVersionSource, {
      kind: "npm",
      name: "opencode-ai",
    });
  });

  it("uses Homebrew updates but keeps npm latest metadata for tapped OpenCode installs", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      binaryPath: "opencode",
      realCommandPath: "/opt/homebrew/Cellar/opencode/1.14.46/bin/opencode",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "brew upgrade anomalyco/tap/opencode",
      executable: "brew",
      args: ["upgrade", "anomalyco/tap/opencode"],
      lockKey: "homebrew",
    });
    assert.deepStrictEqual(capabilities.latestVersionSource, {
      kind: "npm",
      name: "opencode-ai",
    });
  });

  describe("resolveProviderMaintenanceCapabilitiesEffect", () => {
    function runWithVirtualFileSystem(
      presentPaths: ReadonlySet<string>,
      options: Parameters<typeof resolveProviderMaintenanceCapabilitiesEffect>[1],
    ) {
      const probed: string[] = [];
      const layer = FileSystem.layerNoop({
        exists: (probedPath: string) =>
          Effect.sync(() => {
            probed.push(probedPath);
            return presentPaths.has(probedPath);
          }),
        realPath: (probedPath: string) => Effect.succeed(probedPath),
      });
      return Effect.runPromise(
        resolveProviderMaintenanceCapabilitiesEffect(CODEX_DEFINITION, options).pipe(
          Effect.provide(layer),
          Effect.map((capabilities) => ({ capabilities, probed })),
        ),
      );
    }

    it("walks PATH in order and reports the first directory that holds the binary", async () => {
      const { capabilities, probed } = await runWithVirtualFileSystem(
        new Set([join("/second", "codex")]),
        {
          binaryPath: "codex",
          platform: "darwin",
          env: { PATH: "/first:/second:/third" },
        },
      );

      assert.deepStrictEqual(probed, [join("/first", "codex"), join("/second", "codex")]);
      // Resolution stops at the hit, so /third is never touched, and the detected directory is
      // the PATH entry rather than anything derived from the command name.
      assert.strictEqual(capabilities.update, null);
    });

    it("tries the extensionless name before PATHEXT variants on Windows", async () => {
      const { probed } = await runWithVirtualFileSystem(new Set(), {
        binaryPath: "codex",
        platform: "win32",
        env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" },
      });

      // An installation can be an extensionless file that nothing could spawn directly; this
      // resolver is reporting on what is installed, not picking something to run.
      // Candidates are joined with the host separator, so compare file names rather than paths.
      assert.deepStrictEqual(probed.map(fileNameOf), [
        "codex",
        "codex.EXE",
        "codex.exe",
        "codex.CMD",
        "codex.cmd",
      ]);
    });

    it("prefers .BAT over .CMD, matching Windows' own PATHEXT precedence", async () => {
      // The list this replaced was ["", ".exe", ".cmd", ".bat"], which resolved this pair the
      // wrong way round whenever both shims existed.
      const { probed } = await runWithVirtualFileSystem(new Set(), {
        binaryPath: "codex",
        platform: "win32",
        env: { PATH: "C:\\bin" },
      });

      const batIndex = probed.findIndex((entry) => entry.endsWith("codex.BAT"));
      const cmdIndex = probed.findIndex((entry) => entry.endsWith("codex.CMD"));
      assert.ok(batIndex >= 0 && cmdIndex >= 0);
      assert.ok(batIndex < cmdIndex);
    });

    it("does not search PATH when a binary path already names a location", async () => {
      const { probed } = await runWithVirtualFileSystem(new Set(), {
        binaryPath: "/opt/homebrew/bin/codex",
        platform: "darwin",
        env: { PATH: "/first" },
      });

      assert.deepStrictEqual(probed, []);
    });

    it("resolves explicit Homebrew symlinks before selecting a cask variant", async () => {
      const layer = FileSystem.layerNoop({
        realPath: () => Effect.succeed("/opt/homebrew/Caskroom/claude-code@latest/2.1.100/claude"),
      });

      const capabilities = await Effect.runPromise(
        resolveProviderMaintenanceCapabilitiesEffect(CLAUDE_DEFINITION, {
          binaryPath: "/opt/homebrew/bin/claude",
          platform: "darwin",
        }).pipe(Effect.provide(layer)),
      );

      assert.deepStrictEqual(capabilities.update, {
        command: "brew upgrade --cask claude-code@latest",
        executable: "brew",
        args: ["upgrade", "--cask", "claude-code@latest"],
        lockKey: "homebrew",
      });
      assert.deepStrictEqual(capabilities.latestVersionSource, {
        kind: "homebrew",
        name: "claude-code@latest",
        homebrewKind: "cask",
      });
    });

    it("probes the native POSIX defaults when the supplied environment has no PATH", async () => {
      // Do not fall back to process.env: Node itself uses /usr/bin:/bin when PATH is absent.
      const { probed } = await runWithVirtualFileSystem(new Set(), {
        binaryPath: "codex",
        platform: "darwin",
        env: { HOME: "/home/test" },
      });

      assert.deepStrictEqual(probed, ["/usr/bin/codex", "/bin/codex"]);
    });
  });

  it("marks older semver versions as behind latest", () => {
    const advisory = createProviderVersionAdvisory({
      provider: "codex",
      currentVersion: "0.129.0",
      latestVersion: "0.130.0",
    });

    assert.strictEqual(advisory.status, "behind_latest");
    assert.strictEqual(advisory.currentVersion, "0.129.0");
    assert.strictEqual(advisory.latestVersion, "0.130.0");
    assert.strictEqual(advisory.latestVersionKnowable, true);
  });

  it("reports an unknowable latest version for self-updating providers", () => {
    // `cursor-agent update` exists, but no registry publishes its version, so the
    // advisory can never reach "current" — callers must not read that as "outdated".
    const advisory = createProviderVersionAdvisory({
      provider: "cursor",
      currentVersion: "2026.07.09-c59fd9a",
      maintenanceCapabilities: makeProviderMaintenanceCapabilities({
        provider: "cursor",
        packageName: null,
        updateExecutable: "cursor-agent",
        updateArgs: ["update"],
        updateLockKey: "cursor-agent",
      }),
    });

    assert.strictEqual(advisory.status, "unknown");
    assert.strictEqual(advisory.latestVersion, null);
    assert.strictEqual(advisory.latestVersionKnowable, false);
    assert.strictEqual(advisory.canUpdate, true);
  });
});
