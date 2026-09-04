// Installed-artifact smoke test: bundles the account launcher exactly the way
// packaged CLI/desktop builds do, stages it in the packaged layout inside a
// temp directory outside the monorepo checkout, installs real shims through
// the CLI integration, and proves a shim can start without the source tree.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import {
  accountAgentHome,
  accountJsonPath,
  accountSecretPath,
  activePointerPath,
  secretsDir,
} from "@synara/shared/providerAccounts/accountPaths";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeCliIntegration } from "./cliIntegration";

const LAUNCHER_WORKSPACE = resolve(import.meta.dirname, "../../../account-launcher");

const binDirOf = (command: string) => {
  const binaryPath = spawnSync("which", [command], { encoding: "utf8" }).stdout.trim();
  expect(binaryPath.length).toBeGreaterThan(0);
  return dirname(binaryPath);
};

/** Writes a connected API-key codex account directly into the account root. */
const writeCodexAccount = (root: string, ordinal: number, apiKey: string) => {
  mkdirSync(accountAgentHome(root, "codex", ordinal), { recursive: true });
  writeFileSync(
    accountJsonPath(root, "codex", ordinal),
    JSON.stringify({
      schemaVersion: 1,
      provider: "codex",
      ordinal,
      createdAt: "2026-01-01T00:00:00.000Z",
      agent: { generation: 1, state: "connected", authMethod: "apiKey" },
    }),
  );
  mkdirSync(secretsDir(root), { recursive: true });
  writeFileSync(accountSecretPath(root, "codex", ordinal, "agent"), apiKey, { mode: 0o600 });
};

/** A fake `codex` binary that reports the environment it received. */
const installFakeCodex = (root: string) => {
  const fakeBinDir = join(root, "fake-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(
    join(fakeBinDir, "codex"),
    [
      "#!/bin/sh",
      'echo "CODEX_HOME=${CODEX_HOME:-unset}"',
      'echo "OPENAI_API_KEY=${OPENAI_API_KEY:-unset}"',
      'echo "ARGS=$*"',
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeBinDir;
};

describe("packaged launcher artifact", () => {
  let stageRoot: string;
  let launcherEntry: string;
  let accountRoot: string;
  let shimDir: string;
  let fakeBinDir: string;

  beforeAll(() => {
    stageRoot = mkdtempSync(join(tmpdir(), "synara-packaged-launcher-"));

    // Bundle the launcher the same way the CLI build stages it for release.
    const bundleDir = join(stageRoot, "bundle");
    const build = spawnSync("bun", ["tsdown", "-d", bundleDir], {
      cwd: LAUNCHER_WORKSPACE,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(build.status, build.stderr).toBe(0);

    // Packaged layout: dist/account-launcher/{package.json,bin/launcher.mjs}.
    const stagedLauncherDir = join(stageRoot, "app", "account-launcher");
    mkdirSync(join(stagedLauncherDir, "bin"), { recursive: true });
    launcherEntry = join(stagedLauncherDir, "bin", "launcher.mjs");
    writeFileSync(launcherEntry, readFileSync(join(bundleDir, "launcher.mjs")));
    const workspaceVersion = (
      JSON.parse(readFileSync(join(LAUNCHER_WORKSPACE, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    writeFileSync(
      join(stagedLauncherDir, "package.json"),
      JSON.stringify({ name: "@synara/account-launcher", version: workspaceVersion }),
    );

    accountRoot = join(stageRoot, "account-root");
    mkdirSync(accountRoot, { recursive: true });
    shimDir = join(accountRoot, "bin");
    fakeBinDir = installFakeCodex(stageRoot);
    writeCodexAccount(accountRoot, 1, "sk-packaged-1");
    mkdirSync(join(accountRoot, "active"), { recursive: true });
    writeFileSync(activePointerPath(accountRoot, "codex"), "1");
  }, 120_000);

  afterAll(() => {
    rmSync(stageRoot, { recursive: true, force: true });
  });

  it("installs shims that run the bundled launcher under node", async () => {
    const integration = makeCliIntegration({
      root: accountRoot,
      launcherEntry,
      env: { PATH: shimDir },
    });
    const status = await Effect.runPromise(integration.install);
    expect(status.launcherInstalled).toBe(true);
    expect(status.launcherEntryExists).toBe(true);
    const shim = readFileSync(join(shimDir, "codex"), "utf8");
    expect(shim).toContain(`exec node '${launcherEntry}'`);
  });

  it("starts a real shim from outside the monorepo checkout", () => {
    const result = spawnSync(join(shimDir, "codex"), ["exec", "--flag"], {
      cwd: stageRoot,
      encoding: "utf8",
      env: {
        PATH: [shimDir, fakeBinDir, binDirOf("node"), "/usr/bin", "/bin"].join(delimiter),
        SYNARA_ACCOUNT_HOME: accountRoot,
      },
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`CODEX_HOME=${accountAgentHome(accountRoot, "codex", 1)}`);
    expect(result.stdout).toContain("OPENAI_API_KEY=sk-packaged-1");
    expect(result.stdout).toContain("ARGS=exec --flag");
  });
});
