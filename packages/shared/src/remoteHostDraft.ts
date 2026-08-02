// FILE: remoteHostDraft.ts
// Purpose: Turn what a user actually types in the add-host form — a destination
//          and an optional name — into a complete, validated RemoteHostConfig.
// Layer: Shared runtime (server + web + tests)
// Exports: RemoteHostDraft, makeRemoteHostId, defaultLabelForDestination,
//          buildRemoteHostConfig, upsertRemoteHost, removeRemoteHost
//
// The form has two real inputs because ten of RemoteHostConfig's twelve fields
// have a decoding default and `hostId` is generated rather than typed. Building
// the config in ONE place — shared by the dialog, the RPC and the tests — is
// what keeps "what the user filled in" and "what gets persisted" from drifting.

import { Schema } from "effect";

import { RemoteHostConfig, type RemoteHostId } from "@synara/contracts";

import { validateRemoteHostConfig } from "./remoteCommand";

/** Exactly the fields the add-host form collects. Everything else is defaulted. */
export interface RemoteHostDraft {
  readonly destination: string;
  /** Optional; falls back to a name derived from the destination. */
  readonly label?: string | undefined;
  /** Advanced disclosure. Absent means "use the schema default". */
  readonly port?: number | undefined;
  readonly sshBinary?: string | undefined;
  readonly sshArgs?: readonly string[] | undefined;
  readonly connectTimeoutSeconds?: number | undefined;
  readonly binaryPath?: string | undefined;
}

/**
 * Host ids are generated, never typed.
 *
 * A user-chosen id is a second name for the same thing that immediately drifts
 * from the label, and it would let a rename silently orphan the connectivity
 * state and probe cache keyed on it. A random id is stable across every edit.
 */
export function makeRemoteHostId(): RemoteHostId {
  return `host-${crypto.randomUUID()}` as RemoteHostId;
}

/**
 * A readable default name for a destination.
 *
 * `user@box.example.com:22` becomes `box`, because the first label of the
 * hostname is what a user calls the machine. A `~/.ssh/config` alias is already
 * the user's own name for it and passes through unchanged.
 */
export function defaultLabelForDestination(destination: string): string {
  const withoutUser = destination.includes("@")
    ? (destination.slice(destination.lastIndexOf("@") + 1) ?? destination)
    : destination;
  const withoutPort = withoutUser.split(":")[0] ?? withoutUser;
  const firstLabel = withoutPort.split(".")[0] ?? withoutPort;
  const trimmed = firstLabel.trim();
  return trimmed.length > 0 ? trimmed : destination.trim();
}

const decodeRemoteHostConfig = Schema.decodeUnknownSync(RemoteHostConfig);

/**
 * Builds a complete config from a draft.
 *
 * Decoding fills every defaulted field, so callers never handle a partial host;
 * `validateRemoteHostConfig` then applies the same gate a command build applies,
 * so a config that could never run is refused at the point of ADDING it rather
 * than at the first turn.
 *
 * There is deliberately no `hostKeyVerification` parameter. The schema has no
 * "off" member and the form must not invent one.
 */
export function buildRemoteHostConfig(
  draft: RemoteHostDraft,
  hostId: RemoteHostId = makeRemoteHostId(),
): RemoteHostConfig {
  const destination = draft.destination.trim();
  const label = (draft.label ?? "").trim() || defaultLabelForDestination(destination);
  // A port typed in the advanced section becomes a real ssh flag rather than
  // being glued onto the destination, which ssh would read as part of the name.
  const portArgs = draft.port === undefined ? [] : ["-p", String(draft.port)];

  const config = decodeRemoteHostConfig({
    hostId,
    label,
    destination,
    sshArgs: [...portArgs, ...(draft.sshArgs ?? [])],
    ...(draft.sshBinary?.trim() ? { sshBinary: draft.sshBinary.trim() } : {}),
    ...(draft.connectTimeoutSeconds !== undefined
      ? { connectTimeoutSeconds: draft.connectTimeoutSeconds }
      : {}),
    ...(draft.binaryPath?.trim() ? { binaryPath: draft.binaryPath.trim() } : {}),
  });

  return validateRemoteHostConfig(config);
}

/** Adds a host, or replaces the existing entry with the same id, preserving order. */
export function upsertRemoteHost(
  hosts: readonly RemoteHostConfig[],
  host: RemoteHostConfig,
): readonly RemoteHostConfig[] {
  const index = hosts.findIndex((entry) => entry.hostId === host.hostId);
  if (index === -1) return [...hosts, host];
  return hosts.map((entry, at) => (at === index ? host : entry));
}

/**
 * Drops a host from the list.
 *
 * This is a LOCAL forget and nothing more: it does not touch the remote host.
 * Whatever is installed there — including any threads that ran on it — stays
 * exactly as it is, which is what makes re-adding the host bring them back.
 */
export function removeRemoteHost(
  hosts: readonly RemoteHostConfig[],
  hostId: RemoteHostId,
): readonly RemoteHostConfig[] {
  return hosts.filter((entry) => entry.hostId !== hostId);
}
