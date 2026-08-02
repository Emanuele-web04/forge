// FILE: remoteHostFingerprintService.ts
// Purpose: Run the two processes that produce a host's key fingerprint —
//          `ssh -G` to resolve the destination, `ssh-keyscan` to fetch the keys —
//          and hand back a rendered result for the trust prompt.
// Layer: Server — SSH broker connection layer
// Exports: fetchRemoteHostFingerprint, RemoteHostFingerprintRunner
//
// The argv construction, parsing and digest computation all live in
// @synara/shared/remoteHostFingerprint. This module is only the process spawn,
// so the security-relevant logic stays in one tested, side-effect-free place.

import type { RemoteHostConfig, RemoteHostFingerprintResult } from "@synara/contracts";
import { RemoteHostConfigError } from "@synara/shared/remoteCommand";
import {
  buildSshKeyscanArgv,
  buildSshResolveArgv,
  parseHostKeyFingerprints,
  parseResolvedSshTarget,
  SSH_KEYSCAN_DEADLINE_MS,
} from "@synara/shared/remoteHostFingerprint";

import { runProcess } from "./processRunner";

export type RemoteHostFingerprintRunner = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; allowNonZeroExit: true; outputMode: "truncate" },
) => Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>;

const defaultRunner: RemoteHostFingerprintRunner = (command, args, options) =>
  runProcess(command, args, options);

/** `ssh -G` does no network I/O, so it only needs to survive a slow config parse. */
const RESOLVE_DEADLINE_MS = 5_000;

function describeFailure(stderr: string, fallback: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

/**
 * Fetches a host's fingerprints.
 *
 * Failure is returned as data rather than thrown: a fingerprint we could not
 * fetch must degrade to "we cannot show you one", NOT to a trust prompt with an
 * empty or invented value. The caller decides what to do with an empty list, and
 * the UI must not offer trust without a fingerprint to compare.
 */
export async function fetchRemoteHostFingerprint(
  host: RemoteHostConfig,
  run: RemoteHostFingerprintRunner = defaultRunner,
): Promise<RemoteHostFingerprintResult> {
  let hostname: string;
  let port: number;

  try {
    const resolveArgv = buildSshResolveArgv(host);
    const resolved = await run(resolveArgv.command, resolveArgv.args, {
      timeoutMs: RESOLVE_DEADLINE_MS,
      allowNonZeroExit: true,
      outputMode: "truncate",
    });
    if (resolved.timedOut || resolved.code !== 0) {
      return {
        hostname: host.destination,
        port: 22,
        fingerprints: [],
        error: describeFailure(resolved.stderr, "ssh could not resolve this destination."),
      };
    }
    const target = parseResolvedSshTarget(resolved.stdout);
    hostname = target.hostname;
    port = target.port;
  } catch (cause) {
    return {
      hostname: host.destination,
      port: 22,
      fingerprints: [],
      error:
        cause instanceof RemoteHostConfigError
          ? cause.message
          : "ssh could not resolve this destination.",
    };
  }

  try {
    const scanArgv = buildSshKeyscanArgv({ hostname, port });
    const scanned = await run(scanArgv.command, scanArgv.args, {
      timeoutMs: SSH_KEYSCAN_DEADLINE_MS,
      allowNonZeroExit: true,
      outputMode: "truncate",
    });
    if (scanned.timedOut) {
      return {
        hostname,
        port,
        fingerprints: [],
        error: "The host did not answer with a key before the deadline.",
      };
    }
    const fingerprints = parseHostKeyFingerprints(scanned.stdout);
    if (fingerprints.length === 0) {
      return {
        hostname,
        port,
        fingerprints: [],
        error: describeFailure(scanned.stderr, "The host did not offer a readable key."),
      };
    }
    return { hostname, port, fingerprints };
  } catch (cause) {
    return {
      hostname,
      port,
      fingerprints: [],
      error:
        cause instanceof RemoteHostConfigError
          ? cause.message
          : "The host's key could not be fetched.",
    };
  }
}
