// FILE: device-helper-sweep.ts
// Purpose: Run the device helper smoke check against every locally installed Xcode.
// Layer: Release/CI smoke check (macOS only; not part of normal CI).
// Depends on: scripts/device-helper-smoke.ts.
//
// The helper dlopen's private CoreSimulator/SimulatorKit symbols, which move
// between Xcode releases. Testing against the one toolchain a developer happens
// to have selected is how a broken symbol reaches users; this sweeps every
// Xcode on the machine by pointing DEVELOPER_DIR at each in turn.
//
// Probe-only by default: compile plus preflight is the symbol tripwire and
// needs no simulator runtime. Pass --full to boot a simulator per toolchain.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deviceHelperCacheKey } from "@synara/shared/deviceHelperCache";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeScript = join(repoRoot, "scripts/device-helper-smoke.ts");

interface Toolchain {
  readonly developerDir: string;
  /** `26.2-17C52`, or the developer dir when the version cannot be read. */
  readonly label: string;
}

interface SweepResult {
  readonly label: string;
  readonly developerDir: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly durationMs: number;
}

function log(message: string): void {
  console.log(`[device-sweep] ${message}`);
}

/**
 * Every Xcode this machine can build against.
 *
 * `/Applications/Xcode*.app` is the conventional install location and covers
 * the common case of several versions side by side. `xcodes installed` is
 * consulted when present because it is the usual way people keep more than one
 * Xcode around, and it can report installs outside /Applications.
 */
function discoverToolchains(): Toolchain[] {
  const developerDirs = new Set<string>();

  for (const entry of readdirSync("/Applications")) {
    if (!entry.startsWith("Xcode") || !entry.endsWith(".app")) continue;
    const developerDir = join("/Applications", entry, "Contents/Developer");
    if (existsSync(developerDir)) developerDirs.add(developerDir);
  }

  try {
    const listed = execFileSync("xcodes", ["installed"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of listed.split("\n")) {
      // Lines look like: `26.2 (17C52)  /Applications/Xcode.app`
      const match = /(\/.*\.app)\s*$/u.exec(line.trim());
      if (!match) continue;
      const developerDir = join(match[1]!, "Contents/Developer");
      if (existsSync(developerDir)) developerDirs.add(developerDir);
    }
  } catch {
    // No xcodes CLI, or it failed: the /Applications scan already covers the
    // standard layout, so this is not worth reporting as an error.
  }

  return [...developerDirs].sort().map((developerDir) => ({
    developerDir,
    label: readToolchainLabel(developerDir) ?? developerDir,
  }));
}

function readToolchainLabel(developerDir: string): string | null {
  try {
    const version = execFileSync("xcodebuild", ["-version"], {
      encoding: "utf8",
      env: { ...process.env, DEVELOPER_DIR: developerDir },
      stdio: ["ignore", "pipe", "ignore"],
    });
    return deviceHelperCacheKey(version);
  } catch {
    return null;
  }
}

function runSmoke(toolchain: Toolchain, probeOnly: boolean): SweepResult {
  const started = Date.now();
  const args = [smokeScript, ...(probeOnly ? ["--probe-only"] : [])];
  const result = spawnSync("bun", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DEVELOPER_DIR: toolchain.developerDir },
    // Inherited so a long full run shows progress instead of going silent; the
    // per-toolchain verdict comes from the exit status rather than the output.
    stdio: ["ignore", "inherit", "inherit"],
    timeout: probeOnly ? 10 * 60_000 : 30 * 60_000,
  });
  const durationMs = Date.now() - started;
  if (result.error) {
    return {
      ...toolchain,
      ok: false,
      detail: result.error.message,
      durationMs,
    };
  }
  return {
    ...toolchain,
    ok: result.status === 0,
    detail: result.status === 0 ? "pass" : `exit ${result.status ?? "signal"}`,
    durationMs,
  };
}

function printTable(results: readonly SweepResult[]): void {
  const labelWidth = Math.max(9, ...results.map((entry) => entry.label.length));
  const detailWidth = Math.max(6, ...results.map((entry) => entry.detail.length));
  const header = `${"toolchain".padEnd(labelWidth)}  ${"result".padEnd(6)}  ${"detail".padEnd(detailWidth)}  time`;
  console.log(`\n${header}`);
  console.log("-".repeat(header.length));
  for (const entry of results) {
    console.log(
      `${entry.label.padEnd(labelWidth)}  ${(entry.ok ? "PASS" : "FAIL").padEnd(6)}  ` +
        `${entry.detail.padEnd(detailWidth)}  ${(entry.durationMs / 1000).toFixed(1)}s`,
    );
  }
}

function main(): void {
  if (process.platform !== "darwin") {
    console.error("[device-sweep] the device helper is macOS only");
    process.exit(1);
  }

  const probeOnly = !process.argv.includes("--full");
  const toolchains = discoverToolchains();
  if (toolchains.length === 0) {
    console.error("[device-sweep] no Xcode installs found under /Applications");
    process.exit(1);
  }

  log(
    `${toolchains.length} toolchain(s), mode=${probeOnly ? "probe-only" : "full smoke"}` +
      `${probeOnly ? " (pass --full to boot a simulator per toolchain)" : ""}`,
  );

  const results: SweepResult[] = [];
  for (const toolchain of toolchains) {
    log(`--- ${toolchain.label} (${toolchain.developerDir}) ---`);
    results.push(runSmoke(toolchain, probeOnly));
  }

  printTable(results);

  const failed = results.filter((entry) => !entry.ok);
  if (failed.length > 0) {
    console.error(
      `\n[device-sweep] FAIL: ${failed.length}/${results.length} toolchain(s) broken: ` +
        failed.map((entry) => entry.label).join(", "),
    );
    process.exit(1);
  }
  console.log(`\n[device-sweep] PASS: ${results.length}/${results.length} toolchain(s)`);
}

main();
