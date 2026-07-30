// FILE: remoteHostProbe.ts
// Purpose: Renders and classifies the structured remote-host probe. The probe runs
//          the EXACT session command with only the turn's arguments swapped for a
//          version check, so a passing probe cannot be passing for a different
//          command than the one that will run.
// Layer: Shared runtime (server + tests)
// Exports: renderRemoteProbeCommand, classifyRemoteProbe, isProbeResultFresh,
//          PROBE_MARKERS, REMOTE_PROBE_DEADLINE_MS

import type {
  RemoteCommandTarget,
  RemoteHostProbeResult,
  RemoteHostConfig,
  RemoteHostUnreachableReason,
  RemoteLauncher,
} from "@synara/contracts";

import {
  buildLauncherArgv,
  buildRemoteScript,
  buildSshArgv,
  PROBE_EXIT_BINARY_MISSING,
  PROBE_EXIT_CWD_MISSING,
  remoteCommandSignature,
  type SshInvocation,
} from "./remoteCommand";

/**
 * Markers are fixed, unlikely strings rather than anything derived from user
 * input, so a path or a version banner can never impersonate one.
 */
export const PROBE_MARKERS = {
  begin: "__SYNARA_PROBE_BEGIN__",
  cwdMissing: "__SYNARA_PROBE_CWD_MISSING__",
  binaryMissing: "__SYNARA_PROBE_BINARY_MISSING__",
} as const;

/**
 * The probe must always terminate. ssh's ConnectTimeout only bounds the TCP/auth
 * phase — a host that accepts the connection and then stalls (a wedged NFS mount
 * in a login profile, a rc file waiting on input) would otherwise hang forever.
 */
export const REMOTE_PROBE_DEADLINE_MS = 20_000;

/** ConnectTimeout used while probing: shorter than a session's, so a dead host fails fast. */
export const REMOTE_PROBE_CONNECT_TIMEOUT_SECONDS = 8;

export interface RenderRemoteProbeCommandInput {
  readonly config: RemoteHostConfig;
  readonly target: RemoteCommandTarget;
  /** Overrides the host's launcher, used for the login-shell rescue attempt. */
  readonly launcherOverride?: RemoteLauncher | undefined;
  readonly controlDirectory?: string | undefined;
}

export interface RenderedRemoteCommand {
  readonly invocation: SshInvocation;
  readonly signature: string;
  readonly launcher: RemoteLauncher;
}

function renderCommand(
  input: RenderRemoteProbeCommandInput,
  probe: boolean,
): RenderedRemoteCommand {
  const launcher = input.launcherOverride ?? input.config.launcher;
  const script = buildRemoteScript({
    target: input.target,
    shellInit: input.config.shellInit,
    defaultBinary: input.config.binaryPath,
    ...(probe ? { probe: PROBE_MARKERS } : {}),
  });
  const invocation = buildSshArgv({
    config: { ...input.config, launcher },
    remoteArgv: buildLauncherArgv(launcher, script),
    controlDirectory: input.controlDirectory,
    ...(probe ? { connectTimeoutSecondsOverride: REMOTE_PROBE_CONNECT_TIMEOUT_SECONDS } : {}),
  });
  return { invocation, signature: remoteCommandSignature(invocation), launcher };
}

/** The probe form: identical to the session command except for the version args. */
export function renderRemoteProbeCommand(
  input: RenderRemoteProbeCommandInput,
): RenderedRemoteCommand {
  return renderCommand(input, true);
}

/** The real session command. */
export function renderRemoteSessionCommand(
  input: RenderRemoteProbeCommandInput,
): RenderedRemoteCommand {
  return renderCommand(input, false);
}

/**
 * Signature of what a probe VOUCHES for.
 *
 * Deliberately the session command's signature, not the probe command's: the
 * probe exists to certify the session command, and its own deadline/version-args
 * differences must not make the certificate look stale. Everything a user can
 * edit — destination, ssh args, launcher, shell-init, cwd, binary — changes both
 * commands identically, so an edit still discards a stale "ready".
 */
export function remoteProbeSignature(input: RenderRemoteProbeCommandInput): string {
  return renderRemoteSessionCommand(input).signature;
}

// ── Classification ───────────────────────────────────────────────────────────

export interface RemoteProbeExecution {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /** True when our own deadline fired, whatever ssh was doing at the time. */
  readonly timedOut: boolean;
  /** Set when the local ssh binary itself could not be spawned. */
  readonly spawnErrorCode?: string | undefined;
}

/**
 * ssh's own failure vocabulary. Matching is anchored on ssh's actual phrasing —
 * never a bare "not found" substring, which appears in a remote binary's own
 * error output and in half of every shell's diagnostics, and which prior art
 * used to (mis)classify unrelated failures.
 */
const UNREACHABLE_PATTERNS: ReadonlyArray<readonly [RegExp, RemoteHostUnreachableReason]> = [
  [/host key verification failed/i, "host-key"],
  [/remote host identification has changed/i, "host-key"],
  [/no matching host key type/i, "host-key"],
  [/permission denied \(/i, "auth"],
  [/too many authentication failures/i, "auth"],
  [/no supported authentication methods/i, "auth"],
  [/^ssh: could not resolve hostname/im, "dns"],
  [/name or service not known/i, "dns"],
  [/nodename nor servname provided/i, "dns"],
  [/connection refused/i, "refused"],
  [/connection closed by remote host/i, "network"],
  [/connection reset by peer/i, "network"],
  [/no route to host/i, "network"],
  [/network is unreachable/i, "network"],
  [/broken pipe/i, "network"],
  [/operation timed out/i, "timeout"],
  [/connection timed out/i, "timeout"],
  [/timeout, server .* not responding/i, "timeout"],
];

function classifyUnreachable(stderr: string): RemoteHostUnreachableReason | undefined {
  for (const [pattern, reason] of UNREACHABLE_PATTERNS) {
    if (pattern.test(stderr)) return reason;
  }
  return undefined;
}

const UNREACHABLE_MESSAGES: Readonly<Record<RemoteHostUnreachableReason, string>> = {
  auth: "SSH rejected the credentials for this host. Add a key ssh can use without a passphrase prompt, or load it into your agent.",
  "host-key":
    "The host key could not be verified. Verify the host's fingerprint and add it to your known_hosts — Synara will not skip this check.",
  dns: "The hostname could not be resolved. Check the destination, or the Host alias in your ~/.ssh/config.",
  refused: "The connection was refused. Check that sshd is running and the port is correct.",
  network: "The network connection to the host dropped. Check connectivity or the VPN.",
  timeout: "The host did not answer before the connection deadline.",
  "ssh-missing":
    "The local ssh client could not be started. Check that ssh is installed and on PATH.",
  unknown: "SSH could not connect to this host.",
};

function trimForDisplay(value: string, max = 2_000): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export interface ClassifyRemoteProbeInput {
  readonly execution: RemoteProbeExecution;
  readonly signature: string;
  readonly checkedAt: string;
  readonly target: RemoteCommandTarget;
  /** Launcher that produced this execution; reported when a rescue succeeded. */
  readonly launcher?: RemoteLauncher | undefined;
  /** True when this execution was the login-shell rescue attempt. */
  readonly viaRescue?: boolean | undefined;
}

export function classifyRemoteProbe(input: ClassifyRemoteProbeInput): RemoteHostProbeResult {
  const { execution } = input;
  const stderr = trimForDisplay(execution.stderr);
  const base = { signature: input.signature, checkedAt: input.checkedAt };

  if (execution.spawnErrorCode !== undefined) {
    return {
      ...base,
      outcome: "unreachable",
      unreachableReason: "ssh-missing",
      message: UNREACHABLE_MESSAGES["ssh-missing"],
    };
  }

  if (execution.timedOut) {
    return {
      ...base,
      outcome: "unreachable",
      unreachableReason: "timeout",
      message:
        "The host did not finish the check within the deadline. A password or passphrase prompt, or a login script waiting for input, will do this.",
      ...(stderr ? { detail: stderr } : {}),
    };
  }

  // Order matters: `cd` runs before the binary check, and both failures say "no
  // such file or directory". Classifying on the message would make a missing
  // project directory look like a missing agent binary and send the user to
  // install software they already have. The script settles it with distinct exit
  // codes and distinct markers, and we read the cwd case first regardless.
  if (
    execution.exitCode === PROBE_EXIT_CWD_MISSING ||
    execution.stderr.includes(PROBE_MARKERS.cwdMissing)
  ) {
    return {
      ...base,
      outcome: "missing-path",
      message: `The directory ${input.target.cwd} does not exist on the host (or is not readable by this user).`,
    };
  }

  if (
    execution.exitCode === PROBE_EXIT_BINARY_MISSING ||
    execution.stderr.includes(PROBE_MARKERS.binaryMissing)
  ) {
    return {
      ...base,
      outcome: "missing-binary",
      message:
        "The agent binary was not found on the host's PATH for this launcher. Set an absolute binary path, or switch to a login shell so the host's profile PATH applies.",
      ...(stderr ? { detail: stderr } : {}),
    };
  }

  const markerIndex = execution.stdout.indexOf(PROBE_MARKERS.begin);
  if (markerIndex === -1) {
    const reason = classifyUnreachable(execution.stderr);
    if (reason !== undefined) {
      return {
        ...base,
        outcome: "unreachable",
        unreachableReason: reason,
        message: UNREACHABLE_MESSAGES[reason],
        ...(stderr ? { detail: stderr } : {}),
      };
    }
    if (execution.exitCode === 255) {
      // 255 is ssh's own "transport failed" code; a remote command's own failure
      // arrives with the remote exit status instead.
      return {
        ...base,
        outcome: "unreachable",
        unreachableReason: "unknown",
        message: UNREACHABLE_MESSAGES.unknown,
        ...(stderr ? { detail: stderr } : {}),
      };
    }
    return {
      ...base,
      outcome: "command-failed",
      message: "The check ran on the host but did not complete successfully.",
      ...(stderr ? { detail: stderr } : {}),
    };
  }

  // Anything the shell printed to stdout before our marker lands in the protocol
  // stream ahead of the first JSON-RPC frame. The session does not fail loudly —
  // it fails invisibly, as a parse error on a message nobody sent. That is why a
  // noisy shell is a probe failure and not a warning.
  const preamble = execution.stdout.slice(0, markerIndex);
  if (preamble.trim().length > 0) {
    return {
      ...base,
      outcome: "noisy-shell",
      message:
        "The host's shell prints output on startup. That output would be injected into the session's protocol stream and corrupt it. Move the printing to the interactive-only branch of your shell rc, or use the direct launcher.",
      noisyOutput: trimForDisplay(preamble, 500),
    };
  }

  const version = execution.stdout.slice(markerIndex + PROBE_MARKERS.begin.length).trim();

  if (execution.exitCode !== 0) {
    return {
      ...base,
      outcome: "command-failed",
      message: "The agent binary was found but exited with an error during the version check.",
      ...(stderr ? { detail: stderr } : {}),
    };
  }

  return {
    ...base,
    outcome: "ok",
    message: input.viaRescue
      ? "The host works through a login shell. Switch this host's launcher to login-shell."
      : "The host is ready.",
    ...(version ? { version: trimForDisplay(version, 200) } : {}),
    ...(input.viaRescue && input.launcher ? { suggestedLauncher: input.launcher } : {}),
  };
}

/**
 * A rescue is only worth trying when a login shell could plausibly change the
 * answer: a PATH set in the user's profile. It cannot fix an unreachable host,
 * a missing directory, or a shell that is already too noisy.
 */
export function shouldRetryThroughLoginShell(
  result: RemoteHostProbeResult,
  launcher: RemoteLauncher,
): boolean {
  return result.outcome === "missing-binary" && launcher.kind === "direct";
}

/**
 * A probe result may only be trusted for the exact command that produced it, and
 * only for a bounded time — a host reachable an hour ago says nothing about now.
 *
 * This is the check that makes re-probing before session start meaningful: prior
 * art probed once at project creation and never again, so a host that broke after
 * setup still showed "ready" until a turn hung.
 */
export const REMOTE_PROBE_MAX_AGE_MS = 5 * 60_000;

export function isProbeResultFresh(
  result: RemoteHostProbeResult | undefined,
  expectedSignature: string,
  nowMs: number,
  maxAgeMs: number = REMOTE_PROBE_MAX_AGE_MS,
): boolean {
  if (result === undefined) return false;
  if (result.signature !== expectedSignature) return false;
  if (result.outcome !== "ok") return false;
  const checkedAtMs = Date.parse(result.checkedAt);
  if (Number.isNaN(checkedAtMs)) return false;
  // A timestamp from the future is a clock jump, not freshness.
  if (checkedAtMs > nowMs) return false;
  return nowMs - checkedAtMs <= maxAgeMs;
}
