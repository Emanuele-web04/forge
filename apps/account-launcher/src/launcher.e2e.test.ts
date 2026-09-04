import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import {
  accountAgentHome,
  accountJsonPath,
  accountSecretPath,
  activePointerPath,
  secretsDir,
} from "@synara/shared/providerAccounts/accountPaths";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LAUNCHER_ENTRY = resolve(import.meta.dirname, "launcher.ts");

const bunDir = () => {
  const bunPath = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();
  expect(bunPath.length).toBeGreaterThan(0);
  return dirname(bunPath);
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

/** Installs a `codex` shim into <root>/bin the way the CLI integration does. */
const installShim = (root: string) => {
  const shimDir = join(root, "bin");
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(
    join(shimDir, "codex"),
    `#!/bin/sh\nSYNARA_LAUNCHER_SHIM=codex exec bun "${LAUNCHER_ENTRY}" "$@"\n`,
    { mode: 0o755 },
  );
  return shimDir;
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
      'echo "SYNARA_ACCOUNT_HOME=${SYNARA_ACCOUNT_HOME:-unset}"',
      'echo "SYNARA_LAUNCHER_BYPASS=${SYNARA_LAUNCHER_BYPASS:-unset}"',
      'echo "SYNARA_LAUNCHER_SHIM=${SYNARA_LAUNCHER_SHIM:-unset}"',
      'echo "ARGS=$*"',
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeBinDir;
};

describe("standalone launcher end to end", () => {
  let root: string;
  let shimDir: string;
  let fakeBinDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "synara-launcher-e2e-"));
    shimDir = installShim(root);
    fakeBinDir = installFakeCodex(root);
    writeCodexAccount(root, 1, "sk-launcher-1");
    writeCodexAccount(root, 2, "sk-launcher-2");
    mkdirSync(join(root, "active"), { recursive: true });
    writeFileSync(activePointerPath(root, "codex"), "2");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const pathWithShims = () => [shimDir, fakeBinDir, bunDir(), "/usr/bin", "/bin"].join(delimiter);

  it("runs the codex shim with the active account's home and key", () => {
    const result = spawnSync(join(shimDir, "codex"), ["--flag", "value"], {
      encoding: "utf8",
      env: {
        PATH: pathWithShims(),
        SYNARA_ACCOUNT_HOME: root,
        OPENAI_API_KEY: "native-key",
      },
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`CODEX_HOME=${accountAgentHome(root, "codex", 2)}`);
    expect(result.stdout).toContain("OPENAI_API_KEY=sk-launcher-2");
    // The account root is inherited; launcher control variables are stripped.
    expect(result.stdout).toContain(`SYNARA_ACCOUNT_HOME=${root}`);
    expect(result.stdout).toContain("SYNARA_LAUNCHER_BYPASS=unset");
    expect(result.stdout).toContain("SYNARA_LAUNCHER_SHIM=unset");
    expect(result.stdout).toContain("ARGS=--flag value");
  });

  it("selects an explicit ordinal in run mode over the active pointer", () => {
    const result = spawnSync(
      "bun",
      [LAUNCHER_ENTRY, "run", "codex", "--ordinal", "1", "--", "exec"],
      {
        encoding: "utf8",
        env: { PATH: pathWithShims(), SYNARA_ACCOUNT_HOME: root },
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`CODEX_HOME=${accountAgentHome(root, "codex", 1)}`);
    expect(result.stdout).toContain("OPENAI_API_KEY=sk-launcher-1");
    expect(result.stdout).toContain("ARGS=exec");
  });

  it("bypass mode launches the native binary untouched and strips control variables", () => {
    const result = spawnSync(join(shimDir, "codex"), [], {
      encoding: "utf8",
      env: {
        PATH: pathWithShims(),
        SYNARA_ACCOUNT_HOME: root,
        SYNARA_LAUNCHER_BYPASS: "1",
        OPENAI_API_KEY: "native-key",
      },
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CODEX_HOME=unset");
    expect(result.stdout).toContain("OPENAI_API_KEY=native-key");
    expect(result.stdout).toContain("SYNARA_LAUNCHER_BYPASS=unset");
    expect(result.stdout).toContain("SYNARA_LAUNCHER_SHIM=unset");
  });

  it("does not recurse into itself when the real binary is missing", () => {
    // PATH exposes only the shim (and bun): the shim is the sole `codex`.
    const result = spawnSync(join(shimDir, "codex"), [], {
      encoding: "utf8",
      env: { PATH: [shimDir, bunDir()].join(delimiter), SYNARA_ACCOUNT_HOME: root },
      timeout: 30_000,
    });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("Could not find the real 'codex' binary on PATH.");
  });

  it("fails closed when the selected account's stored key is missing", () => {
    rmSync(accountSecretPath(root, "codex", 2, "agent"));
    const result = spawnSync(join(shimDir, "codex"), [], {
      encoding: "utf8",
      env: { PATH: pathWithShims(), SYNARA_ACCOUNT_HOME: root },
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing its stored API key");
  });
});
