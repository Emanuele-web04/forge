// FILE: phoneReachability.ts
// Purpose: Runs the Tailscale probes and reports how a phone can reach THIS
//          server: the blessed HTTPS path, or the documented SSH fallback.
// Layer: Server — pairing support
// Exports: detectPhoneReachability plus its injectable command runner.

import {
  parseTailscaleServeMappings,
  parseTailscaleStatus,
  resolvePhoneReachability,
  sshPortForwardCommand,
  type PhoneReachability,
} from "@synara/shared/tailscaleServe";

import { runProcess } from "./processRunner";

/**
 * Both probes are read-only and local, but they still spawn a process on every
 * pairing screen open, so they are bounded tightly. A slow or hung `tailscale`
 * must degrade to the fallback path, not stall the pairing UI.
 */
const TAILSCALE_PROBE_TIMEOUT_MS = 2_000;

export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly code: number | null }>;

const defaultRunner: CommandRunner = async (command, args) => {
  const result = await runProcess(command, args, {
    timeoutMs: TAILSCALE_PROBE_TIMEOUT_MS,
    // `tailscale status --json` can be sizeable on a large tailnet; truncating
    // is safe because a truncated document fails JSON.parse and the parsers
    // already fall back to the SSH path on unparseable input.
    outputMode: "truncate",
  });
  return { stdout: result.stdout, code: result.code };
};

/**
 * Runs one probe, returning empty output for ANY failure.
 *
 * `tailscale` missing entirely is the common case on a fresh host and is not an
 * error; the parsers already fail closed on empty input, so every failure lands
 * on the same safe answer: offer the SSH fallback.
 */
async function probeJson(
  runner: CommandRunner,
  binary: string,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await runner(binary, args);
    return result.code === 0 ? result.stdout : "";
  } catch {
    return "";
  }
}

export interface PhoneReachabilityReport extends PhoneReachability {
  /** The always-works fallback command, always present so it can be documented. */
  readonly fallbackCommand: string;
}

/**
 * How a phone can reach this server right now.
 *
 * `sshDestination` is the host as the user would type it in a terminal, used
 * only to render the fallback command. It is never executed here.
 */
export async function detectPhoneReachability(input: {
  readonly localPort: number;
  readonly sshDestination: string;
  readonly tailscaleBinary?: string;
  readonly runner?: CommandRunner;
}): Promise<PhoneReachabilityReport> {
  const runner = input.runner ?? defaultRunner;
  const binary = input.tailscaleBinary ?? "tailscale";

  const [statusJson, serveJson] = await Promise.all([
    probeJson(runner, binary, ["status", "--json"]),
    probeJson(runner, binary, ["serve", "status", "--json"]),
  ]);

  const reachability = resolvePhoneReachability({
    status: parseTailscaleStatus(statusJson),
    serveMappings: parseTailscaleServeMappings(serveJson),
    localPort: input.localPort,
  });

  return {
    ...reachability,
    // Rendered even on the Tailscale path: the fallback is what a user needs
    // the moment the tailnet is unavailable, and hunting for it then is the
    // worst possible time to look it up.
    fallbackCommand: sshPortForwardCommand({
      sshDestination: input.sshDestination,
      localPort: input.localPort,
      remotePort: input.localPort,
    }),
  };
}
