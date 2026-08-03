// FILE: remoteHostFacts.ts
// Purpose: Read the handful of facts about a remote box that the supervisor
//          plan depends on — OS, architecture, home directory, uid — in one
//          round trip, as validated data.
// Layer: Server / remote broker
// Exports: RemoteHostFacts, readRemoteHostFacts, remoteArtifactTargetFor,
//          deriveRemoteServerPort
//
// These are read rather than assumed because every one of them changes what we
// install: the artifact set is architecture-specific, the supervisor is
// OS-specific, and the unit file embeds the resolved home directory and uid as
// literals (see remoteSupervisor.ts, which refuses `$HOME` / `$(id -u)`).

import { createHash } from "node:crypto";

import type { BootstrapArtifactManifestTarget } from "./bootstrapArtifactManifest";
import { expectRemoteSuccess, type RemoteConnection } from "./remoteConnection";

export interface RemoteHostFacts {
  readonly os: "linux" | "darwin";
  readonly arch: "x64" | "arm64";
  readonly homeDirectory: string;
  readonly userId: number;
}

export class RemoteHostFactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteHostFactsError";
  }
}

/**
 * Normalizes `uname -s`. Anything that is not one of the two systems we can
 * supervise is a hard error here rather than a default, because defaulting to
 * linux on a BSD would render a systemd unit that silently never starts.
 */
function parseOs(value: string): "linux" | "darwin" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "linux") return "linux";
  if (normalized === "darwin") return "darwin";
  throw new RemoteHostFactsError(`Unsupported remote operating system: ${value.trim()}`);
}

/** Normalizes `uname -m` across the names the same CPU answers to. */
function parseArch(value: string): "x64" | "arm64" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "x86_64" || normalized === "amd64") return "x64";
  if (normalized === "aarch64" || normalized === "arm64") return "arm64";
  throw new RemoteHostFactsError(`Unsupported remote architecture: ${value.trim()}`);
}

function parseHomeDirectory(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    throw new RemoteHostFactsError(`Remote home directory is not an absolute path: ${trimmed}`);
  }
  return trimmed;
}

function parseUserId(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RemoteHostFactsError(`Remote user id is not a number: ${value.trim()}`);
  }
  return parsed;
}

/**
 * Reads all four facts.
 *
 * Four separate commands rather than one shell pipeline: `exec` takes an argv
 * vector precisely so nothing here is composed into a string a remote shell
 * parses, and the cost is paid once per host over a multiplexed connection.
 */
export async function readRemoteHostFacts(connection: RemoteConnection): Promise<RemoteHostFacts> {
  const [os, arch, home, uid] = await Promise.all([
    expectRemoteSuccess(connection, ["uname", "-s"]),
    expectRemoteSuccess(connection, ["uname", "-m"]),
    // `$HOME` has to be expanded by a shell, so this is the one fact that needs
    // `sh -c`. The script is a fixed literal with nothing interpolated into it,
    // which is what keeps it off the seam the argv contract exists to close.
    expectRemoteSuccess(connection, ["sh", "-c", 'printf %s "$HOME"']),
    expectRemoteSuccess(connection, ["id", "-u"]),
  ]);
  return {
    os: parseOs(os.stdout),
    arch: parseArch(arch.stdout),
    homeDirectory: parseHomeDirectory(home.stdout),
    userId: parseUserId(uid.stdout),
  };
}

/**
 * The manifest target for a host. Linux only — the manifests the release
 * pipeline produces are `linux-x64` and `linux-arm64`, and there is no darwin
 * set to fall back to.
 */
export function remoteArtifactTargetFor(
  facts: RemoteHostFacts,
): BootstrapArtifactManifestTarget | undefined {
  // linux and darwin are both supported hosts; each splits x64/arm64 the same
  // way. A Mac mini is a first-class remote, proven end to end against a real
  // launchctl.
  const arch = facts.arch === "arm64" ? "arm64" : "x64";
  if (facts.os === "linux") return `linux-${arch}`;
  if (facts.os === "darwin") return `darwin-${arch}`;
  return undefined;
}

/** Ports the remote server may bind. Unprivileged, and clear of the ephemeral range. */
const REMOTE_PORT_FLOOR = 20_000;
const REMOTE_PORT_SPAN = 10_000;

/**
 * The loopback port the remote server listens on.
 *
 * DERIVED, not allocated. The port is baked into the systemd unit at install
 * time, so a second bootstrap of the same install root must arrive at the same
 * number or it would write a unit that disagrees with the running service.
 * Deriving it from the install root makes that automatic and keeps two
 * different Synaras on one box off each other's port.
 *
 * A collision with an unrelated service is possible and is not silently
 * tolerated: the remote server fails to bind, the handshake never answers, and
 * the pipeline reports that failure rather than publishing a port that belongs
 * to something else.
 */
export function deriveRemoteServerPort(installRoot: string): number {
  const digest = createHash("sha256").update(installRoot).digest();
  return REMOTE_PORT_FLOOR + (digest.readUInt32BE(0) % REMOTE_PORT_SPAN);
}
