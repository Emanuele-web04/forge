#!/usr/bin/env node
// Entry point for `synara-account-launcher`. Standalone: no Electron, no
// WebSocket, no server, no database. Prints nothing on success; errors go to
// stderr with an exit code.

import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { resolveAccountRoot } from "@synara/shared/providerAccounts/accountPaths";
import {
  isLauncherBypass,
  providerShimCommands,
} from "@synara/shared/providerAccounts/launcherProtocol";

import {
  AccountLaunchError,
  buildChildEnvironment,
  resolveLaunchEnvironment,
} from "./accountResolution.ts";
import { LauncherUsageError, parseLauncherInvocation } from "./cli.ts";
import { resolveRealBinary } from "./binaryResolution.ts";

function fail(message: string, exitCode: number): never {
  process.stderr.write(`synara-account-launcher: ${message}\n`);
  process.exit(exitCode);
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv): never {
  let invocation;
  try {
    invocation = parseLauncherInvocation(argv, env);
  } catch (error) {
    if (error instanceof LauncherUsageError) fail(error.message, 2);
    throw error;
  }
  const command = providerShimCommands[invocation.provider];

  // Installed shims live in <account-root>/bin; that directory must never
  // resolve as the "real" binary (shims copied elsewhere are caught by the
  // shim-signature check inside resolveRealBinary).
  const installedShimDir = path.join(resolveAccountRoot({ env }), "bin");
  const binary = resolveRealBinary({
    command,
    pathEnv: env.PATH,
    shimDir: installedShimDir,
  });
  if (binary === null) {
    fail(`Could not find the real '${command}' binary on PATH.`, 127);
  }

  // Synara-internal launches run the native binary untouched. Control
  // variables still never reach the child.
  let overrides: Readonly<Record<string, string>> = {};
  if (!isLauncherBypass(env)) {
    try {
      overrides = resolveLaunchEnvironment({
        root: resolveAccountRoot({ env }),
        provider: invocation.provider,
        ...(invocation.explicitOrdinal !== undefined
          ? { explicitOrdinal: invocation.explicitOrdinal }
          : {}),
        env,
      }).overrides;
    } catch (error) {
      if (error instanceof AccountLaunchError) fail(error.message, 1);
      throw error;
    }
  }

  const childEnv = buildChildEnvironment(env, overrides);

  // Node cannot execvp; spawnSync with inherited stdio keeps the provider in
  // the foreground process group so terminal signals and exit codes behave
  // natively.
  const result = spawnSync(binary, [...invocation.providerArgs], {
    stdio: "inherit",
    env: childEnv,
  });
  if (result.error !== undefined)
    fail(`Failed to launch '${binary}': ${result.error.message}`, 126);
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status ?? 1);
}

main(process.argv.slice(2), process.env);
