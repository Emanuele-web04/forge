// FILE: remoteHostBroker.ts
// Purpose: Executes the structured remote-host probe, owns SSH connection reuse
//          (a private ControlMaster directory), and drives the per-host
//          connectivity state machine.
// Layer: Server — SSH broker connection layer
// Exports: RemoteHostBroker, makeRemoteHostBroker, resolveSshControlDirectory
//
// This module is the interface issue #9 (remote bootstrap/supervisor) consumes:
// call `ensureSessionReady` before starting anything on a host, and
// `sessionInvocation` to get the argv to spawn. Nothing else should build an ssh
// command line.

import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  RemoteCommandTarget,
  RemoteHostConfig,
  RemoteHostConnectivityStatus,
  RemoteHostId,
  RemoteHostProbeResult,
} from "@synara/contracts";
import { makeTokenBucketLimiter, type TokenBucketLimiter } from "@synara/shared/rateLimiter";
import { resolveSynaraHomeDirectory } from "@synara/shared/synaraHome";
import {
  RemoteHostConfigError,
  validateRemoteHostConfig,
  type SshInvocation,
} from "@synara/shared/remoteCommand";
import {
  applyHealthResult,
  initialConnectivity,
  isHostUsable,
  shouldAttemptNow,
} from "@synara/shared/remoteHostConnectivity";
import {
  classifyRemoteProbe,
  isProbeResultFresh,
  REMOTE_PROBE_DEADLINE_MS,
  remoteProbeSignature,
  renderRemoteProbeCommand,
  renderRemoteSessionCommand,
  shouldRetryThroughLoginShell,
  type RemoteProbeExecution,
} from "@synara/shared/remoteHostProbe";

import { runProcess } from "./processRunner";

/**
 * Probes cost an outbound connection to a third-party host, so the limit is
 * server-side rather than a debounce in the UI: a client stuck in a retry loop
 * would otherwise turn this server into an outbound amplifier.
 */
export const PROBE_RATE_LIMIT_CAPACITY = 5;
export const PROBE_RATE_LIMIT_PER_SECOND = 1 / 6; // ~10 per minute sustained.

export class RemoteHostRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(
      `Too many connection checks for this host. Try again in ${Math.ceil(retryAfterMs / 1_000)}s.`,
    );
    this.name = "RemoteHostRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class RemoteHostNotReadyError extends Error {
  readonly probe: RemoteHostProbeResult;
  constructor(probe: RemoteHostProbeResult) {
    super(probe.message);
    this.name = "RemoteHostNotReadyError";
    this.probe = probe;
  }
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; allowNonZeroExit: true; outputMode: "truncate" },
) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}>;

const defaultRunner: ProcessRunner = (command, args, options) => runProcess(command, args, options);

/**
 * Multiplexing sockets live in a directory only this user may enter.
 *
 * A control socket is a live, already-authenticated channel to the remote host:
 * anyone who can open it rides our credentials without ever touching a key. A
 * world-writable or group-writable directory therefore hands local users a
 * password-free login to every host Synara is connected to. We create it 0700 and
 * re-verify the mode on every resolve, because a directory that existed before us
 * (or was chmod'd after) is exactly the case a create-only check misses.
 */
export function resolveSshControlDirectory(
  synaraHome: string,
  fs: Pick<typeof FS, "mkdirSync" | "lstatSync" | "chmodSync"> = FS,
): string {
  const directory = Path.join(synaraHome, "ssh-control");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // lstat, never stat: stat follows the link and reports the TARGET's mode, so a
  // symlink planted here before us — pointing at a directory the attacker owns
  // and has dutifully chmod'd 0700 — passes the check below while every live,
  // authenticated control socket is created inside their directory. mkdirSync
  // does not replace an existing symlink to a directory, so this is the only
  // place that distinction can be caught.
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink()) {
    throw new RemoteHostConfigError(
      "controlDirectory",
      `${directory} is a symbolic link; SSH connection sharing was refused because its target's ownership cannot be trusted.`,
    );
  }
  // POSIX ONLY. Windows does not implement POSIX mode bits: `lstat` synthesises
  // them from the read-only attribute, so a perfectly ordinary user directory
  // reports 0666 and this check refused to start the server AT ALL on Windows —
  // not a remote-hosts failure, a boot failure, because the broker is
  // constructed during startup. Windows access control lives in ACLs, which
  // `mode` cannot express, so there is nothing here to verify; `chmodSync` is
  // equally a no-op beyond the read-only flag.
  //
  // The guarantee is unchanged where it is enforceable. ControlMaster sockets
  // are a POSIX mechanism (OpenSSH on Windows does not support ControlPath at
  // all), so on Windows there is no shared socket to protect.
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    // Do not silently continue with a permissive directory: fix it, and fail if
    // that is not possible.
    fs.chmodSync(directory, 0o700);
    if ((fs.lstatSync(directory).mode & 0o077) !== 0) {
      throw new RemoteHostConfigError(
        "controlDirectory",
        `${directory} is accessible to other users; SSH connection sharing was refused.`,
      );
    }
  }
  return directory;
}

export interface RemoteHostBrokerOptions {
  readonly controlDirectory: string;
  readonly run?: ProcessRunner;
  readonly now?: () => number;
  readonly probeLimiter?: TokenBucketLimiter;
  readonly random?: () => number;
}

export interface ProbeOptions {
  /** Skip the rate limiter for internal health checks we scheduled ourselves. */
  readonly internal?: boolean;
}

export class RemoteHostBroker {
  readonly #controlDirectory: string;
  readonly #run: ProcessRunner;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #limiter: TokenBucketLimiter;
  readonly #probes = new Map<string, RemoteHostProbeResult>();
  readonly #connectivity = new Map<RemoteHostId, RemoteHostConnectivityStatus>();

  constructor(options: RemoteHostBrokerOptions) {
    this.#controlDirectory = options.controlDirectory;
    this.#run = options.run ?? defaultRunner;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#limiter =
      options.probeLimiter ??
      makeTokenBucketLimiter({
        capacity: PROBE_RATE_LIMIT_CAPACITY,
        refillPerSecond: PROBE_RATE_LIMIT_PER_SECOND,
        now: this.#now,
      });
  }

  /** The argv to spawn for a real session. The ONLY supported way to build one. */
  sessionInvocation(config: RemoteHostConfig, target: RemoteCommandTarget): SshInvocation {
    return renderRemoteSessionCommand({
      config: validateRemoteHostConfig(config),
      target,
      controlDirectory: this.#controlDirectory,
    }).invocation;
  }

  connectivity(hostId: RemoteHostId): RemoteHostConnectivityStatus {
    return this.#connectivity.get(hostId) ?? initialConnectivity(hostId, this.#now());
  }

  lastProbe(
    config: RemoteHostConfig,
    target: RemoteCommandTarget,
  ): RemoteHostProbeResult | undefined {
    return this.#probes.get(this.#probeKey(config, target));
  }

  #probeKey(config: RemoteHostConfig, target: RemoteCommandTarget): string {
    return this.#probeKeyFor(config.hostId, remoteProbeSignature({ config, target }));
  }

  // One construction site for the cache key so the delimiter cannot drift
  // between writer and reader. A newline is safe because hostId rejects
  // whitespace and the signature is a hex digest.
  #probeKeyFor(hostId: string, signature: string): string {
    return `${hostId}\n${signature}`;
  }

  async #execute(invocation: SshInvocation): Promise<RemoteProbeExecution> {
    try {
      const result = await this.#run(invocation.command, invocation.args, {
        // Our own deadline, independent of ssh's ConnectTimeout: ssh only bounds
        // the connect phase, so a host that answers and then stalls in an rc file
        // would otherwise never return.
        timeoutMs: REMOTE_PROBE_DEADLINE_MS,
        allowNonZeroExit: true,
        outputMode: "truncate",
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
        timedOut: result.timedOut,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        spawnErrorCode: code ?? "ESPAWN",
      };
    }
  }

  /**
   * Runs the structured probe: the exact session command with the version check
   * substituted, then a login-shell rescue when — and only when — a login shell
   * could plausibly change the answer.
   */
  async probe(
    config: RemoteHostConfig,
    target: RemoteCommandTarget,
    options: ProbeOptions = {},
  ): Promise<RemoteHostProbeResult> {
    const validated = validateRemoteHostConfig(config);

    if (options.internal !== true) {
      const decision = this.#limiter.take(validated.hostId);
      if (!decision.allowed) throw new RemoteHostRateLimitError(decision.retryAfterMs);
    }

    // The signature is the SESSION command's, so a result certifies the command
    // that will actually run.
    const signature = remoteProbeSignature({ config: validated, target });
    const checkedAt = new Date(this.#now()).toISOString();

    const first = renderRemoteProbeCommand({
      config: validated,
      target,
      controlDirectory: this.#controlDirectory,
    });
    let result = classifyRemoteProbe({
      execution: await this.#execute(first.invocation),
      signature,
      checkedAt,
      target,
    });

    if (shouldRetryThroughLoginShell(result, first.launcher)) {
      const rescueLauncher = { kind: "login-shell" } as const;
      const rescue = renderRemoteProbeCommand({
        config: validated,
        target,
        launcherOverride: rescueLauncher,
        controlDirectory: this.#controlDirectory,
      });
      const rescueResult = classifyRemoteProbe({
        execution: await this.#execute(rescue.invocation),
        signature,
        checkedAt,
        target,
        launcher: rescueLauncher,
        viaRescue: true,
      });
      // A rescue only replaces the verdict when it actually succeeded; otherwise
      // the user keeps the original, more specific diagnosis.
      if (rescueResult.outcome === "ok") result = rescueResult;
    }

    this.#probes.set(this.#probeKeyFor(validated.hostId, signature), result);
    this.#recordHealth(validated.hostId, result);
    return result;
  }

  #recordHealth(hostId: RemoteHostId, result: RemoteHostProbeResult): void {
    const current = this.connectivity(hostId);
    this.#connectivity.set(
      hostId,
      applyHealthResult(
        current,
        {
          ok: result.outcome === "ok",
          outcome: result.outcome,
          ...(result.outcome === "ok" ? {} : { error: result.message }),
        },
        this.#now(),
        this.#random,
      ),
    );
  }

  /**
   * Gate a session start.
   *
   * Prior art probed once at project creation and never again, so a host that
   * broke afterwards still displayed "ready" until a turn hung with no
   * explanation. Here the probe re-runs before every session start unless a
   * result for the IDENTICAL rendered command is still fresh.
   */
  async ensureSessionReady(
    config: RemoteHostConfig,
    target: RemoteCommandTarget,
  ): Promise<RemoteHostProbeResult> {
    const signature = remoteProbeSignature({ config, target });
    const cached = this.#probes.get(this.#probeKeyFor(config.hostId, signature));
    if (isProbeResultFresh(cached, signature, this.#now())) {
      return cached as RemoteHostProbeResult;
    }
    const result = await this.probe(config, target, { internal: true });
    if (result.outcome !== "ok") throw new RemoteHostNotReadyError(result);
    return result;
  }

  /**
   * Health check that exercises the REAL command path (cd + binary + version)
   * rather than a bare TCP connect, so a host that answers but has lost the
   * project directory or the binary is reported as unhealthy instead of green.
   */
  async healthCheck(
    config: RemoteHostConfig,
    target: RemoteCommandTarget,
  ): Promise<RemoteHostConnectivityStatus> {
    const status = this.connectivity(config.hostId);
    if (!shouldAttemptNow(status, this.#now())) return status;
    await this.probe(config, target, { internal: true });
    return this.connectivity(config.hostId);
  }

  isUsable(hostId: RemoteHostId): boolean {
    return isHostUsable(this.connectivity(hostId));
  }
}

export function makeRemoteHostBroker(options: RemoteHostBrokerOptions): RemoteHostBroker {
  return new RemoteHostBroker(options);
}

let sharedBroker: RemoteHostBroker | undefined;

/**
 * Process-wide broker. Deliberately one instance: the probe rate limiter, the
 * connectivity state machine and the ControlMaster directory are all per-host
 * state that must be shared by every caller, and a second broker would silently
 * halve the effective rate limit while opening a second set of master sockets.
 *
 * Constructed lazily so the control directory is created (and its mode enforced)
 * only when a remote host is actually used.
 */
export function sharedRemoteHostBroker(): RemoteHostBroker {
  if (sharedBroker === undefined) {
    sharedBroker = makeRemoteHostBroker({
      controlDirectory: resolveSshControlDirectory(resolveSynaraHomeDirectory()),
    });
  }
  return sharedBroker;
}

/** Test seam: resets the process-wide broker. */
export function resetSharedRemoteHostBroker(): void {
  sharedBroker = undefined;
}
