// FILE: activeHost.ts
// Purpose: Which host this window is currently working on. The local shell is
//          the default; choosing another host reloads the window onto the
//          shell's bridged socket for that host.
// Layer: Web remote-access feature state.
// Exports: read/set/clear the active host, and the socket URL override the
//          transport honours.
//
// Why a reload rather than a live transport swap: every store in the app —
// projects, threads, terminals, device panes, keybindings — is keyed to one
// server and assumes it does not change underneath them mid-session. The
// transport already treats a changed server instance id as "reset your resume
// cursors", but the stores above it have no such notion. A reload is the one
// boundary that is guaranteed to clear all of them at once, and it costs the
// same as a server restart, which the app already handles cleanly.

const ACTIVE_HOST_STORAGE_KEY = "synara:active-host:v1";

export interface ActiveHost {
  readonly hostId: string;
  readonly hostName: string;
  /** The shell's local upgrade path for this host's bridged session. */
  readonly wsPath: string;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readActiveHost(): ActiveHost | null {
  const raw = storage()?.getItem(ACTIVE_HOST_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ActiveHost>;
    if (
      typeof parsed.hostId === "string" &&
      typeof parsed.hostName === "string" &&
      typeof parsed.wsPath === "string" &&
      parsed.wsPath.startsWith("/")
    ) {
      return { hostId: parsed.hostId, hostName: parsed.hostName, wsPath: parsed.wsPath };
    }
  } catch {
    // Fall through: a corrupt value is the same as none.
  }
  storage()?.removeItem(ACTIVE_HOST_STORAGE_KEY);
  return null;
}

/** Persists the choice for this window and reloads onto the bridged socket. */
export function activateHost(host: ActiveHost): void {
  storage()?.setItem(ACTIVE_HOST_STORAGE_KEY, JSON.stringify(host));
  window.location.reload();
}

/** Back to the local shell. */
export function deactivateHost(): void {
  storage()?.removeItem(ACTIVE_HOST_STORAGE_KEY);
  window.location.reload();
}

/**
 * The path prefix the transport puts in front of `/ws`, `/ws/negotiate` and
 * `/ws/bootstrap` while a host is active. The shell mounts those paths under
 * the host's bridge path; its own auth (the desktop bridge `?token=`, or
 * loopback trust) is unchanged because the bridge applies the same admission
 * as the local `/ws`. Null when this window is on the local shell.
 */
export function readActiveHostSocketPrefix(): string | null {
  const active = readActiveHost();
  return active ? active.wsPath.replace(/\/+$/, "") : null;
}
