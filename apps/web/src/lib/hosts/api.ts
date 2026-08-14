// FILE: api.ts
// Purpose: The remote-host surface the web app consumes — hosts, devices, the
//          device-code approval, and the grant that opens a session.
// Layer: Web remote-access feature port.
// Exports: HostsApi and the capability probe that produces one.

import type { AccountDevice, AccountHost, AccountHostPlatform } from "@synara/contracts";

import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import type { HostReachability } from "./reachability";

/**
 * What the app knows about the machine it is running on, as an account entity.
 *
 * `organizationMemberCount` exists for exactly one decision (ADR 0002): a host
 * that auto-registers at sign-in must not become discoverable to a *team*
 * without the owner saying so. It is nullable because the count comes from the
 * identity provider and a provider outage must not be allowed to answer the
 * question — see `shouldPromptForDiscoverability`, which fails closed.
 */
export interface HostEnrollment {
  /** The locally-bundled host's account row, or null when this shell has none. */
  readonly host: AccountHost | null;
  /** Members of the workspace the host was registered into; null when unknown. */
  readonly organizationMemberCount: number | null;
  /**
   * Whether the owner has already answered the discoverability prompt for this
   * host. Persisted with the host, not the client, so a second device does not
   * re-ask a question already answered.
   */
  readonly discoverabilityAcknowledged: boolean;
}

/**
 * The account-side operations the remote-access UI needs.
 *
 * Every call is brokered by the local server (which owns the account
 * credentials — the browser never holds an access token), so this mirrors the
 * `NativeApi` shape rather than the HTTP routes. Nothing here talks to the
 * account service directly.
 */
export interface HostsApi {
  /** Owner rows plus discoverable rows of the active workspace. */
  listHosts: () => Promise<{ readonly hosts: readonly AccountHost[] }>;
  /** Owner-only. Rejects for a host the caller does not own. */
  updateHost: (input: {
    readonly hostId: string;
    readonly discoverable?: boolean;
    readonly name?: string;
  }) => Promise<AccountHost>;
  /** Owner-only, and irreversible: the host and its stored secrets both go. */
  deleteHost: (input: { readonly hostId: string }) => Promise<void>;
  listDevices: () => Promise<{ readonly devices: readonly AccountDevice[] }>;
  /** Refuses the device key from here on and drops its live sessions. */
  revokeDevice: (input: { readonly deviceId: string }) => Promise<void>;
  /** The owner half of the headless device-code flow (ADR 0015). */
  approveDeviceLink: (input: { readonly userCode: string }) => Promise<void>;
  /** A short-lived, device-bound grant this client presents to the host. */
  requestGrant: (input: { readonly hostId: string }) => Promise<{ readonly grant: string }>;
  enrollment: () => Promise<HostEnrollment>;
  /** Sign-out's counterpart: removes this machine's key from the directory. */
  unlinkLocalHost: () => Promise<void>;
  /**
   * Runs the transport race against one host and answers what it found.
   *
   * Optional, and the only optional member: probing needs the shell to open
   * sockets the browser cannot (TCP, SSH), so a shell may legitimately expose
   * the directory without it. Callers render the absence as "no known
   * address", never as "offline" — see ADR 0010.
   */
  checkReachability?: (input: { readonly hostId: string }) => Promise<HostReachability>;
}

/**
 * The remote-host namespace as it appears on a shell that has one.
 *
 * Probed structurally rather than typed onto `NativeApi`: the server half of
 * this slice ships separately, and a client that assumed the namespace exists
 * would fail with `undefined is not a function` deep inside a query instead of
 * telling the user their server is too old. Every consumer treats `null` as a
 * first-class state.
 */
function readHostsNamespace(api: unknown): HostsApi | null {
  if (typeof api !== "object" || api === null) return null;
  const candidate = (api as { hosts?: unknown }).hosts;
  if (typeof candidate !== "object" || candidate === null) return null;
  const required: readonly (keyof HostsApi)[] = [
    "listHosts",
    "updateHost",
    "deleteHost",
    "listDevices",
    "revokeDevice",
    "approveDeviceLink",
    "requestGrant",
    "enrollment",
    "unlinkLocalHost",
  ];
  const namespace = candidate as Record<string, unknown>;
  for (const method of required) {
    if (typeof namespace[method] !== "function") return null;
  }
  return candidate as HostsApi;
}

/** The remote-host API, or null when this server/shell does not expose one. */
export function readHostsApi(): HostsApi | null {
  return readHostsNamespace(readNativeApi());
}

/**
 * The remote-host API, or a rejection naming the reason. Used by mutations,
 * where a silent no-op would look like a successful toggle.
 */
export function ensureHostsApi(): HostsApi {
  const hosts = readHostsNamespace(ensureNativeApi());
  if (!hosts) {
    throw new Error("This Synara server does not support hosts yet.");
  }
  return hosts;
}

const PLATFORM_LABELS: Record<AccountHostPlatform, string> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
};

export function hostPlatformLabel(platform: AccountHostPlatform): string {
  return PLATFORM_LABELS[platform];
}

/**
 * Owner badge copy. `mine` is set by the list read; an absent flag means the
 * server did not say, and the safe reading is "not mine" — claiming ownership
 * the caller does not have would offer them controls the API will refuse.
 */
export function hostOwnerBadgeLabel(host: AccountHost): "Mine" | "Workspace" {
  return host.mine === true ? "Mine" : "Workspace";
}

/** Only the owner may change discoverability, rename, or delete (ADR 0002). */
export function canManageHost(host: AccountHost): boolean {
  return host.mine === true;
}
