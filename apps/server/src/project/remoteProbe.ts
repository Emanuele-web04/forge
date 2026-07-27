// FILE: remoteProbe.ts
// Purpose: Runs one bounded ssh round-trip against a project's remote target so the
//          configuration dialog can answer "will this work?" before a project exists.
// Layer: Server project utility
// Exports: probeProjectRemote

import type { ProjectProbeRemoteInput, ProjectProbeRemoteResult } from "@synara/contracts";
import { buildLocalSshProcessEnv } from "@synara/shared/sshRemote";
import {
  buildRemoteProbeSpawn,
  classifyRemoteProbe,
  DEFAULT_PROBE_BINARY_NAME,
  REMOTE_PROBE_TIMEOUT_MS,
  type RemoteProbeOutcome,
} from "@synara/shared/sshRemoteProbe";

import { runProcess } from "../processRunner.ts";

/**
 * ssh is asked not to prompt: the probe has no terminal, so a host that wants a password or
 * an unknown-key confirmation would otherwise hang until the timeout instead of reporting
 * what it wanted. A real session keeps the interactive behaviour — this restriction exists
 * only so the dialog gets an answer.
 */
const PROBE_ONLY_SSH_OPTIONS: ReadonlyArray<string> = ["-o", "BatchMode=yes"];

async function runProbe(
  spawn: { readonly command: string; readonly args: ReadonlyArray<string> },
  env: NodeJS.ProcessEnv,
): Promise<RemoteProbeOutcome> {
  const result = await runProcess(spawn.command, [...PROBE_ONLY_SSH_OPTIONS, ...spawn.args], {
    env,
    timeoutMs: REMOTE_PROBE_TIMEOUT_MS,
    allowNonZeroExit: true,
    outputMode: "truncate",
  });
  return {
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

export async function probeProjectRemote(
  input: ProjectProbeRemoteInput,
): Promise<ProjectProbeRemoteResult> {
  const binaryName = input.remote.binaryPath ?? input.binaryName ?? DEFAULT_PROBE_BINARY_NAME;
  const env = buildLocalSshProcessEnv(process.env);
  const outcome = await runProbe(
    buildRemoteProbeSpawn({
      remote: input.remote,
      workspaceRoot: input.workspaceRoot,
      ...(input.binaryName ? { binaryName: input.binaryName } : {}),
    }),
    env,
  );

  // Only one failure is worth a second round-trip: a binary that a plain ssh command cannot
  // see is usually one a login shell can, and knowing which of the two it is turns an error
  // into a setting the dialog can apply on the user's behalf.
  const shouldRetryThroughLoginShell =
    outcome.exitCode !== 0 &&
    !outcome.timedOut &&
    input.remote.launcher?.kind !== "login-shell" &&
    !/no such file or directory/i.test(outcome.stderr.replace(input.workspaceRoot, ""));

  const loginShellRetry = shouldRetryThroughLoginShell
    ? await runProbe(
        buildRemoteProbeSpawn({
          remote: { ...input.remote, launcher: { kind: "login-shell", shell: null } },
          workspaceRoot: input.workspaceRoot,
          ...(input.binaryName ? { binaryName: input.binaryName } : {}),
        }),
        env,
      )
    : undefined;

  return classifyRemoteProbe({
    ...outcome,
    remote: input.remote,
    workspaceRoot: input.workspaceRoot,
    binaryName,
    ...(loginShellRetry ? { loginShellRetry } : {}),
  });
}
