// FILE: sshRemoteProbe.ts
// Purpose: Turn the raw result of running `<agent> --version` on a remote host into the one
//          thing the user has to fix. Every failure below is otherwise indistinguishable at
//          session start, where they all look like "the session produced no first turn".
// Layer: Shared domain helper (pure; the caller owns the process)
// Exports: probe plan construction and result classification

import type { ProjectRemote, ProjectProbeRemoteResult } from "@synara/contracts";

import { buildSshRemoteSpawn, type SshRemoteSpawn } from "./sshRemote";

/** ssh's own "could not run anything at all" exit code. */
const SSH_CONNECTION_FAILURE_EXIT_CODE = 255;
/** POSIX shells report an unfound command this way; `cd` failures surface as 1 or 2. */
const SHELL_COMMAND_NOT_FOUND_EXIT_CODE = 127;

export const DEFAULT_PROBE_BINARY_NAME = "claude";

/** Bounded: an unreachable host must fail fast rather than hold the dialog open. */
export const REMOTE_PROBE_TIMEOUT_MS = 20_000;

/**
 * The probe deliberately runs the *rendered* session command rather than a simplified
 * `ssh host true`: the launcher, the ssh options, the working directory, and the quoting are
 * exactly what a real session uses, so a probe that passes cannot be passing for a different
 * command than the one that will run.
 */
export function buildRemoteProbeSpawn(input: {
  readonly remote: ProjectRemote;
  readonly workspaceRoot: string;
  readonly binaryName?: string | undefined;
}): SshRemoteSpawn {
  return buildSshRemoteSpawn({
    remote: input.remote,
    command: input.remote.binaryPath ?? input.binaryName ?? DEFAULT_PROBE_BINARY_NAME,
    args: ["--version"],
    cwd: input.workspaceRoot,
    shellInit: input.remote.shellInit,
  });
}

export interface RemoteProbeOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the probe was killed for exceeding its own deadline. */
  readonly timedOut?: boolean | undefined;
}

function firstNonEmptyLine(value: string): string | null {
  return (
    value
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? null
  );
}

function looksLikeMissingDirectory(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("no such file or directory") || normalized.includes("not a directory");
}

function looksLikeMissingCommand(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("command not found") ||
    normalized.includes("not found") ||
    normalized.includes("no such file or directory")
  );
}

/**
 * A version line is the only stdout the agent should produce here. Anything printed before
 * it came from the user's shell — and would be interleaved into the agent protocol on a real
 * session, where it corrupts the stream instead of merely looking untidy.
 */
function splitShellNoise(stdout: string): {
  readonly noise: string | null;
  readonly version: string | null;
} {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const versionIndex = lines.findIndex((line) => /\d+\.\d+/.test(line));
  if (versionIndex < 0) {
    return { noise: lines.length > 0 ? lines.join("\n") : null, version: null };
  }
  const noise = lines.slice(0, versionIndex);
  return {
    noise: noise.length > 0 ? noise.join("\n") : null,
    version: lines[versionIndex]?.trim() ?? null,
  };
}

export interface ClassifyRemoteProbeInput extends RemoteProbeOutcome {
  readonly remote: ProjectRemote;
  readonly workspaceRoot: string;
  readonly binaryName: string;
  /** Result of the login-shell retry, when the first attempt could not find the binary. */
  readonly loginShellRetry?: RemoteProbeOutcome | undefined;
}

export function classifyRemoteProbe(input: ClassifyRemoteProbeInput): ProjectProbeRemoteResult {
  const stderr = input.stderr.trim();
  const stdout = input.stdout.trim();

  if (input.timedOut) {
    return {
      status: "unreachable",
      summary: `${input.remote.host} did not answer within ${Math.round(REMOTE_PROBE_TIMEOUT_MS / 1000)}s.`,
      detail: stderr || null,
      version: null,
      suggestedLauncher: null,
    };
  }

  // ssh reports its own failures with 255 and never runs the command, so authentication,
  // DNS, and network problems are separated from anything the host said.
  if (input.exitCode === SSH_CONNECTION_FAILURE_EXIT_CODE || input.exitCode === null) {
    return {
      status: "unreachable",
      summary: `Could not open an ssh session to ${input.remote.host}.`,
      detail: stderr || null,
      version: null,
      suggestedLauncher: null,
    };
  }

  if (input.exitCode !== 0) {
    // `cd` runs before the agent, so a missing workspace root is reported first and is
    // distinguishable from a missing binary even though both are "no such file".
    if (looksLikeMissingDirectory(stderr) && stderr.includes(input.workspaceRoot)) {
      return {
        status: "missing-path",
        summary: `${input.workspaceRoot} does not exist on ${input.remote.host}.`,
        detail: stderr || null,
        version: null,
        suggestedLauncher: null,
      };
    }

    if (input.exitCode === SHELL_COMMAND_NOT_FOUND_EXIT_CODE || looksLikeMissingCommand(stderr)) {
      // A login shell sources the profile, which is where version managers (nvm, mise, asdf,
      // rbenv, Herd) put the binary. If that is all that was missing, say so concretely
      // instead of leaving the user to work out which launcher to choose.
      const retry = input.loginShellRetry;
      if (retry && retry.exitCode === 0) {
        const { version } = splitShellNoise(retry.stdout);
        return {
          status: "ok",
          summary: `${input.binaryName} is only on the PATH of a login shell — switched "Run the agent through" to a login shell.`,
          detail: null,
          version,
          suggestedLauncher: { kind: "login-shell", shell: null },
        };
      }
      return {
        status: "missing-binary",
        summary: `${input.binaryName} is not on the PATH ${input.remote.host} uses for this connection.`,
        detail: stderr || null,
        version: null,
        suggestedLauncher: null,
      };
    }

    return {
      status: "unreachable",
      summary: `${input.remote.host} rejected the command (exit ${input.exitCode}).`,
      detail: stderr || firstNonEmptyLine(stdout),
      version: null,
      suggestedLauncher: null,
    };
  }

  const { noise, version } = splitShellNoise(stdout);
  if (noise) {
    return {
      status: "noisy-shell",
      summary: `${input.remote.host} prints output before the agent starts, which corrupts the session stream. Move it behind an interactive-shell guard.`,
      detail: noise,
      version,
      suggestedLauncher: null,
    };
  }

  return {
    status: "ok",
    summary: version
      ? `${input.binaryName} ${version} is ready in ${input.workspaceRoot}.`
      : `${input.binaryName} is ready in ${input.workspaceRoot}.`,
    detail: null,
    version,
    suggestedLauncher: null,
  };
}
